/**
 * A client of a hosted room. Runs its own copy of the Game a few ticks ahead of the host so the
 * player's car and the ball respond instantly; every host snapshot is checked against what was
 * predicted for that tick and, when they disagree, the game is rewound to the snapshot and the
 * unacknowledged inputs replayed. Other cars are drawn from the snapshots themselves, a few ticks
 * in the past, interpolated.
 */
import type { Peer } from 'peerjs';
import { Quaternion, Vector3 } from 'three';
import type { Team } from '../sim/car';
import { CAR_FLAG_BOOSTING, CAR_FLAG_DEMOED, CAR_FLAG_SUPERSONIC } from '../sim/car';
import { Game, type BodyState, type GameConfig, type GameState } from '../sim/game';
import { TICK_DT, TICK_RATE } from '../sim/rl';
import { ByteReader, quantizeInput } from '../sim/state';
import { EMPTY_INPUT, type CarInput } from '../input/types';
import { DEFAULT_MATCH_SETTINGS, PROTOCOL_VERSION, Packet, clampBody, encodeInputs, encodePing, type CtrlMsg, type LobbyPlayer, type MatchSettings } from './protocol';
import { joinRoom, type Link } from './transport';
import { liveCarState, type CarRenderState, type LobbyState, type Session } from './session';

/** How many ticks of input the host should have in hand when it simulates a tick. */
const TARGET_LEAD = 3;
/** Beyond this disagreement in lead we jump the clock instead of nudging it. */
const HARD_RESYNC_TICKS = 40;
/** Remote cars are drawn this many ticks behind the newest snapshot so there is always a next sample. */
const INTERP_DELAY_TICKS = 4;
/** Extrapolate a remote car at most this far past its last sample. */
const MAX_EXTRAPOLATE_TICKS = 12;
/** Corrections larger than this snap instead of being smoothed (m). */
const MAX_SMOOTH_DISTANCE = 2.5;
/** Smoothing decay rate (1/s). */
const SMOOTH_RATE = 12;
const PING_INTERVAL_MS = 500;
/** Tolerances for "my prediction matched the host". */
const POS_TOL = 0.03;
const VEL_TOL = 0.2;
const QUAT_TOL = 0.9995;

interface RemoteSample {
  tick: number;
  body: BodyState;
  vel: { x: number; y: number; z: number };
  steer: number;
  boosting: boolean;
  supersonic: boolean;
  demoed: boolean;
}

interface RemoteBuffer {
  team: Team;
  samples: RemoteSample[];
}

const tmpQ = new Quaternion();
const tmpQ2 = new Quaternion();
const identityQ = new Quaternion();

export class ClientSession implements Session {
  readonly kind = 'client';
  game: Game | null = null;
  localId = -1;
  alpha = 0;
  ping: number | null = null;
  onLobbyChanged: (() => void) | null = null;
  onMatchStarted: (() => void) | null = null;
  onEnded: ((reason: string) => void) | null = null;

  /** Debug counters. */
  readonly stats = { snapshots: 0, replays: 0, replayTicks: 0, catchUps: 0, catchUpTicks: 0, resyncLead: 0, resyncBehind: 0 };

  private players: LobbyPlayer[] = [];
  private settings: MatchSettings = { ...DEFAULT_MATCH_SETTINGS };
  private inMatch = false;
  private status = 'Connecting…';
  private synced = false;
  private startingGame = false;
  private ended = false;

  private readonly pending = new Map<number, CarInput>();
  private lastLocalInput: CarInput = EMPTY_INPUT;
  private ackedInputTick = -1;
  private readonly history = new Map<number, Float32Array>();
  private accumulator = 0;
  private timeScale = 1;
  private lastSnapshotTick = -1;
  private leadErrorStreak = 0;
  private latestSnapTick = 0;
  private latestSnapAt = 0;
  private readonly remote = new Map<number, RemoteBuffer>();
  private remoteRenderTick = 0;
  private lastPingSent = 0;
  private readonly rttSamples: number[] = [];

