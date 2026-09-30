import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ARENA, BALL, BOOST_PADS, CAR, GRAVITY, OCTANE, UU, curve } from '../sim/rl';
import type { ArenaGeometry } from '../sim/arena';
import type { BodyState, BoostPad } from '../sim/game';
import type { Team } from '../sim/car';
import type { CarRenderState } from '../net/session';
import { BlobShadow, Explosion, GLOW, Ribbon, glow, glowTexture } from './effects';
import { TEAM_GLOW, TEAM_PAINT, buildCarMeshes, type CarMeshes } from './cars';

const pA = new THREE.Vector3();
const pB = new THREE.Vector3();
const qA = new THREE.Quaternion();
const qB = new THREE.Quaternion();

/** Linear HDR luminance above which the bloom pass picks a pixel up. See `glow` in effects. */
const BLOOM_THRESHOLD = 2.0;

/** One car's meshes: body group, steerable wheels, boost flame, optional nameplate. */
interface CarVisual {
  group: THREE.Group;
  team: Team;
  body: number;
  wheels: { pivot: THREE.Group; mesh: THREE.Object3D; radius: number; front: boolean; restY: number }[];
  flame: THREE.Mesh;
  flameMaterial: THREE.MeshBasicMaterial;
  nameplate: THREE.Sprite | null;
  name: string;
  trail: Ribbon;
  shadow: BlobShadow;
}

/** Per-pad bookkeeping for the instanced orbs and rings; big pads also get a glow sprite. */
interface PadVisual {
  x: number;
  z: number;
  big: boolean;
  /** Instance index within the big or small instanced meshes. */
  index: number;
  halo: THREE.Sprite | null;
  phase: number;
}

/**
 * PBR materials lit by a hemisphere, an overhead key light and a stadium environment map, tone
 * mapped for HDR. `setQuality` scales the cost: Low renders straight to the canvas; Medium adds
 * MSAA and bloom; High adds real shadows. Always at pixel ratio 1: on a Retina screen 1.25x and
 * up cost several times more (MSAA on HDR targets is bandwidth-bound) for little visible gain.
 */
export class Renderer {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly gl: THREE.WebGLRenderer;
  readonly ballMesh: THREE.Mesh;
  private readonly container: HTMLElement;
  private readonly key: THREE.DirectionalLight;
  private composer: EffectComposer | null = null;
  private renderPass: RenderPass | null = null;
  private garage: Garage | null = null;
  private quality = -1;
  /** True when the key light casts shadows, so the fake blob shadows under cars are hidden. */
  private realShadows = false;
  private readonly cars = new Map<number, CarVisual>();
  private pads: PadVisual[] = [];
  private bigOrbs!: THREE.InstancedMesh;
  private bigRings!: THREE.InstancedMesh;
  private smallRings!: THREE.InstancedMesh;
  private readonly padMatrix = new THREE.Matrix4();
  private readonly padColorOn = glow(0xffc46b, 2.5);
  private readonly padColorOff = new THREE.Color(0x2f3d33);
  private readonly ballTrail = new Ribbon(16, 0.42, 0xdfe8ff, 0.28, 0.7, 2);
  private readonly ballGlow: THREE.Sprite;
  private readonly ballShadow = new BlobShadow(1.1, 9);
  private readonly explosions: Explosion[] = [];
  private readonly lastBallPos = new THREE.Vector3();
  private readonly prevBallPos = new THREE.Vector3();
  private padTime = 0;
  private readonly tmpV = new THREE.Vector3();
  private readonly landingRing: THREE.Mesh;
  private readonly landingDisc: THREE.Mesh;
  private readonly padPops: { sprite: THREE.Sprite; age: number }[] = [];
  private prevPadCooldown: number[] = [];

