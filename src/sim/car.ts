import RAPIER from '@dimforge/rapier3d-compat';
import { Quaternion, Vector3 } from 'three';
import { BT, CAR, GRAVITY, M_TO_BT, OCTANE, UU, curve } from './rl';
import { TUNING } from './tuning';
import { EMPTY_INPUT, type CarInput } from '../input/types';
import { readInput, writeInput, type ByteReader, type ByteWriter } from './state';

export type Team = 'blue' | 'orange';

interface V3 {
  x: number;
  y: number;
  z: number;
}

/** Decoded serialize() record. `flags` packs the booleans (see serialize). */
export interface CarState {
  pos: V3;
  rot: { x: number; y: number; z: number; w: number };
  vel: V3;
  angVel: V3;
  preStepAngVel: V3;
  boost: number;
  handbrakeVal: number;
  jumpTime: number;
  airTimeSinceJump: number;
  flipTime: number;
  flipDirForward: number;
  flipDirSide: number;
  autoflipTimer: number;
  boostingTime: number;
  supersonicTime: number;
  demoTimer: number;
  lastBallImpulseTick: number;
  autoflipSign: number;
  flags: number;
  lastInput: CarInput;
}

export const CAR_FLAG_BOOSTING = 1;
export const CAR_FLAG_SUPERSONIC = 2;
export const CAR_FLAG_DEMOED = 1024;

// Car-local axes. Forward is -Z, right is +X, up is +Y.
const LOCAL_FORWARD = new Vector3(0, 0, -1);
const LOCAL_UP = new Vector3(0, 1, 0);
const LOCAL_RIGHT = new Vector3(1, 0, 0);

/** Octane hitbox half extents in our frame: x = width, y = height, z = length. */
export const HITBOX_HALF = {
  x: OCTANE.hitboxSize.y / 2,
  y: OCTANE.hitboxSize.z / 2,
  z: OCTANE.hitboxSize.x / 2,
};

/**
 * The rigid body origin is RL's car origin (axle height, between the wheels). The hitbox is
 * offset from it: forward is our -Z, so RL's +x offset becomes -z.
 */
export const HITBOX_OFFSET = new Vector3(0, OCTANE.hitboxOffset.z, -OCTANE.hitboxOffset.x);

/** Height of the body origin above the surface when resting on the wheels. */
export const REST_HEIGHT = OCTANE.restZ;

/** Uniform-box inertia of the hitbox about its own axes (kg·m²), used as the body's inertia as RocketSim does. */
const INERTIA_LOCAL = new Vector3(
  (CAR.mass / 12) * ((2 * HITBOX_HALF.y) ** 2 + (2 * HITBOX_HALF.z) ** 2),
  (CAR.mass / 12) * ((2 * HITBOX_HALF.x) ** 2 + (2 * HITBOX_HALF.z) ** 2),
  (CAR.mass / 12) * ((2 * HITBOX_HALF.x) ** 2 + (2 * HITBOX_HALF.y) ** 2),
);

interface WheelDef {
  /** Hardpoint relative to the body origin (RL x forward -> our -z; RL y -> our x; RL z -> our y). */
  hardpoint: Vector3;
  restDist: number;
  radius: number;
  forceScale: number;
  front: boolean;
}

const WHEELS: WheelDef[] = [
  { side: 1, front: true },
  { side: -1, front: true },
  { side: 1, front: false },
  { side: -1, front: false },
].map(({ side, front }) => {
  const off = front ? OCTANE.frontWheelOffset : OCTANE.rearWheelOffset;
  return {
    hardpoint: new Vector3(side * off.y, off.z, -off.x),
    restDist: (front ? OCTANE.frontSuspensionRest : OCTANE.rearSuspensionRest) - TUNING.suspensionRestOffset + (front ? OCTANE.frontWheelRadius : OCTANE.rearWheelRadius), // see tuning.ts
    radius: front ? OCTANE.frontWheelRadius : OCTANE.rearWheelRadius,
    forceScale: front ? CAR.suspensionForceScaleFront : CAR.suspensionForceScaleBack,
    front,
  };
});

interface WheelState {
  contact: boolean;
  point: Vector3;
  normal: Vector3;
  traceLen: number;
}

const UU_TO_BT = UU * M_TO_BT;
/** Guards duration comparisons against float64 tick accumulation (see updateJump). */
const TIME_EPS = 1e-6;

// Scratch objects.
const q = new Quaternion();
const qInv = new Quaternion();
const qSteer = new Quaternion();
const pos = new Vector3();
const vel = new Vector3();
const angVel = new Vector3();
const forward = new Vector3();
const up = new Vector3();
const right = new Vector3();
const groundUp = new Vector3();
const contactNormal = new Vector3();
const tmp = new Vector3();
const tmp2 = new Vector3();
const tmp3 = new Vector3();
const rA = new Vector3();
const axle = new Vector3();
const wheelFwd = new Vector3();
const vc = new Vector3();
const impulse = new Vector3();
const localAng = new Vector3();

export interface CarOptions {
  /** Stable identity across host and clients (the player's slot). */
  id: number;
  team: Team;
  infiniteBoost?: boolean;
}

/**
 * Octane on a Rapier dynamic body, driven the way RocketSim drives Bullet: four wheel rays
 * with spring/damper suspension and slip-curve friction applied as impulses, a sticky force,
 * and RL's jump / flip / air-control rules applied to the velocities. Method order and names
 * follow RocketSim's Car::_PreTickUpdate. See rl.ts for sources.
 */
