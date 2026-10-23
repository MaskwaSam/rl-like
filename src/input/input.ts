import type { CarInput, FrameInput } from './types';
import type { Settings } from '../settings';

const STORAGE_KEY = 'rl-like.bindings.v1';
const NAV_STICK_THRESHOLD = 0.6;

/** Rebindable actions. Steering / pitch axes are fixed (left stick, WASD / arrows). */
export const ACTIONS = [
  'throttle',
  'reverse',
  'jump',
  'boost',
  'handbrake',
  'airRoll',
  'airRollLeft',
  'airRollRight',
  'ballCam',
  'reset',
  'menu',
] as const;
export type Action = (typeof ACTIONS)[number];

export const ACTION_LABELS: Record<Action, string> = {
  throttle: 'Throttle',
  reverse: 'Reverse',
  jump: 'Jump / dodge',
  boost: 'Boost',
  handbrake: 'Powerslide',
  airRoll: 'Air roll (free)',
  airRollLeft: 'Air roll left',
  airRollRight: 'Air roll right',
  ballCam: 'Toggle ball cam',
  reset: 'Reset match',
  menu: 'Menu',
};

export interface Bindings {
  /** Standard-mapping gamepad button index per action. */
  gamepad: Record<Action, number>;
  /** KeyboardEvent.code per action. */
  keyboard: Record<Action, string>;
}

export const DEFAULT_BINDINGS: Bindings = {
  gamepad: {
    throttle: 7, // RT
    reverse: 6, // LT
    jump: 0, // A
    boost: 1, // B
    handbrake: 2, // X
    airRoll: 2, // X (RL also defaults both to the same button)
    airRollLeft: 4, // LB
    airRollRight: 5, // RB
    ballCam: 3, // Y
    reset: 8, // Back / Share
    menu: 9, // Start / Options
  },
  keyboard: {
    throttle: 'KeyW',
    reverse: 'KeyS',
    jump: 'Space',
    boost: 'ShiftLeft',
    handbrake: 'ShiftRight',
    airRoll: 'ShiftRight',
    airRollLeft: 'KeyQ',
    airRollRight: 'KeyE',
    ballCam: 'KeyC',
    reset: '',
    menu: 'Escape',
  },
};

/** Menu navigation uses the standard layout regardless of bindings. */
const NAV = { accept: 0, back: 1, up: 12, down: 13, left: 14, right: 15 };

const GAMEPAD_BUTTON_NAMES = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'Back', 'Start', 'LS', 'RS', 'D-Up', 'D-Down', 'D-Left', 'D-Right', 'Home'];

export function gamepadButtonName(index: number): string {
  return GAMEPAD_BUTTON_NAMES[index] ?? `Button ${index}`;
}

export function keyName(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  return code.replace('Left', ' L').replace('Right', ' R').replace('Arrow', '');
}

export function loadBindings(): Bindings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return structuredClone(DEFAULT_BINDINGS);
    const parsed = JSON.parse(raw) as Partial<Bindings> & { version?: number };
    const bindings: Bindings = {
      gamepad: { ...DEFAULT_BINDINGS.gamepad, ...(parsed.gamepad ?? {}) },
      keyboard: { ...DEFAULT_BINDINGS.keyboard, ...(parsed.keyboard ?? {}) },
    };
    // Clear the former default once, while preserving other customized controls.
    // A player can still deliberately bind R again after this migration.
    if (parsed.version !== 2 && bindings.keyboard.reset === 'KeyR') {
      bindings.keyboard.reset = '';
      saveBindings(bindings);
    }
    return bindings;
  } catch {
    return structuredClone(DEFAULT_BINDINGS);
  }
}

export function saveBindings(b: Bindings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...b, version: 2 }));
  } catch {
    /* storage unavailable; bindings stay in memory */
  }
}

export type Captured = { kind: 'gamepad'; button: number } | { kind: 'key'; code: string };

function pressed(gp: Gamepad, i: number): boolean {
  const b = gp.buttons[i];
  return !!b && (b.pressed || b.value > 0.5);
}

function value(gp: Gamepad, i: number): number {
  const b = gp.buttons[i];
  if (!b) return 0;
  return b.value > 0 ? b.value : b.pressed ? 1 : 0;
}

/**
 * Reads keyboard and the first connected gamepad every frame and produces one CarInput plus
 * menu navigation. Gamepad wins over keyboard when it is connected and any control is active.
 */
export class InputManager {
  bindings: Bindings = loadBindings();

  private keys = new Set<string>();
  private tapped = new Set<string>();
  private gamepadIndex: number | null = null;
  private prevReset = false;
  private prevToggleCam = false;
  private prevMenu = false;
  private prevAccept = false;
  private prevBack = false;
  private prevButtons: boolean[] = [];
  private capture: ((c: Captured) => void) | null = null;
  private blockJump = false;

