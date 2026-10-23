/**
 * VERIFIED Rocket League values.
 *
 * Every number here comes from one of two sources and is written in the game's own
 * unreal units (uu, uu/s, uu/s², rad, s) with a `* UU` conversion to metres where the
 * sim consumes it. If you change a value here you are deviating from the real game.
 *
 *   [RS]  RocketSim by ZealanL: src/RLConst.h, src/Sim/Car/Car.cpp,
 *         src/Sim/Car/CarConfig/CarConfig.cpp, src/Sim/btVehicleRL/btVehicleRL.cpp
 *         https://github.com/ZealanL/RocketSim (reverse-engineered, tick-accurate sim)
 *   [WIKI] RLBot "Useful game values": https://wiki.rlbot.org/v4/botmaking/useful-game-values/
 *   [MESH] Measured from RL's arena collision mesh (RocketSim .cmf format, 1 BT = 50 uu). The
 *          mesh itself is Psyonix's and is not part of this repo; only the measurements are.
 *
 * Everything approximate or invented lives in ./tuning.ts instead.
 */

/** 1 unreal unit = 1 cm. All sim math is in metres. */
export const UU = 0.01;
/** [RS] Bullet works in "BT" units: 1 BT = 50 uu = 0.5 m. Some formulas are replicated in BT. */
export const BT = 0.5;
export const M_TO_BT = 1 / BT;

export const TICK_RATE = 120; // [RS] RL physics runs at 120 Hz
export const TICK_DT = 1 / TICK_RATE;

export const GRAVITY = 650 * UU; // [RS] GRAVITY_Z = -650

// ---------------------------------------------------------------------------------
// Arena (standard soccar)
// ---------------------------------------------------------------------------------
export const ARENA = {
  extentX: 4096 * UU, // [RS][WIKI] side walls at x = ±4096
  extentY: 5120 * UU, // [RS][WIKI] back walls at y = ±5120 (our z axis)
  height: 2044 * UU, // [WIKI] ceiling z = 2044 ([RS] uses 2048 for its AABB)
  /** [WIKI] Corner walls lie on the 45° planes |x| + |y| = 8064, i.e. they cut 1152 uu off each axis. */
  cornerPlane: 8064 * UU,
  cornerCut: (4096 + 5120 - 8064) * UU, // = 1152 uu
  cornerWallLength: 1629.174 * UU, // [WIKI] = 1152 * sqrt(2)
  /** [MESH] goal interior half-width; the collision mesh's side netting is at x = ±896 ([WIKI] quotes 892.755 centre-to-post). */
  goalHalfWidth: 896 * UU,
  /** [MESH] underside of the crossbar lintel; [WIKI] quotes 642.775. */
  goalHeight: 640 * UU,
  goalDepth: 880 * UU, // [WIKI][MESH] back of the net at y = ±6000
  /** [RS] SOCCAR_GOAL_SCORE_BASE_THRESHOLD_Y: goal when |ball.y| > this + ball radius. */
  goalScoreThresholdY: 5124.25 * UU,
  collisionFriction: 0.6, // [RS] ARENA_COLLISION_BASE_FRICTION
  collisionRestitution: 0.3, // [RS] ARENA_COLLISION_BASE_RESTITUTION
};

/**
 * [MESH] Goal interior profile, measured from RL's collision mesh, as (depth behind the mouth
 * plane, height) in uu. The chamber is a tube a car can ride: flat floor, a quarter-pipe back
 * (radius 256 centred 624 uu behind the mouth at height 256) that curls forward past vertical,
 * a roof sloping from the top of that curl (477 high, 733 deep) up to 640 at 224 deep, then the
 * flat underside of the crossbar lintel (640) out to the mouth. Side netting is vertical at ±896.
 */
export const GOAL_PROFILE = {
  backCurveRadius: 256 * UU,
  backCurveCentreDepth: 624 * UU,
  backCurveCentreHeight: 256 * UU,
  /** Angle above horizontal at which the back curve hands over to the roof (top point 733 deep, 477 high). */
  backCurveEndAngle: Math.atan2(477 - 256, 733 - 624),
  roofBackDepth: 733 * UU,
  roofBackHeight: 477 * UU,
  roofFrontDepth: 224 * UU,
  roofFrontHeight: 640 * UU,
  /** Rounding of the roof/side corners (skipped in the analytic mesh). */
  cornerFilletRadius: 96 * UU,
};

