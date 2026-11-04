/**
 * The host: owns the room, the lobby and the authoritative Game. Runs the simulation in this
 * tab at 120 Hz, applies each client's input for the tick it was meant for (or repeats the last
 * one when a packet is late), and broadcasts the full state every other tick.
 */
import type { Peer } from 'peerjs';
import { normalizeArena } from '../arenas';
import type { Vector3 } from 'three';
import type { Team } from '../sim/car';
import { Game, type GameConfig } from '../sim/game';
import { TICK_DT } from '../sim/rl';
import { ByteReader, quantizeInput } from '../sim/state';
import type { CarInput } from '../input/types';
import { DEFAULT_MATCH_SETTINGS, MAX_PLAYERS, MAX_SPECTATORS, PROTOCOL_VERSION, Packet, clampBody, decodeInputs, encodePong, encodeSnapshot, type CtrlMsg, type LobbyPlayer, type MatchSettings } from './protocol';
import { acceptConnections, hostRoom, type Link } from './transport';
import { liveCarState, type CarRenderState, type LobbyState, type Session } from './session';
import { balancedTeam, teamHasSpace } from './roster';

/** Snapshots go out every SNAPSHOT_INTERVAL ticks (60 Hz). */
const SNAPSHOT_INTERVAL = 2;
/** Ignore inputs stamped this far ahead of the host's clock (a confused client). */
const MAX_INPUT_LEAD = 240;
/** Kickoff countdown in online matches. */
const ONLINE_COUNTDOWN = 3;

interface Client {
  slot: number;
  name: string;
  team: Team;
  body: number;
  link: Link;
  /** Inputs by tick, waiting to be applied. */
  inputs: Map<number, CarInput>;
  lastInputTick: number;
  joinedAt: number;
  dodgeDeadzone: number;
}

export class HostSession implements Session {
  readonly kind = 'host';
  readonly localId = 0;
  readonly ping = null;
  game: Game | null = null;
  alpha = 0;
  onLobbyChanged: (() => void) | null = null;
  onMatchStarted: (() => void) | null = null;
  onEnded: ((reason: string) => void) | null = null;

  readonly code: string;
  hostName: string;
  hostTeam: Team = 'blue';
  hostBody = 0;
  hostDodgeDeadzone = 0.5;
  settings: MatchSettings = { ...DEFAULT_MATCH_SETTINGS };
  private readonly clients = new Map<number, Client>();
  /** Watch-only links: no slot, no car, no inputs. */
  private readonly spectators = new Set<Link>();
  private accumulator = 0;
  private inMatch = false;
  private spectatorEpoch = 0;
  private starting = false;
  private config: GameConfig | null = null;
  private readonly startedAt = performance.now();
  private ended = false;
  private teamNotice = '';

  private constructor(
    private readonly peer: Peer,
    code: string,
    hostName: string,
  ) {
    this.code = code;
    this.hostName = hostName;
    acceptConnections(peer, (link) => this.onConnection(link));
    peer.on('disconnected', () => {
      // Signalling dropped: existing players keep playing, nobody new can join. Try to come back.
      try {
        peer.reconnect();
      } catch {
        /* ignore */
      }
    });
    peer.on('error', (err) => {
      const type = (err as { type?: string }).type;
      // Errors about a single failed connection attempt are not fatal for the room.
      if (type === 'peer-unavailable' || type === 'webrtc') return;
      this.end(`Connection error: ${err.message}`);
    });
  }

  static async create(hostName: string): Promise<HostSession> {
    const { peer, code } = await hostRoom();
    return new HostSession(peer, code, hostName);
  }

  get lobby(): LobbyState {
    return {
      code: this.code,
      players: this.players(),
      mySlot: 0,
      isHost: true,
      settings: this.settings,
      inMatch: this.inMatch,
      spectators: this.spectators.size,
      status: this.teamNotice || `Hosting room ${this.code}`,
    };
  }

  private players(): LobbyPlayer[] {
    const list: LobbyPlayer[] = [{ slot: 0, name: this.hostName, team: this.hostTeam, body: this.hostBody }];
    for (const c of [...this.clients.values()].sort((a, b) => a.slot - b.slot)) list.push({ slot: c.slot, name: c.name, team: c.team, body: c.body });
    return list;
  }

