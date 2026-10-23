import RAPIER from '@dimforge/rapier3d-compat';
import { Quaternion, Vector3 } from 'three';
import { ARENA, BALL, BALL_CAR_EXTRA_IMPULSE, BOOST_PADS, CAR, DEMO, GRAVITY, KICKOFF_SPAWNS, TICK_DT, UU, curve } from './rl';
import { TUNING } from './tuning';
import { allColliderBoxes, buildArenaGeometry, type ArenaGeometry } from './arena';
import { Car, type CarState, type Team } from './car';
import { EMPTY_INPUT, type CarInput } from '../input/types';
import { ByteReader, ByteWriter, Rng } from './state';

export type { Team };

/** Plain-number transform so it can be copied, interpolated and sent over the wire. */
export interface BodyState {
  px: number;
  py: number;
  pz: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
}

/** Render-side view of one tick: transforms only. */
export interface Snapshot {
  tick: number;
  cars: Map<number, BodyState>;
  ball: BodyState;
}

export interface BoostPad {
  x: number;
  y: number;
  z: number;
  big: boolean;
  /** Seconds until the pad is available again; 0 = active. */
  cooldown: number;
}

export interface GameConfig {
  /** Visual venue only; absent on older hosts. Does not affect simulation. */
  arena?: number;
  /** Boost never runs out (free play). Pads still light up and recharge. */
  infiniteBoost: boolean;
  /** Seconds cars stay frozen at each kickoff. 0 = drive immediately. */
  countdown: number;
  /** Match length in seconds. 0 = unlimited. */
  matchSeconds: number;
  /** Seed for the kickoff shuffle so a restored client draws the same order. */
  seed: number;
}

export const FREE_PLAY_CONFIG: GameConfig = { infiniteBoost: true, countdown: 0, matchSeconds: 0, seed: 1 };

/**
 * countdown: cars and ball frozen at kickoff. play: normal. goal: ball gone, cars drive, kickoff
 * follows. over: match ended, cars may still drive, nothing counts.
 */
export type Phase = 'countdown' | 'play' | 'goal' | 'over';
const PHASES: Phase[] = ['countdown', 'play', 'goal', 'over'];

/** Decoded serialize() record; see Game.decode. */
export interface GameState {
  tick: number;
  phase: Phase;
  countdown: number;
  goalPause: number;
  timeRemaining: number;
  overtimeElapsed: number;
  overtime: boolean;
  score: Record<Team, number>;
  lastGoal: Team | null;
  lastGoalScorer: number;
  lastTouch: number;
  lastGoalSpeed: number;
  rngState: number;
  spawnOrder: number[];
  spawnCursor: number;
  currentSpawn: number;
  ball: {
    pos: { x: number; y: number; z: number };
    rot: { x: number; y: number; z: number; w: number };
    vel: { x: number; y: number; z: number };
    angVel: { x: number; y: number; z: number };
    frozen: boolean;
  };
  /** Cooldown seconds per pad, in Game.pads order. */
  pads: number[];
  cars: { id: number; team: Team; state: CarState }[];
}

export type GameMetaState = Omit<GameState, 'tick' | 'ball' | 'cars'>;

export function emptyState(): BodyState {
  return { px: 0, py: 0, pz: 0, qx: 0, qy: 0, qz: 0, qw: 1 };
}

function readBody(body: RAPIER.RigidBody, out: BodyState): void {
  const t = body.translation();
  const r = body.rotation();
  out.px = t.x;
  out.py = t.y;
  out.pz = t.z;
  out.qx = r.x;
  out.qy = r.y;
  out.qz = r.z;
  out.qw = r.w;
}

// Scratch vectors for the car-ball impulse.
const relVel = new Vector3();
const hitDir = new Vector3();
const carFwd = new Vector3();
const carRot = new Quaternion();

/** Pad cooldowns travel as 1/20 s so a snapshot stays small. */
const PAD_COOLDOWN_SCALE = 20;

/**
 * The whole match simulation: arena, any number of cars on two teams, one ball, boost pads,
 * kickoffs, goals, the clock. Deterministic, fixed-tick, no rendering concerns. Runs unchanged
 * as the authority in the host's tab and as the predictor in every client.
 */
export class Game {
  readonly world: RAPIER.World;
  readonly arena: ArenaGeometry;
  readonly cars = new Map<number, Car>();
  readonly ball: RAPIER.RigidBody;
  readonly ballCollider: RAPIER.Collider;
  readonly pads: BoostPad[];
  readonly config: GameConfig;

