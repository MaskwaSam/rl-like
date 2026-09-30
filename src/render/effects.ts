/**
 * Cheap visual effects: camera-facing ribbon trails (ball streak, boost trails), blob shadows,
 * and a goal explosion. Everything is MeshBasicMaterial with additive blending and a handful
 * of vertices; nothing here costs more than a couple of draw calls.
 */
import * as THREE from 'three';

/**
 * Lit surfaces stay below the bloom threshold (linear HDR, before tone mapping), so only colours
 * pushed above it glow: lights, pads, goal frames, boost flames. `glow(hex, k)` makes one.
 */
export const GLOW = 4;
export function glow(hex: number, k = GLOW): THREE.Color {
  return new THREE.Color(hex).multiplyScalar(k);
}

const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpSide = new THREE.Vector3();

interface TrailPoint {
  pos: THREE.Vector3;
  age: number;
}

/**
 * A ribbon of the last N positions, widest at the newest point and tapering to nothing, faded
 * out by age. Each quad faces the camera so it reads as a streak from any angle.
 */
export class Ribbon {
  readonly mesh: THREE.Mesh;
  private readonly points: TrailPoint[] = [];
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private readonly geometry: THREE.BufferGeometry;
  private readonly color = new THREE.Color();

  constructor(
    private readonly maxPoints: number,
    private readonly width: number,
    color: number,
    private readonly lifetime: number,
    opacity = 0.7,
    /** Multiplier on the colour; above 1 pushes the trail into the bloom pass. */
    intensity = 1,
  ) {
    this.color.setHex(color).multiplyScalar(intensity);
    this.geometry = new THREE.BufferGeometry();
    this.positions = new Float32Array(maxPoints * 2 * 3);
    this.colors = new Float32Array(maxPoints * 2 * 3);
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 3).setUsage(THREE.DynamicDrawUsage));
    const index: number[] = [];
    for (let i = 0; i < maxPoints - 1; i++) {
      const a = i * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    this.geometry.setIndex(index);
    this.geometry.setDrawRange(0, 0);
    this.mesh = new THREE.Mesh(
      this.geometry,
      new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    );
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
  }

  /** Record the emitter's position this frame. Skip calling it to let the trail fade out. */
  addPoint(p: THREE.Vector3): void {
    const last = this.points[0];
    if (last && last.pos.distanceToSquared(p) < 0.0004) return; // not moving: no new segment
    if (this.points.length >= this.maxPoints) this.points.pop();
    this.points.unshift({ pos: p.clone(), age: 0 });
  }

  /** Age points, drop dead ones, rebuild the camera-facing quads. */
  update(dt: number, cameraPos: THREE.Vector3): void {
    for (const pt of this.points) pt.age += dt;
    while (this.points.length && this.points[this.points.length - 1].age > this.lifetime) this.points.pop();
    const n = this.points.length;
    if (n < 2) {
      this.geometry.setDrawRange(0, 0);
      this.mesh.visible = false;
      return;
    }
    this.mesh.visible = true;
    for (let i = 0; i < n; i++) {
      const p = this.points[i].pos;
      const next = this.points[Math.min(i + 1, n - 1)].pos;
      const prev = this.points[Math.max(i - 1, 0)].pos;
      tmpA.subVectors(prev, next); // along the trail
      tmpB.subVectors(cameraPos, p);
      tmpSide.crossVectors(tmpA, tmpB);
      if (tmpSide.lengthSq() < 1e-8) tmpSide.set(0, 1, 0);
      tmpSide.normalize();
      const t = i / (n - 1); // 0 at the newest point
      const life = 1 - this.points[i].age / this.lifetime;
      const w = this.width * (1 - t) * Math.max(0, life);
      const o = i * 6;
      this.positions[o] = p.x + tmpSide.x * w;
      this.positions[o + 1] = p.y + tmpSide.y * w;
      this.positions[o + 2] = p.z + tmpSide.z * w;
      this.positions[o + 3] = p.x - tmpSide.x * w;
      this.positions[o + 4] = p.y - tmpSide.y * w;
      this.positions[o + 5] = p.z - tmpSide.z * w;
      const c = Math.max(0, life) * (1 - t * 0.7);
      for (let k = 0; k < 2; k++) {
        this.colors[o + k * 3] = this.color.r * c;
        this.colors[o + k * 3 + 1] = this.color.g * c;
        this.colors[o + k * 3 + 2] = this.color.b * c;
      }
    }
    (this.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    this.geometry.setDrawRange(0, (n - 1) * 6);
  }

  clear(): void {
    this.points.length = 0;
    this.geometry.setDrawRange(0, 0);
    this.mesh.visible = false;
  }
}

