/** Per-tick control state for one car. All analog values are in [-1, 1]. */
export interface CarInput {
  /** +1 forward, -1 reverse */
  throttle: number;
  /** +1 right */
  steer: number;
  /** +1 nose up (stick pulled back) */
  pitch: number;
  /** +1 right, only used while airborne */
  yaw: number;
  /** +1 roll right, only used while airborne */
  roll: number;
  jump: boolean;
  boost: boolean;
  /** Powerslide (ground only). */
  handbrake: boolean;
  /** Free air roll held: the stick's X axis rolls instead of yawing. Already folded into yaw/roll. */
  airRoll: boolean;
}

export const EMPTY_INPUT: CarInput = {
  throttle: 0,
  steer: 0,
  pitch: 0,
  yaw: 0,
  roll: 0,
  jump: false,
  boost: false,
  handbrake: false,
  airRoll: false,
};

/** What the input layer hands the frame loop: car controls plus one-shot UI actions. */
export interface FrameInput {
  car: CarInput;
  resetPressed: boolean;
  toggleCameraPressed: boolean;
  menuPressed: boolean;
  controllerName: string | null;
  /** Menu navigation. `*Held` are current states, `accept`/`back` are press edges. */
  nav: {
    upHeld: boolean;
    downHeld: boolean;
    leftHeld: boolean;
    rightHeld: boolean;
    accept: boolean;
    back: boolean;
  };
}