  tick = 0;
  phase: Phase = 'play';
  score: Record<Team, number> = { blue: 0, orange: 0 };
  lastGoal: Team | null = null;
  /** Car that scored the last goal (last to touch the ball), -1 if unknown. */
  lastGoalScorer = -1;
  /** Last car to touch the ball, -1 if none since kickoff. */
  lastTouch = -1;
  /** Seconds left in the kickoff countdown. */
  countdown = 0;
  /** Seconds until the ball respawns after a goal. The ball is hidden meanwhile; cars keep driving. */
  goalPause = 0;
  /** Seconds left on the match clock (matchSeconds > 0 only). */
  timeRemaining = 0;
  overtime = false;
  overtimeElapsed = 0;
  /** Ball speed (m/s) at the moment of the last goal. */
  lastGoalSpeed = 0;
  /** True on ticks where any car touched the ball. */
  ballTouched = false;
  /** Largest relative car-ball speed (m/s) among touches this tick, else 0. */
  ballHitRelSpeed = 0;
  /** Demolitions this tick, for effects and sound: who was demolished, where, and by whom. */
  readonly demosThisTick: { victim: number; attacker: number; x: number; y: number; z: number }[] = [];
  /** Car-car bumps this tick, for effects: impact speed in m/s at the contact point. */
  readonly bumpsThisTick: { a: number; b: number; speed: number; x: number; y: number; z: number }[] = [];
  /** Magnitude of the ball's velocity change (m/s) this tick when no car touched it (arena bounce), else 0. */
  ballBounceDeltaV = 0;
  /** Index into KICKOFF_SPAWNS used by the first blue car at the current kickoff. */
  currentSpawn = 4;

  readonly prev: Snapshot = { tick: 0, cars: new Map(), ball: emptyState() };
  readonly curr: Snapshot = { tick: 0, cars: new Map(), ball: emptyState() };

  private readonly rng: Rng;
  /** Player setting per car id, applied whenever that car is (re)created. */
  private readonly dodgeDeadzones = new Map<number, number>();
  private readonly ballVelBefore = { x: 0, y: 0, z: 0 };
  private readonly ballPosBefore = { x: 0, y: 0, z: 0 };
  private spawnOrder: number[] = [];
  private spawnCursor = 0;
  private ballFrozen = false;

  static async create(config: GameConfig = FREE_PLAY_CONFIG): Promise<Game> {
    await RAPIER.init();
    return new Game(config);
  }

  private constructor(config: GameConfig) {
    this.config = { ...config };
    this.rng = new Rng(config.seed);
    this.world = new RAPIER.World({ x: 0, y: -GRAVITY, z: 0 });
    this.world.timestep = TICK_DT;
    this.arena = buildArenaGeometry();
    this.buildArenaColliders();
    [this.ball, this.ballCollider] = this.buildBall();
    this.pads = buildPads();
    this.timeRemaining = config.matchSeconds;
    this.resetKickoff();
    this.capture(this.curr);
    this.copySnapshot(this.curr, this.prev);
  }

  get ballVisible(): boolean {
    return this.phase !== 'goal';
  }

  /** Match clock as RL shows it: remaining time, or overtime elapsed counting up. */
  get clockSeconds(): number {
    return this.overtime ? this.overtimeElapsed : this.timeRemaining;
  }

  // ---------------------------------------------------------------------------
  // Cars
  // ---------------------------------------------------------------------------

  addCar(id: number, team: Team): Car {
    const existing = this.cars.get(id);
    if (existing) {
      if (existing.team === team) return existing;
      this.removeCar(id);
    }
    const car = new Car(this.world, { id, team, infiniteBoost: this.config.infiniteBoost });
    const dz = this.dodgeDeadzones.get(id);
    if (dz !== undefined) car.dodgeDeadzone = dz;
    this.cars.set(id, car);
    this.placeAtSpawn(car);
    if (this.phase === 'countdown') car.setFrozen(true);
    this.prev.cars.set(id, emptyState());
    this.curr.cars.set(id, emptyState());
    readBody(car.body, this.prev.cars.get(id)!);
    readBody(car.body, this.curr.cars.get(id)!);
    return car;
  }

  /** RL's dodge deadzone is a player setting; the host applies each client's value to that client's car. */
  setDodgeDeadzone(id: number, value: number): void {
    this.dodgeDeadzones.set(id, value);
    const car = this.cars.get(id);
    if (car) car.dodgeDeadzone = value;
  }

  removeCar(id: number): void {
    const car = this.cars.get(id);
    if (!car) return;
    car.destroy();
    this.cars.delete(id);
    this.prev.cars.delete(id);
    this.curr.cars.delete(id);
  }

  /** Free play convenience: the only car. */
  get car(): Car {
    return this.cars.values().next().value as Car;
  }

  // ---------------------------------------------------------------------------
  // Stepping
  // ---------------------------------------------------------------------------