  constructor(container: HTMLElement, arena: ArenaGeometry, pads: BoostPad[]) {
    this.container = container;
    // Antialiasing comes from the composer's MSAA target, so the canvas itself never needs it.
    this.gl = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    this.gl.setPixelRatio(1);
    this.gl.setSize(container.clientWidth, container.clientHeight);
    this.gl.toneMapping = THREE.NeutralToneMapping;
    this.gl.shadowMap.type = THREE.PCFShadowMap;
    this.gl.shadowMap.enabled = false;
    container.appendChild(this.gl.domElement);

    this.camera = new THREE.PerspectiveCamera(75, container.clientWidth / container.clientHeight, 0.1, 300);
    this.scene.background = new THREE.Color(0x05080f);

    // Reflections: a simple night stadium baked once into a prefiltered environment map, so the
    // car paint, glass and ball have floodlights to catch without any image files.
    const pmrem = new THREE.PMREMGenerator(this.gl);
    this.scene.environment = pmrem.fromScene(stadiumEnvironment(), 0.03).texture;
    pmrem.dispose();

    // Stadium lighting: sky/turf bounce, a high floodlight key tilted enough that a grounded car's
    // shadow shows beside it (straight overhead, the car hides it) and a cool fill for shape.
    // The ball casts no real shadow: its blob and ring stay straight below it, which is what
    // players read to judge where it is.
    this.scene.add(new THREE.HemisphereLight(0xc4d8ff, 0x2c4a30, 0.6));
    this.key = new THREE.DirectionalLight(0xfff6e8, 1.5);
    this.key.position.set(30, 85, 20);
    this.scene.add(this.key, this.key.target);
    const reach = Math.max(ARENA.extentX, ARENA.extentY + ARENA.goalDepth) + 2;
    const sc = this.key.shadow.camera;
    sc.left = -reach;
    sc.right = reach;
    sc.top = reach;
    sc.bottom = -reach;
    sc.near = 20;
    sc.far = 140;
    this.key.shadow.mapSize.set(2048, 2048);
    this.key.shadow.bias = -0.0004;
    this.key.shadow.normalBias = 0.03;
    const fill = new THREE.DirectionalLight(0x9fc4ff, 0.35);
    fill.position.set(-40, 30, -50);
    this.scene.add(fill);

    this.buildSky();
    this.buildFloodlights();
    this.buildArena(arena);
    this.buildPads(pads);
    this.ballMesh = this.buildBall();
    this.ballGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: 0x9fb8ff, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.ballGlow.scale.setScalar(3.2);
    this.scene.add(this.ballGlow);
    this.scene.add(this.ballTrail.mesh);
    this.scene.add(this.ballShadow.mesh);
    // Ground marker: the ball's position straight down on the floor, shown at all times.
    this.landingRing = new THREE.Mesh(new THREE.RingGeometry(0.86, 1, 48), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false }));
    this.landingRing.rotation.x = -Math.PI / 2;
    this.landingRing.renderOrder = 2;
    this.landingRing.visible = false;
    this.landingDisc = new THREE.Mesh(new THREE.CircleGeometry(0.86, 40), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.12, depthWrite: false }));
    this.landingDisc.rotation.x = -Math.PI / 2;
    this.landingDisc.renderOrder = 2;
    this.landingDisc.visible = false;
    this.scene.add(this.landingRing, this.landingDisc);
    for (let i = 0; i < 6; i++) {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: 0xffd080, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
      sprite.visible = false;
      this.scene.add(sprite);
      this.padPops.push({ sprite, age: 99 });
    }

    window.addEventListener('resize', () => this.resize(container));
  }

  resize(container: HTMLElement): void {
    const w = container.clientWidth;
    const h = container.clientHeight;
    this.gl.setSize(w, h);
    this.composer?.setPixelRatio(this.gl.getPixelRatio());
    this.composer?.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** 0 Low, 1 Medium, 2 High (see GRAPHICS_DEFS). Cheap to call every time settings change. */
  setQuality(level: number): void {
    const q = Math.max(0, Math.min(2, Math.round(level)));
    if (q === this.quality) return;
    this.quality = q;

    const shadows = q >= 2;
    if (shadows !== this.realShadows) {
      this.realShadows = shadows;
      this.gl.shadowMap.enabled = shadows;
      this.key.castShadow = shadows;
      // Materials compile shadow support in or out, so they need rebuilding after a switch.
      this.scene.traverse((o) => {
        const m = (o as THREE.Mesh).material;
        if (m) for (const mat of Array.isArray(m) ? m : [m]) mat.needsUpdate = true;
      });
    }

    this.composer?.dispose();
    this.composer = null;
    if (q >= 1) {
      const composer = new EffectComposer(this.gl);
      // MSAA on the scene target: smooth edges on geometry and the 1px arena lines alike.
      composer.renderTarget1.samples = 4;
      composer.renderTarget2.samples = 4;
      this.renderPass = new RenderPass(this.scene, this.camera);
      composer.addPass(this.renderPass);
      composer.addPass(new UnrealBloomPass(new THREE.Vector2(256, 256), 0.6, 0.35, BLOOM_THRESHOLD));
      composer.addPass(new OutputPass());
      this.composer = composer;
    }
    this.resize(this.container);
  }

  /** The Object3D the camera follows, once that car exists. */
  carObject(id: number): THREE.Object3D | null {
    return this.cars.get(id)?.group ?? null;
  }

  /** Create, update and remove car visuals to match `states`. Call once per frame. */
  syncCars(states: CarRenderState[], localId: number, dt: number): void {
    const seen = new Set<number>();
    for (const s of states) {
      seen.add(s.id);
      let v = this.cars.get(s.id);
      if (v && (v.team !== s.team || v.body !== s.body)) {
        this.removeCar(s.id);
        v = undefined;
      }
      if (!v) {
        v = this.buildCar(s.team, s.body);
        this.cars.set(s.id, v);
      }
      const showName = s.id !== localId && s.name.length > 0;
      if (showName && v.name !== s.name) {
        if (v.nameplate) v.group.remove(v.nameplate);
        v.nameplate = makeNameplate(s.name, s.team);
        v.group.add(v.nameplate);
        v.name = s.name;
      } else if (!showName && v.nameplate) {
        v.group.remove(v.nameplate);
        v.nameplate = null;
        v.name = '';
      }
      // A demolished car is simply not drawn until it respawns.
      v.group.visible = !s.demoed;
      v.shadow.mesh.visible = !s.demoed;
      if (s.demoed) {
        v.trail.clear();
        if (v.nameplate) v.nameplate.visible = false;
        continue;
      }
      if (v.nameplate) v.nameplate.visible = true;
      applyInterpolated(v.group, s.prev, s.curr, s.alpha);
      if (s.offsetPos) v.group.position.add(s.offsetPos);
      if (s.offsetQuat) v.group.quaternion.premultiply(s.offsetQuat);
      for (let i = 0; i < v.wheels.length; i++) {
        const w = v.wheels[i];
        w.mesh.rotation.x -= (s.forwardSpeed / w.radius) * dt;
        if (w.front) w.pivot.rotation.y = -s.steer * steerAngleFor(s.forwardSpeed);
        // Suspension: ease the wheel toward where the ray found the ground.
        const targetY = s.wheelY ? s.wheelY[i] : w.restY;
        w.pivot.position.y += (targetY - w.pivot.position.y) * Math.min(1, dt * 30);
      }
      v.flame.visible = s.boosting;
      v.flameMaterial.color.setHex(s.supersonic ? 0xfff3d6 : 0xffa62b).multiplyScalar(GLOW);
      v.flame.scale.setScalar(s.supersonic ? 1.5 : 1);
      if (s.boosting) {
        v.flame.getWorldPosition(this.tmpV);
        v.trail.addPoint(this.tmpV);
      }
      v.trail.update(dt, this.camera.position);
      v.shadow.update(v.group.position, !this.realShadows);
    }
    for (const id of [...this.cars.keys()]) if (!seen.has(id)) this.removeCar(id);
  }

  removeCar(id: number): void {
    const v = this.cars.get(id);
    if (!v) return;
    this.scene.remove(v.group);
    this.scene.remove(v.trail.mesh);
    this.scene.remove(v.shadow.mesh);
    this.cars.delete(id);
  }

  syncBall(prev: BodyState, curr: BodyState, alpha: number, visible: boolean, offset: THREE.Vector3 | null, dt: number, vel?: { x: number; y: number; z: number }): void {
    applyInterpolated(this.ballMesh, prev, curr, alpha);
    if (offset) this.ballMesh.position.add(offset);
    this.ballMesh.visible = visible;
    this.ballGlow.visible = visible;
    this.ballGlow.position.copy(this.ballMesh.position);
    if (visible) {
      this.lastBallPos.copy(this.ballMesh.position);
      // Streak only when the ball is really moving (RL shows it past roughly half max speed).
      const speed = dt > 0 ? this.ballMesh.position.distanceTo(this.prevBallPos) / dt : 0;
      if (speed > 14 && speed < 200) this.ballTrail.addPoint(this.ballMesh.position);
      this.prevBallPos.copy(this.ballMesh.position);
    } else this.ballTrail.clear();
    this.ballTrail.update(dt, this.camera.position);
    this.ballShadow.update(this.ballMesh.position, visible);
    this.updateBallMarker(visible);
  }

  syncPads(pads: BoostPad[], dt: number): void {
    this.padTime += dt;
    for (let i = 0; i < pads.length; i++) {
      const p = pads[i];
      const v = this.pads[i];
      const active = p.cooldown === 0;
      const rings = v.big ? this.bigRings : this.smallRings;
      rings.setColorAt(v.index, active ? this.padColorOn : this.padColorOff);
      if (v.big) {
        // Gentle bob so the orb reads as a floating pickup; hidden by scaling to nothing.
        const bob = Math.sin(this.padTime * 2 + v.phase) * 0.12;
        const y = 1.15 + bob;
        const sc = active ? 1 : 0;
        this.padMatrix.makeRotationY(this.padTime * 0.8 + v.phase);
        this.padMatrix.scale(new THREE.Vector3(sc, sc, sc));
        this.padMatrix.setPosition(v.x, y, v.z);
        this.bigOrbs.setMatrixAt(v.index, this.padMatrix);
        if (v.halo) {
          v.halo.visible = active;
          v.halo.position.y = y;
        }
      }
      // Pickup pop: a quick glow that expands and fades where the pad was taken.
      if (this.prevPadCooldown.length === pads.length && this.prevPadCooldown[i] === 0 && p.cooldown > 0) {
        const pop = this.padPops.reduce((a, b) => (a.age > b.age ? a : b));
        pop.age = 0;
        pop.sprite.visible = true;
        pop.sprite.position.set(v.x, v.big ? 1.15 : 0.35, v.z);
        pop.sprite.scale.setScalar(v.big ? 2.5 : 1.2);
      }
    }
    if (this.prevPadCooldown.length !== pads.length) this.prevPadCooldown = pads.map((p) => p.cooldown);
    else for (let i = 0; i < pads.length; i++) this.prevPadCooldown[i] = pads[i].cooldown;
    for (const pop of this.padPops) {
      if (!pop.sprite.visible) continue;
      pop.age += dt;
      const k = Math.min(1, pop.age / 0.35);
      pop.sprite.scale.multiplyScalar(1 + dt * 6);
      (pop.sprite.material as THREE.SpriteMaterial).opacity = 0.9 * (1 - k);
      if (k >= 1) pop.sprite.visible = false;
    }
    this.bigOrbs.instanceMatrix.needsUpdate = true;
    if (this.bigRings.instanceColor) this.bigRings.instanceColor.needsUpdate = true;
    if (this.smallRings.instanceColor) this.smallRings.instanceColor.needsUpdate = true;
  }

  /**
   * Ring on the floor directly beneath the ball, so its horizontal position is always readable
   * even when it is high. The ring grows a little with height (so a high ball is easy to spot)
   * and fades in only once the ball leaves the ground, where it would just sit on the ball.
   */
  private updateBallMarker(visible: boolean): void {
    const p = this.ballMesh.position;
    if (!visible) {
      this.landingRing.visible = false;
      this.landingDisc.visible = false;
      return;
    }
    const height = Math.max(0, p.y - BALL.restZ);
    const fade = Math.min(1, height / 0.6); // on the floor the ring is redundant
    this.landingRing.visible = fade > 0.02;
    this.landingDisc.visible = this.landingRing.visible;
    if (!this.landingRing.visible) return;
    const r = 1 + Math.min(1.6, height * 0.05);
    this.landingRing.position.set(p.x, 0.02, p.z);
    this.landingDisc.position.set(p.x, 0.018, p.z);
    this.landingRing.scale.set(r, r, 1);
    this.landingDisc.scale.set(r, r, 1);
    (this.landingRing.material as THREE.MeshBasicMaterial).opacity = 0.75 * fade;
    (this.landingDisc.material as THREE.MeshBasicMaterial).opacity = 0.12 * fade;
  }

  /** Goal scored: burst at the ball's last visible position in the team's colour. */
  goalExplosion(team: Team): void {
    this.burst(this.lastBallPos, TEAM_PAINT[team]);
  }

  /** Demolition: a white-hot burst where the two cars met. */
  demoExplosion(x: number, y: number, z: number): void {
    this.burst(this.tmpV.set(x, y, z), 0xfff0c8);
  }

  private burst(pos: THREE.Vector3, color: number): void {
    const e = new Explosion(pos, color);
    this.explosions.push(e);
    this.scene.add(e.group);
  }

  render(dt = 0): void {
    for (let i = this.explosions.length - 1; i >= 0; i--) {
      const e = this.explosions[i];
      e.update(dt);
      if (e.done) {
        this.scene.remove(e.group);
        e.dispose();
        this.explosions.splice(i, 1);
      }
    }
    if (this.composer) this.composer.render(dt);
    else this.gl.render(this.scene, this.camera);
  }

  // ---------------------------------------------------------------------------
  // Arena
  // ---------------------------------------------------------------------------

  private buildArena(arena: ArenaGeometry): void {
    // Floor: one static textured plane covering the field and both goals. The texture is drawn in
    // the plane's own metres so markings land exactly on the physics positions.
    const floorW = arena.floorBox.hx * 2;
    const floorL = arena.floorBox.hz * 2;
    const floorGeo = new THREE.PlaneGeometry(floorW, floorL);
    const floor = new THREE.Mesh(floorGeo, new THREE.MeshStandardMaterial({ map: makeFieldTexture(floorW, floorL), roughness: 0.82, metalness: 0 }));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);

    // Wall shell straight from the physics trimesh, opaque and single-sided: the normals point
    // into the arena, so it is solid from inside and see-through when the camera is outside.
    // UVs: u runs along the wall (world x + z works for both wall directions), v is height.
    const shell = new THREE.BufferGeometry();
    shell.setAttribute('position', new THREE.BufferAttribute(arena.vertices, 3));
    const uv = new Float32Array((arena.vertices.length / 3) * 2);
    for (let i = 0; i < arena.vertices.length / 3; i++) {
      const x = arena.vertices[i * 3];
      const y = arena.vertices[i * 3 + 1];
      const z = arena.vertices[i * 3 + 2];
      uv[i * 2] = (x + z) / 8; // one panel every 8 m along the wall
      uv[i * 2 + 1] = y / ARENA.height;
    }
    shell.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    shell.setIndex(new THREE.BufferAttribute(arena.indices, 1));
    shell.computeVertexNormals();
    // Glossy glass: low roughness so the floodlights and environment slide across it.
    // The texture also drives a faint emissive, as if the stands behind the glass were lit.
    const wallTex = makeWallTexture();
    // Shadows land on the floor only: the key light is overhead, so walls would rarely show one.
    this.scene.add(new THREE.Mesh(shell, new THREE.MeshStandardMaterial({ map: wallTex, emissive: 0xffffff, emissiveMap: wallTex, emissiveIntensity: 0.45, roughness: 0.3, metalness: 0.15, side: THREE.FrontSide })));
    this.scene.add(new THREE.LineSegments(new THREE.EdgesGeometry(shell, 20), new THREE.LineBasicMaterial({ color: 0x5f7fb5, transparent: true, opacity: 0.55 })));

    // A neon band along the walls at goal height, like the arena's glass line. Bright enough to bloom.
    const band = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(ARENA.extentX * 2, ARENA.extentY * 2)), new THREE.LineBasicMaterial({ color: glow(0x8fb8ff, 3.5), transparent: true, opacity: 0.8 }));
    band.rotation.x = -Math.PI / 2;
    band.position.y = ARENA.goalHeight;
    this.scene.add(band);

    // Goal chambers straight from the physics mesh: quarter-pipe back, sloped roof, netting.
    // Drawn as translucent tinted netting with edge lines so the curve reads from inside and out.
    const goalGeo = new THREE.BufferGeometry();
    goalGeo.setAttribute('position', new THREE.BufferAttribute(arena.goalVertices, 3));
    goalGeo.setIndex(new THREE.BufferAttribute(arena.goalIndices, 1));
    goalGeo.computeVertexNormals();
    // Split by sign of z for team tints.
    const tintByZ = (positive: boolean) => {
      const idx = arena.goalIndices;
      const kept: number[] = [];
      for (let i = 0; i < idx.length; i += 3) {
        const z = arena.goalVertices[idx[i] * 3 + 2];
        if (z > 0 === positive) kept.push(idx[i], idx[i + 1], idx[i + 2]);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(arena.goalVertices, 3));
      g.setIndex(kept);
      g.computeVertexNormals();
      return g;
    };
    for (const positive of [true, false]) {
      const color = positive ? 0xff9a3c : 0x4aa3ff;
      const g = tintByZ(positive);
      this.scene.add(new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.25, roughness: 0.6, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false })));
      this.scene.add(new THREE.LineSegments(new THREE.EdgesGeometry(g, 12), new THREE.LineBasicMaterial({ color: glow(color, 1.6), transparent: true, opacity: 0.6 })));
      this.scene.add(goalFrame(color, positive ? 1 : -1));
    }

    // Ceiling outline only, so the camera never gets blocked.
    const ceil = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(ARENA.extentX * 2, ARENA.extentY * 2)), new THREE.LineBasicMaterial({ color: 0x5f7fb5, transparent: true, opacity: 0.35 }));
    ceil.rotation.x = -Math.PI / 2;
    ceil.position.y = ARENA.height;
    this.scene.add(ceil);
  }

  /**
   * RL-style pickups: big pads float a glowing orb about a metre up on a ring, small pads are a
   * lit ring on the floor; a ring goes dark while its pad recharges. Three instanced meshes plus
   * six glow sprites for the big pads: nine draw calls for all 34 pads.
   */
  private buildPads(pads: BoostPad[]): void {
    const bigs = pads.filter((p) => p.big).length;
    const smalls = pads.length - bigs;
    const ringMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.85, side: THREE.DoubleSide });
    this.bigOrbs = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.42, 1), new THREE.MeshBasicMaterial({ color: glow(0xffc24a) }), bigs);
    this.bigRings = new THREE.InstancedMesh(new THREE.RingGeometry(1.35, 1.6, 32), ringMat, bigs);
    // Small pads are just a lit ring on the floor, as in RL; big pads add the floating orb.
    this.smallRings = new THREE.InstancedMesh(new THREE.RingGeometry(0.55, 0.9, 20), ringMat, smalls);
    for (const m of [this.bigOrbs, this.bigRings, this.smallRings]) {
      m.frustumCulled = false;
      this.scene.add(m);
    }
    const haloTex = glowTexture();
    let bi = 0;
    let si = 0;
    const m = new THREE.Matrix4();
    this.pads = pads.map((p, i) => {
      const index = p.big ? bi++ : si++;
      const rings = p.big ? this.bigRings : this.smallRings;
      m.makeRotationX(-Math.PI / 2);
      m.setPosition(p.x, 0.015, p.z);
      rings.setMatrixAt(index, m);
      rings.setColorAt(index, this.padColorOn);
      let halo: THREE.Sprite | null = null;
      if (p.big) {
        halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: haloTex, color: 0xffa030, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }));
        halo.scale.setScalar(2.6);
        halo.position.set(p.x, 1.15, p.z);
        this.scene.add(halo);
      }
      return { x: p.x, z: p.z, big: p.big, index, halo, phase: i * 0.7 };
    });
    this.bigRings.instanceMatrix.needsUpdate = true;
    this.smallRings.instanceMatrix.needsUpdate = true;
  }

  /**
   * Floodlight banks above the four corners, angled at the centre spot: a grid of lamps bright
   * enough to bloom plus a soft halo. Purely visual; the lighting itself comes from `key`.
   */
  private buildFloodlights(): void {
    const lampGeo = new THREE.BoxGeometry(0.9, 0.9, 0.2);
    const lampMat = new THREE.MeshBasicMaterial({ color: glow(0xfff4dc, 6) });
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x1a1f29, roughness: 0.6, metalness: 0.5 });
    const halo = glowTexture();
    const cols = 5;
    const rows = 2;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const bank = new THREE.Group();
        bank.position.set(sx * (ARENA.extentX + 6), ARENA.height + 9, sz * (ARENA.extentY - 4));
        bank.lookAt(0, 0, 0);
        const frame = new THREE.Mesh(new THREE.BoxGeometry(cols * 1.1 + 0.4, rows * 1.1 + 0.4, 0.3), frameMat);
        frame.position.z = -0.2;
        bank.add(frame);
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            const lamp = new THREE.Mesh(lampGeo, lampMat);
            lamp.position.set((c - (cols - 1) / 2) * 1.1, (r - (rows - 1) / 2) * 1.1, 0);
            bank.add(lamp);
          }
        }
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: halo, color: 0xfff0d0, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
        sprite.scale.setScalar(16);
        sprite.position.z = 0.5;
        bank.add(sprite);
        this.scene.add(bank);
      }
    }
  }

  /** Night sky: a dithered gradient dome instead of a flat colour, one draw call. */
  private buildSky(): void {
    const cv = document.createElement('canvas');
    cv.width = 64;
    cv.height = 1024;
    const ctx = cv.getContext('2d')!;
    const img = ctx.createImageData(cv.width, cv.height);
    // Horizon (bottom of the texture, v = 0) to zenith. Per-pixel noise breaks the 8-bit banding
    // that a smooth near-black gradient shows on a sphere as concentric rings.
    const stops: [number, [number, number, number]][] = [
      [0, [30, 42, 70]],
      [0.3, [16, 24, 44]],
      [1, [4, 6, 12]],
    ];
    for (let y = 0; y < cv.height; y++) {
      const v = 1 - y / (cv.height - 1);
      let i = 0;
      while (i < stops.length - 2 && v > stops[i + 1][0]) i++;
      const [v0, c0] = stops[i];
      const [v1, c1] = stops[i + 1];
      const t = Math.min(1, Math.max(0, (v - v0) / (v1 - v0)));
      for (let x = 0; x < cv.width; x++) {
        const n = (Math.random() - 0.5) * 3;
        const o = (y * cv.width + x) * 4;
        img.data[o] = c0[0] + (c1[0] - c0[0]) * t + n;
        img.data[o + 1] = c0[1] + (c1[1] - c0[1]) * t + n;
        img.data[o + 2] = c0[2] + (c1[2] - c0[2]) * t + n;
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    // A sprinkle of stars in the upper half.
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    for (let i = 0; i < 90; i++) ctx.fillRect(Math.random() * cv.width, Math.random() * 500, 1, 1);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sky = new THREE.Mesh(new THREE.SphereGeometry(240, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, depthWrite: false, fog: false }));
    sky.renderOrder = -10;
    this.scene.add(sky);
  }

  // ---------------------------------------------------------------------------
  // Cars (bodies live in cars.ts) and the Garage preview
  // ---------------------------------------------------------------------------

  private buildCar(team: Team, body: number): CarVisual {
    const m = buildCarMeshes(team, body);
    const trail = new Ribbon(10, 0.13, team === 'blue' ? 0x4f8cff : 0xff9030, 0.11, 0.55, 3);
    const shadow = new BlobShadow(0.95, 6);
    this.scene.add(m.group, trail.mesh, shadow.mesh);
    return { ...m, team, body, nameplate: null, name: '', trail, shadow };
  }

  /**
   * Garage: the chosen body turning slowly on a showroom turntable, drawn instead of the arena
   * while the Garage menu is open. Its own small scene, sharing the environment map and the
   * composer (so it gets the same glow and antialiasing as the game at the current quality).
   */
  renderGarage(body: number, team: Team, dt: number): void {
    const g = (this.garage ??= buildGarage(this.scene.environment));
    if (!g.car || g.body !== body || g.team !== team) {
      if (g.car) g.scene.remove(g.car.group);
      g.car = buildCarMeshes(team, body);
      g.car.group.position.y = OCTANE.restZ;
      g.scene.add(g.car.group);
      g.ringMat.color.copy(glow(TEAM_GLOW[team], 2.5));
      g.body = body;
      g.team = team;
    }
    g.angle += dt * 0.45;
    g.car.group.rotation.y = g.angle;
    g.camera.aspect = this.container.clientWidth / this.container.clientHeight;
    g.camera.updateProjectionMatrix();
    if (this.composer && this.renderPass) {
      this.renderPass.scene = g.scene;
      this.renderPass.camera = g.camera;
      this.composer.render(dt);
      this.renderPass.scene = this.scene;
      this.renderPass.camera = this.camera;
    } else this.gl.render(g.scene, g.camera);
  }

  private buildBall(): THREE.Mesh {
    const ballTex = makeBallTexture();
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(BALL.visualRadius, 48, 32),
      // A little self-lit, like RL's ball under stadium lights, so it stays easy to find.
      new THREE.MeshPhysicalMaterial({ map: ballTex, emissive: 0xffffff, emissiveMap: ballTex, emissiveIntensity: 0.3, roughness: 0.42, metalness: 0.1, clearcoat: 0.5, clearcoatRoughness: 0.2 }),
    );
    this.scene.add(mesh);
    return mesh;
  }
}