// ---------------------------------------------------------------------------------
// Ball
// ---------------------------------------------------------------------------------
export const BALL = {
  radius: 91.25 * UU, // [RS] BALL_COLLISION_RADIUS_SOCCAR, confirmed on car-soccer.com's RocketSim build
  visualRadius: 92.75 * UU, // [WIKI] the rendered ball
  restZ: 93.15 * UU, // [RS] BALL_REST_Z
  mass: 30, // [RS] BALL_MASS_BT = CAR_MASS_BT / 6
  restitution: 0.6, // [RS] BALL_RESTITUTION
  friction: 0.35, // [RS] BALL_FRICTION
  drag: 0.03, // [RS] BALL_DRAG, applied as Bullet linear damping
  maxSpeed: 6000 * UU, // [RS] BALL_MAX_SPEED
  maxAngularSpeed: 6.0, // [RS] BALL_MAX_ANG_SPEED rad/s
  /** [RS] Car-ball contact material. */
  carFriction: 2.0, // CARBALL_COLLISION_FRICTION
  carRestitution: 0.0, // CARBALL_COLLISION_RESTITUTION
};

/**
 * [RS] Ball.cpp _OnHit: extra velocity added to the ball whenever a car touches it.
 *   relSpeed = min(|v_ball - v_car|, maxDeltaVel)
 *   hitDir   = normalize((ballPos - carPos) * (1, 1, zScale))     (z scaled BEFORE normalising)
 *   hitDir   = normalize(hitDir - carForward * dot(hitDir, carForward) * (1 - forwardScale))
 *   ballVel += hitDir * relSpeed * factorCurve(relSpeed)
 */
export const BALL_CAR_EXTRA_IMPULSE = {
  zScale: 0.35,
  forwardScale: 0.65,
  maxDeltaVel: 4600 * UU,
  /** relSpeed (uu/s) -> factor. */
  factorCurve: [
    [0, 0.65],
    [500, 0.65],
    [2300, 0.55],
    [4600, 0.3],
  ] as [number, number][],
};

// ---------------------------------------------------------------------------------
// Car: Octane preset
// ---------------------------------------------------------------------------------
/**
 * [RS] CarConfig.cpp CAR_CONFIG_OCTANE. RocketSim notes these hitbox extents reproduce the
 * real inertia tensor; the commonly shared 118.01 x 84.20 x 36.16 come from
 * GetLocalCollisionExtent() and are slightly off. Axes: x forward, y right, z up.
 *
 * suspensionRest* is the hardpoint-to-contact distance at rest INCLUDING the wheel radius:
 * with the hardpoints 37.755 uu above the ground at rest (restZ + hitboxOffset.z) the
 * spring/gravity balance below lands within ~1.3 uu of the floor, which is the only reading
 * consistent with CAR_SPAWN_REST_Z = 17.
 */
export const OCTANE = {
  hitboxSize: { x: 120.507 * UU, y: 86.6994 * UU, z: 38.6591 * UU },
  /** Hitbox centre relative to the car origin (the origin is at axle height, between the wheels). */
  hitboxOffset: { x: 13.8757 * UU, y: 0, z: 20.755 * UU },
  frontWheelRadius: 12.5 * UU,
  rearWheelRadius: 15.0 * UU,
  frontSuspensionRest: 38.755 * UU,
  rearSuspensionRest: 37.055 * UU,
  /** Wheel hardpoints relative to the car origin (y mirrored for left/right). */
  frontWheelOffset: { x: 51.25 * UU, y: 25.9 * UU, z: 20.755 * UU },
  rearWheelOffset: { x: -33.75 * UU, y: 29.5 * UU, z: 20.755 * UU },
  /** [RS] CAR_SPAWN_REST_Z: height of the car origin when resting on flat ground. */
  restZ: 17 * UU,
};