  /**
   * Advance one tick. `inputs` gives each car's input for this tick; a missing entry repeats the
   * car's previous input (what the host does when a client's packet is late).
   */
  step(inputs: ReadonlyMap<number, CarInput> | CarInput, dt: number = TICK_DT): void {
    this.copySnapshot(this.curr, this.prev);

    this.updatePhase(dt);
    const frozen = this.phase === 'countdown';

    // Pre-step ball state, used by the car-ball extra impulse like RocketSim's contact callback
    // (which runs before the solver) and by the bounce detector.
    const bv0 = this.ball.linvel();
    this.ballVelBefore.x = bv0.x;
    this.ballVelBefore.y = bv0.y;
    this.ballVelBefore.z = bv0.z;
    const bp0 = this.ball.translation();
    this.ballPosBefore.x = bp0.x;
    this.ballPosBefore.y = bp0.y;
    this.ballPosBefore.z = bp0.z;

    for (const car of this.cars.values()) {
      const input = inputs instanceof Map ? (inputs.get(car.id) ?? car.lastInput) : (inputs as CarInput);
      if (car.demoed) {
        // Demolished: not simulated at all, just counting down to the respawn.
        car.lastInput = input;
        car.demoTimer -= dt;
        if (car.demoTimer <= 0) this.respawnCar(car);
        continue;
      }
      if (frozen) {
        car.lastInput = input;
        continue;
      }
      car.tick(input, dt);
    }

    this.world.step();
    if (!frozen) for (const car of this.cars.values()) if (!car.demoed) car.postStep();
    this.tick++;

    this.demosThisTick.length = 0;
    this.bumpsThisTick.length = 0;
    if (!frozen) this.resolveCarContacts();

    this.updatePads(dt);
    this.ballHitRelSpeed = 0;
    this.ballBounceDeltaV = 0;
    this.ballTouched = false;
    if (this.phase === 'play' || this.phase === 'over') {
      for (const car of this.cars.values()) if (!car.demoed) this.applyCarBallExtraImpulse(car);
      this.clampBall();
      if (!this.ballTouched) {
        const bv1 = this.ball.linvel();
        // Gravity alone changes vy by g*dt; anything well beyond that is a bounce.
        const dv = Math.hypot(bv1.x - this.ballVelBefore.x, bv1.y - this.ballVelBefore.y + GRAVITY * dt, bv1.z - this.ballVelBefore.z);
        if (dv > 1.0) this.ballBounceDeltaV = dv;
      }
    }
    this.capture(this.curr);

    if (this.phase === 'play') this.checkGoal();
  }

  private updatePhase(dt: number): void {
    switch (this.phase) {
      case 'countdown':
        this.countdown -= dt;
        if (this.countdown <= 0) {
          this.countdown = 0;
          this.setFrozen(false);
          this.phase = 'play';
        }
        break;
      case 'goal':
        this.goalPause -= dt;
        if (this.goalPause <= 0) {
          this.goalPause = 0;
          if (this.timedOut() && this.score.blue !== this.score.orange) this.phase = 'over';
          else this.resetKickoff();
        }
        break;
      case 'play':
        if (this.config.matchSeconds > 0) {
          if (this.overtime) this.overtimeElapsed += dt;
          else if (this.timeRemaining > 0) this.timeRemaining = Math.max(0, this.timeRemaining - dt);
          else if (this.ballOnGround()) {
            // Time is up and the ball touched the floor: decide, or go to overtime with a kickoff.
            if (this.score.blue !== this.score.orange) this.phase = 'over';
            else {
              this.overtime = true;
              this.resetKickoff();
            }
          }
        }
        break;
      case 'over':
        break;
    }
  }

  private timedOut(): boolean {
    return this.config.matchSeconds > 0 && (this.overtime || this.timeRemaining <= 0);
  }

  private ballOnGround(): boolean {
    return this.ball.translation().y <= BALL.restZ + 0.05;
  }

  // ---------------------------------------------------------------------------
  // Kickoff and match flow
  // ---------------------------------------------------------------------------

  /**
   * [RS] Arena::ResetToRandomKickoff: one shuffle of the five spawn indices per kickoff; the i-th
   * blue car takes spawn order[i], the i-th orange car the mirrored one. Here the shuffle is drawn
   * once per cycle so a lone car visits all five before repeating.
   */
  resetKickoff(): void {
    if (this.spawnCursor >= this.spawnOrder.length) this.reshuffleSpawns();
    this.currentSpawn = this.spawnOrder[this.spawnCursor++];
    let blue = 0;
    let orange = 0;
    for (const car of [...this.cars.values()].sort((a, b) => a.id - b.id)) {
      car.setDemoed(false);
      car.demoTimer = 0;
      const slot = car.team === 'blue' ? blue++ : orange++;
      this.placeCar(car, (this.currentSpawn + slot) % KICKOFF_SPAWNS.length);
    }
    this.goalPause = 0;
    this.lastTouch = -1;
    this.respawnBall();
    for (const p of this.pads) p.cooldown = 0;
    if (this.config.countdown > 0) {
      this.phase = 'countdown';
      this.countdown = this.config.countdown;
      this.setFrozen(true);
    } else {
      this.phase = 'play';
      this.setFrozen(false);
    }
  }

