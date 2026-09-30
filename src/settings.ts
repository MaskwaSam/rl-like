/**
 * Player settings, modelled on Rocket League's Camera and Controls menus.
 * Values are in RL's own units (uu, degrees) and converted where consumed.
 */

export interface Settings {
  camera: {
    /** Horizontal field of view in degrees. RL: 60–110, default 110. */
    fov: number;
    /** Distance behind the car in uu. RL: 100–400, default 270. */
    distance: number;
    /** Height above the car in uu. RL: 40–200, default 110. */
    height: number;
    /** Camera pitch offset in degrees, negative looks down. RL: -15–0, default -3. */
    angle: number;
    /** How quickly the camera follows. RL: 0–1, default 0.5. */
    stiffness: number;
  };
  controls: {
    /** Multiplier on stick steering, clamped to 1. RL: 1–10, default 1. */
    steeringSensitivity: number;
    /** Multiplier on stick pitch/yaw/roll in the air. RL: 1–10, default 1. */
    aerialSensitivity: number;
    /** Radial stick deadzone. RL: 0.05–0.5, default 0.5 (we default lower). */
    deadzone: number;
    /** Stick magnitude needed for a dodge instead of a double jump. RL: 0.5–0.9, default 0.5. */
    dodgeDeadzone: number;
  };
  audio: {
    /** Master volume 0–1. */
    volume: number;
  };
  graphics: {
    /** 0 Low, 1 Medium, 2 High. See GRAPHICS_DEFS. */
    quality: number;
  };
  car: {
    /** Index into CAR_BODIES (render/cars.ts). Chosen in the Garage. */
    body: number;
  };
}

/** Defaults follow the most common pro camera: FOV 110, distance 270, height 100, angle -3, stiffness 0.45. */
export const DEFAULT_SETTINGS: Settings = {
  camera: { fov: 110, distance: 270, height: 100, angle: -3, stiffness: 0.45 },
  controls: { steeringSensitivity: 1.0, aerialSensitivity: 1.0, deadzone: 0.2, dodgeDeadzone: 0.5 },
  audio: { volume: 0.6 },
  graphics: { quality: 1 },
  car: { body: 0 },
};

export type SettingSection = keyof Settings;

export interface SettingDef {
  section: SettingSection;
  key: string;
  label: string;
  /** One or two sentences shown under the label. */
  description: string;
  min: number;
  max: number;
  step: number;
  unit?: string;
  decimals: number;
  /** Names shown instead of the number, indexed by value (for stepped choices like quality). */
  labels?: string[];
}

export const CAMERA_DEFS: SettingDef[] = [
  {
    section: 'camera',
    key: 'fov',
    label: 'Field of view',
    description: 'How wide the camera sees, in degrees. Higher shows more of the field but makes the ball look smaller and farther away.',
    min: 60,
    max: 110,
    step: 1,
    unit: '°',
    decimals: 0,
  },
  {
    section: 'camera',
    key: 'distance',
    label: 'Distance',
    description: 'How far the camera sits behind the car. Higher shows more of your surroundings; lower keeps the car large and close.',
    min: 100,
    max: 400,
    step: 10,
    decimals: 0,
  },
  {
    section: 'camera',
    key: 'height',
    label: 'Height',
    description: 'How high the camera sits above the car. Higher gives a more top-down view of the ball and floor.',
    min: 40,
    max: 200,
    step: 10,
    decimals: 0,
  },
  {
    section: 'camera',
    key: 'angle',
    label: 'Angle',
    description: 'Tilts the camera down (negative) or level. More negative shows more floor and less sky.',
    min: -15,
    max: 0,
    step: 1,
    unit: '°',
    decimals: 0,
  },
  {
    section: 'camera',
    key: 'stiffness',
    label: 'Stiffness',
    description: 'How tightly the camera follows the car. 0 lags and floats, giving a sense of speed; 1 locks the car in place on screen.',
    min: 0,
    max: 1,
    step: 0.05,
    decimals: 2,
  },
];

export const CONTROL_DEFS: SettingDef[] = [
  {
    section: 'controls',
    key: 'steeringSensitivity',
    label: 'Steering sensitivity',
    description: 'Multiplies the stick when steering on the ground. Above 1 you reach full lock with less stick travel; it never exceeds full lock.',
    min: 1,
    max: 10,
    step: 0.1,
    decimals: 1,
  },
  {
    section: 'controls',
    key: 'aerialSensitivity',
    label: 'Aerial sensitivity',
    description: 'Multiplies the stick for pitch, yaw and air roll in the air. Higher makes small stick movements rotate the car faster.',
    min: 1,
    max: 10,
    step: 0.1,
    decimals: 1,
  },
  {
    section: 'controls',
    key: 'deadzone',
    label: 'Controller deadzone',
    description: 'Stick movement below this is ignored, which hides drift from a worn stick. Lower feels more responsive; too low and the car twitches on its own.',
    min: 0.05,
    max: 0.5,
    step: 0.05,
    decimals: 2,
  },
  {
    section: 'controls',
    key: 'dodgeDeadzone',
    label: 'Dodge deadzone',
    description: 'How far the stick must be pushed when you press jump in the air to dodge instead of double-jumping. Higher makes accidental flips less likely.',
    min: 0.5,
    max: 0.9,
    step: 0.05,
    decimals: 2,
  },
  {
    section: 'audio',
    key: 'volume',
    label: 'Sound volume',
    description: 'Master volume for engine, boost, hits and goals.',
    min: 0,
    max: 1,
    step: 0.05,
    decimals: 2,
  },
];

export const GRAPHICS_DEFS: SettingDef[] = [
  {
    section: 'graphics',
    key: 'quality',
    label: 'Graphics quality',
    description: 'Low is the original lightweight look, for older laptops. Medium adds smooth edges and glowing lights. High adds real shadows.',
    min: 0,
    max: 2,
    step: 1,
    decimals: 0,
    labels: ['Low', 'Medium', 'High'],
  },
];

const STORAGE_KEY = 'rl-like.settings.v1';

export function loadSettings(): Settings {
  const s = structuredClone(DEFAULT_SETTINGS);
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return s;
    const parsed = JSON.parse(raw) as Partial<Record<SettingSection, Record<string, number>>>;
    for (const section of ['camera', 'controls', 'audio', 'graphics', 'car'] as SettingSection[]) {
      const target = s[section] as unknown as Record<string, number>;
      for (const [k, v] of Object.entries(parsed[section] ?? {})) {
        if (k in target && typeof v === 'number' && Number.isFinite(v)) target[k] = v;
      }
    }
  } catch {
    /* fall through to defaults */
  }
  return s;
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable */
  }
}

export function getSetting(s: Settings, def: SettingDef): number {
  return (s[def.section] as unknown as Record<string, number>)[def.key];
}

export function setSetting(s: Settings, def: SettingDef, value: number): void {
  const v = Math.min(def.max, Math.max(def.min, Math.round(value / def.step) * def.step));
  (s[def.section] as unknown as Record<string, number>)[def.key] = +v.toFixed(def.decimals);
}