interface Garage {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  ringMat: THREE.MeshBasicMaterial;
  car: CarMeshes | null;
  body: number;
  team: Team;
  angle: number;
}

/** Showroom for the Garage: dark studio, reflective turntable with a lit rim, soft key and rim lights. */
function buildGarage(environment: THREE.Texture | null): Garage {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x070b14);
  scene.environment = environment;
  scene.add(new THREE.HemisphereLight(0xc4d8ff, 0x10141c, 0.7));
  const key = new THREE.DirectionalLight(0xfff6e8, 2.2);
  key.position.set(2, 4, 3);
  const rim = new THREE.DirectionalLight(0x9fc4ff, 1.6);
  rim.position.set(-3, 2, -4);
  scene.add(key, rim);

  const deck = new THREE.Mesh(new THREE.CircleGeometry(1.6, 64), new THREE.MeshStandardMaterial({ color: 0x151b26, roughness: 0.35, metalness: 0.4 }));
  deck.rotation.x = -Math.PI / 2;
  scene.add(deck);
  const ringMat = new THREE.MeshBasicMaterial({ color: glow(TEAM_GLOW.blue, 2.5) });
  const ring = new THREE.Mesh(new THREE.RingGeometry(1.56, 1.62, 96), ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.002;
  scene.add(ring);
  const shadow = new BlobShadow(0.95, 6);
  shadow.update(new THREE.Vector3(0, 0.1, 0), true);
  scene.add(shadow.mesh);
  // A soft overhead softbox, so the roof and bonnet catch a long highlight as the car turns.
  const softbox = new THREE.Mesh(new THREE.PlaneGeometry(3, 1.2), new THREE.MeshBasicMaterial({ color: glow(0xffffff, 1.2) }));
  softbox.rotation.x = Math.PI / 2;
  softbox.position.y = 3.2;
  scene.add(softbox);

  // Low three-quarter view, aimed a little under the car so it sits above the menu panel.
  const camera = new THREE.PerspectiveCamera(24, 1, 0.1, 50);
  camera.position.set(0, 2.1, 6.0);
  camera.lookAt(0, -0.45, 0);
  // Start on a front three-quarter view (the nose is at -z, the camera at +z).
  return { scene, camera, ringMat, car: null, body: -1, team: 'blue', angle: Math.PI - 0.7 };
}