  private readonly smoothCarPos = new Vector3();
  private readonly smoothCarQuat = new Quaternion();
  private readonly smoothBallPos = new Vector3();
  private readonly inputs = new Map<number, CarInput>();

  private constructor(
    private readonly peer: Peer,
    private readonly link: Link,
    readonly code: string,
  ) {
    link.onCtrl = (msg) => this.onCtrl(msg);
    link.onFast = (buf) => this.onPacket(buf);
    link.onClose = () => this.end('Disconnected from the host');
    peer.on('error', (err) => {
      const type = (err as { type?: string }).type;
      if (type === 'peer-unavailable' || type === 'webrtc' || type === 'network') return;
      this.end(`Connection error: ${err.message}`);
    });
  }

  /** Connect, say hello, wait to be admitted. */
  static async create(code: string, name: string, dodgeDeadzone: number, body: number): Promise<ClientSession> {
    const { peer, link } = await joinRoom(code);
    const session = new ClientSession(peer, link, code);
    session.dodgeDeadzone = dodgeDeadzone;
    session.body = body;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        session.leave();
        reject(new Error('The host did not answer'));
      }, 10000);
      session.admitted = (err) => {
        clearTimeout(timer);
        if (err) reject(new Error(err));
        else resolve();
      };
      link.sendCtrl({ t: 'hello', name, version: PROTOCOL_VERSION, dodgeDeadzone, body });
    });
    return session;
  }

  private admitted: ((err: string | null) => void) | null = null;
  private dodgeDeadzone = 0.5;
  private body = 0;

  /** Change own car body; the host echoes it to everyone in the next lobby update. */
  setBody(body: number): void {
    if (body === this.body) return;
    this.body = body;
    this.link.sendCtrl({ t: 'body', body });
  }

  get lobby(): LobbyState {
    return {
      code: this.code,
      players: this.players,
      mySlot: this.localId,
      isHost: false,
      settings: this.settings,
      inMatch: this.inMatch,
      status: this.status,
    };
  }

  requestTeam(team: Team): void {
    this.link.sendCtrl({ t: 'team', team });
  }

  // ---------------------------------------------------------------------------
  // Control channel
  // ---------------------------------------------------------------------------

  private onCtrl(msg: CtrlMsg): void {
    switch (msg.t) {
      case 'welcome':
        this.localId = msg.slot;
        this.status = `In room ${this.code}`;
        this.admitted?.(null);
        this.admitted = null;
        break;
      case 'reject':
        this.admitted?.(msg.reason);
        this.admitted = null;
        this.end(msg.reason);
        break;
      case 'lobby':
        this.players = msg.players;
        this.settings = msg.settings;
        this.onLobbyChanged?.();
        break;
      case 'start':
        void this.startGame(msg.config);
        break;
      case 'end':
        this.inMatch = false;
        this.synced = false;
        this.game?.destroy();
        this.game = null;
        this.remote.clear();
        this.onLobbyChanged?.();
        break;
      default:
        break;
    }
  }

  private async startGame(config: GameConfig): Promise<void> {
    if (this.startingGame) return;
    this.startingGame = true;
    const game = await Game.create(config);
    this.startingGame = false;
    if (this.ended) {
      game.destroy();
      return;
    }
    game.setDodgeDeadzone(this.localId, this.dodgeDeadzone);
    this.game?.destroy();
    this.game = game;
    this.synced = false;
    this.inMatch = true;
    this.pending.clear();
    this.history.clear();
    this.remote.clear();
    this.lastSnapshotTick = -1;
    this.timeScale = 1;
    this.status = 'Waiting for the first snapshot…';
    this.onLobbyChanged?.();
    this.onMatchStarted?.();
  }

  // ---------------------------------------------------------------------------
  // Per frame
  // ---------------------------------------------------------------------------

  update(input: CarInput, frameDt: number, menuOpen: boolean): void {
    const now = performance.now();
    if (now - this.lastPingSent > PING_INTERVAL_MS) {
      this.lastPingSent = now;
      this.link.sendFast(encodePing(now));
    }

    const game = this.game;
    if (!game || !this.synced) return;

    // Behind the menu the car coasts with neutral input, but the simulation keeps up with the host.
    const q = quantizeInput(menuOpen ? EMPTY_INPUT : input);
    this.accumulator += frameDt * this.timeScale;
    let steps = 0;
    while (this.accumulator >= TICK_DT && steps < 12) {
      this.pending.set(game.tick, q);
      this.lastLocalInput = q;
      this.inputs.clear();
      this.inputs.set(this.localId, q);
      game.step(this.inputs, TICK_DT);
      this.recordHistory(game.tick);
      this.accumulator -= TICK_DT;
      steps++;
    }
    if (steps === 12) this.accumulator = 0;
    this.alpha = Math.min(1, this.accumulator / TICK_DT);
    this.sendInputs();

    // Remote cars: advance the playback clock, nudging it toward "newest snapshot minus delay".
    const sinceSnap = (now - this.latestSnapAt) / 1000;
    const target = this.latestSnapTick + sinceSnap * TICK_RATE - INTERP_DELAY_TICKS;
    this.remoteRenderTick += frameDt * TICK_RATE;
    const drift = target - this.remoteRenderTick;
    if (Math.abs(drift) > 30) this.remoteRenderTick = target;
    else this.remoteRenderTick += drift * Math.min(1, frameDt * 2);

    // Let visual corrections fade.
    const k = Math.exp(-SMOOTH_RATE * frameDt);
    this.smoothCarPos.multiplyScalar(k);
    this.smoothBallPos.multiplyScalar(k);
    this.smoothCarQuat.slerp(identityQ, 1 - k);
  }

  private sendInputs(): void {
    const game = this.game;
    if (!game) return;
    const ticks = [...this.pending.keys()].filter((t) => t > this.ackedInputTick).sort((a, b) => a - b);
    if (ticks.length === 0) return;
    // Consecutive by construction; send the newest run (at most 32).
    const start = Math.max(0, ticks.length - 32);
    const firstTick = ticks[start];
    const list: CarInput[] = [];
    for (let i = start; i < ticks.length; i++) {
      if (ticks[i] !== firstTick + list.length) break;
      list.push(this.pending.get(ticks[i])!);
    }
    this.link.sendFast(encodeInputs(firstTick, list));
  }

  private recordHistory(tick: number): void {
    const game = this.game!;
    const car = game.cars.get(this.localId);
    if (!car) return;
    const t = car.body.translation();
    const r = car.body.rotation();
    const v = car.body.linvel();
    const bt = game.ball.translation();
    const bv = game.ball.linvel();
    this.history.set(tick, new Float32Array([t.x, t.y, t.z, r.x, r.y, r.z, r.w, v.x, v.y, v.z, car.boost, bt.x, bt.y, bt.z, bv.x, bv.y, bv.z]));
  }

  // ---------------------------------------------------------------------------
  // Fast channel
  // ---------------------------------------------------------------------------

  private onPacket(buf: ArrayBuffer): void {
    if (buf.byteLength < 1) return;
    const r = new ByteReader(buf);
    const type = r.u8();
    if (type === Packet.Pong) {
      const sent = r.u32();
      const rtt = (performance.now() >>> 0) - sent;
      if (rtt >= 0 && rtt < 5000) {
        this.rttSamples.push(rtt);
        if (this.rttSamples.length > 8) this.rttSamples.shift();
        const sorted = [...this.rttSamples].sort((a, b) => a - b);
        this.ping = sorted[Math.floor(sorted.length / 2)];
      }
    } else if (type === Packet.Snapshot) {
      const lastInputTick = r.i32();
      r.u32(); // host time, unused for now
      const state = Game.decode(r);
      this.onSnapshot(state, lastInputTick);
    }
  }

  private onSnapshot(state: GameState, lastInputTick: number): void {
    if (state.tick <= this.lastSnapshotTick) return; // stale or out of order
    this.stats.snapshots++;
    this.lastSnapshotTick = state.tick;
    this.latestSnapTick = state.tick;
    this.latestSnapAt = performance.now();
    if (lastInputTick > this.ackedInputTick) this.ackedInputTick = lastInputTick;
    this.storeRemoteSamples(state);

    const game = this.game;
    if (!game) return;

    if (!this.synced) {
      this.resync(state, 'initial');
      return;
    }

    // Clock control: keep the host holding TARGET_LEAD ticks of my input. A wildly wrong lead
    // that persists for a while (about half a second of snapshots) means the clocks have
    // drifted apart for good and we jump; a brief one is just a late frame and nudging suffices.
    if (lastInputTick >= 0) {
      const lead = lastInputTick - state.tick;
      const err = TARGET_LEAD - lead;
      if (Math.abs(err) > HARD_RESYNC_TICKS) {
        if (++this.leadErrorStreak > 30) {
          this.leadErrorStreak = 0;
          this.resync(state, 'lead');
          return;
        }
      } else this.leadErrorStreak = 0;
      this.timeScale = Math.max(0.9, Math.min(1.15, 1 + 0.02 * err));
    }

    if (state.tick > game.tick) {
      // The host got ahead of our frame loop (a late frame). Simulate the missing ticks now with the
      // input we would have used, taking the time out of the accumulator, then reconcile normally.
      const gap = state.tick - game.tick;
      if (gap > HARD_RESYNC_TICKS) {
        this.resync(state, 'behind');
        return;
      }
      const q = this.lastLocalInput;
      while (game.tick < state.tick) {
        this.pending.set(game.tick, q);
        this.inputs.clear();
        this.inputs.set(this.localId, q);
        game.step(this.inputs, TICK_DT);
        this.recordHistory(game.tick);
      }
      this.accumulator = Math.max(0, this.accumulator - gap * TICK_DT);
      this.stats.catchUps++;
      this.stats.catchUpTicks += gap;
      this.sendInputs(); // do not wait for the next frame: the host is already asking for these
    }

    const local = state.cars.find((c) => c.id === this.localId);
    const h = this.history.get(state.tick);
    const agrees = !!local && !!h && this.matches(h, local.state, state.ball);

    if (agrees) {
      // Physics matched at that tick: keep the prediction, take everything else from the host.
      game.applyMetaState(state);
      const leadTicks = game.tick - state.tick;
      const seen = new Set<number>();
      for (const c of state.cars) {
        seen.add(c.id);
        if (c.id === this.localId) {
          const car = game.cars.get(c.id);
          if (car) car.boost = c.state.boost;
          continue;
        }
        const car = game.addCar(c.id, c.team);
        car.setFrozen(false);
        car.applyState(c.state);
        // Carry the remote car forward to our time along its velocity so ball contacts line up better.
        const p = c.state.pos;
        const v = c.state.vel;
        const dt = leadTicks * TICK_DT;
        car.body.setTranslation({ x: p.x + v.x * dt, y: p.y + v.y * dt, z: p.z + v.z * dt }, true);
        car.setFrozen(game.phase === 'countdown');
      }
      for (const id of [...game.cars.keys()]) if (!seen.has(id)) game.removeCar(id);
    } else {
      this.stats.replays++;
      const oldTick = game.tick;
      const oldCar = game.curr.cars.get(this.localId);
      const oldCarCopy = oldCar ? { ...oldCar } : null;
      const oldBall = { ...game.curr.ball };
      const ballWasVisible = game.ballVisible;

      game.applyState(state);
      for (let t = state.tick; t < oldTick; t++) {
        this.inputs.clear();
        this.inputs.set(this.localId, this.pending.get(t) ?? this.lastLocalInput);
        game.step(this.inputs, TICK_DT);
        this.recordHistory(game.tick);
        this.stats.replayTicks++;
      }

      // Fold the correction into a visual offset that fades, unless it is a teleport.
      const newCar = game.curr.cars.get(this.localId);
      if (oldCarCopy && newCar) {
        const dx = oldCarCopy.px - newCar.px;
        const dy = oldCarCopy.py - newCar.py;
        const dz = oldCarCopy.pz - newCar.pz;
        if (Math.hypot(dx, dy, dz) < MAX_SMOOTH_DISTANCE) {
          this.smoothCarPos.x += dx;
          this.smoothCarPos.y += dy;
          this.smoothCarPos.z += dz;
          tmpQ.set(oldCarCopy.qx, oldCarCopy.qy, oldCarCopy.qz, oldCarCopy.qw);
          tmpQ2.set(newCar.qx, newCar.qy, newCar.qz, newCar.qw).invert();
          tmpQ.multiply(tmpQ2); // old * new⁻¹ takes the new orientation back to the old one
          this.smoothCarQuat.premultiply(tmpQ);
        } else {
          this.smoothCarPos.set(0, 0, 0);
          this.smoothCarQuat.identity();
        }
      }
      const nb = game.curr.ball;
      if (ballWasVisible && game.ballVisible) {
        const dx = oldBall.px - nb.px;
        const dy = oldBall.py - nb.py;
        const dz = oldBall.pz - nb.pz;
        if (Math.hypot(dx, dy, dz) < MAX_SMOOTH_DISTANCE) {
          this.smoothBallPos.x += dx;
          this.smoothBallPos.y += dy;
          this.smoothBallPos.z += dz;
        } else this.smoothBallPos.set(0, 0, 0);
      } else this.smoothBallPos.set(0, 0, 0);
    }

    for (const t of this.pending.keys()) if (t < state.tick) this.pending.delete(t);
    for (const t of this.history.keys()) if (t < state.tick) this.history.delete(t);
  }

  private matches(h: Float32Array, car: GameState['cars'][number]['state'], ball: GameState['ball']): boolean {
    const dp = Math.hypot(h[0] - car.pos.x, h[1] - car.pos.y, h[2] - car.pos.z);
    if (dp > POS_TOL) return false;
    const dv = Math.hypot(h[7] - car.vel.x, h[8] - car.vel.y, h[9] - car.vel.z);
    if (dv > VEL_TOL) return false;
    const qd = Math.abs(h[3] * car.rot.x + h[4] * car.rot.y + h[5] * car.rot.z + h[6] * car.rot.w);
    if (qd < QUAT_TOL) return false;
    const bp = Math.hypot(h[11] - ball.pos.x, h[12] - ball.pos.y, h[13] - ball.pos.z);
    if (bp > POS_TOL) return false;
    const bv = Math.hypot(h[14] - ball.vel.x, h[15] - ball.vel.y, h[16] - ball.vel.z);
    if (bv > VEL_TOL) return false;
    return true;
  }

  /** Adopt the snapshot outright and run ahead of it by half the round trip plus the target lead. */
  private resync(state: GameState, reason: 'initial' | 'lead' | 'behind'): void {
    const game = this.game!;
    if (reason === 'lead') this.stats.resyncLead++;
    if (reason === 'behind') this.stats.resyncBehind++;
    game.applyState(state);
    this.pending.clear();
    this.history.clear();
    const rttTicks = Math.ceil(((this.ping ?? 100) / 1000) * TICK_RATE);
    const target = state.tick + Math.ceil(rttTicks / 2) + TARGET_LEAD;
    const neutral = quantizeInput(EMPTY_INPUT);
    while (game.tick < target && game.tick < state.tick + 120) {
      this.pending.set(game.tick, neutral);
      this.inputs.clear();
      this.inputs.set(this.localId, neutral);
      game.step(this.inputs, TICK_DT);
    }
    this.recordHistory(game.tick);
    this.lastLocalInput = neutral;
    this.accumulator = 0;
    this.timeScale = 1;
    this.synced = true;
    this.status = `In room ${this.code}`;
    this.smoothCarPos.set(0, 0, 0);
    this.smoothCarQuat.identity();
    this.smoothBallPos.set(0, 0, 0);
    if (reason === 'initial') this.remoteRenderTick = state.tick - INTERP_DELAY_TICKS;
  }

  private storeRemoteSamples(state: GameState): void {
    const seen = new Set<number>();
    for (const c of state.cars) {
      if (c.id === this.localId) continue;
      seen.add(c.id);
      let buf = this.remote.get(c.id);
      if (!buf || buf.team !== c.team) {
        buf = { team: c.team, samples: [] };
        this.remote.set(c.id, buf);
      }
      const s = c.state;
      buf.samples.push({
        tick: state.tick,
        body: { px: s.pos.x, py: s.pos.y, pz: s.pos.z, qx: s.rot.x, qy: s.rot.y, qz: s.rot.z, qw: s.rot.w },
        vel: s.vel,
        steer: s.lastInput.steer,
        boosting: !!(s.flags & CAR_FLAG_BOOSTING),
        supersonic: !!(s.flags & CAR_FLAG_SUPERSONIC),
        demoed: !!(s.flags & CAR_FLAG_DEMOED),
      });
      if (buf.samples.length > 40) buf.samples.splice(0, buf.samples.length - 40);
    }
    for (const id of [...this.remote.keys()]) if (!seen.has(id)) this.remote.delete(id);
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  carRenderStates(): CarRenderState[] {
    const game = this.game;
    if (!game || !this.synced) return [];
    const out: CarRenderState[] = [];
    const mine = liveCarState(game, this.localId, this.alpha, this.nameOf(this.localId), this.body);
    if (mine) {
      mine.offsetPos = this.smoothCarPos;
      mine.offsetQuat = this.smoothCarQuat;
      out.push(mine);
    }
    const T = this.remoteRenderTick;
    for (const [id, buf] of this.remote) {
      const s = buf.samples;
      if (s.length === 0) continue;
      let a = s[0];
      let b = s[0];
      let alpha = 0;
      if (T <= s[0].tick) {
        a = b = s[0];
      } else if (T >= s[s.length - 1].tick) {
        // Past the newest sample: extrapolate along its velocity, capped.
        const last = s[s.length - 1];
        const dtTicks = Math.min(MAX_EXTRAPOLATE_TICKS, T - last.tick);
        const dt = dtTicks * TICK_DT;
        const ex: BodyState = { ...last.body, px: last.body.px + last.vel.x * dt, py: last.body.py + last.vel.y * dt, pz: last.body.pz + last.vel.z * dt };
        a = b = { ...last, body: ex };
        alpha = 1;
      } else {
        for (let i = 0; i < s.length - 1; i++) {
          if (T >= s[i].tick && T < s[i + 1].tick) {
            a = s[i];
            b = s[i + 1];
            alpha = (T - a.tick) / (b.tick - a.tick);
            break;
          }
        }
      }
      const q = b.body;
      const fwdX = -(2 * (q.qx * q.qz + q.qw * q.qy));
      const fwdZ = -(1 - 2 * (q.qx * q.qx + q.qy * q.qy));
      out.push({
        id,
        team: buf.team,
        name: this.nameOf(id),
        body: this.bodyOf(id),
        prev: a.body,
        curr: b.body,
        alpha,
        forwardSpeed: b.vel.x * fwdX + b.vel.z * fwdZ,
        steer: b.steer,
        boosting: b.boosting,
        supersonic: b.supersonic,
        demoed: b.demoed,
        offsetPos: null,
        offsetQuat: null,
        wheelY: null,
      });
      // Drop samples well behind the playback point.
      while (s.length > 2 && s[1].tick < T - 10) s.shift();
    }
    return out;
  }

  ballOffset(): Vector3 | null {
    return this.smoothBallPos;
  }

  private nameOf(id: number): string {
    return this.players.find((p) => p.slot === id)?.name ?? '';
  }

  private bodyOf(id: number): number {
    return clampBody(this.players.find((p) => p.slot === id)?.body);
  }

  resetMatch(): void {
    /* clients cannot reset; the host decides */
  }

  leave(): void {
    this.end('You left the room');
  }

  private end(reason: string): void {
    if (this.ended) return;
    this.ended = true;
    this.inMatch = false;
    this.synced = false;
    this.link.close();
    this.game?.destroy();
    this.game = null;
    try {
      this.peer.destroy();
    } catch {
      /* ignore */
    }
    this.onEnded?.(reason);
  }
}
