import * as THREE from 'three';
import { UU } from '../sim/rl';
import type { Settings } from '../settings';

const carPos = new THREE.Vector3();
const ballPos = new THREE.Vector3();
const carFwd = new THREE.Vector3();
const carUp = new THREE.Vector3();
const pivot = new THREE.Vector3();
const dir = new THREE.Vector3();
const tmp = new THREE.Vector3();
const desired = new THREE.Vector3();
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const DEG = Math.PI / 180;

/** Camera never goes below this height: RL's floor clamp (10 uu). */
const MIN_CAMERA_HEIGHT = 10 * UU;
/** First-order lag rates of the view direction, measured from car-soccer.com's camera kernel. */
const BALL_CAM_RATE = 8.6;
const CAR_CAM_RATE = 24.7;
/** Ball cam: the pivot rises 0.9 uu per degree of the ball's elevation. */
const PIVOT_RISE_PER_DEG = 0.9 * UU;
/** Ball cam: pitch blends from `angle` to the ball's elevation, ramping 0 → 0.8 between 22° and 44° of elevation. */
const BLEND_START = 22 * DEG;
const BLEND_END = 44 * DEG;
const BLEND_MAX = 0.8;
/** Stiffness: the arm grows by (1 - stiffness) * speed / 20 (uu per uu/s). */
const SPEED_TRAIL = 1 / 20;
/** Supersonic widens the horizontal FOV by this much. */
const SUPERSONIC_FOV_BOOST = 10;
/** Car cam on a surface follows the nose pitch by this fraction (slightly less at steep angles). */
const NOSE_FOLLOW = (noseRad: number) => 0.785 - 0.001 * Math.abs(noseRad) / DEG;
/** Car cam on a surface rolls with a tenth of the car's bank. */
const BANK_FOLLOW = 0.1;

export interface CameraCarState {
  /** Three or more wheels on a surface. */
  grounded: boolean;
  /** Car speed in m/s. */
  speed: number;
  supersonic: boolean;
}

/**
 * Rocket League chase camera, reproduced from measurements of car-soccer.com's camera kernel
 * (which runs RL's own camera rules). Everything below was fitted to that kernel's outputs
 * over dozens of probed scenes and matches it to within a degree and a few uu.
 *
 * Common: a pivot sits `height` above the car. The camera is pulled `distance` back from the
 * pivot along the smoothed view direction (so the `angle` tilt also raises the camera), the arm
 * grows with speed by (1 - stiffness) * speed / 20, and the camera never goes below 10 uu.
 * The view direction eases toward its target with a first-order lag. FOV is horizontal and
 * widens by 10° while supersonic.
 *
 * Ball cam: the pivot uses world up and rises by 0.9 uu per degree of the ball's elevation.
 * Yaw points at the ball. Pitch is a blend of `angle` and the ball's elevation E from the pivot:
 * weight 0 below 22°, ramping to 0.8 at 44° and staying there. So a very high ball is followed
 * only 80% of the way and the car can leave the frame, exactly as in RL.
 *
 * Car cam: yaw follows the nose heading, holding through flips (a heading jump past 90° is
 * ignored) and near-vertical noses. In the air the pitch is just `angle` and the roll is level,
 * so air rolls and flips leave the view alone. On a surface the pivot rides the car's up, the
 * pitch follows about three quarters of the nose pitch and the roll a tenth of the bank.
 */
export class FollowCamera {
  ballCam = true;
  private initialized = false;
  private wasBallCam = true;
  /** Smoothed view direction. */
  private readonly viewDir = new THREE.Vector3(0, 0, -1);
  /** Smoothed heading (rad, our convention: 0 faces -Z) for the car cam. */
  private yaw = 0;
  /** The car's own heading last frame, to spot the jump a flip makes. NaN until first seen. */
  private lastCarYaw = Number.NaN;
  /** Smoothed pivot up reference (world up in the air / ball cam, the car's up on a surface). */
  private readonly upRef = new THREE.Vector3(0, 1, 0);
  private readonly camUp = new THREE.Vector3(0, 1, 0);
  private fovBoost = 0;

  constructor(private readonly settings: Settings) {}

  toggle(): void {
    this.ballCam = !this.ballCam;
  }

  /** RL's FOV setting is horizontal; three.js wants vertical. Supersonic adds 10°. */
  applyProjection(camera: THREE.PerspectiveCamera): void {
    const hfov = (this.settings.camera.fov + this.fovBoost) * DEG;
    camera.fov = (2 * Math.atan(Math.tan(hfov / 2) / camera.aspect)) / DEG;
    camera.updateProjectionMatrix();
  }