  /** A car joining mid-match appears at its team's next free kickoff spot. */
  private placeAtSpawn(car: Car): void {
    let n = 0;
    for (const c of this.cars.values()) if (c !== car && c.team === car.team) n++;
    const preferred = (this.currentSpawn + n) % KICKOFF_SPAWNS.length;
    const mirror = car.team === 'orange' ? -1 : 1;
    let safest = preferred;
    let bestClearance = -1;
    for (let offset = 0; offset < KICKOFF_SPAWNS.length; offset++) {
      const index = (preferred + offset) % KICKOFF_SPAWNS.length;
      const [sx, sz] = KICKOFF_SPAWNS[index];
      let clearance = Infinity;
      for (const other of this.cars.values()) {
        if (other === car || other.demoed) continue;
        const p = other.body.translation();
        clearance = Math.min(clearance, (p.x - sx * UU * mirror) ** 2 + (p.z - sz * UU * mirror) ** 2);
      }
      // Three metres leaves room for either car's orientation and suspension settling.
      if (clearance >= 9) { safest = index; break; }
      if (clearance > bestClearance) { bestClearance = clearance; safest = index; }
    }
    this.placeCar(car, safest);
  }

  private placeCar(car: Car, spawnIndex: number): void {
    const [sx, sy, yawRL] = KICKOFF_SPAWNS[spawnIndex];
    const mirror = car.team === 'orange' ? -1 : 1;
    // RL yaw is measured from +x toward +y (our +z). Our car faces -Z at yaw 0 and a rotation ψ
    // about +Y sends (0,0,-1) to (-sin ψ, 0, -cos ψ), so solve for the RL heading (cos θ, sin θ).
    const heading = yawRL + (mirror < 0 ? Math.PI : 0);
    const yaw = Math.atan2(-Math.cos(heading), -Math.sin(heading));
    car.setFrozen(false);
    car.reset(sx * UU * mirror, sy * UU * mirror, yaw);
  }

  private setFrozen(frozen: boolean): void {
    for (const car of this.cars.values()) car.setFrozen(frozen);
    this.freezeBall(frozen);
  }

  private freezeBall(frozen: boolean): void {
    this.ballFrozen = frozen;
    const type = frozen ? RAPIER.RigidBodyType.Fixed : RAPIER.RigidBodyType.Dynamic;
    if (this.ball.bodyType() !== type) this.ball.setBodyType(type, true);
  }

  /** Ball back to the centre spot, at rest, dynamic and visible. */
  private respawnBall(): void {
    this.freezeBall(false);
    this.ball.setTranslation({ x: 0, y: BALL.restZ, z: 0 }, true);
    this.ball.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
    this.ball.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.ball.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }

  /** Full reset including score and clock. */
  resetMatch(): void {
    this.score = { blue: 0, orange: 0 };
    this.lastGoal = null;
    this.lastGoalScorer = -1;
    this.goalPause = 0;
    this.timeRemaining = this.config.matchSeconds;
    this.overtime = false;
    this.overtimeElapsed = 0;
    this.resetKickoff();
  }

  private reshuffleSpawns(): void {
    const previous = this.spawnOrder;
    let next: number[];
    let guard = 0;
    do {
      next = KICKOFF_SPAWNS.map((_, i) => i);
      for (let i = next.length - 1; i > 0; i--) {
        const j = Math.floor(this.rng.next() * (i + 1));
        [next[i], next[j]] = [next[j], next[i]];
      }
    } while (previous.length > 0 && next.every((v, i) => v === previous[i]) && guard++ < 8);
    this.spawnOrder = next;
    this.spawnCursor = 0;
  }

  private capture(into: Snapshot): void {
    into.tick = this.tick;
    for (const car of this.cars.values()) {
      let s = into.cars.get(car.id);
      if (!s) {
        s = emptyState();
        into.cars.set(car.id, s);
      }
      readBody(car.body, s);
    }
    for (const id of into.cars.keys()) if (!this.cars.has(id)) into.cars.delete(id);
    readBody(this.ball, into.ball);
  }

  private copySnapshot(from: Snapshot, to: Snapshot): void {
    to.tick = from.tick;
    for (const [id, s] of from.cars) {
      let d = to.cars.get(id);
      if (!d) {
        d = emptyState();
        to.cars.set(id, d);
      }
      Object.assign(d, s);
    }
    for (const id of to.cars.keys()) if (!from.cars.has(id)) to.cars.delete(id);
    Object.assign(to.ball, from.ball);
  }

  private checkGoal(): void {
    const z = this.curr.ball.pz;
    const line = ARENA.goalScoreThresholdY + BALL.radius;
    if (z > line) this.onGoal('blue');
    else if (z < -line) this.onGoal('orange');
  }