/**
 * What shiny surfaces reflect: a dome running from dark turf through a dimly lit ring of stands
 * to night sky, four floodlight banks and an overhead strip. The lamps are kept only a little
 * over BLOOM_THRESHOLD so a reflected light glints instead of flaring across the screen.
 */
function stadiumEnvironment(): THREE.Scene {
  const env = new THREE.Scene();
  const R = 50;
  const dome = new THREE.SphereGeometry(R, 48, 24);
  const pos = dome.attributes.position;
  const sky = new THREE.Color(0x0b1224);
  const stands = new THREE.Color(0x3a4460);
  const turf = new THREE.Color(0x1d3a22);
  const c = new THREE.Color();
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / R;
    if (y >= 0) c.copy(stands).lerp(sky, Math.min(1, y * 2.5));
    else c.copy(stands).lerp(turf, Math.min(1, -y * 4));
    c.toArray(colors, i * 3);
  }
  dome.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  env.add(new THREE.Mesh(dome, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));

  const lamp = new THREE.MeshBasicMaterial({ color: glow(0xfff4dc, 2.5) });
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const bank = new THREE.Mesh(new THREE.PlaneGeometry(14, 6), lamp);
      bank.position.set(sx * 30, 28, sz * 36);
      bank.lookAt(0, 0, 0);
      env.add(bank);
    }
  }
  const strip = new THREE.Mesh(new THREE.PlaneGeometry(30, 6), lamp);
  strip.rotation.x = Math.PI / 2; // face straight down
  strip.position.y = 45;
  env.add(strip);
  return env;
}

