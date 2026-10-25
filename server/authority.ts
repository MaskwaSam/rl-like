import { Game, type GameConfig } from '../src/sim/game';
import { isArena } from '../src/arenas';
import { TICK_DT } from '../src/sim/rl';
import { ByteReader } from '../src/sim/state';
import { EMPTY_INPUT, type CarInput } from '../src/input/types';
import { PROTOCOL_VERSION, Packet, decodeInputs, encodePong, encodeSnapshot, type CtrlMsg, type LobbyPlayer } from '../src/net/protocol';

interface Player extends LobbyPlayer {
  principal: string;
  connected: boolean;
  disconnectedAt: number;
  dodgeDeadzone: number;
  inputs: Map<number, CarInput>;
  lastInputTick: number;
  inputAt: number;
}

/** Headless authority: no DOM, renderer, PeerJS or local host-player assumption. */
export class RoomAuthority {
  game: Game | null = null;
  epoch = 0;
  matchSeconds = 300;
  arena = 0;
  private config: GameConfig | null = null;
  private players = new Map<string, Player>();
  private starting = false;
  private generation = 0;
  private closed = false;
  private accumulator = 0;
  private readonly startedAt = performance.now();
  readonly metrics = { ticks: 0, droppedBacklogs: 0, snapshots: 0, maxStepMs: 0 };

  constructor(readonly owner: string, readonly teamSize: number,
    private readonly ctrl: (principal: string, message: CtrlMsg) => void,
    private readonly binary: (principal: string, epoch: number, packet: ArrayBuffer) => void,
    private readonly snapshotHz = 60) {}

  private roster(): LobbyPlayer[] {
    return [...this.players.values()].sort((a, b) => a.slot - b.slot)
      .map(({ slot, name, team, body }) => ({ slot, name, team, body }));
  }

  admit(principal: string, message: unknown): boolean {
    const msg = message as Record<string, unknown> | null;
    if (!msg || msg.t !== 'hello' || msg.version !== PROTOCOL_VERSION || typeof msg.name !== 'string' || msg.name.length > 64
      || !Number.isInteger(msg.body) || Number(msg.body) < 0 || Number(msg.body) > 2
      || typeof msg.dodgeDeadzone !== 'number' || !Number.isFinite(msg.dodgeDeadzone) || msg.dodgeDeadzone < 0.5 || msg.dodgeDeadzone > 0.9) return false;
    let player = this.players.get(principal);
    if (!player) {
      const roster = this.roster();
      let slot = 0;
      while (roster.some(p => p.slot === slot)) slot++;
      if (slot >= this.teamSize * 2) { this.ctrl(principal, { t: 'reject', reason: 'Room full. Try again when a place opens.' }); return true; }
      const blue = roster.filter(p => p.team === 'blue').length;
      player = { principal, slot, name: msg.name.replace(/[\x00-\x1f\x7f<>]/g, '').trim().slice(0, 16) || `Player ${slot + 1}`,
        team: blue <= roster.length - blue ? 'blue' : 'orange', body: Number(msg.body),
        dodgeDeadzone: msg.dodgeDeadzone, connected: true, disconnectedAt: 0, inputs: new Map(), lastInputTick: -1, inputAt: 0 };
      this.players.set(principal, player);
      if (this.game) { this.game.setDodgeDeadzone(slot, player.dodgeDeadzone); this.game.addCar(slot, player.team); }
    }
    player.connected = true;
    player.body = Number(msg.body); player.dodgeDeadzone = msg.dodgeDeadzone;
    this.game?.setDodgeDeadzone(player.slot, player.dodgeDeadzone);
    player.inputs.clear();
    player.lastInputTick = -1;
    this.ctrl(principal, { t: 'welcome', slot: player.slot, owner: principal === this.owner });
    if (this.config) this.ctrl(principal, { t: 'start', config: this.config, epoch: this.epoch });
    else this.ctrl(principal, { t: 'end' }); // reconnect may have missed an earlier end
    this.lobby();
    return true;
  }

  disconnect(principal: string): void {
    const p = this.players.get(principal);
    if (p) { p.connected = false; p.disconnectedAt = performance.now(); p.inputs.clear(); }
  }

  remove(principal: string): void {
    const p = this.players.get(principal);
    if (!p) return;
    this.players.delete(principal); this.game?.removeCar(p.slot); this.lobby();
  }

  refresh(): void {
    for (const p of this.players.values()) if (p.connected) this.ctrl(p.principal, { t: 'welcome', slot: p.slot, owner: p.principal === this.owner });
    this.lobby();
  }

  control(principal: string, value: unknown): boolean {
    const p = this.players.get(principal);
    const msg = value as Record<string, unknown> | null;
    if (!p || !msg || typeof msg.t !== 'string') return false;
    if (msg.t === 'body' && Number.isInteger(msg.body) && Number(msg.body) >= 0 && Number(msg.body) < 3) {
      p.body = Number(msg.body); this.lobby(); return true;
    }
    if (msg.t === 'team' && (msg.team === 'blue' || msg.team === 'orange')) {
      if (this.roster().filter(o => o.team === msg.team && o.slot !== p.slot).length >= this.teamSize) {
        this.ctrl(principal, { t: 'notice', reason: 'Other team is full.' }); return true;
      }
      p.team = msg.team; p.inputs.clear(); p.lastInputTick = -1;
      if (this.game) this.game.addCar(p.slot, p.team);
      this.lobby(); return true;
    }
    if (principal !== this.owner) return false;
    if (msg.t === 'settings') {
      if (msg.matchSeconds === undefined && msg.arena === undefined) return false;
      if (msg.matchSeconds !== undefined && (typeof msg.matchSeconds !== 'number' || ![0, 120, 180, 300, 600].includes(msg.matchSeconds))) return false;
      if (msg.arena !== undefined && (!isArena(msg.arena) || this.game || this.starting)) return false;
      if (msg.matchSeconds !== undefined) this.matchSeconds = msg.matchSeconds as number;
      if (msg.arena !== undefined) this.arena = msg.arena as number;
      this.lobby(); return true;
    }
    if (msg.t === 'room-command') {
      if (msg.action === 'start') { void this.start(); return true; }
      if (msg.action === 'reset') { this.end(); void this.start(); return true; }
      if (msg.action === 'end') { this.end(); return true; }
    }
    return false;
  }