  // ---------------------------------------------------------------------------
  // Lobby
  // ---------------------------------------------------------------------------

  private onConnection(link: Link): void {
    let client: Client | null = null;
    let spectator = false;
    link.onCtrl = (msg) => {
      if (spectator) return; // viewers have no lobby controls
      if (!client && msg.t === 'spectate') {
        spectator = this.admitSpectator(link, msg.version);
        return;
      }
      if (!client) {
        if (msg.t !== 'hello') return;
        if (msg.version !== PROTOCOL_VERSION) {
          link.sendCtrl({ t: 'reject', reason: 'Version mismatch: reload the page' });
          setTimeout(() => link.close(), 500);
          return;
        }
        const slot = this.freeSlot();
        if (slot < 0) {
          link.sendCtrl({ t: 'reject', reason: 'Room is full (8/8 players)' });
          setTimeout(() => link.close(), 500);
          return;
        }
        client = {
          slot,
          name: sanitizeName(msg.name) || `Player ${slot + 1}`,
          team: balancedTeam(this.players()),
          body: clampBody(msg.body),
          link,
          inputs: new Map(),
          lastInputTick: -1,
          joinedAt: performance.now(),
          dodgeDeadzone: clampDeadzone(msg.dodgeDeadzone),
        };
        this.clients.set(slot, client);
        link.sendCtrl({ t: 'welcome', slot });
        if (this.inMatch && this.config && this.game) {
          this.game.setDodgeDeadzone(slot, client.dodgeDeadzone);
          this.game.addCar(slot, client.team);
          link.sendCtrl({ t: 'start', config: this.config });
        }
        this.broadcastLobby();
        return;
      }
      this.onClientCtrl(client, msg);
    };
    link.onFast = (buf) => {
      if (client) this.onClientPacket(client, buf);
      else if (spectator && buf.byteLength === 5 && new Uint8Array(buf)[0] === Packet.Ping) link.sendFast(encodePong(new DataView(buf).getUint32(1, true)));
    };
    link.onClose = () => {
      if (spectator) {
        spectator = false;
        this.spectators.delete(link);
        this.broadcastLobby();
        return;
      }
      if (!client) return;
      this.clients.delete(client.slot);
      this.game?.removeCar(client.slot);
      client = null;
      this.broadcastLobby();
    };
  }

  private admitSpectator(link: Link, version: number): boolean {
    const reject = (reason: string) => {
      link.sendCtrl({ t: 'reject', reason });
      setTimeout(() => link.close(), 500);
      return false;
    };
    if (version !== PROTOCOL_VERSION) return reject('Version mismatch: reload the page');
    if (this.spectators.size >= MAX_SPECTATORS) return reject(`Room has the maximum ${MAX_SPECTATORS} spectators`);
    this.spectators.add(link);
    link.sendCtrl({ t: 'welcome', slot: -1, spectator: true });
    if (this.inMatch && this.config) link.sendCtrl({ t: 'start', config: this.config, epoch: this.spectatorEpoch });
    this.broadcastLobby();
    return true;
  }

  private onClientCtrl(client: Client, msg: CtrlMsg): void {
    switch (msg.t) {
      case 'team':
        if (msg.team === 'blue' || msg.team === 'orange') {
          if (!teamHasSpace(this.players(), msg.team, client.slot)) {
            client.link.sendCtrl({ t: 'notice', reason: `${msg.team === 'blue' ? 'Blue' : 'Orange'} team is full (4/4)` });
            return;
          }
          if (client.team === msg.team) return;
          client.team = msg.team;
          client.inputs.clear();
          client.lastInputTick = -1;
          if (this.game) this.game.addCar(client.slot, client.team); // re-creates the car on the new team
          this.broadcastLobby();
        }
        break;
      case 'body':
        client.body = clampBody(msg.body);
        this.broadcastLobby();
        break;
      default:
        break;
    }
  }

