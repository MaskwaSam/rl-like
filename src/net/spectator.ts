/**
 * A watch-only seat in a browser-hosted room. Nothing here waits in an interpolation buffer:
 * every host snapshot is applied to a local Game, which is then simulated forward to "host now"
 * (time since the snapshot plus half the round trip) with each car repeating the input it had
 * in that snapshot, exactly what the host does with a late packet. On a LAN that is a tick or
 * two of extrapolation, so the picture is as close to live as the host's own screen. Each new
 * snapshot corrects the extrapolation; small corrections are folded into a fading visual
 * offset so the view never pops.
 */
import type { Peer } from 'peerjs';
import { Quaternion, Vector3 } from 'three';
import { Game, type BodyState, type GameConfig, type GameState } from '../sim/game';
import { TICK_DT, TICK_RATE } from '../sim/rl';
import { ByteReader } from '../sim/state';
import { DEFAULT_MATCH_SETTINGS, PROTOCOL_VERSION, Packet, clampBody, encodePing, type CtrlMsg, type LobbyPlayer, type MatchSettings } from './protocol';
import { joinRoom } from './transport';
import type { GameLink } from './channel';
import { liveCarState, type CarRenderState } from './session';
import { createSpectatorAdmission } from './spectator-admission';

/** Never extrapolate further than this past the newest snapshot (a stalled host freezes, it does not fly off). */
const MAX_EXTRAPOLATE_TICKS = 18;
/** Re-simulating more than this after a snapshot is pointless; the clock snaps instead. */
const MAX_RESIM_TICKS = 30;
/** Playback-clock disagreement (ticks) beyond which it jumps rather than eases. */
const CLOCK_SNAP_TICKS = 12;
/** Corrections larger than this (m) are teleports (kickoff, respawn) and snap. */
const MAX_SMOOTH_DISTANCE = 2.5;
/** Correction fade (1/s). Faster than the player client: LAN corrections are tiny. */
const SMOOTH_RATE = 18;
const PING_INTERVAL_MS = 500;
/** Cap per-frame stepping after a stall. */
const MAX_STEPS_PER_FRAME = 24;

const tmpQ = new Quaternion();
const tmpQ2 = new Quaternion();
const identityQ = new Quaternion();

export interface SpectatorEvents {
  demos: { victim: number; attacker: number; x: number; y: number; z: number }[];
  ballHitSpeed: number;
  ballBounceSpeed: number;
}

export class SpectatorSession {
  game: Game | null = null;
  ping: number | null = null;
  players: LobbyPlayer[] = [];
  settings: MatchSettings = { ...DEFAULT_MATCH_SETTINGS };
  spectators = 0;
  inMatch = false;
  status = 'Connecting…';
  alpha = 1;
  onLobbyChanged: (() => void) | null = null;
  onMatchStarted: (() => void) | null = null;
  onEnded: ((reason: string) => void) | null = null;
  /** Effects gathered while stepping this frame (deduplicated across re-simulation). */
  readonly events: SpectatorEvents = { demos: [], ballHitSpeed: 0, ballBounceSpeed: 0 };
  readonly stats = { snapshots: 0, resims: 0, resimTicks: 0, clockSnaps: 0, extrapolatedTicks: 0, snapshotIntervalMs: 0 };

  private synced = false;
  private ended = false;
  private startingGame = false;
  private gameGeneration = 0;
  private matchEpoch: number | null = null;
  private buffered: GameState | null = null;
  private lastSnapshotTick = -1;
  private latestAt = 0;
  /** Fractional playback tick; game.tick is ceil of this. */
  private renderTick = 0;
  private lastPingSent = -Infinity;
  private readonly rttSamples: number[] = [];
  private readonly carOffsets = new Map<number, { pos: Vector3; quat: Quaternion }>();
  private readonly ballOffsetVec = new Vector3();
  private readonly demoSeen = new Map<number, number>();
  private admitted: ((err: string | null) => void) | null = null;