export const CAR = {
  mass: 180, // [RS] CAR_MASS_BT
  maxSpeed: 2300 * UU, // [RS] CAR_MAX_SPEED
  supersonicStartSpeed: 2200 * UU, // [RS]
  supersonicMaintainMinSpeed: 2100 * UU, // [RS]
  supersonicMaintainMaxTime: 1.0, // [RS]
  maxAngularSpeed: 5.5, // [RS] CAR_MAX_ANG_SPEED rad/s, clamped every tick, flips included

  // --- Wheels and suspension [RS] btVehicleRL.cpp + RLConst.h ---------------------
  /** Bullet raycast-vehicle spring: force = (rest - length) * stiffness * (1 / (normal·up)) - damping * relVel, then * forceScale, never negative. */
  suspensionStiffness: 500,
  suspensionDampingCompression: 25,
  suspensionDampingRelaxation: 40,
  suspensionForceScaleFront: 36 - 1 / 4, // = 35.75
  suspensionForceScaleBack: 54 + 1 / 4 + 1.5 / 100, // ≈ 54.265
  maxSuspensionTravel: 12 * UU,
  /** Subtracted from the wheel ray length. Given in BT units in RocketSim (0.05 BT = 2.5 uu). */
  suspensionSubtraction: 0.05 * BT,
  /** Bullet's default solverInfo.m_erp, used by the wheel "extra pushback" contact (resolveSingleCollision). */
  contactErp: 0.2,
  /** [RS] isOnGround when at least this many wheels touch something (the ball counts). */
  wheelsForGround: 3,

  // --- Driving [RS] Car.cpp -------------------------------------------------------
  /** THROTTLE_TORQUE_AMOUNT = mass * 400 per wheel -> 400 uu/s² per wheel, 1600 total. */
  throttleAccelPerWheel: 400 * UU,
  /** [RS] DRIVE_SPEED_TORQUE_FACTOR_CURVE: speed (uu/s) -> fraction of throttle force. */
  driveSpeedTorqueFactorCurve: [
    [0, 1.0],
    [1400, 0.1],
    [1410, 0.0],
  ] as [number, number][],
  /** BRAKE_TORQUE_AMOUNT = mass * (14.25 + 1/3) in BT -> 875 uu/s² per wheel at full brake, 3500 total. */
  brakeAccelPerWheel: (14.25 + 1 / 3) * BT,
  /** [RS] ROLLING_FRICTION_SCALE_MAGIC: rolling friction = clamp(-relVel * this, ±brake), BT units. */
  rollingFrictionScaleMagic: 113.73963,
  coastingBrakeFactor: 0.15, // [RS] COASTING_BRAKE_FACTOR
  stoppingForwardVel: 25 * UU, // [RS] STOPPING_FORWARD_VEL: below this, no-throttle = full brake
  brakingNoThrottleSpeedThresh: 0.01 * UU, // [RS]
  throttleDeadzone: 0.001, // [RS]
  airThrottleAccel: (200 / 3) * UU, // [RS] THROTTLE_AIR_ACCEL = 66.667
  /** [RS] wheel friction impulses are scaled by mass / 3 (frictionScale in calcFrictionImpulses). */
  frictionMassDivisor: 3,
  /** Bullet resolveSingleBilateral contact damping: side impulse = -0.2 * relVel / jacDiagAB. */
  bilateralContactDamping: 0.2,
  /** Wheel friction impulses are applied at the contact point projected to the chassis' up height. */

  /** [RS] STEER_ANGLE_FROM_SPEED_CURVE: speed (uu/s) -> front wheel steer angle (rad). */
  steerAngleFromSpeedCurve: [
    [0, 0.53356],
    [500, 0.3193],
    [1000, 0.18203],
    [1500, 0.1057],
    [1750, 0.08507],
    [3000, 0.03454],
  ] as [number, number][],
  /** [RS] POWERSLIDE_STEER_ANGLE_FROM_SPEED_CURVE */
  powerslideSteerAngleFromSpeedCurve: [
    [0, 0.39235],
    [2500, 0.1261],
  ] as [number, number][],
  /** [RS] Handbrake value ramps up at 5/s and down at 2/s. */
  powerslideRiseRate: 5,
  powerslideFallRate: 2,
  /**
   * [RS] Wheel friction curves. Input is the lateral slip ratio
   *   |v_lat| / (|v_lat| + |v_long|)  (0 if |v_lat| < 5 uu/s), output a friction multiplier.
   */
  latFrictionCurve: [
    [0, 1.0],
    [1, 0.2],
  ] as [number, number][],
  /** LONG_FRICTION_CURVE is empty in RocketSim (always 1). */
  handbrakeLatFrictionFactorCurve: [[0, 0.1]] as [number, number][],
  handbrakeLongFrictionFactorCurve: [
    [0, 0.5],
    [1, 0.9],
  ] as [number, number][],
  /** Applied to both friction values when there is no throttle; input is the contact normal's z (our y). */
  nonStickyFrictionFactorCurve: [
    [0, 0.1],
    [0.7075, 0.5],
    [1, 1.0],
  ] as [number, number][],
  latFrictionSlipMinSpeed: 5 * UU, // [RS] below this lateral speed the curve input is 0
  /**
   * [RS] Sticky force (Car.cpp): with any wheel contact, a central force of
   *   scale * gravity toward the surface, scale = 0.5 (+ 1 - |up.z| when throttling or moving).
   * On flat ground that is the community's "325 uu/s²"; on walls it rises to 975.
   */
  stickyBaseScale: 0.5,
  /** [WIKI] Measured turning curvature (1/uu) vs speed. Kept for reference/tests; the sim now steers the wheels. */
  turnCurvatureCurve: [
    [0, 0.0069],
    [500, 0.00398],
    [1000, 0.00235],
    [1500, 0.001375],
    [1750, 0.0011],
    [2300, 0.00088],
  ] as [number, number][],

  // --- Boost [RS] -------------------------------------------------------------------
  boostAccelGround: (2975 / 3) * UU, // = 991.667
  boostAccelAir: (3175 / 3) * UU, // = 1058.333
  boostMax: 100,
  boostSpawnAmount: 100 / 3, // BOOST_SPAWN_AMOUNT: boost at kickoff
  boostUsedPerSecond: 100 / 3,
  boostMinTime: 0.1, // once started, boost stays on at least this long

  // --- Jumping [RS] -----------------------------------------------------------------
  jumpImmediateForce: (875 / 3) * UU, // = 291.667 uu/s instant velocity
  jumpAccel: (4375 / 3) * UU, // = 1458.333 uu/s² while holding
  jumpPreMinAccelScale: 0.62, // acceleration scale before jumpMinTime
  jumpMinTime: 0.025,
  jumpMaxTime: 0.2,
  jumpResetTimePad: 1 / 40, // hasJumped is not cleared by ground contact before jumpMinTime + this
  doubleJumpMaxDelay: 1.25, // window after the FIRST jump ENDS; a car that fell off a surface without jumping can flip any time
  doubleJumpImpulse: (875 / 3) * UU,

  // --- Flips (dodges) [RS] ----------------------------------------------------------
  flipInitialVelScale: 500 * UU,
  flipTorqueTime: 0.65,
  flipTorqueMinTime: 0.41,
  flipPitchLockTime: 1.0,
  flipPitchLockExtraTime: 0.3,
  flipZDamp120: 0.35, // per-tick factor applied to vertical velocity while flipping
  flipZDampStart: 0.15,
  flipZDampEnd: 0.21,
  /** Applied straight as angular acceleration (rad/s²) about the car's local axes; the 5.5 cap is hit in 3 ticks. */
  flipTorqueX: 260, // side flips (roll)
  flipTorqueY: 224, // front/back flips (pitch)
  flipForwardImpulseMaxSpeedScale: 1.0,
  flipSideImpulseMaxSpeedScale: 1.9,
  flipBackwardImpulseMaxSpeedScale: 2.5,
  flipBackwardImpulseScaleX: 16 / 15,
  flipDodgeDeadzone: 0.1,
  flipBackwardSpeedThreshold: 100 * UU,
  /** Flip cancel: pitch input with the same sign as the flip's pitch torque scales that torque by (1 - |pitch|). */

  // --- Air control [RS] -------------------------------------------------------------
  /** CAR_TORQUE_SCALE converts the raw torque/damping constants to rad/s² and 1/s. */
  torqueScale: ((2 * Math.PI) / 65536) * 1000,
  airControlTorque: { pitch: 130, yaw: 95, roll: 400 }, // CAR_AIR_CONTROL_TORQUE
  airControlDamping: { pitch: 30, yaw: 20, roll: 50 }, // CAR_AIR_CONTROL_DAMPING
  /** Damping on each axis is multiplied by (1 - |input on that axis|). */

  // --- Recovery [RS] ----------------------------------------------------------------
  autoflipImpulse: 200 * UU, // along -carUp
  autoflipTorque: 50, // rad/s² about carForward
  autoflipTime: 0.4, // scaled by |roll| / π
  autoflipNormalZThreshold: Math.SQRT1_2,
  autoflipRollThreshold: 2.8,
  autorollForce: 100 * UU,
  autorollTorque: 80,

  /** [RS] Contact materials. */
  worldFriction: 0.3, // CARWORLD_COLLISION_FRICTION
  worldRestitution: 0.3, // CARWORLD_COLLISION_RESTITUTION
  carFriction: 0.09,
  carRestitution: 0.1,
};