/**
 * Neon frame around a goal mouth: two posts and a crossbar in the team colour, bright enough to
 * bloom. Set half into the back wall at the edge of the opening, so it never narrows the goal.
 */
function goalFrame(color: number, side: 1 | -1): THREE.Group {
  const group = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color: glow(color, 3) });
  const t = 0.3; // bar thickness
  const w = ARENA.goalHalfWidth;
  const h = ARENA.goalHeight;
  for (const s of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(t, h + t, t), mat);
    post.position.set(s * (w + t / 2), (h + t) / 2, 0);
    group.add(post);
  }
  const bar = new THREE.Mesh(new THREE.BoxGeometry(w * 2 + t * 2, t, t), mat);
  bar.position.set(0, h + t / 2, 0);
  group.add(bar);
  group.position.z = side * ARENA.extentY;
  return group;
}

function applyInterpolated(obj: THREE.Object3D, a: BodyState, b: BodyState, alpha: number): void {
  pA.set(a.px, a.py, a.pz);
  pB.set(b.px, b.py, b.pz);
  obj.position.copy(pA).lerp(pB, alpha);
  qA.set(a.qx, a.qy, a.qz, a.qw);
  qB.set(b.qx, b.qy, b.qz, b.qw);
  obj.quaternion.copy(qA).slerp(qB, alpha);
}

