import * as THREE from 'three';
import { ARENA } from '../sim/rl';

const DEG = Math.PI / 180;
const look = new THREE.Vector3();
const desired = new THREE.Vector3();
const forward = new THREE.Vector3();
const right = new THREE.Vector3();
const WORLD_UP = new THREE.Vector3(0, 1, 0);

/** Horizontal FOV (deg) to the vertical FOV three.js wants; capped so portrait screens do not fish-eye. */
export function setHorizontalFov(camera: THREE.PerspectiveCamera, hfovDeg: number): void {
  const fov = Math.min(78, (2 * Math.atan(Math.tan((hfovDeg * DEG) / 2) / camera.aspect)) / DEG);
  if (Math.abs(camera.fov - fov) < 1e-4) return;
  camera.fov = fov;
  camera.updateProjectionMatrix();
}

/**
 * TV-style overview. `broadcast` sits high on the side line and pans/dollies with the ball, the
 * way a match feed does; `field` is a fixed high view that keeps the whole pitch in frame.
 */
export class OverviewCamera {
  style: 'broadcast' | 'field' = 'broadcast';
  private initialized = false;
  private readonly pos = new THREE.Vector3();
  private readonly target = new THREE.Vector3();

  reset(): void {
    this.initialized = false;
  }

  toggleStyle(): void {
    this.style = this.style === 'broadcast' ? 'field' : 'broadcast';
  }

  update(camera: THREE.PerspectiveCamera, ball: THREE.Vector3 | null, dt: number): void {
    const b = ball ?? look.set(0, 0, 0);
    // Both stay inside the bowl: the seating decks start just outside the side wall, and a
    // camera among or behind them looks through the back of the stands.
    if (this.style === 'broadcast') {
      // Hung over the side line below the ceiling; tracks the ball along the long axis, never all the way.
      const z = THREE.MathUtils.clamp(b.z * 0.65, -ARENA.extentY * 0.55, ARENA.extentY * 0.55);
      desired.set(ARENA.extentX - 1, 15 + Math.max(0, b.y - 4) * 0.2, z);
      look.set(b.x * 0.5, Math.min(b.y, 10) * 0.5, b.z * 0.9);
    } else {
      desired.set(ARENA.extentX - 4, 34, 0);
      look.set(-9, -2, 0);
    }
    if (!this.initialized) {
      this.pos.copy(desired);
      this.target.copy(look);
      this.initialized = true;
    } else {
      this.pos.lerp(desired, 1 - Math.exp(-2.4 * dt));
      this.target.lerp(look, 1 - Math.exp(-4.5 * dt));
    }
    camera.position.copy(this.pos);
    camera.up.copy(WORLD_UP);
    camera.lookAt(this.target);
    setHorizontalFov(camera, this.style === 'broadcast' ? 80 : 104);
  }
}

export interface FreeCamInput {
  /** -1..1: strafe right, move forward, rise. */
  moveX: number;
  moveZ: number;
  moveY: number;
  /** Radians to turn this frame (already scaled by sensitivity). */
  yaw: number;
  pitch: number;
  fast: boolean;
}

/** Fly-anywhere camera with eased velocity. Kept inside the stadium bowl. */
export class FreeCamera {
  private readonly pos = new THREE.Vector3(0, 12, 40);
  private readonly vel = new THREE.Vector3();
  private yaw = 0;
  private pitch = -0.25;

  /** Start where the viewer already is, so switching to free cam is seamless. */
  takeOver(camera: THREE.PerspectiveCamera): void {
    this.pos.copy(camera.position);
    camera.getWorldDirection(forward);
    this.yaw = Math.atan2(-forward.x, -forward.z);
    this.pitch = Math.asin(THREE.MathUtils.clamp(forward.y, -1, 1));
    this.vel.set(0, 0, 0);
  }

  update(camera: THREE.PerspectiveCamera, input: FreeCamInput, dt: number): void {
    this.yaw -= input.yaw;
    this.pitch = THREE.MathUtils.clamp(this.pitch - input.pitch, -89 * DEG, 89 * DEG);
    const cp = Math.cos(this.pitch);
    forward.set(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
    right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const speed = input.fast ? 48 : 18;
    desired.set(0, 0, 0)
      .addScaledVector(forward, input.moveZ)
      .addScaledVector(right, input.moveX)
      .addScaledVector(WORLD_UP, input.moveY);
    if (desired.lengthSq() > 1) desired.normalize();
    desired.multiplyScalar(speed);
    this.vel.lerp(desired, 1 - Math.exp(-8 * dt));
    this.pos.addScaledVector(this.vel, dt);
    this.pos.x = THREE.MathUtils.clamp(this.pos.x, -ARENA.extentX - 30, ARENA.extentX + 30);
    this.pos.z = THREE.MathUtils.clamp(this.pos.z, -ARENA.extentY - 35, ARENA.extentY + 35);
    this.pos.y = THREE.MathUtils.clamp(this.pos.y, 0.4, 70);
    camera.position.copy(this.pos);
    camera.up.copy(WORLD_UP);
    camera.lookAt(look.copy(this.pos).add(forward));
    setHorizontalFov(camera, 100);
  }
}