  private onGoal(team: Team): void {
    this.score[team]++;
    this.lastGoal = team;
    this.lastGoalScorer = this.lastTouch;
    this.phase = 'goal';
    this.goalPause = TUNING.goalResetDelay;
    const v = this.ball.linvel();
    this.lastGoalSpeed = Math.hypot(v.x, v.y, v.z);
    // RL explodes the ball; we park it out of play (fixed, under the floor) and hide it until it respawns.
    this.ball.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.ball.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.freezeBall(true);
    this.ball.setTranslation({ x: 0, y: -50, z: 0 }, true);
  }

  // ---------------------------------------------------------------------------
  // Serialisation: the complete state, enough to continue the simulation elsewhere
  // ---------------------------------------------------------------------------

  serialize(w: ByteWriter): void {
    w.u32(this.tick);
    w.u8(PHASES.indexOf(this.phase));
    w.f32(this.countdown);
    w.f32(this.goalPause);
    w.f32(this.timeRemaining);
    w.f32(this.overtimeElapsed);
    w.bool(this.overtime);
    w.u8(this.score.blue);
    w.u8(this.score.orange);
    w.i8(this.lastGoal === null ? -1 : this.lastGoal === 'blue' ? 0 : 1);
    w.i8(this.lastGoalScorer);
    w.i8(this.lastTouch);
    w.f32(this.lastGoalSpeed);
    w.u32(this.rng.state >>> 0);
    for (let i = 0; i < KICKOFF_SPAWNS.length; i++) w.u8(this.spawnOrder[i] ?? 0);
    w.u8(this.spawnOrder.length);
    w.u8(this.spawnCursor);
    w.u8(this.currentSpawn);
    // Ball.
    const t = this.ball.translation();
    const r = this.ball.rotation();
    const lv = this.ball.linvel();
    const av = this.ball.angvel();
    w.f32(t.x);
    w.f32(t.y);
    w.f32(t.z);
    w.f32(r.x);
    w.f32(r.y);
    w.f32(r.z);
    w.f32(r.w);
    w.f32(lv.x);
    w.f32(lv.y);
    w.f32(lv.z);
    w.f32(av.x);
    w.f32(av.y);
    w.f32(av.z);
    w.bool(this.ballFrozen);
    // Pads.
    for (const p of this.pads) w.u8(Math.min(255, Math.round(p.cooldown * PAD_COOLDOWN_SCALE)));
    // Cars.
    w.u8(this.cars.size);
    for (const car of this.cars.values()) {
      w.u8(car.id);
      w.u8(car.team === 'blue' ? 0 : 1);
      car.serialize(w);
    }
  }

  /** Decode a serialize() record into a plain object. Mirrors serialize() field for field. */
  static decode(r: ByteReader): GameState {
    const tick = r.u32();
    const phase = PHASES[r.u8()] ?? 'play';
    const countdown = r.f32();
    const goalPause = r.f32();
    const timeRemaining = r.f32();
    const overtimeElapsed = r.f32();
    const overtime = r.bool();
    const scoreBlue = r.u8();
    const scoreOrange = r.u8();
    const lg = r.i8();
    const lastGoal: Team | null = lg < 0 ? null : lg === 0 ? 'blue' : 'orange';
    const lastGoalScorer = r.i8();
    const lastTouch = r.i8();
    const lastGoalSpeed = r.f32();
    const rngState = r.u32() | 0;
    const order: number[] = [];
    for (let i = 0; i < KICKOFF_SPAWNS.length; i++) order.push(r.u8());
    const orderLen = r.u8();
    const spawnCursor = r.u8();
    const currentSpawn = r.u8();
    const ball = {
      pos: { x: r.f32(), y: r.f32(), z: r.f32() },
      rot: { x: r.f32(), y: r.f32(), z: r.f32(), w: r.f32() },
      vel: { x: r.f32(), y: r.f32(), z: r.f32() },
      angVel: { x: r.f32(), y: r.f32(), z: r.f32() },
      frozen: r.bool(),
    };
    const pads: number[] = [];
    for (let i = 0; i < BOOST_PADS.bigLocations.length + BOOST_PADS.smallLocations.length; i++) pads.push(r.u8() / PAD_COOLDOWN_SCALE);
    const n = r.u8();
    const cars: GameState['cars'] = [];
    for (let i = 0; i < n; i++) {
      const id = r.u8();
      const team: Team = r.u8() === 0 ? 'blue' : 'orange';
      cars.push({ id, team, state: Car.decode(r) });
    }
    return {
      tick,
      phase,
      countdown,
      goalPause,
      timeRemaining,
      overtimeElapsed,
      overtime,
      score: { blue: scoreBlue, orange: scoreOrange },
      lastGoal,
      lastGoalScorer,
      lastTouch,
      lastGoalSpeed,
      rngState,
      spawnOrder: order.slice(0, orderLen),
      spawnCursor,
      currentSpawn,
      ball,
      pads,
      cars,
    };
  }

  /** Replace the whole state with a serialised one. Cars are created or removed to match. */
  restore(r: ByteReader): void {
    this.applyState(Game.decode(r));
  }