/** Soft dark disc on the floor under an object, fading with height. Reads depth far better than none. */
export class BlobShadow {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.MeshBasicMaterial;

  constructor(radius: number, private readonly maxHeight: number) {
    this.material = new THREE.MeshBasicMaterial({ map: blobTexture(), transparent: true, opacity: 0.45, depthWrite: false });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(radius * 2, radius * 2), this.material);
    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.renderOrder = 1;
  }

  update(pos: THREE.Vector3, visible: boolean): void {
    const h = pos.y;
    const k = visible && h < this.maxHeight ? 1 - h / this.maxHeight : 0;
    this.mesh.visible = k > 0.01;
    if (!this.mesh.visible) return;
    this.mesh.position.set(pos.x, 0.012, pos.z);
    const s = 1 + Math.min(h, this.maxHeight) * 0.12;
    this.mesh.scale.set(s, s, 1);
    this.material.opacity = 0.45 * k;
  }
}

let blobTex: THREE.Texture | null = null;
function blobTexture(): THREE.Texture {
  if (blobTex) return blobTex;
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const ctx = cv.getContext('2d')!;
  const g = ctx.createRadialGradient(32, 32, 4, 32, 32, 32);
  g.addColorStop(0, 'rgba(0,0,0,1)');
  g.addColorStop(0.6, 'rgba(0,0,0,0.55)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  blobTex = new THREE.CanvasTexture(cv);
  return blobTex;
}

let glowTex: THREE.Texture | null = null;
/** Radial white glow for sprites. */
export function glowTexture(): THREE.Texture {
  if (glowTex) return glowTex;
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const ctx = cv.getContext('2d')!;
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  g.addColorStop(0.6, 'rgba(255,255,255,0.12)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  glowTex = new THREE.CanvasTexture(cv);
  glowTex.colorSpace = THREE.SRGBColorSpace;
  return glowTex;
}

/** Goal explosion: a flash sprite and an expanding shock ring in the scoring team's colour. */
export class Explosion {
  readonly group = new THREE.Group();
  private readonly flash: THREE.Sprite;
  private readonly ring: THREE.Mesh;
  private readonly shards: THREE.Points;
  private readonly shardVel: Float32Array;
  private age = 0;
  private readonly duration = 1.3;
  done = false;

  constructor(pos: THREE.Vector3, hex: number) {
    this.group.position.copy(pos);
    // Over-bright so the burst blooms; harmless when bloom is off (it just clips to the hue).
    const color = new THREE.Color(hex).multiplyScalar(3);
    this.flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.flash.scale.setScalar(10);
    this.group.add(this.flash);
    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(0.85, 1, 48),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.ring.rotation.x = -Math.PI / 2;
    this.group.add(this.ring);
    const n = 60;
    const positions = new Float32Array(n * 3);
    this.shardVel = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(2 * Math.random() - 1);
      const sp = 9 + Math.random() * 14;
      this.shardVel[i * 3] = Math.sin(ph) * Math.cos(th) * sp;
      this.shardVel[i * 3 + 1] = Math.abs(Math.cos(ph)) * sp * 0.8 + 2;
      this.shardVel[i * 3 + 2] = Math.sin(ph) * Math.sin(th) * sp;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
    this.shards = new THREE.Points(geo, new THREE.PointsMaterial({ color, size: 0.5, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.shards.frustumCulled = false;
    this.group.add(this.shards);
  }

  update(dt: number): void {
    this.age += dt;
    const t = Math.min(1, this.age / this.duration);
    const r = 2 + t * 34;
    this.ring.scale.set(r, r, 1);
    (this.ring.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - t) ** 1.5;
    this.flash.scale.setScalar(10 + t * 22);
    (this.flash.material as THREE.SpriteMaterial).opacity = (1 - t) ** 2;
    const pos = this.shards.geometry.attributes.position as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    for (let i = 0; i < arr.length; i += 3) {
      this.shardVel[i + 1] -= 9 * dt;
      arr[i] += this.shardVel[i] * dt;
      arr[i + 1] += this.shardVel[i + 1] * dt;
      arr[i + 2] += this.shardVel[i + 2] * dt;
    }
    pos.needsUpdate = true;
    (this.shards.material as THREE.PointsMaterial).opacity = 1 - t;
    if (t >= 1) this.done = true;
  }

  dispose(): void {
    this.ring.geometry.dispose();
    (this.ring.material as THREE.Material).dispose();
    (this.flash.material as THREE.Material).dispose();
    this.shards.geometry.dispose();
    (this.shards.material as THREE.Material).dispose();
  }
}