export class Car {
  readonly id: number;
  readonly team: Team;
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  /** Last input applied to this car; the host holds it when a client's packet is late. */
  lastInput: CarInput = { ...EMPTY_INPUT };
  /** Tick of the last car-ball extra impulse (see Game.applyCarBallExtraImpulse). */
  lastBallImpulseTick = -10;
  /** Velocity and position handed to the solver this tick (RocketSim's contact callback sees these). */
  readonly preStepVel = new Vector3();
  readonly preStepPos = new Vector3();
  /** Demolished: parked out of play and not simulated until `demoTimer` runs out. */
  demoed = false;
  demoTimer = 0;
  /** Tick of the last bump involving this car, so one contact does not fire every tick. */
  lastBumpTick = -1000;

  /** ≥3 wheels touching something (RL's isOnGround). */
  grounded = false;
  numWheelsInContact = 0;
  /** Hitbox touching the arena (roof, side, nose). */
  worldContact = false;
  boost = CAR.boostMax;
  boosting = false;
  supersonic = false;
  isJumping = false;
  isFlipping = false;
  isAutoflipping = false;
  handbrakeVal = 0;
  /** Player setting: |yaw| + |pitch| + |roll| needed for a dodge instead of a double jump (RL default 0.5). */
  dodgeDeadzone = 0.5;
  infiniteBoost: boolean;
  /** Per-tick diagnostics (vertical components of impulses applied this tick, in m/s of chassis velocity). */
  readonly debug = { suspensionDvY: 0, frictionDvY: 0, maxCompression: 0, minInvDot: 0 };

