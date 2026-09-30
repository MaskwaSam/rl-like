/**
 * The host: owns the room, the lobby and the authoritative Game. Runs the simulation in this
 * tab at 120 Hz, applies each client's input for the tick it was meant for (or repeats the last
 * one when a packet is late), and broadcasts the full state every other tick.
 */
import type { Peer } from 'peerjs';
import type { Vector3 } from 'three';
import type { Team } from '../sim/car';
import { Game, type GameConfig } from '../sim/game';
import { TICK_DT } from '../sim/rl';
import { ByteReader, quantizeInput } from '../sim/state';
import type { CarInput } from '../input/types';
import { DEFAULT_MATCH_SETTINGS, MAX_PLAYERS, PROTOCOL_VERSION, Packet, clampBody, decodeInputs, encodePong, encodeSnapshot, type CtrlMsg, type LobbyPlayer, type MatchSettings } from './protocol';
import { acceptConnections, hostRoom, type Link } from './transport';
import { liveCarState, type CarRenderState, type LobbyState, type Session } from './session';

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
  private accumulator = 0;
  private inMatch = false;
  private starting = false;
  private config: GameConfig | null = null;
  private readonly startedAt = performance.now();
  private ended = false;

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
      status: `Hosting room ${this.code}`,
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
    link.onCtrl = (msg) => {
      if (!client) {
        if (msg.t !== 'hello') return;
        if (msg.version !== PROTOCOL_VERSION) {
          link.sendCtrl({ t: 'reject', reason: 'Version mismatch: reload the page' });
          setTimeout(() => link.close(), 500);
          return;
        }
        const slot = this.freeSlot();
        if (slot < 0) {
          link.sendCtrl({ t: 'reject', reason: 'Room is full' });
          setTimeout(() => link.close(), 500);
          return;
        }
        client = {
          slot,
          name: sanitizeName(msg.name) || `Player ${slot + 1}`,
          team: this.balancedTeam(),
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
    };
    link.onClose = () => {
      if (!client) return;
      this.clients.delete(client.slot);
      this.game?.removeCar(client.slot);
      client = null;
      this.broadcastLobby();
    };
  }

  private onClientCtrl(client: Client, msg: CtrlMsg): void {
    switch (msg.t) {
      case 'team':
        if (msg.team === 'blue' || msg.team === 'orange') {
          client.team = msg.team;
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

  private balancedTeam(): Team {
    let blue = this.hostTeam === 'blue' ? 1 : 0;
    let orange = 1 - blue;
    for (const c of this.clients.values()) c.team === 'blue' ? blue++ : orange++;
    return blue <= orange ? 'blue' : 'orange';
  }

  private broadcastLobby(): void {
    const msg: CtrlMsg = { t: 'lobby', players: this.players(), settings: this.settings, inMatch: this.inMatch };
    for (const c of this.clients.values()) c.link.sendCtrl(msg);
    this.onLobbyChanged?.();
  }

  /** Host UI: switch own team. */
  setHostTeam(team: Team): void {
    this.hostTeam = team;
    if (this.game) this.game.addCar(0, team);
    this.broadcastLobby();
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
    Object.assign(this.settings, settings);
    this.broadcastLobby();
  }

  // ---------------------------------------------------------------------------
  // Match
  // ---------------------------------------------------------------------------

  async startMatch(): Promise<void> {
    if (this.inMatch || this.starting) return;
    this.starting = true;
    const config: GameConfig = {
      infiniteBoost: false,
      countdown: ONLINE_COUNTDOWN,
      matchSeconds: this.settings.matchSeconds,
      seed: (Math.random() * 0xffffffff) >>> 0 || 1,
    };
    const game = await Game.create(config);
    game.setDodgeDeadzone(0, this.hostDodgeDeadzone);
    game.addCar(0, this.hostTeam);
    for (const c of this.clients.values()) {
      game.setDodgeDeadzone(c.slot, c.dodgeDeadzone);
      game.addCar(c.slot, c.team);
      c.inputs.clear();
      c.lastInputTick = -1;
    }
    // Cars were placed as they were added; a proper kickoff lines everyone up together.
    game.resetKickoff();
    this.game?.destroy();
    this.game = game;
    this.config = config;
    this.inMatch = true;
    this.starting = false;
    this.accumulator = 0;
    for (const c of this.clients.values()) c.link.sendCtrl({ t: 'start', config });
    this.broadcastLobby();
    this.onMatchStarted?.();
  }

  /** Back to the lobby for everyone. */
  endMatch(): void {
    if (!this.inMatch) return;
    this.inMatch = false;
    for (const c of this.clients.values()) c.link.sendCtrl({ t: 'end' });
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
      if (game.tick % SNAPSHOT_INTERVAL === 0) this.broadcastSnapshot();
    }
    if (steps === 12) this.accumulator = 0;
    this.alpha = Math.min(1, this.accumulator / TICK_DT);
  }

  private broadcastSnapshot(): void {
    const game = this.game;
    if (!game || this.clients.size === 0) return;
    const state = game.snapshotBytes();
    const now = performance.now() - this.startedAt;
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