// ---------------------------------------------------------------------------------
// Boost pads [RS] (not implemented, kept for later)
// ---------------------------------------------------------------------------------
export const BOOST_PADS = {
  bigAmount: 100,
  smallAmount: 12,
  bigCooldown: 10,
  smallCooldown: 4,
  cylinderHeight: 95 * UU,
  cylinderRadiusBig: 208 * UU,
  cylinderRadiusSmall: 144 * UU,
  boxHeight: 64 * UU,
  boxRadiusBig: 160 * UU,
  boxRadiusSmall: 120 * UU,
  bigLocations: [
    [-3584, 0],
    [3584, 0],
    [-3072, 4096],
    [3072, 4096],
    [-3072, -4096],
    [3072, -4096],
  ] as [number, number][],
  smallLocations: [
    [0, -4240], [-1792, -4184], [1792, -4184], [-940, -3308], [940, -3308], [0, -2816],
    [-3584, -2484], [3584, -2484], [-1788, -2300], [1788, -2300], [-2048, -1036], [0, -1024],
    [2048, -1036], [-1024, 0], [1024, 0], [-2048, 1036], [0, 1024], [2048, 1036],
    [-1788, 2300], [1788, 2300], [-3584, 2484], [3584, 2484], [0, 2816], [-940, 3308],
    [940, 3308], [-1792, 4184], [1792, 4184], [0, 4240],
  ] as [number, number][],
};