  private onClientPacket(client: Client, buf: ArrayBuffer): void {
    if (buf.byteLength < 1) return;
    const r = new ByteReader(buf);
    const type = r.u8();
    if (type === Packet.Input) {
      const { firstTick, inputs } = decodeInputs(r);
      const now = this.game ? this.game.tick : 0;
      for (let i = 0; i < inputs.length; i++) {
        const tick = firstTick + i;
        if (tick < now || tick > now + MAX_INPUT_LEAD) continue;
        if (!client.inputs.has(tick)) client.inputs.set(tick, inputs[i]);
        if (tick > client.lastInputTick) client.lastInputTick = tick;
      }
    } else if (type === Packet.Ping) {
      client.link.sendFast(encodePong(r.u32()));
    }
  }

  private freeSlot(): number {
    for (let s = 1; s < MAX_PLAYERS; s++) if (!this.clients.has(s)) return s;
    return -1;
  }

  private broadcastLobby(): void {
    this.teamNotice = '';
    const msg: CtrlMsg = { t: 'lobby', players: this.players(), settings: this.settings, inMatch: this.inMatch, spectators: this.spectators.size };
    for (const c of this.clients.values()) c.link.sendCtrl(msg);
    for (const link of this.spectators) link.sendCtrl(msg);
    this.onLobbyChanged?.();
  }

  /** Host UI: switch own team. */
  setHostTeam(team: Team): boolean {
    if (!teamHasSpace(this.players(), team, 0)) {
      this.teamNotice = `${team === 'blue' ? 'Blue' : 'Orange'} team is full (4/4)`;
      this.onLobbyChanged?.();
      return false;
    }
    this.teamNotice = '';
    if (this.hostTeam === team) return true;
    this.hostTeam = team;
    if (this.game) this.game.addCar(0, team);
    this.broadcastLobby();
    return true;
  }

  /** Host UI: own car body. Cosmetic, so it can change at any time, even mid-match. */
  setHostBody(body: number): void {
    if (body === this.hostBody) return;
    this.hostBody = clampBody(body);
    this.broadcastLobby();
  }

  setHostName(name: string): void {
    this.hostName = sanitizeName(name) || 'Host';
    this.broadcastLobby();
  }

  setSettings(settings: Partial<MatchSettings>): void {
    if (settings.matchSeconds !== undefined) this.settings.matchSeconds = settings.matchSeconds;
    if (settings.arena !== undefined && !this.inMatch && !this.starting) this.settings.arena = normalizeArena(settings.arena);
    this.broadcastLobby();
  }

  // ---------------------------------------------------------------------------
  // Match
  // ---------------------------------------------------------------------------

  async startMatch(): Promise<void> {
    if (this.ended || this.inMatch || this.starting) return;
    this.starting = true;
    const config: GameConfig = {
      infiniteBoost: false,
      countdown: ONLINE_COUNTDOWN,
      matchSeconds: this.settings.matchSeconds,
      arena: normalizeArena(this.settings.arena),
      seed: (Math.random() * 0xffffffff) >>> 0 || 1,
    };
    // Keep the candidate private until setup succeeds; a failed start must leave the lobby
    // and any previous game intact, and release the lock so the host can retry.
    let candidate: Game | null = null;
    try {
      candidate = await Game.create(config);
      if (this.ended) return;
      candidate.setDodgeDeadzone(0, this.hostDodgeDeadzone);
      candidate.addCar(0, this.hostTeam);
      for (const c of this.clients.values()) {
        candidate.setDodgeDeadzone(c.slot, c.dodgeDeadzone);
        candidate.addCar(c.slot, c.team);
      }
      // Cars were placed as they were added; a proper kickoff lines everyone up together.
      candidate.resetKickoff();
      this.game?.destroy();
      this.game = candidate;
      candidate = null; // ownership has transferred to the session
      this.config = config;
      this.inMatch = true;
      this.accumulator = 0;
      for (const c of this.clients.values()) {
        c.inputs.clear();
        c.lastInputTick = -1;
      }
    } finally {
      this.starting = false;
      candidate?.destroy();
    }
    for (const c of this.clients.values()) c.link.sendCtrl({ t: 'start', config });
    this.spectatorEpoch++;
    for (const link of this.spectators) link.sendCtrl({ t: 'start', config, epoch: this.spectatorEpoch });
    this.broadcastLobby();
    this.onMatchStarted?.();
  }