  private readonly wheels: WheelState[] = WHEELS.map(() => ({
    contact: false,
    point: new Vector3(),
    normal: new Vector3(0, 1, 0),
    traceLen: 0,
  }));
  private readonly preStepAngVel = new Vector3();
  private prevJump = false;
  private jumpTime = 0;
  private airTimeSinceJump = 0;
  private hasJumped = false;
  private hasDoubleJumped = false;
  private hasFlipped = false;
  private flipTime = 0;
  private flipDirForward = 0;
  private flipDirSide = 0;
  private autoflipTimer = 0;
  private autoflipSign = 1;
  private boostingTime = 0;
  private supersonicTime = 0;
  private readonly ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });

  constructor(
    private readonly world: RAPIER.World,
    options: CarOptions,
  ) {
    this.id = options.id;
    this.team = options.team;
    this.infiniteBoost = options.infiniteBoost ?? false;

    this.body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setCanSleep(false).setCcdEnabled(true).setLinearDamping(0).setAngularDamping(0),
    );
    // The hitbox sits offset from the body origin; the centre of mass stays at the origin
    // (expressed here in the collider's own frame), with the hitbox's own box inertia.
    this.collider = world.createCollider(
      RAPIER.ColliderDesc.cuboid(HITBOX_HALF.x, HITBOX_HALF.y, HITBOX_HALF.z)
        .setTranslation(HITBOX_OFFSET.x, HITBOX_OFFSET.y, HITBOX_OFFSET.z)
        .setMassProperties(
          CAR.mass,
          { x: -HITBOX_OFFSET.x, y: -HITBOX_OFFSET.y, z: -HITBOX_OFFSET.z },
          { x: INERTIA_LOCAL.x, y: INERTIA_LOCAL.y, z: INERTIA_LOCAL.z },
          { x: 0, y: 0, z: 0, w: 1 },
        )
        .setFriction(CAR.worldFriction)
        .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Max)
        // 0 so car-ball comes out at RL's 0.0 (Min against the ball's Max 0). Costs car-arena
        // restitution (RL 0.3); see tuning.ts.
        .setRestitution(0)
        .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Min),
      this.body,
    );
  }

  /**
   * Visual suspension: local y of each wheel centre (order FL, FR, RL, RR) from the last ray
   * probe: the hardpoint minus the trace length plus the wheel radius, clamped to the travel.
   */
  wheelCenterY(out: number[]): number[] {
    for (let i = 0; i < WHEELS.length; i++) {
      const def = WHEELS[i];
      const w = this.wheels[i];
      const trace = w.contact ? w.traceLen : def.restDist + CAR.maxSuspensionTravel;
      const clamped = Math.max(def.restDist - CAR.maxSuspensionTravel, Math.min(def.restDist + CAR.maxSuspensionTravel, trace));
      out[i] = def.hardpoint.y - clamped + def.radius;
    }
    return out;
  }

  /** True once the double jump has been used this flight (sound edge). */
  get doubleJumped(): boolean {
    return this.hasDoubleJumped;
  }

  /** Remove the body (and collider) from the world. The car is unusable afterwards. */
  destroy(): void {
    this.world.removeRigidBody(this.body);
  }

  /**
   * Everything needed to continue the simulation from this exact state: rigid body transform and
   * velocities plus every timer and flag the tick logic reads. Wheel contacts and world contact
   * are recomputed at the start of each tick, so they are not stored.
   */
  serialize(w: ByteWriter): void {
    const t = this.body.translation();
    const r = this.body.rotation();
    const lv = this.body.linvel();
    const av = this.body.angvel();
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
    w.f32(this.preStepAngVel.x);
    w.f32(this.preStepAngVel.y);
    w.f32(this.preStepAngVel.z);
    w.f32(this.boost);
    w.f32(this.handbrakeVal);
    w.f32(this.jumpTime);
    w.f32(this.airTimeSinceJump);
    w.f32(this.flipTime);
    w.f32(this.flipDirForward);
    w.f32(this.flipDirSide);
    w.f32(this.autoflipTimer);
    w.f32(this.boostingTime);
    w.f32(this.supersonicTime);
    w.f32(this.demoTimer);
    w.i32(this.lastBallImpulseTick);
    w.i8(this.autoflipSign);
    w.u16(
      (this.boosting ? 1 : 0) |
        (this.supersonic ? 2 : 0) |
        (this.isJumping ? 4 : 0) |
        (this.isFlipping ? 8 : 0) |
        (this.isAutoflipping ? 16 : 0) |
        (this.hasJumped ? 32 : 0) |
        (this.hasDoubleJumped ? 64 : 0) |
        (this.hasFlipped ? 128 : 0) |
        (this.prevJump ? 256 : 0) |
        (this.grounded ? 512 : 0) |
        (this.demoed ? 1024 : 0),
    );
    writeInput(w, this.lastInput);
  }

  /** Decode one serialize() record into a plain object without touching any car. */
  static decode(r: ByteReader): CarState {
    const s: CarState = {
      pos: { x: r.f32(), y: r.f32(), z: r.f32() },
      rot: { x: r.f32(), y: r.f32(), z: r.f32(), w: r.f32() },
      vel: { x: r.f32(), y: r.f32(), z: r.f32() },
      angVel: { x: r.f32(), y: r.f32(), z: r.f32() },
      preStepAngVel: { x: r.f32(), y: r.f32(), z: r.f32() },
      boost: r.f32(),
      handbrakeVal: r.f32(),
      jumpTime: r.f32(),
      airTimeSinceJump: r.f32(),
      flipTime: r.f32(),
      flipDirForward: r.f32(),
      flipDirSide: r.f32(),
      autoflipTimer: r.f32(),
      boostingTime: r.f32(),
      supersonicTime: r.f32(),
      demoTimer: r.f32(),
      lastBallImpulseTick: r.i32(),
      autoflipSign: r.i8(),
      flags: r.u16(),
      lastInput: EMPTY_INPUT,
    };
    s.lastInput = readInput(r);
    return s;
  }

  restore(r: ByteReader): void {
    this.applyState(Car.decode(r));
  }

  applyState(s: CarState): void {
    this.body.setTranslation(s.pos, true);
    this.body.setRotation(s.rot, true);
    this.body.setLinvel(s.vel, true);
    this.body.setAngvel(s.angVel, true);
    this.preStepAngVel.set(s.preStepAngVel.x, s.preStepAngVel.y, s.preStepAngVel.z);
    this.boost = s.boost;
    this.handbrakeVal = s.handbrakeVal;
    this.jumpTime = s.jumpTime;
    this.airTimeSinceJump = s.airTimeSinceJump;
    this.flipTime = s.flipTime;
    this.flipDirForward = s.flipDirForward;
    this.flipDirSide = s.flipDirSide;
    this.autoflipTimer = s.autoflipTimer;
    this.boostingTime = s.boostingTime;
    this.supersonicTime = s.supersonicTime;
    this.demoTimer = s.demoTimer;
    this.lastBallImpulseTick = s.lastBallImpulseTick;
    this.autoflipSign = s.autoflipSign;
    const f = s.flags;
    this.boosting = !!(f & 1);
    this.supersonic = !!(f & 2);
    this.isJumping = !!(f & 4);
    this.isFlipping = !!(f & 8);
    this.isAutoflipping = !!(f & 16);
    this.hasJumped = !!(f & 32);
    this.hasDoubleJumped = !!(f & 64);
    this.hasFlipped = !!(f & 128);
    this.prevJump = !!(f & 256);
    this.grounded = !!(f & 512);
    this.setDemoed(!!(f & 1024));
    this.lastInput = s.lastInput;
  }

  /** Byte length of one serialize() record. */
  static readonly SERIALIZED_BYTES = 16 * 4 + 11 * 4 + 4 + 1 + 2 + 6;

  /**
   * Demolished cars are parked below the floor and frozen rather than removed, so ids, colliders
   * and the network state all stay put for the three seconds until they respawn.
   */
  setDemoed(demoed: boolean): void {
    if (this.demoed === demoed) return;
    this.demoed = demoed;
    if (demoed) {
      this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      this.setFrozen(true);
      this.body.setTranslation({ x: 0, y: -60, z: 0 }, true);
      this.boosting = false;
      this.isJumping = false;
      this.isFlipping = false;
    } else {
      this.setFrozen(false);
    }
  }

  /** Freeze in place (kickoff countdown) or release. */
  setFrozen(frozen: boolean): void {
    const type = frozen ? RAPIER.RigidBodyType.Fixed : RAPIER.RigidBodyType.Dynamic;
    if (this.body.bodyType() !== type) this.body.setBodyType(type, true);
  }

  /** Place the car at rest on flat ground at (x, z) with the given yaw (0 = facing -Z). */
  reset(x: number, z: number, yaw: number): void {
    q.setFromAxisAngle(LOCAL_UP, yaw);
    this.body.setTranslation({ x, y: REST_HEIGHT + TUNING.spawnDropHeight, z }, true);
    this.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.preStepAngVel.set(0, 0, 0);
    this.boost = CAR.boostSpawnAmount;
    this.boosting = false;
    this.supersonic = false;
    this.prevJump = false;
    this.isJumping = false;
    this.isFlipping = false;
    this.isAutoflipping = false;
    this.handbrakeVal = 0;
    this.jumpTime = 0;
    this.airTimeSinceJump = 0;
    this.hasJumped = false;
    this.hasDoubleJumped = false;
    this.hasFlipped = false;
    this.flipTime = 0;
    this.flipDirForward = 0;
    this.flipDirSide = 0;
    this.autoflipTimer = 0;
    this.boostingTime = 0;
    this.supersonicTime = 0;
    this.lastBallImpulseTick = -10;
    this.lastInput = { ...EMPTY_INPUT };
    this.demoTimer = 0;
    this.lastBumpTick = -1000;
  }

  tick(input: CarInput, dt: number): void {
    this.lastInput = input;
    this.readState();
    const jumpPressed = input.jump && !this.prevJump;

    // Handbrake value ramps, it is not a boolean in RL.
    this.handbrakeVal += (input.handbrake ? CAR.powerslideRiseRate : -CAR.powerslideFallRate) * dt;
    this.handbrakeVal = Math.max(0, Math.min(1, this.handbrakeVal));

    // Boosting drives the wheels at full throttle.
    const hasBoost = this.infiniteBoost || this.boost > 0;
    const willBoost = this.boosting ? hasBoost && (input.boost || this.boostingTime < CAR.boostMinTime) : input.boost && hasBoost;
    const realThrottle = willBoost ? 1 : input.throttle;

    // --- Wheels -------------------------------------------------------------------
    this.debug.suspensionDvY = 0;
    this.debug.frictionDvY = 0;
    this.debug.maxCompression = 0;
    this.debug.minInvDot = 0;
    this.probeWheels();
    this.grounded = this.numWheelsInContact >= CAR.wheelsForGround;
    this.probeWorldContact();

    if (this.numWheelsInContact > 0) {
      this.applySuspension(dt);
      this.readState();
      this.applyWheelFriction(input, realThrottle, dt);
      this.readState();
      this.applySticky(realThrottle, dt);
    }

    // --- Air torque (Car::_UpdateAirTorque): flip torque with < 3 wheels, air control with 0 --
    if (this.numWheelsInContact < CAR.wheelsForGround) {
      this.updateAirTorque(input, dt, this.numWheelsInContact === 0);
    } else {
      this.isFlipping = false;
    }

    this.updateJump(input, dt, jumpPressed);
    this.updateAutoflip(dt, jumpPressed);
    this.updateDoubleJumpOrFlip(input, dt, jumpPressed);

    const partialContact = this.numWheelsInContact > 0 && this.numWheelsInContact < 4;
    if (Math.abs(input.throttle) >= CAR.throttleDeadzone && !this.isAutoflipping && (partialContact || this.worldContact)) {
      this.autoroll(dt);
    }

    this.updateBoost(dt, willBoost);
    this.updateSupersonic(vel.length(), dt);

    // No caps here: RocketSim clamps in _FinishPhysicsTick AFTER the step, so the rotation of
    // this step integrates with up to one tick of torque above the cap. That extra ~2 rad/s during
    // the 0.65 s flip is what makes RL flips come round a full turn. See postStep().
    this.body.setLinvel({ x: vel.x, y: vel.y, z: vel.z }, true);
    this.body.setAngvel({ x: angVel.x, y: angVel.y, z: angVel.z }, true);
    this.preStepAngVel.copy(angVel);
    this.preStepVel.copy(vel);
    this.preStepPos.copy(pos);
    this.prevJump = input.jump;
  }

  /**
   * Call right after the physics step (Car::_FinishPhysicsTick).
   *  - Rapier integrates gyroscopic precession for the box inertia, so a flip about a
   *    non-principal axis tumbles. Bullet with RocketSim's flags does not: if nothing touched the
   *    car during the step, restore the pre-step angular velocity.
   *  - Then clamp speed and angular speed to RL's caps.
   */
  postStep(): void {
    let touched = false;
    this.world.contactPairsWith(this.collider, (other) => {
      if (touched) return;
      this.world.contactPair(this.collider, other, (manifold) => {
        for (let i = 0; i < manifold.numContacts(); i++) {
          if (manifold.contactDist(i) <= 0.001) {
            touched = true;
            return;
          }
        }
      });
    });
    if (!touched) this.body.setAngvel({ x: this.preStepAngVel.x, y: this.preStepAngVel.y, z: this.preStepAngVel.z }, true);

    const lv = this.body.linvel();
    const speed = Math.hypot(lv.x, lv.y, lv.z);
    if (speed > CAR.maxSpeed) {
      const k = CAR.maxSpeed / speed;
      this.body.setLinvel({ x: lv.x * k, y: lv.y * k, z: lv.z * k }, true);
    }
    const av = this.body.angvel();
    const angSpeed = Math.hypot(av.x, av.y, av.z);
    if (angSpeed > CAR.maxAngularSpeed) {
      const k = CAR.maxAngularSpeed / angSpeed;
      this.body.setAngvel({ x: av.x * k, y: av.y * k, z: av.z * k }, true);
    }
  }

  private readState(): void {
    const b = this.body;
    const r = b.rotation();
    q.set(r.x, r.y, r.z, r.w);
    const t = b.translation();
    pos.set(t.x, t.y, t.z);
    const lv = b.linvel();
    vel.set(lv.x, lv.y, lv.z);
    const av = b.angvel();
    angVel.set(av.x, av.y, av.z);
    forward.copy(LOCAL_FORWARD).applyQuaternion(q);
    up.copy(LOCAL_UP).applyQuaternion(q);
    right.copy(LOCAL_RIGHT).applyQuaternion(q);
  }

  // ---------------------------------------------------------------------------
  // Wheels: rays, suspension, friction, sticky force
  // ---------------------------------------------------------------------------

  private probeWheels(): void {
    this.numWheelsInContact = 0;
    groundUp.set(0, 0, 0);
    tmp2.copy(up).negate();
    for (let i = 0; i < WHEELS.length; i++) {
      const def = WHEELS[i];
      const w = this.wheels[i];
      tmp.copy(def.hardpoint).applyQuaternion(q).add(pos);
      this.ray.origin.x = tmp.x;
      this.ray.origin.y = tmp.y;
      this.ray.origin.z = tmp.z;
      this.ray.dir.x = tmp2.x;
      this.ray.dir.y = tmp2.y;
      this.ray.dir.z = tmp2.z;
      const rayLength = def.restDist + CAR.maxSuspensionTravel - CAR.suspensionSubtraction;
      const hit = this.world.castRayAndGetNormal(this.ray, rayLength, true, undefined, undefined, undefined, this.body);
      if (hit) {
        w.contact = true;
        w.traceLen = hit.timeOfImpact;
        w.point.copy(tmp).addScaledVector(tmp2, hit.timeOfImpact);
        w.normal.set(hit.normal.x, hit.normal.y, hit.normal.z);
        this.numWheelsInContact++;
        groundUp.add(w.normal);
      } else {
        w.contact = false;
      }
    }
    if (this.numWheelsInContact > 0) groundUp.normalize();
    else groundUp.copy(up);
  }

  /** Hitbox touching arena geometry (fixed bodies only: not the ball, not other cars). Sets contactNormal pointing at the car. */
  private probeWorldContact(): void {
    this.worldContact = false;
    this.world.contactPairsWith(this.collider, (other) => {
      if (this.worldContact) return;
      const parent = other.parent();
      if (!parent || !parent.isFixed()) return;
      this.world.contactPair(this.collider, other, (manifold, flipped) => {
        if (this.worldContact) return;
        for (let i = 0; i < manifold.numContacts(); i++) {
          if (manifold.contactDist(i) <= 0.001) {
            const n = manifold.normal();
            contactNormal.set(n.x, n.y, n.z);
            if (!flipped) contactNormal.negate();
            this.worldContact = true;
            return;
          }
        }
      });
    });
  }

  /**
   * Bullet raycast-vehicle suspension, replicated in BT units so RocketSim's constants apply
   * verbatim: force = ((rest - length) * k / (n·up) - c * relVel) * forceScale, never negative,
   * plus RocketSim's "extra pushback" rigid contact once a wheel compresses past 2.5 uu.
   * Applied as an impulse along the contact normal at the contact point.
   */
  private applySuspension(dt: number): void {
    qInv.copy(q).invert();
    for (let i = 0; i < WHEELS.length; i++) {
      const w = this.wheels[i];
      if (!w.contact) continue;
      const def = WHEELS[i];

      const minLen = def.restDist - CAR.maxSuspensionTravel;
      const maxLen = def.restDist + CAR.maxSuspensionTravel;
      const suspLen = Math.max(minLen, Math.min(maxLen, w.traceLen));

      const denom = w.normal.dot(up);
      let relVel = 0;
      let invDot = 10;
      rA.subVectors(w.point, pos);
      vc.copy(angVel).cross(rA).add(vel);
      if (denom > 0.1) {
        relVel = w.normal.dot(vc) / denom;
        invDot = 1 / denom;
      }

      const compressionBt = (def.restDist - suspLen) * M_TO_BT;
      const relVelBt = relVel * M_TO_BT;
      const damping = relVelBt < 0 ? CAR.suspensionDampingCompression : CAR.suspensionDampingRelaxation;
      let forceBt = (compressionBt * CAR.suspensionStiffness * invDot - damping * relVelBt) * def.forceScale;
      if (forceBt < 0) forceBt = 0;

      // Extra pushback: Bullet resolveSingleCollision (restitution 0, erp 0.2) split over the wheels.
      let extraPushback = 0;
      const pushbackThresh = def.restDist - CAR.suspensionSubtraction;
      if (w.traceLen < pushbackThresh) {
        const approach = w.normal.dot(vc); // negative when moving into the surface
        const positionalError = (CAR.contactErp * (pushbackThresh - w.traceLen)) / dt;
        const velocityError = -approach;
        tmp.copy(rA).cross(w.normal).applyQuaternion(qInv);
        const denomJ =
          1 / CAR.mass + (tmp.x * tmp.x) / INERTIA_LOCAL.x + (tmp.y * tmp.y) / INERTIA_LOCAL.y + (tmp.z * tmp.z) / INERTIA_LOCAL.z;
        extraPushback = Math.max(0, (positionalError + velocityError) / denomJ) / WHEELS.length;
      }
      if (forceBt === 0 && extraPushback === 0) continue;

      // Impulse in BT is force * dt; velocities scale by BT to reach SI.
      const magnitude = forceBt * dt * BT + extraPushback;
      impulse.copy(w.normal).multiplyScalar(magnitude);
      this.debug.suspensionDvY += impulse.y / CAR.mass;
      this.debug.maxCompression = Math.max(this.debug.maxCompression, def.restDist - suspLen);
      this.debug.minInvDot = Math.max(this.debug.minInvDot, invDot);
      this.body.applyImpulseAtPoint({ x: impulse.x, y: impulse.y, z: impulse.z }, { x: w.point.x, y: w.point.y, z: w.point.z }, true);
    }
  }

  /**
   * RocketSim calcFrictionImpulses / applyFrictionImpulses. All wheel impulses are computed from
   * the same pre-impulse state, then applied at the contact point raised to the chassis' height.
   */
  private applyWheelFriction(input: CarInput, realThrottle: number, dt: number): void {
    const forwardSpeed = vel.dot(forward);
    const absForwardSpeedUU = Math.abs(forwardSpeed) / UU;

    // Throttle / brake decision (Car.cpp).
    let engineThrottle = realThrottle;
    let realBrake = 0;
    if (!input.handbrake) {
      const absThrottle = Math.abs(realThrottle);
      if (absThrottle >= CAR.throttleDeadzone) {
        if (absForwardSpeedUU > CAR.stoppingForwardVel / UU && Math.sign(realThrottle) !== Math.sign(forwardSpeed)) {
          realBrake = 1;
          if (absForwardSpeedUU > CAR.brakingNoThrottleSpeedThresh / UU) engineThrottle = 0;
        }
      } else {
        engineThrottle = 0;
        realBrake = absForwardSpeedUU < CAR.stoppingForwardVel / UU ? 1 : CAR.coastingBrakeFactor;
      }
    }

    let driveSpeedScale = curve(CAR.driveSpeedTorqueFactorCurve, absForwardSpeedUU);
    if (this.numWheelsInContact < CAR.wheelsForGround) driveSpeedScale /= 4;
    const engineForceBt = engineThrottle * CAR.mass * (CAR.throttleAccelPerWheel / UU) * UU_TO_BT * driveSpeedScale;
    const brakeBt = realBrake * CAR.mass * (CAR.brakeAccelPerWheel / BT) * UU_TO_BT;

    // Steering angle (front wheels), blended toward the powerslide curve by handbrakeVal.
    let steerAngle = curve(CAR.steerAngleFromSpeedCurve, absForwardSpeedUU);
    if (this.handbrakeVal > 0) {
      steerAngle += (curve(CAR.powerslideSteerAngleFromSpeedCurve, absForwardSpeedUU) - steerAngle) * this.handbrakeVal;
    }
    steerAngle *= input.steer;
    // Positive rotation about up turns left, so steering right rotates the axle by -angle.
    qSteer.setFromAxisAngle(up, -steerAngle);

    const frictionScale = CAR.mass / CAR.frictionMassDivisor;
    const impulses: Vector3[] = [];
    const points: Vector3[] = [];

    qInv.copy(q).invert();

    for (let i = 0; i < WHEELS.length; i++) {
      const w = this.wheels[i];
      if (!w.contact) continue;
      const def = WHEELS[i];

      // Axle direction (with steering) projected onto the contact plane.
      axle.copy(right);
      if (def.front) axle.applyQuaternion(qSteer);
      axle.addScaledVector(w.normal, -axle.dot(w.normal)).normalize();
      wheelFwd.crossVectors(w.normal, axle).normalize();

      rA.subVectors(w.point, pos);
      vc.copy(angVel).cross(rA).add(vel);
      const relLat = vc.dot(axle);
      const relLong = vc.dot(wheelFwd);

      // Slip ratio drives the friction curves.
      let frictionCurveInput = 0;
      const baseFriction = Math.abs(relLat);
      if (baseFriction > CAR.latFrictionSlipMinSpeed) frictionCurveInput = baseFriction / (Math.abs(relLong) + baseFriction);
      let latFriction = curve(CAR.latFrictionCurve, frictionCurveInput);
      let longFriction = 1;
      if (this.handbrakeVal > 0) {
        latFriction *= (curve(CAR.handbrakeLatFrictionFactorCurve, frictionCurveInput) - 1) * this.handbrakeVal + 1;
        longFriction = (curve(CAR.handbrakeLongFrictionFactorCurve, frictionCurveInput) - 1) * this.handbrakeVal + 1;
      }
      if (realThrottle === 0) {
        const nonSticky = curve(CAR.nonStickyFrictionFactorCurve, w.normal.y);
        latFriction *= nonSticky;
        longFriction *= nonSticky;
      }

      // Side impulse: Bullet resolveSingleBilateral against a static ground, in BT units.
      // jacDiagAB = 1/m + (r×a)·I⁻¹(r×a), with r and I in BT.
      tmp.copy(rA).multiplyScalar(M_TO_BT).cross(axle);
      tmp3.copy(tmp).applyQuaternion(qInv);
      const inertiaTerm =
        (tmp3.x * tmp3.x) / (INERTIA_LOCAL.x * M_TO_BT * M_TO_BT) +
        (tmp3.y * tmp3.y) / (INERTIA_LOCAL.y * M_TO_BT * M_TO_BT) +
        (tmp3.z * tmp3.z) / (INERTIA_LOCAL.z * M_TO_BT * M_TO_BT);
      const jacDiagAB = 1 / CAR.mass + inertiaTerm;
      const sideImpulseBt = (-CAR.bilateralContactDamping * (relLat * M_TO_BT)) / jacDiagAB;

      // Rolling / engine term along the wheel's forward direction.
      let rollingBt: number;
      if (engineForceBt === 0) {
        if (brakeBt > 0) {
          const relLongBt = relLong * M_TO_BT;
          rollingBt = Math.max(-brakeBt, Math.min(brakeBt, -relLongBt * CAR.rollingFrictionScaleMagic));
        } else {
          rollingBt = 0;
        }
      } else {
        rollingBt = engineForceBt / frictionScale;
      }

      const J = new Vector3()
        .copy(wheelFwd)
        .multiplyScalar(rollingBt * longFriction)
        .addScaledVector(axle, sideImpulseBt * latFriction)
        .multiplyScalar(frictionScale * dt * BT);
      impulses.push(J);
      // Raise the application point to the chassis' height so lateral grip does not roll the car.
      const p = new Vector3().copy(rA).addScaledVector(up, -rA.dot(up)).add(pos);
      points.push(p);
    }

    for (let i = 0; i < impulses.length; i++) {
      const J = impulses[i];
      const p = points[i];
      this.debug.frictionDvY += J.y / CAR.mass;
      this.body.applyImpulseAtPoint({ x: J.x, y: J.y, z: J.z }, { x: p.x, y: p.y, z: p.z }, true);
    }
  }

  /** Central force toward the surface: 0.5 g, plus (1 - |up.z|) g when throttling or moving. */
  private applySticky(realThrottle: number, dt: number): void {
    const fullStick = realThrottle !== 0 || vel.length() > CAR.stoppingForwardVel;
    let scale = CAR.stickyBaseScale;
    if (fullStick) scale += 1 - Math.abs(groundUp.y);
    vel.addScaledVector(groundUp, -scale * GRAVITY * dt);
  }

  // ---------------------------------------------------------------------------
  // Air torque: flips, flip cancel, air control
  // ---------------------------------------------------------------------------

  /**
   * Car::_UpdateAirTorque. Flip torque while flipping (pitch input with the flip's sign scales it
   * down: flip cancel). Air control otherwise, and during a cancel or stall, but only with no
   * wheel touching; pitch input is locked during the flip and for 0.3 s after. Roll damping is
   * always full; pitch/yaw damping scale with (1 - |input|). Torques are angular accelerations.
   * Local axes: x = pitch (+ nose up), y = yaw (+ left), z = roll (+ roll left).
   */
  private updateAirTorque(input: CarInput, dt: number, updateAirControl: boolean): void {
    qInv.copy(q).invert();
    localAng.copy(angVel).applyQuaternion(qInv);

    let doAirControl = false;
    if (this.isFlipping) this.isFlipping = this.hasFlipped && this.flipTime + TIME_EPS < CAR.flipTorqueTime;

    if (this.isFlipping) {
      if (this.flipDirForward !== 0 || this.flipDirSide !== 0) {
        let pitchScale = 1;
        if (this.flipDirForward !== 0 && input.pitch !== 0 && Math.sign(this.flipDirForward) === Math.sign(input.pitch)) {
          pitchScale = 1 - Math.min(Math.abs(input.pitch), 1);
          doAirControl = true;
        }
        // Forward flip = nose down = negative pitch; side flip right = roll right = negative local z.
        localAng.x -= this.flipDirForward * pitchScale * CAR.flipTorqueY * dt;
        localAng.z -= this.flipDirSide * CAR.flipTorqueX * dt;
      } else {
        doAirControl = true; // stall: a flip with no direction
      }
    } else {
      doAirControl = true;
    }

    doAirControl = doAirControl && !this.isAutoflipping && updateAirControl;
    if (doAirControl) {
      let pitchTorqueScale = 1;
      if (this.isFlipping) pitchTorqueScale = 0;
      else if (this.hasFlipped && this.flipTime < CAR.flipTorqueTime + CAR.flipPitchLockExtraTime) pitchTorqueScale = 0;

      const s = CAR.torqueScale;
      const pitchIn = input.pitch * pitchTorqueScale;
      const yawIn = -input.yaw;
      const rollIn = -input.roll;
      // Damping from the pre-torque angular velocity, as one combined torque in RocketSim.
      const dampX = localAng.x * CAR.airControlDamping.pitch * (1 - Math.abs(pitchIn));
      const dampY = localAng.y * CAR.airControlDamping.yaw * (1 - Math.abs(yawIn));
      const dampZ = localAng.z * CAR.airControlDamping.roll;
      localAng.x += (CAR.airControlTorque.pitch * pitchIn - dampX) * s * dt;
      localAng.y += (CAR.airControlTorque.yaw * yawIn - dampY) * s * dt;
      localAng.z += (CAR.airControlTorque.roll * rollIn - dampZ) * s * dt;
    }

    angVel.copy(localAng).applyQuaternion(q);

    // Air throttle is tiny but real.
    vel.addScaledVector(forward, CAR.airThrottleAccel * input.throttle * dt);
  }

  // ---------------------------------------------------------------------------
  // Jumping, double jump, dodge
  // ---------------------------------------------------------------------------

  /** Car::_UpdateJump. */
  private updateJump(input: CarInput, dt: number, jumpPressed: boolean): void {
    if (this.grounded && !this.isJumping) {
      if (this.hasJumped && this.jumpTime < CAR.jumpMinTime + CAR.jumpResetTimePad) {
        // Still leaving the ground after a minimum-time jump; keep the jump state.
      } else {
        this.hasJumped = false;
        this.jumpTime = 0;
      }
    }

    if (this.isJumping) {
      // TIME_EPS: 24 ticks of 1/120 s sum to 0.19999999… in float64, which would grant a 25th
      // tick of jump acceleration that RocketSim (float32) does not; measured +12 uu/s.
      this.isJumping = this.jumpTime + TIME_EPS < CAR.jumpMinTime || (input.jump && this.jumpTime + TIME_EPS < CAR.jumpMaxTime);
    } else if (this.grounded && jumpPressed) {
      this.isJumping = true;
      this.jumpTime = 0;
      vel.addScaledVector(up, CAR.jumpImmediateForce);
    }

    if (this.isJumping) {
      this.hasJumped = true;
      const scale = this.jumpTime + TIME_EPS < CAR.jumpMinTime ? CAR.jumpPreMinAccelScale : 1;
      vel.addScaledVector(up, CAR.jumpAccel * scale * dt);
    }

    if (this.isJumping || this.hasJumped) this.jumpTime += dt;
  }

  /** Car::_UpdateDoubleJumpOrFlip. */
  private updateDoubleJumpOrFlip(input: CarInput, dt: number, jumpPressed: boolean): void {
    if (this.grounded) {
      this.hasDoubleJumped = false;
      this.hasFlipped = false;
      this.airTimeSinceJump = 0;
      this.flipTime = 0;
    } else {
      // A car that fell off a surface without jumping keeps airTimeSinceJump at 0 and can flip any time.
      if (this.hasJumped && !this.isJumping) this.airTimeSinceJump += dt;
      else this.airTimeSinceJump = 0;

      if (jumpPressed && this.airTimeSinceJump < CAR.doubleJumpMaxDelay) {
        const inputMagnitude = Math.abs(input.yaw) + Math.abs(input.pitch) + Math.abs(input.roll);
        const isFlipInput = inputMagnitude >= this.dodgeDeadzone;
        let canUse = !this.hasDoubleJumped && !this.hasFlipped;
        if (this.isAutoflipping) canUse = false;

        if (canUse) {
          if (isFlipInput) {
            this.flipTime = 0;
            this.hasFlipped = true;
            this.isFlipping = true;

            // Dodge direction from (-pitch, yaw + roll). The torque uses the normalised direction;
            // the impulse zeroes components under 0.1 first.
            let df = -input.pitch;
            let ds = input.yaw + input.roll;
            if (Math.abs(ds) < CAR.flipDodgeDeadzone && Math.abs(df) < CAR.flipDodgeDeadzone) {
              df = 0;
              ds = 0;
            } else {
              const m = Math.hypot(df, ds);
              df /= m;
              ds /= m;
            }
            this.flipDirForward = df;
            this.flipDirSide = ds;

            if (Math.abs(df) < CAR.flipDodgeDeadzone) df = 0;
            if (Math.abs(ds) < CAR.flipDodgeDeadzone) ds = 0;
            if (df !== 0 || ds !== 0) this.applyDodgeImpulse(df, ds);
          } else {
            vel.addScaledVector(up, CAR.doubleJumpImpulse);
            this.hasDoubleJumped = true;
          }
        }
      }
    }

    if (this.isFlipping) {
      this.flipTime += dt;
      if (this.flipTime <= CAR.flipTorqueTime) {
        // Vertical velocity damping during the dodge: the "float".
        if (this.flipTime >= CAR.flipZDampStart && (vel.y < 0 || this.flipTime < CAR.flipZDampEnd)) {
          vel.y *= Math.pow(1 - CAR.flipZDamp120, dt * 120);
        }
      }
    } else if (this.hasFlipped) {
      // Keeps counting after the flip for the pitch lock window.
      this.flipTime += dt;
    }
  }

  private applyDodgeImpulse(df: number, ds: number): void {
    const forwardSpeed = vel.dot(forward);
    const speedRatio = Math.abs(forwardSpeed) / CAR.maxSpeed;
    const backwards =
      Math.abs(forwardSpeed) < CAR.flipBackwardSpeedThreshold ? df < 0 : df >= 0 !== forwardSpeed >= 0;

    let vx = df * CAR.flipInitialVelScale;
    let vy = ds * CAR.flipInitialVelScale;
    const maxScaleX = backwards ? CAR.flipBackwardImpulseMaxSpeedScale : CAR.flipForwardImpulseMaxSpeedScale;
    vx *= (maxScaleX - 1) * speedRatio + 1;
    vy *= (CAR.flipSideImpulseMaxSpeedScale - 1) * speedRatio + 1;
    if (backwards) vx *= CAR.flipBackwardImpulseScaleX;

    // [RS] The impulse uses the HORIZONTAL projections of forward and right (forwardDir2D), so a
    // pitched car does not dodge into the ground or the sky.
    const fwd2D = tmp.set(forward.x, 0, forward.z);
    if (fwd2D.lengthSq() < 1e-6) fwd2D.set(right.z, 0, -right.x);
    fwd2D.normalize();
    const right2D = tmp2.set(-fwd2D.z, 0, fwd2D.x); // fwd2D × up
    vel.addScaledVector(fwd2D, vx).addScaledVector(right2D, vy);
  }

  // ---------------------------------------------------------------------------
  // Recovery: autoflip (jump while upside down) and autoroll (throttle while tilted)
  // ---------------------------------------------------------------------------

  private updateAutoflip(dt: number, jumpPressed: boolean): void {
    if (jumpPressed && this.worldContact && contactNormal.y > CAR.autoflipNormalZThreshold) {
      // Roll angle: positive when rolled to the right.
      const roll = Math.atan2(-right.y, up.y);
      const absRoll = Math.abs(roll);
      if (absRoll > CAR.autoflipRollThreshold) {
        this.autoflipTimer = CAR.autoflipTime * (absRoll / Math.PI);
        this.autoflipSign = roll >= 0 ? 1 : -1;
        this.isAutoflipping = true;
        vel.addScaledVector(up, -CAR.autoflipImpulse);
      }
    }

    if (this.isAutoflipping) {
      if (this.autoflipTimer <= 0) {
        this.isAutoflipping = false;
        this.autoflipTimer = 0;
      } else {
        angVel.addScaledVector(forward, CAR.autoflipTorque * this.autoflipSign * dt);
        this.autoflipTimer -= dt;
      }
    }
  }

  private autoroll(dt: number): void {
    // Press into the surface and rotate the car's up toward the surface normal.
    const surfaceUp = this.numWheelsInContact > 0 ? groundUp : contactNormal;
    vel.addScaledVector(surfaceUp, -CAR.autorollForce * dt);
    const err = tmp.crossVectors(up, surfaceUp);
    angVel.addScaledVector(err, TUNING.autorollAlignGain);
  }

  // ---------------------------------------------------------------------------
  // Boost and supersonic
  // ---------------------------------------------------------------------------

  private updateBoost(dt: number, willBoost: boolean): void {
    if (this.infiniteBoost) this.boost = CAR.boostMax;
    if (!this.boosting && willBoost) this.boostingTime = 0;
    else if (this.boosting) this.boostingTime += dt;
    this.boosting = willBoost;
    if (!this.boosting) return;
    const accel = this.grounded ? CAR.boostAccelGround : CAR.boostAccelAir;
    vel.addScaledVector(forward, accel * dt);
    if (!this.infiniteBoost) this.boost = Math.max(0, this.boost - CAR.boostUsedPerSecond * dt);
  }

  private updateSupersonic(speed: number, dt: number): void {
    if (speed >= CAR.supersonicStartSpeed) {
      this.supersonic = true;
      this.supersonicTime = 0;
    } else if (this.supersonic && speed >= CAR.supersonicMaintainMinSpeed) {
      this.supersonicTime += dt;
      if (this.supersonicTime > CAR.supersonicMaintainMaxTime) this.supersonic = false;
    } else {
      this.supersonic = false;
      this.supersonicTime = 0;
    }
  }
}