/** [RS] CAR_SPAWN_LOCATIONS_SOCCAR for the blue team: [x, y, yaw] with yaw measured from +x toward +y. */
/**
 * Demolitions, measured against car-soccer.com's RocketSim build by driving one car into another
 * at a range of speeds and reading the DEMOED flag out of its state:
 *  - a hit demolishes only when the attacking car's SUPERSONIC flag is set. Contacts at up to
 *    1508 uu/s relative with the flag clear always bumped instead, and a hit at only 1040 uu/s
 *    relative demolished once the flag was set (it lingers for a second after dropping below
 *    2200, which is why the trigger is the flag and not the instantaneous speed).
 *  - the victim respawns after exactly 360 ticks, 3.0 s.
 */
export const DEMO = {
  respawnTime: 3.0, // [RS] measured: 360 ticks at 120 Hz
};

export const KICKOFF_SPAWNS: [number, number, number][] = [
  [-2048, -2560, Math.PI / 4],
  [2048, -2560, (Math.PI / 4) * 3],
  [-256, -3840, Math.PI / 2],
  [256, -3840, Math.PI / 2],
  [0, -4608, Math.PI / 2],
];

/** Piecewise-linear lookup on a [[x, y], ...] table, clamped at both ends. */
export function curve(table: [number, number][], x: number): number {
  if (x <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i++) {
    const [x1, y1] = table[i];
    if (x <= x1) {
      const [x0, y0] = table[i - 1];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return table[table.length - 1][1];
}