  private constructor(private readonly peer: Peer | null, private readonly link: GameLink, readonly code: string) {
    link.onCtrl = (msg) => this.onCtrl(msg);
    link.onFast = (buf) => this.onPacket(buf);
    link.onClose = () => this.end('Disconnected from the host');
    peer?.on('error', (err) => {
      const type = (err as { type?: string }).type;
      if (type === 'peer-unavailable' || type === 'webrtc' || type === 'network') return;
      this.end(`Connection error: ${err.message}`);
    });
  }

  static async create(code: string): Promise<SpectatorSession> {
    const { peer, link } = await joinRoom(code);
    return SpectatorSession.createOnLink(link, code, peer);
  }

  static async createOnLink(link: GameLink, code: string, peer: Peer | null = null, timeoutMs = 10000): Promise<SpectatorSession> {
    const session = new SpectatorSession(peer, link, code);
    const admission = createSpectatorAdmission(timeoutMs, () => session.leave());
    session.admitted = admission.settle;
    try {
      link.sendCtrl({ t: 'spectate', version: PROTOCOL_VERSION });
    } catch (err) {
      session.end(`Connection error: ${err instanceof Error ? err.message : String(err)}`);
    }
    await admission.promise;
    return session;
  }

  /** Estimated one-way delay to the host (ms): what extrapolation has to cover beyond packet age. */
  get oneWayMs(): number {
    return (this.ping ?? 0) / 2;
  }

  get ready(): boolean {
    return !!this.game && this.synced;
  }

  // ---------------------------------------------------------------------------
  // Control channel
  // ---------------------------------------------------------------------------

  private onCtrl(msg: CtrlMsg): void {
    switch (msg.t) {
      case 'welcome':
        this.status = `Watching room ${this.code}`;
        this.admitted?.(null);
        this.admitted = null;
        this.onLobbyChanged?.();
        break;
      case 'reject':
        this.admitted?.(msg.reason);
        this.admitted = null;
        this.end(msg.reason);
        break;
      case 'lobby':
        this.players = msg.players;
        this.settings = msg.settings;
        this.spectators = msg.spectators ?? 0;
        this.onLobbyChanged?.();
        break;
      case 'start':
        this.matchEpoch = msg.epoch ?? null;
        void this.startGame(msg.config);
        break;
      case 'end':
        this.matchEpoch = null;
        this.gameGeneration++;
        this.reset();
        this.inMatch = false;
        this.game?.destroy();
        this.game = null;
        this.onLobbyChanged?.();
        break;
      default:
        break;
    }
  }

  private reset(): void {
    this.buffered = null;
    this.startingGame = false;
    this.synced = false;
    this.lastSnapshotTick = -1;
    this.latestAt = 0;
    this.renderTick = 0;
    this.alpha = 1;
    this.carOffsets.clear();
    this.ballOffsetVec.set(0, 0, 0);
    this.demoSeen.clear();
  }