  onControllerChange: ((name: string | null) => void) | null = null;

  constructor(private readonly settings: Settings) {
    window.addEventListener('keydown', (e) => {
      if (isTextField(e.target)) return; // typing a name or room code
      if (this.capture) {
        e.preventDefault();
        if (e.code !== 'Escape') this.finishCapture({ kind: 'key', code: e.code });
        else this.cancelCapture();
        return;
      }
      if (e.repeat) return;
      this.keys.add(e.code);
      this.tapped.add(e.code); // latched until the next poll so short taps survive slow frames
      // Enter is handled by menu navigation. Native button activation can otherwise fire
      // the last mouse-focused button as well as the current keyboard/gamepad selection.
      if (['Space', 'Enter', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());

    window.addEventListener('gamepadconnected', (e) => {
      if (this.gamepadIndex === null) this.gamepadIndex = e.gamepad.index;
      this.onControllerChange?.(this.currentGamepad()?.id ?? null);
    });
    window.addEventListener('gamepaddisconnected', (e) => {
      if (this.gamepadIndex === e.gamepad.index) this.gamepadIndex = null;
      this.onControllerChange?.(this.currentGamepad()?.id ?? null);
    });
  }

  /** Next gamepad button or key press is reported to `cb` instead of driving the car. Escape cancels. */
  startCapture(cb: (c: Captured) => void): void {
    this.capture = cb;
  }

  cancelCapture(): void {
    this.capture = null;
  }

  get capturing(): boolean {
    return this.capture !== null;
  }

  /** Controller vibration (dual-rumble), if the connected pad supports it. Intensities 0..1, duration ms. */
  rumble(strong: number, weak: number, ms: number): void {
    const gp = this.currentGamepad();
    const act = (gp as (Gamepad & { vibrationActuator?: { playEffect?: (type: string, params: object) => Promise<unknown> } }) | null)?.vibrationActuator;
    if (!act?.playEffect) return;
    try {
      void act.playEffect('dual-rumble', { startDelay: 0, duration: ms, strongMagnitude: Math.min(1, strong), weakMagnitude: Math.min(1, weak) }).catch(() => {});
    } catch {
      /* unsupported */
    }
  }

  /** Ignore the jump button until it is released, so the press that closed the menu does not jump. */
  blockJumpUntilRelease(): void {
    this.blockJump = true;
  }

  private finishCapture(c: Captured): void {
    const cb = this.capture;
    this.capture = null;
    cb?.(c);
  }

  rebind(action: Action, c: Captured): void {
    if (c.kind === 'gamepad') this.bindings.gamepad[action] = c.button;
    else this.bindings.keyboard[action] = c.code;
    saveBindings(this.bindings);
  }

  resetBindings(): void {
    this.bindings = structuredClone(DEFAULT_BINDINGS);
    saveBindings(this.bindings);
  }

  private currentGamepad(): Gamepad | null {
    if (typeof navigator.getGamepads !== 'function') return null;
    const pads = navigator.getGamepads();
    if (this.gamepadIndex !== null) {
      const gp = pads[this.gamepadIndex];
      if (gp && gp.connected) return gp;
      this.gamepadIndex = null;
    }
    // Chrome only exposes a pad after a button press and may not fire `gamepadconnected`. Poll.
    for (const gp of pads) {
      if (gp && gp.connected) {
        this.gamepadIndex = gp.index;
        this.onControllerChange?.(gp.id);
        return gp;
      }
    }
    return null;
  }

  /** Radial deadzone with rescaling, then sensitivity, clamped to ±1. */
  private stick(raw: number, sensitivity: number): number {
    const dz = this.settings.controls.deadzone;
    const a = Math.abs(raw);
    if (a < dz) return 0;
    const scaled = ((a - dz) / (1 - dz)) * sensitivity;
    return Math.sign(raw) * Math.min(1, scaled);
  }

  poll(): FrameInput {
    const gp = this.currentGamepad();

    if (gp) {
      const now = gp.buttons.map((_, i) => pressed(gp, i));
      if (this.capture) {
        for (let i = 0; i < now.length; i++) {
          if (now[i] && !this.prevButtons[i]) {
            this.prevButtons = now;
            this.finishCapture({ kind: 'gamepad', button: i });
            break;
          }
        }
      }
      this.prevButtons = now;
    }

    if (isTextField(document.activeElement)) this.keys.clear();
    const kb = this.readKeyboard();
    const pad = gp ? this.readGamepad(gp) : null;
    const car: CarInput = this.capture ? zeroed() : pad && isActive(pad) ? pad : kb;
    if (this.blockJump) {
      if (!car.jump) this.blockJump = false;
      car.jump = false;
    }

    const g = this.bindings.gamepad;
    const k = this.bindings.keyboard;
    // One-shot actions: a key counts if it is held now OR was tapped since the last poll.
    const typing = isTextField(document.activeElement);
    const key = (code: string) => !!code && !typing && (this.keys.has(code) || this.tapped.has(code));
    const reset = !this.capture && (key(k.reset) || (!!gp && pressed(gp, g.reset)));
    const toggleCam = !this.capture && (key(k.ballCam) || (!!gp && pressed(gp, g.ballCam)));
    const menu = !this.capture && (key(k.menu) || (!!gp && pressed(gp, g.menu)));

    // Menu navigation: D-pad or left stick, A / Enter accepts, B / Backspace goes back.
    const ax = gp ? (gp.axes[0] ?? 0) : 0;
    const ay = gp ? (gp.axes[1] ?? 0) : 0;
    const upHeld = key('ArrowUp') || (!!gp && (pressed(gp, NAV.up) || ay < -NAV_STICK_THRESHOLD));
    const downHeld = key('ArrowDown') || (!!gp && (pressed(gp, NAV.down) || ay > NAV_STICK_THRESHOLD));
    const leftHeld = key('ArrowLeft') || (!!gp && (pressed(gp, NAV.left) || ax < -NAV_STICK_THRESHOLD));
    const rightHeld = key('ArrowRight') || (!!gp && (pressed(gp, NAV.right) || ax > NAV_STICK_THRESHOLD));
    const accept = !this.capture && (key('Enter') || (!!gp && pressed(gp, NAV.accept)));
    const back = !this.capture && (key('Backspace') || (!!gp && pressed(gp, NAV.back)));
    this.tapped.clear();

    const frame: FrameInput = {
      car,
      resetPressed: reset && !this.prevReset,
      toggleCameraPressed: toggleCam && !this.prevToggleCam,
      menuPressed: menu && !this.prevMenu,
      controllerName: gp?.id ?? null,
      nav: {
        upHeld,
        downHeld,
        leftHeld,
        rightHeld,
        accept: accept && !this.prevAccept,
        back: back && !this.prevBack,
      },
    };
    this.prevReset = reset;
    this.prevToggleCam = toggleCam;
    this.prevMenu = menu;
    this.prevAccept = accept;
    this.prevBack = back;
    return frame;
  }

  private readGamepad(gp: Gamepad): CarInput {
    const g = this.bindings.gamepad;
    const c = this.settings.controls;
    const lxSteer = this.stick(gp.axes[0] ?? 0, c.steeringSensitivity);
    const lxAir = this.stick(gp.axes[0] ?? 0, c.aerialSensitivity);
    const lyAir = this.stick(gp.axes[1] ?? 0, c.aerialSensitivity);
    const handbrake = pressed(gp, g.handbrake);
    const airRoll = pressed(gp, g.airRoll);
    const rollButtons = (pressed(gp, g.airRollRight) ? 1 : 0) - (pressed(gp, g.airRollLeft) ? 1 : 0);
    return {
      throttle: clamp(value(gp, g.throttle) - value(gp, g.reverse)),
      steer: lxSteer,
      pitch: lyAir, // stick back (positive) = nose up
      yaw: airRoll ? 0 : lxAir,
      roll: airRoll ? lxAir : rollButtons,
      jump: pressed(gp, g.jump),
      boost: pressed(gp, g.boost),
      handbrake,
      airRoll,
    };
  }

  private readKeyboard(): CarInput {
    const k = this.keys;
    const b = this.bindings.keyboard;
    const fwd = (k.has(b.throttle) || k.has('ArrowUp') ? 1 : 0) - (k.has(b.reverse) || k.has('ArrowDown') ? 1 : 0);
    const side = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    const handbrake = k.has(b.handbrake);
    const airRoll = k.has(b.airRoll);
    const roll = (k.has(b.airRollRight) ? 1 : 0) - (k.has(b.airRollLeft) ? 1 : 0);
    return {
      throttle: fwd,
      steer: side,
      pitch: -fwd, // forward key pitches the nose down like pushing the stick forward
      yaw: airRoll ? 0 : side,
      roll: airRoll ? side : roll,
      jump: k.has(b.jump),
      boost: k.has(b.boost),
      handbrake,
      airRoll,
    };
  }
}

/** True while a text field has focus, so keys type instead of driving or navigating. */
export function isTextField(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');
}

function zeroed(): CarInput {
  return { throttle: 0, steer: 0, pitch: 0, yaw: 0, roll: 0, jump: false, boost: false, handbrake: false, airRoll: false };
}

function isActive(i: CarInput): boolean {
  return i.throttle !== 0 || i.steer !== 0 || i.pitch !== 0 || i.roll !== 0 || i.jump || i.boost || i.handbrake || i.airRoll;
}

function clamp(v: number): number {
  return Math.max(-1, Math.min(1, v));
}
