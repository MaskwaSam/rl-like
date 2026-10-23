/**
 * APPROXIMATIONS AND INVENTED VALUES.
 *
 * Nothing in this file is a verified Rocket League number. Each entry says what the real game
 * does instead and why we approximate. When a value here gets replaced by the real mechanism,
 * move the mechanism's constants to ./rl.ts and delete the entry.
 */
import { UU } from './rl';

export const TUNING = {
  // ------------------------------------------------------------------------------
  // Car body model
  // ------------------------------------------------------------------------------
  /**
   * We simulate the car as a single filled Octane hitbox whose centre of mass IS the hitbox
   * centre, with the inertia of a uniform box of that size and RL's 180 mass. RL's rigid body
   * origin sits 13.9 uu behind and 20.8 uu below the hitbox centre (OCTANE.hitboxOffset), and
   * RocketSim reports that these hitbox extents reproduce RL's inertia tensor, so rotations
   * happen about a slightly different point than in RL.
   */
  bodyAtHitboxCentre: true,

  // ------------------------------------------------------------------------------
  // Wheels
  // ------------------------------------------------------------------------------
  /**
   * The wheel model (suspension springs, friction curves, sticky force, steer curves) now
   * follows RocketSim's btVehicleRL. Two things are still ours:
   *  - Bullet's resolveSingleBilateral uses the full solver Jacobian between chassis and
   *    ground; we compute it analytically for a static ground (1/m + (r×a)·I⁻¹(r×a)).
   *  - RL's "extra pushback" when a wheel ray penetrates static geometry is omitted; Rapier's
   *    hitbox collision handles deep penetration instead.
   */

  /**
   * Zero-force suspension length from the hardpoint to the ground, per axle. Measured on
   * car-soccer.com's RocketSim build: the Octane settles at origin z = 17.03, pitched 0.55° nose
   * down, with suspension lengths (trace minus wheel radius) of 24.79 front and 23.11 rear. Their
   * difference equals the config rest lengths' difference (38.755 - 37.055 = 1.70), so RocketSim
   * uses the config values minus a common offset; with our identical spring law and 0.5 g sticky
   * force that offset comes out at 12.115 uu, i.e. the unloaded trace is config - 12.115 + radius.
   * Using the raw config values as trace lengths left our car 1.9 uu low and level.
   */
  suspensionRestOffset: 12.115 * UU,

  // ------------------------------------------------------------------------------
  // Recovery
  // ------------------------------------------------------------------------------
  /**
   * RL's autoroll applies torque 80 through the inertia tensor toward the ground frame. We use
   * a proportional alignment of the car's up vector toward the surface normal.
   */
  autorollAlignGain: 6, // 1/s

  // ------------------------------------------------------------------------------
  // Contact materials
  // ------------------------------------------------------------------------------
  /**
   * RL wants ball-arena restitution 0.6, car-arena 0.3 and car-ball 0.0. Rapier combines per pair
   * with one rule chosen by priority (Max > Multiply > Min > Average) and no assignment
   * reproduces all three. We use ball 0 (Max), arena 0.6 (Min), car 0 (Min), which gives
   * ball-arena 0.6 and car-ball 0.0 exactly and car-arena 0.0 (RL 0.3): cars slide along walls
   * instead of bouncing slightly. Friction is exact for the pairs that matter:
   * ball 2.0 (Min), arena 0.35 (Min), car 0.3 (Max) -> ball-arena 0.35, car-ball 2.0, car-arena 0.35 (RL 0.3).
   */
  carArenaRestitutionActual: 0.0,
  carArenaFrictionActual: 0.35,

  // ------------------------------------------------------------------------------
  // Arena shape
  // ------------------------------------------------------------------------------
  /**
   * RL's arena is a hand-modelled collision mesh that we cannot distribute (RocketSim loads it from
   * the game files). These radii were MEASURED from that mesh: side-wall floor ramp and corner ramps
   * are circular r = 256; the back-wall floor ramp is smaller, r = 160; every wall meets the ceiling
   * with an r = 550 arc; the flat 45° corner wall on |x|+|y| = 8064 blends into the back wall with an
   * ~800 arc and into the side wall with an ~680 arc. The goal is a tube (see GOAL_PROFILE in
   * rl.ts): quarter-pipe back r = 256 curling forward, roof sloping 477 → 640, flat lintel. Our
   * analytic mesh reproduces those with flat facets. Still approximate: the ~96 uu fillets where
   * the goal roof meets the netting and where the posts meet the back-wall ramp are square here.
   */
  arenaSideRampRadius: 256 * UU,
  arenaBackRampRadius: 160 * UU,
  arenaCeilingRadius: 550 * UU,
  arenaCornerBlendBack: 800 * UU,
  arenaCornerBlendSide: 680 * UU,
  rampSegments: 12, // 7.5° facets on the floor ramps
  ceilingSegments: 8,
  cornerBlendSegments: 5,
  wallThickness: 1.0, // m, for the box colliders behind the goal mouths

  // ------------------------------------------------------------------------------
  // Car-car contact
  // ------------------------------------------------------------------------------
  /**
   * RL adds a bump impulse on top of the rigid-body collision, from a speed curve. Driving cars
   * into each other on RocketSim gave victim velocity changes of roughly 140-230 uu/s at 1410 uu/s
   * of relative speed, but the measurement could not separate the bump from the collision cleanly
   * enough to fit the curve, so this is a straight proportion with RL's upward kick, clamped.
   */
  bumpVelPerRelSpeed: 0.12,
  bumpMaxVel: 350 * UU,
  bumpUpwardFraction: 0.2,
  /** One bump per pair per this long, so a resting contact does not machine-gun impulses. */
  bumpCooldown: 0.25,

  // ------------------------------------------------------------------------------
  // Match flow
  // ------------------------------------------------------------------------------
  goalResetDelay: 2.0, // s. RL shows a replay; there is no physics value to match.
  /** Height to drop the car from at kickoff so the suspension settles. */
  spawnDropHeight: 0.02, // m above rest height
};