  private async startGame(config: GameConfig): Promise<void> {
    const generation = ++this.gameGeneration;
    if (this.ended) return;
    this.reset();
    this.startingGame = true;
    this.game?.destroy();
    this.game = null;
    let game: Game;
    try {
      game = await Game.create(config);
    } catch (err) {
      if (generation === this.gameGeneration) this.end(`Could not start match: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (generation !== this.gameGeneration || this.ended) { game.destroy(); return; }
    this.startingGame = false;
    this.game = game;
    this.inMatch = true;
    this.status = 'Waiting for the first snapshot…';
    this.onLobbyChanged?.();
    const buffered = this.buffered;
    this.buffered = null;
    if (buffered) this.onSnapshot(buffered);
  }

  // ---------------------------------------------------------------------------
  // Fast channel
  // ---------------------------------------------------------------------------

  private onPacket(buf: ArrayBuffer): void {
    if (this.ended || buf.byteLength < 1) return;
    const r = new ByteReader(buf);
    const type = r.u8();
    if (type === Packet.Pong && buf.byteLength === 5) {
      const rtt = (performance.now() >>> 0) - r.u32();
      if (rtt >= 0 && rtt < 5000) {
        this.rttSamples.push(rtt);
        if (this.rttSamples.length > 8) this.rttSamples.shift();
        const sorted = [...this.rttSamples].sort((a, b) => a - b);
        this.ping = sorted[Math.floor(sorted.length / 2)];
      }
    } else if (type === Packet.Snapshot && buf.byteLength >= 9) {
      // The spectator has no input acknowledgement: that header field identifies the match.
      // Fast and reliable channels can cross at a rematch; never apply an old match's state.
      if (this.matchEpoch === null || r.i32() !== this.matchEpoch) return;
      r.u32(); // host time
      this.onSnapshot(Game.decode(r));
    }
  }

  private onSnapshot(state: GameState): void {
    if (this.ended) return;
    if (this.startingGame) {
      if (!this.buffered || state.tick > this.buffered.tick) this.buffered = state;
      return;
    }
    const game = this.game;
    if (!game || state.tick <= this.lastSnapshotTick) return; // stale or out of order
    const now = performance.now();
    if (this.latestAt) this.stats.snapshotIntervalMs += ((now - this.latestAt) - this.stats.snapshotIntervalMs) * 0.1;
    this.stats.snapshots++;
    this.lastSnapshotTick = state.tick;
    this.latestAt = now;

    if (!this.synced) {
      game.applyState(state);
      this.renderTick = state.tick;
      this.alpha = 1;
      this.synced = true;
      this.status = `Watching room ${this.code}`;
      this.onLobbyChanged?.();
      this.onMatchStarted?.();
      return;
    }

    // Remember what is on screen so the correction can fade instead of pop.
    const oldTick = game.tick;
    const oldCars = new Map<number, BodyState>();
    const oldPrevCars = new Map<number, BodyState>();
    for (const [id, body] of game.curr.cars) oldCars.set(id, { ...body });
    for (const [id, body] of game.prev.cars) oldPrevCars.set(id, { ...body });
    const oldBall = { ...game.curr.ball };
    const oldPrevBall = { ...game.prev.ball };
    const ballWasVisible = game.ballVisible;

    game.applyState(state);
    if (this.renderTick < state.tick) this.renderTick = state.tick;
    const resimTo = Math.min(oldTick, state.tick + MAX_RESIM_TICKS);
    if (resimTo > state.tick) {
      this.stats.resims++;
      while (game.tick < resimTo) this.step(game, false);
    }
    if (game.tick !== oldTick) return; // clock moved on its own; nothing comparable to smooth
    // When the snapshot lands on the displayed tick, applyState collapsed prev onto curr. For
    // anything that was not teleported, keep the previous on-screen tick so this frame's
    // interpolation does not jump by a fraction of a tick.
    const keepPrev = resimTo === state.tick;

    for (const [id, body] of game.curr.cars) {
      const old = oldCars.get(id);
      if (!old) continue;
      let offset = this.carOffsets.get(id);
      if (!offset) this.carOffsets.set(id, offset = { pos: new Vector3(), quat: new Quaternion() });
      const dx = old.px - body.px, dy = old.py - body.py, dz = old.pz - body.pz;
      if (Math.hypot(dx, dy, dz) < MAX_SMOOTH_DISTANCE) {
        offset.pos.x += dx; offset.pos.y += dy; offset.pos.z += dz;
        tmpQ.set(old.qx, old.qy, old.qz, old.qw);
        tmpQ2.set(body.qx, body.qy, body.qz, body.qw).invert();
        offset.quat.premultiply(tmpQ.multiply(tmpQ2));
        const prev = oldPrevCars.get(id);
        if (keepPrev && prev) game.prev.cars.set(id, prev);
      } else {
        offset.pos.set(0, 0, 0);
        offset.quat.identity();
      }
    }
    const nb = game.curr.ball;
    const bdx = oldBall.px - nb.px, bdy = oldBall.py - nb.py, bdz = oldBall.pz - nb.pz;
    if (ballWasVisible && game.ballVisible && Math.hypot(bdx, bdy, bdz) < MAX_SMOOTH_DISTANCE) {
      this.ballOffsetVec.x += bdx; this.ballOffsetVec.y += bdy; this.ballOffsetVec.z += bdz;
      if (keepPrev) Object.assign(game.prev.ball, oldPrevBall);
    } else this.ballOffsetVec.set(0, 0, 0);
  }

  /** One tick with every car repeating its last input; records effects without duplicates. */
  private step(game: Game, forward: boolean): void {
    game.step(new Map(), TICK_DT);
    if (forward) {
      this.events.ballHitSpeed = Math.max(this.events.ballHitSpeed, game.ballHitRelSpeed);
      this.events.ballBounceSpeed = Math.max(this.events.ballBounceSpeed, game.ballBounceDeltaV);
    } else this.stats.resimTicks++;
    for (const d of game.demosThisTick) {
      // Re-simulation can produce the same demolition twice; a car cannot be demolished twice within a second.
      const seen = this.demoSeen.get(d.victim);
      if (seen !== undefined && Math.abs(game.tick - seen) < TICK_RATE) continue;
      this.demoSeen.set(d.victim, game.tick);
      this.events.demos.push({ ...d });
    }
  }

  // ---------------------------------------------------------------------------
  // Per frame
  // ---------------------------------------------------------------------------

  update(frameDt: number): void {
    const now = performance.now();
    this.events.demos.length = 0;
    this.events.ballHitSpeed = 0;
    this.events.ballBounceSpeed = 0;
    if (now - this.lastPingSent > PING_INTERVAL_MS) {
      this.lastPingSent = now;
      this.link.sendFast(encodePing(now));
    }
    const game = this.game;
    if (!game || !this.synced) return;

    // Where the host is now: newest snapshot + its age + the trip it took to get here, bounded.
    const ahead = Math.min(MAX_EXTRAPOLATE_TICKS, ((now - this.latestAt) + this.oneWayMs) * TICK_RATE / 1000);
    const target = this.lastSnapshotTick + ahead;
    this.renderTick += frameDt * TICK_RATE;
    const drift = target - this.renderTick;
    if (Math.abs(drift) > CLOCK_SNAP_TICKS) {
      this.renderTick = target;
      this.stats.clockSnaps++;
    } else this.renderTick += drift * Math.min(1, frameDt * 8);
    this.renderTick = Math.min(this.renderTick, this.lastSnapshotTick + MAX_EXTRAPOLATE_TICKS);

    let steps = 0;
    while (game.tick < Math.ceil(this.renderTick) && steps++ < MAX_STEPS_PER_FRAME) this.step(game, true);
    if (game.tick < Math.ceil(this.renderTick)) this.renderTick = game.tick;
    this.alpha = Math.max(0, Math.min(1, 1 - (game.tick - this.renderTick)));
    this.stats.extrapolatedTicks = game.tick - this.lastSnapshotTick;

    const k = Math.exp(-SMOOTH_RATE * frameDt);
    for (const offset of this.carOffsets.values()) {
      offset.pos.multiplyScalar(k);
      offset.quat.slerp(identityQ, 1 - k);
    }
    this.ballOffsetVec.multiplyScalar(k);
  }

  carRenderStates(): CarRenderState[] {
    const game = this.game;
    if (!game || !this.synced) return [];
    const out: CarRenderState[] = [];
    for (const id of game.cars.keys()) {
      const player = this.players.find((p) => p.slot === id);
      const s = liveCarState(game, id, this.alpha, player?.name ?? '', clampBody(player?.body));
      if (!s) continue;
      const offset = this.carOffsets.get(id);
      if (offset) { s.offsetPos = offset.pos; s.offsetQuat = offset.quat; }
      out.push(s);
    }
    return out;
  }

  ballOffset(): Vector3 {
    return this.ballOffsetVec;
  }

  leave(): void {
    this.end('You stopped watching');
  }

  private end(reason: string): void {
    if (this.ended) return;
    this.ended = true;
    this.admitted?.(reason);
    this.admitted = null;
    this.inMatch = false;
    this.synced = false;
    this.link.close();
    this.game?.destroy();
    this.game = null;
    try {
      this.peer?.destroy();
    } catch {
      /* ignore */
    }
    this.onEnded?.(reason);
  }
}