  /** Back to the lobby for everyone. */
  endMatch(): void {
    if (!this.inMatch) return;
    this.inMatch = false;
    for (const c of this.clients.values()) c.link.sendCtrl({ t: 'end' });
    for (const link of this.spectators) link.sendCtrl({ t: 'end' });
    this.game?.destroy();
    this.game = null;
    this.config = null;
    this.broadcastLobby();
  }

  update(input: CarInput, frameDt: number, _menuOpen: boolean): void {
    const game = this.game;
    if (!game || !this.inMatch) return;
    // The host keeps simulating behind its menu: other people are playing.
    const local = quantizeInput(input);
    this.accumulator += frameDt;
    let steps = 0;
    let playerSnapshotDue = false;
    const inputs = new Map<number, CarInput>();
    while (this.accumulator >= TICK_DT && steps < 12) {
      const tick = game.tick;
      inputs.clear();
      inputs.set(0, local);
      for (const c of this.clients.values()) {
        const inp = c.inputs.get(tick);
        if (inp) inputs.set(c.slot, inp); // otherwise the car repeats its previous input
        // Prune everything at or before this tick.
        for (const t of c.inputs.keys()) if (t <= tick) c.inputs.delete(t);
      }
      game.step(inputs, TICK_DT);
      this.accumulator -= TICK_DT;
      steps++;
      if (game.tick % SNAPSHOT_INTERVAL === 0) playerSnapshotDue = true;
    }
    if (steps === 12) this.accumulator = 0;
    this.alpha = Math.min(1, this.accumulator / TICK_DT);
    // Viewers get the newest tick once per host update, including odd ticks. They have no
    // inputs to acknowledge, so their epoch header stays separate from each player's ack.
    const spectatorSnapshotDue = steps > 0 && this.spectators.size > 0;
    // Serialize only after catch-up so every recipient gets the newest simulated tick. Reuse
    // the state bytes, while encoding each packet separately for its ack/epoch header.
    if ((playerSnapshotDue && this.clients.size > 0) || spectatorSnapshotDue) {
      const state = game.snapshotBytes();
      const now = performance.now() - this.startedAt;
      if (playerSnapshotDue && this.clients.size > 0) this.broadcastSnapshot(state, now);
      if (spectatorSnapshotDue) {
        const packet = encodeSnapshot(state, this.spectatorEpoch, now);
        for (const link of this.spectators) link.sendFast(packet);
      }
    }
  }

  private broadcastSnapshot(state: ArrayBuffer, now: number): void {
    const game = this.game;
    if (!game || this.clients.size === 0) return;
    for (const c of this.clients.values()) {
      c.link.sendFast(encodeSnapshot(state, c.lastInputTick, now));
    }
  }

  carRenderStates(): CarRenderState[] {
    const game = this.game;
    if (!game) return [];
    const who = new Map<number, { name: string; body: number }>();
    who.set(0, { name: this.hostName, body: this.hostBody });
    for (const c of this.clients.values()) who.set(c.slot, { name: c.name, body: c.body });
    const out: CarRenderState[] = [];
    for (const id of game.cars.keys()) {
      const w = who.get(id);
      const s = liveCarState(game, id, this.alpha, w?.name ?? '', w?.body ?? 0);
      if (s) out.push(s);
    }
    return out;
  }

  ballOffset(): Vector3 | null {
    return null;
  }

  resetMatch(): void {
    this.game?.resetMatch();
  }

  leave(): void {
    this.end('You left the room');
  }

  private end(reason: string): void {
    if (this.ended) return;
    this.ended = true;
    for (const c of this.clients.values()) c.link.close();
    this.clients.clear();
    for (const link of [...this.spectators]) link.close();
    this.spectators.clear();
    this.game?.destroy();
    this.game = null;
    this.inMatch = false;
    try {
      this.peer.destroy();
    } catch {
      /* ignore */
    }
    this.onEnded?.(reason);
  }
}

function clampDeadzone(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 0.5;
  return Math.max(0.5, Math.min(0.9, n));
}

export function sanitizeName(name: string): string {
  return name.replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 16);
}