  applyState(s: GameState): void {
    this.tick = s.tick;
    this.applyMetaState(s);
    this.freezeBall(s.ball.frozen);
    this.ball.setTranslation(s.ball.pos, true);
    this.ball.setRotation(s.ball.rot, true);
    this.ball.setLinvel(s.ball.vel, true);
    this.ball.setAngvel(s.ball.angVel, true);
    const seen = new Set<number>();
    for (const c of s.cars) {
      seen.add(c.id);
      const car = this.addCar(c.id, c.team);
      car.setFrozen(false);
      car.applyState(c.state);
      car.setFrozen(this.phase === 'countdown');
    }
    for (const id of [...this.cars.keys()]) if (!seen.has(id)) this.removeCar(id);
    this.capture(this.curr);
    this.copySnapshot(this.curr, this.prev);
  }

  /** Copy prediction metadata at this tick, independently of the mutable simulation. */
  captureMetaState(): GameMetaState {
    return {
      phase: this.phase, countdown: this.countdown, goalPause: this.goalPause,
      timeRemaining: this.timeRemaining, overtimeElapsed: this.overtimeElapsed, overtime: this.overtime,
      score: { ...this.score }, lastGoal: this.lastGoal, lastGoalScorer: this.lastGoalScorer,
      lastTouch: this.lastTouch, lastGoalSpeed: this.lastGoalSpeed, rngState: this.rng.state,
      spawnOrder: this.spawnOrder.slice(), spawnCursor: this.spawnCursor, currentSpawn: this.currentSpawn,
      pads: this.pads.map((pad) => pad.cooldown),
    };
  }

  /** Everything except the rigid bodies and the tick: clock, phase, score, pads, RNG. Used when the physics already agrees. */
  applyMetaState(s: GameState): void {
    this.phase = s.phase;
    this.countdown = s.countdown;
    this.goalPause = s.goalPause;
    this.timeRemaining = s.timeRemaining;
    this.overtimeElapsed = s.overtimeElapsed;
    this.overtime = s.overtime;
    this.score.blue = s.score.blue;
    this.score.orange = s.score.orange;
    this.lastGoal = s.lastGoal;
    this.lastGoalScorer = s.lastGoalScorer;
    this.lastTouch = s.lastTouch;
    this.lastGoalSpeed = s.lastGoalSpeed;
    this.rng.state = s.rngState;
    this.spawnOrder = s.spawnOrder.slice();
    this.spawnCursor = s.spawnCursor;
    this.currentSpawn = s.currentSpawn;
    for (let i = 0; i < this.pads.length; i++) this.pads[i].cooldown = s.pads[i] ?? 0;
  }

  /** Free the physics world. The game is unusable afterwards. */
  destroy(): void {
    this.world.free();
  }

  /** Convenience: serialise into a fresh buffer. */
  snapshotBytes(): ArrayBuffer {
    const w = new ByteWriter(256 + this.cars.size * 160);
    this.serialize(w);
    return w.finish();
  }

  // ---------------------------------------------------------------------------
  // Pads, car-ball impulse, ball caps
  // ---------------------------------------------------------------------------

  /**
   * [RS] BoostPad: a pad is collected when a car origin is inside its cylinder (radius 208/144,
   * height 95) or its box (half-width 160/120, height 64), then it cools down for 10 s (big) or
   * 4 s (small). A car with full boost does not collect pads.
   */
  private updatePads(dt: number): void {
    for (const p of this.pads) {
      if (p.cooldown > 0) {
        p.cooldown = Math.max(0, p.cooldown - dt);
        continue;
      }
      for (const car of this.cars.values()) {
        if (car.demoed || car.boost >= CAR.boostMax) continue;
        const t = car.body.translation();
        const dx = t.x - p.x;
        const dz = t.z - p.z;
        const dy = t.y - p.y;
        const cylRad = p.big ? BOOST_PADS.cylinderRadiusBig : BOOST_PADS.cylinderRadiusSmall;
        const boxRad = p.big ? BOOST_PADS.boxRadiusBig : BOOST_PADS.boxRadiusSmall;
        const inCyl = dy >= -p.y && dy <= BOOST_PADS.cylinderHeight && dx * dx + dz * dz <= cylRad * cylRad;
        const inBox = dy >= -p.y && dy <= BOOST_PADS.boxHeight && Math.abs(dx) <= boxRad && Math.abs(dz) <= boxRad;
        if (!inCyl && !inBox) continue;
        car.boost = Math.min(CAR.boostMax, car.boost + (p.big ? BOOST_PADS.bigAmount : BOOST_PADS.smallAmount));
        p.cooldown = p.big ? BOOST_PADS.bigCooldown : BOOST_PADS.smallCooldown;
        break;
      }
    }
  }