  packet(principal: string, epoch: number, buffer: ArrayBuffer): boolean {
    const p = this.players.get(principal);
    if (!p || buffer.byteLength < 1) return false;
    if (epoch < this.epoch) return true; // discard stale packets from a previous match
    if (epoch !== this.epoch) return false;
    const bytes = new Uint8Array(buffer);
    if (bytes[0] === Packet.Ping && bytes.length === 5) {
      this.binary(principal, this.epoch, encodePong(new DataView(buffer).getUint32(1, true))); return true;
    }
    if (bytes[0] !== Packet.Input || bytes.length < 12) return false;
    const n = bytes[5];
    if (n < 1 || n > 32 || bytes.length !== 6 + n * 6) return false;
    for (let i = 0; i < n; i++) {
      const offset = 6 + i * 6;
      for (let a = 0; a < 5; a++) if (bytes[offset + a] === 128) return false;
      if (bytes[offset + 5] & ~15) return false;
    }
    if (!this.game) return true;
    const reader = new ByteReader(buffer); reader.u8();
    const { firstTick, inputs } = decodeInputs(reader);
    const tick = this.game.tick;
    for (let i = 0; i < inputs.length; i++) {
      const t = firstTick + i;
      if (t < tick || t > tick + 240) continue;
      p.inputAt = performance.now();
      if (!p.inputs.has(t)) p.inputs.set(t, inputs[i]);
      p.lastInputTick = Math.max(p.lastInputTick, t);
    }
    return true;
  }

  advance(dt: number): void {
    const now = performance.now();
    for (const p of this.players.values()) if (!p.connected && now - p.disconnectedAt > 30_000) this.remove(p.principal);
    const game = this.game;
    if (!game) return;
    this.accumulator += Math.min(Math.max(dt, 0), 0.1);
    let steps = 0;
    while (this.accumulator >= TICK_DT && steps++ < 12) {
      const started = performance.now();
      const inputs = new Map<number, CarInput>();
      for (const p of this.players.values()) {
        const input = p.inputs.get(game.tick);
        inputs.set(p.slot, !p.connected || now - p.inputAt > 250 ? EMPTY_INPUT : input ?? game.cars.get(p.slot)?.lastInput ?? EMPTY_INPUT);
        for (const tick of p.inputs.keys()) if (tick <= game.tick) p.inputs.delete(tick);
      }
      game.step(inputs, TICK_DT);
      this.metrics.ticks++;
      this.accumulator -= TICK_DT;
      this.metrics.maxStepMs = Math.max(this.metrics.maxStepMs, performance.now() - started);
      if (game.tick % (120 / this.snapshotHz) === 0) {
        const state = game.snapshotBytes();
        for (const p of this.players.values()) if (p.connected) this.binary(p.principal, this.epoch, encodeSnapshot(state, p.lastInputTick, now - this.startedAt));
        this.metrics.snapshots++;
      }
    }
    if (this.accumulator >= TICK_DT) { this.metrics.droppedBacklogs++; this.accumulator = 0; }
  }

  private async start(): Promise<void> {
    if (this.game || this.starting || this.closed) return;
    this.starting = true;
    const generation = ++this.generation;
    const config: GameConfig = { infiniteBoost: false, countdown: 3, matchSeconds: this.matchSeconds, arena: this.arena, seed: (Math.random() * 0xffffffff) >>> 0 || 1 };
    try {
      const game = await Game.create(config);
      if (this.closed || generation !== this.generation) { game.destroy(); return; }
      for (const p of this.players.values()) {
        game.setDodgeDeadzone(p.slot, p.dodgeDeadzone); game.addCar(p.slot, p.team); p.inputs.clear(); p.lastInputTick = -1; p.inputAt = 0;
      }
      game.resetKickoff(); this.game = game; this.config = config; this.epoch++; this.accumulator = 0;
      for (const p of this.players.values()) if (p.connected) this.ctrl(p.principal, { t: 'start', config, epoch: this.epoch });
      this.lobby();
    } finally { if (generation === this.generation) this.starting = false; }
  }

  private end(): void {
    this.generation++; this.starting = false;
    this.game?.destroy(); this.game = null; this.config = null;
    for (const p of this.players.values()) if (p.connected) this.ctrl(p.principal, { t: 'end' });
    this.lobby();
  }

  private lobby(): void {
    for (const p of this.players.values()) if (p.connected) this.ctrl(p.principal, { t: 'lobby', players: this.roster(), settings: { matchSeconds: this.matchSeconds, arena: this.arena }, inMatch: !!this.game });
  }

  destroy(): void { this.closed = true; this.generation++; this.starting = false; this.game?.destroy(); this.game = null; this.players.clear(); }
}