  update(camera: THREE.PerspectiveCamera, car: THREE.Object3D, ball: THREE.Object3D, state: CameraCarState, dt: number): void {
    const s = this.settings.camera;
    const distance = s.distance * UU;
    const height = s.height * UU;
    const angleRad = s.angle * DEG;
    // Speed trail: (1 - stiffness) * speed / 20 in uu of arm per uu/s of speed.
    const arm = distance + (1 - s.stiffness) * (state.speed / UU) * SPEED_TRAIL * UU;

    carPos.copy(car.position);
    ballPos.copy(ball.position);
    carFwd.set(0, 0, -1).applyQuaternion(car.quaternion);
    carUp.set(0, 1, 0).applyQuaternion(car.quaternion);

    if (this.ballCam !== this.wasBallCam) {
      this.wasBallCam = this.ballCam;
      // The smoothed direction carries over, so the switch swings rather than cuts.
      this.yaw = Math.atan2(-this.viewDir.x, -this.viewDir.z);
    }

    let targetYaw: number;
    let targetPitch: number;
    let rate: number;

    if (this.ballCam) {
      // Pivot: world up, raised by 0.9 uu per degree of the ball's elevation from the base pivot.
      const dx = ballPos.x - carPos.x;
      const dz = ballPos.z - carPos.z;
      const h = Math.max(1e-3, Math.hypot(dx, dz));
      const e0 = Math.atan2(ballPos.y - (carPos.y + height), h);
      const rise = (Math.abs(e0) / DEG) * PIVOT_RISE_PER_DEG;
      pivot.set(carPos.x, carPos.y + height + rise, carPos.z);
      const e = Math.atan2(ballPos.y - pivot.y, h);
      const t = BLEND_MAX * clamp01((Math.abs(e) - BLEND_START) / (BLEND_END - BLEND_START));
      targetPitch = angleRad * (1 - t) + e * t;
      targetYaw = h > 0.5 ? Math.atan2(-dx, -dz) : this.yaw; // our yaw: 0 faces -Z, positive turns toward -X
      rate = BALL_CAM_RATE;
      this.upRef.copy(WORLD_UP);
      this.camUp.copy(WORLD_UP);
    } else {
      // Heading from the nose. A flip swings the nose through vertical, which makes the heading
      // jump by about 180° in one frame; hold through that, and through a near-vertical nose whose
      // heading is meaningless. The comparison is against the CAR's previous heading, not the
      // camera's: comparing against the camera would latch forever whenever the view starts far
      // from the nose, which is exactly what happens the moment ball cam is switched off.
      const fh = Math.hypot(carFwd.x, carFwd.z);
      if (fh > 0.25) {
        const y = Math.atan2(-carFwd.x, -carFwd.z);
        const jumped = Number.isFinite(this.lastCarYaw) && Math.abs(shortestAngle(this.lastCarYaw, y)) > 0.5 * Math.PI;
        targetYaw = jumped ? this.yaw : y;
        if (!jumped) this.lastCarYaw = y;
      } else targetYaw = this.yaw;
      if (state.grounded) {
        // On a surface: pivot along the car's up, pitch follows ~75% of the nose pitch, roll a tenth of the bank.
        const nose = Math.atan2(carFwd.y, fh);
        targetPitch = angleRad + nose * NOSE_FOLLOW(nose);
        this.upRef.copy(carUp);
        // Camera up: a tenth of the car's roll about its nose (RL's roll = atan2(-right.z, up.z)),
        // applied about the view heading. A pitched slope has no roll and gets no tilt.
        tmp.set(1, 0, 0).applyQuaternion(car.quaternion); // car right
        const bank = Math.atan2(-tmp.y, carUp.y);
        const axis = new THREE.Vector3(-Math.sin(targetYaw), 0, -Math.cos(targetYaw)); // heading, horizontal
        this.camUp.copy(WORLD_UP).applyAxisAngle(axis, bank * BANK_FOLLOW);
      } else {
        targetPitch = angleRad;
        this.upRef.copy(WORLD_UP);
        this.camUp.copy(WORLD_UP);
      }
      pivot.copy(carPos).addScaledVector(this.upRef, height);
      rate = CAR_CAM_RATE;
    }

    // Ease the view direction (as yaw/pitch) toward the target with a first-order lag.
    if (!this.initialized) {
      this.yaw = targetYaw;
      setDir(this.viewDir, targetYaw, targetPitch);
      this.initialized = true;
    } else {
      const k = 1 - Math.exp(-rate * dt);
      const currentPitch = Math.asin(Math.max(-1, Math.min(1, this.viewDir.y)));
      this.yaw += shortestAngle(this.yaw, targetYaw) * k;
      const pitch = currentPitch + (targetPitch - currentPitch) * k;
      setDir(this.viewDir, this.yaw, pitch);
    }
    if (this.ballCam) this.yaw = Math.atan2(-this.viewDir.x, -this.viewDir.z);

    // Camera rigidly on the arm behind the pivot, floor clamped; look along the view direction.
    desired.copy(pivot).addScaledVector(this.viewDir, -arm);
    if (desired.y < MIN_CAMERA_HEIGHT) desired.y = MIN_CAMERA_HEIGHT;
    camera.position.copy(desired);
    dir.copy(this.viewDir);
    camera.up.copy(this.camUp);
    camera.lookAt(tmp.copy(camera.position).add(dir));

    // Supersonic FOV boost, eased.
    const targetBoost = state.supersonic ? SUPERSONIC_FOV_BOOST : 0;
    const nb = this.fovBoost + (targetBoost - this.fovBoost) * (1 - Math.exp(-6 * dt));
    if (Math.abs(nb - this.fovBoost) > 1e-3) {
      this.fovBoost = nb;
      this.applyProjection(camera);
    }
  }
}

/** Direction from yaw (0 faces -Z, positive toward -X) and pitch (positive up). */
function setDir(out: THREE.Vector3, yaw: number, pitch: number): void {
  const c = Math.cos(pitch);
  out.set(-Math.sin(yaw) * c, Math.sin(pitch), -Math.cos(yaw) * c);
}

function shortestAngle(from: number, to: number): number {
  let d = to - from;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