  /**
   * Car-car contact. Rapier already resolves the collision itself; this adds RL's two extras.
   *
   * A demolition happens when the attacking car's supersonic flag is set (measured against
   * RocketSim: contacts at up to 1508 uu/s relative never demolished with the flag clear, and one
   * at 1040 uu/s did with it set). Teammates never demolish each other. Otherwise the pair gets a
   * bump impulse on top of the collision, rate-limited so a resting contact does not repeat it.
   */
  private resolveCarContacts(): void {
    const cars = [...this.cars.values()];
    for (let i = 0; i < cars.length; i++) {
      const a = cars[i];
      if (a.demoed) continue;
      for (let j = i + 1; j < cars.length; j++) {
        const b = cars[j];
        if (b.demoed) continue;
        let touching = false;
        this.world.contactPair(a.collider, b.collider, (manifold) => {
          for (let k = 0; k < manifold.numContacts(); k++) {
            if (manifold.contactDist(k) <= 0) {
              touching = true;
              return;
            }
          }
        });
        if (!touching) continue;

        const pa = a.body.translation();
        const pb = b.body.translation();
        const mid = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2, z: (pa.z + pb.z) / 2 };
        const va = a.preStepVel;
        const vb = b.preStepVel;
        const relSpeed = Math.hypot(va.x - vb.x, va.y - vb.y, va.z - vb.z);

        const opponents = a.team !== b.team;
        const aDemos = opponents && a.supersonic;
        const bDemos = opponents && b.supersonic;
        if (aDemos || bDemos) {
          // Both supersonic into each other: both go.
          if (bDemos) this.demolish(a, b.id, mid);
          if (aDemos) this.demolish(b, a.id, mid);
          continue;
        }

        if (this.tick - a.lastBumpTick < TUNING.bumpCooldown / TICK_DT) continue;
        a.lastBumpTick = this.tick;
        b.lastBumpTick = this.tick;
        this.bumpsThisTick.push({ a: a.id, b: b.id, speed: relSpeed, ...mid });
        const mag = Math.min(TUNING.bumpMaxVel, relSpeed * TUNING.bumpVelPerRelSpeed);
        if (mag <= 0) continue;
        // Push each car away from the other, with RL's upward kick.
        relVel.set(pb.x - pa.x, 0, pb.z - pa.z);
        if (relVel.lengthSq() < 1e-6) continue;
        relVel.normalize();
        const up = mag * TUNING.bumpUpwardFraction;
        const bv = b.body.linvel();
        b.body.setLinvel({ x: bv.x + relVel.x * mag, y: bv.y + up, z: bv.z + relVel.z * mag }, true);
        const av = a.body.linvel();
        a.body.setLinvel({ x: av.x - relVel.x * mag, y: av.y + up, z: av.z - relVel.z * mag }, true);
      }
    }
  }

  private demolish(victim: Car, attacker: number, at: { x: number; y: number; z: number }): void {
    if (victim.demoed) return;
    this.demosThisTick.push({ victim: victim.id, attacker, x: at.x, y: at.y, z: at.z });
    victim.setDemoed(true);
    victim.demoTimer = DEMO.respawnTime;
  }

  /** Put a demolished car back on its team's side, as RL does after the respawn delay. */
  private respawnCar(car: Car): void {
    car.setDemoed(false);
    car.demoTimer = 0;
    this.placeAtSpawn(car);
  }

  /**
   * RL adds velocity to the ball on every tick a car touches it, on top of the rigid-body
   * collision. See BALL_CAR_EXTRA_IMPULSE in rl.ts for the formula and source.
   */
  private applyCarBallExtraImpulse(car: Car): void {
    let touching = false;
    this.world.contactPair(car.collider, this.ballCollider, (manifold) => {
      for (let i = 0; i < manifold.numContacts(); i++) {
        if (manifold.contactDist(i) <= 0) {
          touching = true;
          return;
        }
      }
    });
    if (!touching) return;
    this.ballTouched = true;
    this.lastTouch = car.id;

    // RocketSim evaluates this in the contact-added callback, i.e. with PRE-collision velocities
    // and positions, and applies it at most every other tick while contact persists.
    const bv = this.ballVelBefore;
    const cv = car.preStepVel;
    relVel.set(bv.x - cv.x, bv.y - cv.y, bv.z - cv.z);
    this.ballHitRelSpeed = Math.max(this.ballHitRelSpeed, relVel.length());
    if (this.tick <= car.lastBallImpulseTick + 1) return;
    const relSpeed = Math.min(relVel.length(), BALL_CAR_EXTRA_IMPULSE.maxDeltaVel);
    if (relSpeed <= 0) return;
    car.lastBallImpulseTick = this.tick;

    const bp = this.ballPosBefore;
    const cp = car.preStepPos;
    hitDir.set(bp.x - cp.x, (bp.y - cp.y) * BALL_CAR_EXTRA_IMPULSE.zScale, bp.z - cp.z).normalize();
    // Bullet only reports a contact while the bodies approach or rest; Rapier can keep a manifold
    // for a tick after the ball has already been kicked away. Skip those separating ticks so one
    // hit does not fire twice.
    if (relVel.dot(hitDir) > 0.5) {
      car.lastBallImpulseTick = -10;
      return;
    }

    const cr = car.body.rotation();
    carRot.set(cr.x, cr.y, cr.z, cr.w);
    carFwd.set(0, 0, -1).applyQuaternion(carRot);
    const along = hitDir.dot(carFwd) * (1 - BALL_CAR_EXTRA_IMPULSE.forwardScale);
    hitDir.addScaledVector(carFwd, -along).normalize();

    const factor = curve(BALL_CAR_EXTRA_IMPULSE.factorCurve, relSpeed / UU);
    const add = relSpeed * factor;
    // Added on top of the post-collision velocity (RocketSim's _velocityImpulseCache at tick end).
    const bvNow = this.ball.linvel();
    this.ball.setLinvel({ x: bvNow.x + hitDir.x * add, y: bvNow.y + hitDir.y * add, z: bvNow.z + hitDir.z * add }, true);
  }

  private clampBall(): void {
    const v = this.ball.linvel();
    const s2 = v.x * v.x + v.y * v.y + v.z * v.z;
    if (s2 > BALL.maxSpeed * BALL.maxSpeed) {
      const k = BALL.maxSpeed / Math.sqrt(s2);
      this.ball.setLinvel({ x: v.x * k, y: v.y * k, z: v.z * k }, true);
    }
    const w = this.ball.angvel();
    const w2 = w.x * w.x + w.y * w.y + w.z * w.z;
    if (w2 > BALL.maxAngularSpeed * BALL.maxAngularSpeed) {
      const k = BALL.maxAngularSpeed / Math.sqrt(w2);
      this.ball.setAngvel({ x: w.x * k, y: w.y * k, z: w.z * k }, true);
    }
  }

  // ---------------------------------------------------------------------------
  // World construction
  // ---------------------------------------------------------------------------

  private buildBall(): [RAPIER.RigidBody, RAPIER.Collider] {
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(0, BALL.restZ, 0)
        .setLinearDamping(BALL.drag)
        .setAngularDamping(0)
        .setCcdEnabled(true)
        .setCanSleep(false),
    );
    const volume = (4 / 3) * Math.PI * BALL.radius ** 3;
    // Combine rules (see tuning.ts): restitution ball-arena 0.6 (arena carries it, ball 0 with Max),
    // car-ball 0.0 as in RL, car-arena 0.0 (RL 0.3, the compromise); friction ball-arena 0.35
    // (arena carries the ball's value), car-ball 2.0 via the car's Max rule.
    const collider = this.world.createCollider(
      RAPIER.ColliderDesc.ball(BALL.radius)
        .setDensity(BALL.mass / volume)
        .setRestitution(BALL.carRestitution)
        .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Max)
        .setFriction(BALL.carFriction)
        .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min),
      body,
    );
    return [body, collider];
  }

  private buildArenaColliders(): void {
    const ground = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    // The arena carries the ball's friction (0.35, Min) because the ball collider holds the
    // car-ball value (2.0) so the car's Max rule can pick it up. RL's own arena base is 0.6.
    const material = (desc: RAPIER.ColliderDesc) =>
      desc
        .setFriction(BALL.friction)
        .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min)
        .setRestitution(BALL.restitution) // ball picks it up with Max; the car's Min with 0 gives 0
        .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Min);

    // ORIENTED: the shell's normals point into the arena, so deep penetrations still push inward.
    const flags = RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES | RAPIER.TriMeshFlags.ORIENTED;
    this.world.createCollider(material(RAPIER.ColliderDesc.trimesh(this.arena.vertices, this.arena.indices, flags)), ground);
    // Goal chambers: netting, quarter-pipe back and sloped roof, normals into the chamber.
    this.world.createCollider(material(RAPIER.ColliderDesc.trimesh(this.arena.goalVertices, this.arena.goalIndices, flags)), ground);
    for (const b of allColliderBoxes(this.arena)) {
      const desc = RAPIER.ColliderDesc.cuboid(b.hx, b.hy, b.hz).setTranslation(b.x, b.y, b.z);
      if (b.yaw) desc.setRotation({ x: 0, y: Math.sin(b.yaw / 2), z: 0, w: Math.cos(b.yaw / 2) });
      this.world.createCollider(material(desc), ground);
    }
  }
}

export { EMPTY_INPUT };

/** RL frame [x, y] with y the long axis -> our (x, z). Pad heights 73 uu (big) / 70 uu (small). */
function buildPads(): BoostPad[] {
  const pads: BoostPad[] = [];
  for (const [x, y] of BOOST_PADS.bigLocations) pads.push({ x: x * UU, y: 73 * UU, z: y * UU, big: true, cooldown: 0 });
  for (const [x, y] of BOOST_PADS.smallLocations) pads.push({ x: x * UU, y: 70 * UU, z: y * UU, big: false, cooldown: 0 });
  return pads;
}