/** Front-wheel steer angle at full lock for a given forward speed (RL's steer curve). */
function steerAngleFor(forwardSpeed: number): number {
  return curve(CAR.steerAngleFromSpeedCurve, Math.abs(forwardSpeed) / UU);
}

/** Name floating above another player's car. Canvas text on a sprite, built once per name. */
function makeNameplate(name: string, team: Team): THREE.Sprite {
  const cv = document.createElement('canvas');
  cv.width = 256;
  cv.height = 64;
  const ctx = cv.getContext('2d')!;
  ctx.font = 'bold 34px Inter, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 6;
  ctx.strokeStyle = 'rgba(0,0,0,0.75)';
  ctx.strokeText(name, 128, 32, 240);
  ctx.fillStyle = team === 'blue' ? '#8fc1ff' : '#ffc08a';
  ctx.fillText(name, 128, 32, 240);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  sprite.scale.set(2.4, 0.6, 1);
  sprite.position.set(0, 1.1, 0);
  return sprite;
}

/** Static field texture: turf stripes, RL-style markings, boost pad rings. Drawn once, in the plane's metres. */
function makeFieldTexture(fieldW: number, fieldL: number): THREE.Texture {
  const W = 2048;
  const Hpx = Math.round((W * fieldL) / fieldW);
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = Hpx;
  const ctx = cv.getContext('2d')!;
  const sx = W / fieldW;
  const sz = Hpx / fieldL;
  const xToPx = (x: number) => W / 2 + x * sx;
  const zToPx = (z: number) => Hpx / 2 - z * sz;

  // Turf with mowing stripes.
  ctx.fillStyle = '#1c5a2d';
  ctx.fillRect(0, 0, W, Hpx);
  const stripeM = 6.4;
  for (let z = -ARENA.extentY; z < ARENA.extentY; z += stripeM * 2) {
    ctx.fillStyle = 'rgba(255,255,255,0.075)';
    ctx.fillRect(0, zToPx(z + stripeM), W, stripeM * sz);
  }
  // Team halves, faintly tinted. The floor plane is laid flat with its top edge at world -z (the
  // blue goal), so the top half of the canvas is blue's end; fading toward the half line.
  for (const [y0, y1, rgb] of [
    [0, Hpx / 2, '60,120,255'],
    [Hpx, Hpx / 2, '255,140,40'],
  ] as const) {
    const g = ctx.createLinearGradient(0, y0, 0, y1);
    g.addColorStop(0, `rgba(${rgb},0.16)`);
    g.addColorStop(1, `rgba(${rgb},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, Math.min(y0, y1), W, Hpx / 2);
  }
  // Fine grain so the turf does not look like flat paint up close.
  let seed = 11;
  for (let i = 0; i < 60000; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const x = seed % W;
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const y = seed % Hpx;
    ctx.fillStyle = i & 1 ? 'rgba(0,0,0,0.07)' : 'rgba(255,255,255,0.05)';
    ctx.fillRect(x, y, 2, 2);
  }
  // Goal areas darker.
  ctx.fillStyle = '#17332a';
  ctx.fillRect(xToPx(-ARENA.goalHalfWidth), zToPx(ARENA.extentY + ARENA.goalDepth), ARENA.goalHalfWidth * 2 * sx, ARENA.goalDepth * sz);
  ctx.fillRect(xToPx(-ARENA.goalHalfWidth), zToPx(-ARENA.extentY), ARENA.goalHalfWidth * 2 * sx, ARENA.goalDepth * sz);

  const line = (color: string, width: number) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
  };
  const white = 'rgba(255,255,255,0.9)';

  // Field boundary (where the floor ramp starts) and corner cuts.
  line('rgba(255,255,255,0.55)', 4);
  const c = ARENA.cornerCut;
  const inset = 2.56;
  const bx = ARENA.extentX - inset;
  const bz = ARENA.extentY - inset;
  ctx.beginPath();
  ctx.moveTo(xToPx(bx - c), zToPx(-bz));
  ctx.lineTo(xToPx(bx), zToPx(-bz + c));
  ctx.lineTo(xToPx(bx), zToPx(bz - c));
  ctx.lineTo(xToPx(bx - c), zToPx(bz));
  ctx.lineTo(xToPx(-(bx - c)), zToPx(bz));
  ctx.lineTo(xToPx(-bx), zToPx(bz - c));
  ctx.lineTo(xToPx(-bx), zToPx(-bz + c));
  ctx.lineTo(xToPx(-(bx - c)), zToPx(-bz));
  ctx.closePath();
  ctx.stroke();

  // Goal lines, half line.
  line(white, 7);
  for (const z of [-ARENA.extentY, ARENA.extentY]) {
    ctx.beginPath();
    ctx.moveTo(xToPx(-bx), zToPx(z));
    ctx.lineTo(xToPx(bx), zToPx(z));
    ctx.stroke();
  }
  line(white, 6);
  ctx.beginPath();
  ctx.moveTo(xToPx(-bx), zToPx(0));
  ctx.lineTo(xToPx(bx), zToPx(0));
  ctx.stroke();

  // Centre circle and spot.
  ctx.beginPath();
  ctx.arc(xToPx(0), zToPx(0), 9.6 * sx, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(xToPx(0), zToPx(0), 0.7 * sx, 0, Math.PI * 2);
  ctx.fillStyle = white;
  ctx.fill();

  // Goal boxes and penalty arcs.
  for (const s of [-1, 1]) {
    const depth = 14;
    const halfW = ARENA.goalHalfWidth + 9;
    const z0 = zToPx(s * ARENA.extentY);
    const z1 = zToPx(s * (ARENA.extentY - depth));
    ctx.strokeRect(xToPx(-halfW), Math.min(z0, z1), halfW * 2 * sx, Math.abs(z1 - z0));
    const smallHalf = ARENA.goalHalfWidth + 3;
    const zs1 = zToPx(s * (ARENA.extentY - 5.5));
    ctx.strokeRect(xToPx(-smallHalf), Math.min(z0, zs1), smallHalf * 2 * sx, Math.abs(zs1 - z0));
    ctx.beginPath();
    const arcCenterZ = s * (ARENA.extentY - 9);
    ctx.arc(xToPx(0), zToPx(arcCenterZ), 9 * sx, s > 0 ? Math.PI * 0.2 : Math.PI * 1.2, s > 0 ? Math.PI * 0.8 : Math.PI * 1.8);
    ctx.stroke();
  }

  // Boost pad markers.
  line('rgba(255,200,120,0.45)', 3);
  for (const [x, y] of BOOST_PADS.bigLocations) {
    ctx.beginPath();
    ctx.arc(xToPx(x * UU), zToPx(y * UU), 2.2 * sx, 0, Math.PI * 2);
    ctx.stroke();
  }
  line('rgba(255,200,120,0.3)', 2);
  for (const [x, y] of BOOST_PADS.smallLocations) {
    ctx.beginPath();
    ctx.arc(xToPx(x * UU), zToPx(y * UU), 1.3 * sx, 0, Math.PI * 2);
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/**
 * Static wall texture: glass with a hexagon mesh (RL's arena glass) over a baked stadium behind it:
 * dark field-level band, three tiers of seating rendered as coloured speckle, roof structure at the
 * top, a light rail at goal height. Tiles along u.
 */
function makeWallTexture(): THREE.Texture {
  const W = 512;
  const H = 1024;
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext('2d')!;
  // v = 0 at the floor is the bottom of the canvas.
  const yPx = (frac: number) => H - frac * H;
  const grad = ctx.createLinearGradient(0, H, 0, 0);
  grad.addColorStop(0, '#1b2538');
  grad.addColorStop(0.2, '#141c2c');
  grad.addColorStop(0.75, '#101625');
  grad.addColorStop(1, '#070a12');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // Seating tiers behind the glass: speckled crowd in muted colours, separated by walkways.
  let seed = 7;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const tiers: [number, number][] = [
    [0.22, 0.36],
    [0.42, 0.56],
    [0.62, 0.74],
  ];
  // Soft, low-contrast speckle: it should read as a distant crowd, not as noise up close.
  const palette = ['rgba(120,132,160,0.35)', 'rgba(100,110,140,0.3)', 'rgba(150,160,185,0.3)', 'rgba(160,130,110,0.28)', 'rgba(90,100,125,0.3)'];
  for (const [lo, hi] of tiers) {
    ctx.fillStyle = '#121a2a';
    ctx.fillRect(0, yPx(hi), W, (hi - lo) * H);
    for (let y = yPx(hi) + 6; y < yPx(lo) - 6; y += 10) {
      for (let x = 0; x < W; x += 9) {
        if (rnd() < 0.7) {
          ctx.fillStyle = palette[Math.floor(rnd() * palette.length)];
          ctx.fillRect(x + rnd() * 3, y + rnd() * 3, 5, 5);
        }
      }
    }
    // Walkway rail above each tier.
    ctx.fillStyle = 'rgba(180,200,235,0.18)';
    ctx.fillRect(0, yPx(hi) - 3, W, 3);
  }
  // Roof structure near the top.
  ctx.strokeStyle = 'rgba(120,140,180,0.25)';
  ctx.lineWidth = 6;
  for (let x = 0; x <= W; x += W / 4) {
    ctx.beginPath();
    ctx.moveTo(x, yPx(0.78));
    ctx.lineTo(x + W / 8, yPx(1));
    ctx.moveTo(x, yPx(0.78));
    ctx.lineTo(x - W / 8, yPx(1));
    ctx.stroke();
  }

  // Glass: hexagon mesh over everything, slightly brighter near the floor where the glass is lit.
  const r = 30;
  const dx = r * Math.sqrt(3);
  const dy = r * 1.5;
  ctx.lineWidth = 2;
  let row = 0;
  for (let y = H + r; y > -r; y -= dy, row++) {
    for (let x = row % 2 ? dx / 2 : 0; x < W + dx; x += dx) {
      const frac = 1 - y / H;
      ctx.strokeStyle = `rgba(160,190,240,${(0.16 - frac * 0.1).toFixed(3)})`;
      ctx.beginPath();
      for (let k = 0; k < 6; k++) {
        const a = (Math.PI / 3) * k + Math.PI / 6;
        const px = x + r * Math.cos(a);
        const py = y + r * Math.sin(a);
        if (k === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.stroke();
    }
  }
  // Glass tint reflections: faint diagonal sheen.
  const sheen = ctx.createLinearGradient(0, H, W, 0);
  sheen.addColorStop(0, 'rgba(255,255,255,0)');
  sheen.addColorStop(0.5, 'rgba(255,255,255,0.045)');
  sheen.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = sheen;
  ctx.fillRect(0, 0, W, H);
  // Rail at goal height and the glow strip near the ceiling curve.
  const goalFrac = ARENA.goalHeight / ARENA.height;
  ctx.fillStyle = 'rgba(143,184,255,0.45)';
  ctx.fillRect(0, yPx(goalFrac) - 4, W, 8);
  ctx.fillStyle = 'rgba(255,179,71,0.22)';
  ctx.fillRect(0, yPx(0.78) - 5, W, 10);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 4;
  return tex;
}

/** RL-like ball: light grey with darker hexagon panel seams and a few darker panels. */
function makeBallTexture(): THREE.Texture {
  const cv = document.createElement('canvas');
  cv.width = 512;
  cv.height = 256;
  const ctx = cv.getContext('2d')!;
  ctx.fillStyle = '#cfd6de';
  ctx.fillRect(0, 0, cv.width, cv.height);
  const r = 22;
  const dx = r * Math.sqrt(3);
  const dy = r * 1.5;
  let row = 0;
  for (let y = -r; y < cv.height + r; y += dy, row++) {
    for (let x = row % 2 ? dx / 2 : 0; x < cv.width + dx; x += dx) {
      ctx.beginPath();
      for (let k = 0; k < 6; k++) {
        const a = (Math.PI / 3) * k + Math.PI / 6;
        const px = x + r * Math.cos(a);
        const py = y + r * Math.sin(a);
        if (k === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      // Every few panels darker, like the ball's pattern.
      const h = (Math.round(x / dx) * 7 + row * 3) % 11;
      ctx.fillStyle = h < 2 ? '#6b7683' : h < 4 ? '#aeb8c4' : '#d6dce3';
      ctx.fill();
      ctx.strokeStyle = '#3d4753';
      ctx.lineWidth = 3;
      ctx.stroke();
    }
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
