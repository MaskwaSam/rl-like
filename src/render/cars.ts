/**
 * Car bodies. Purely cosmetic: every body is built inside the same Octane hitbox the physics
 * uses, with the wheels at RL's Octane hardpoints, so the choice never changes how a car plays.
 *
 * Each body is one extruded side profile (so the silhouette reads correctly from every angle,
 * with a bevel to catch the light) plus a few boxes for glass, lights and trim. Everything is
 * sized from HITBOX_HALF, so the visible car is the shape the physics collides with.
 */
import * as THREE from 'three';
import { OCTANE } from '../sim/rl';
import { HITBOX_HALF, HITBOX_OFFSET, type Team } from '../sim/car';
import { GLOW, glow } from './effects';

export const TEAM_PAINT: Record<Team, number> = { blue: 0x1f63d8, orange: 0xf07f1a };
export const TEAM_GLOW: Record<Team, number> = { blue: 0x4aa3ff, orange: 0xff9a3c };

export interface CarMeshes {
  group: THREE.Group;
  wheels: { pivot: THREE.Group; mesh: THREE.Object3D; radius: number; front: boolean; restY: number }[];
  flame: THREE.Mesh;
  flameMaterial: THREE.MeshBasicMaterial;
}

/** What a body builder gets: the hitbox half-extents, shared materials and drawing helpers. */
interface BodyKit {
  /** Half width (x), half height (y), half length (z); the nose is at -z. */
  hw: number;
  hh: number;
  hl: number;
  paint: THREE.Material;
  trim: THREE.Material;
  glass: THREE.Material;
  chrome: THREE.Material;
  headlight: THREE.Material;
  taillight: THREE.Material;
  /** Body-local z of the front and rear axles, for arches and flares. */
  frontAxleZ: number;
  rearAxleZ: number;
  /**
   * How far the painted surface sits outside the traced profile: the shell's bevel grows the
   * outline by this much. Anything mounted on the nose, tail, roof or screens must allow for it.
   */
  skin: number;
  /** Extrude a side profile of (z, y) points into the painted shell. Call first. */
  shell(profile: [number, number][]): void;
  box(mat: THREE.Material, sx: number, sy: number, sz: number, x: number, y: number, z: number): THREE.Mesh;
  /** A sheet (glass, lights) lying on the profile edge from (z0,y0) to (z1,y1), centred at x. */
  pane(mat: THREE.Material, z0: number, y0: number, z1: number, y1: number, width: number, x?: number): THREE.Mesh;
  /** A part on the flat nose face: `out` is how far it stands proud, `depth` its thickness. */
  front(mat: THREE.Material, sx: number, sy: number, x: number, y: number, out?: number, depth?: number): THREE.Mesh;
  /** The same on the flat tail face. */
  back(mat: THREE.Material, sx: number, sy: number, x: number, y: number, out?: number, depth?: number): THREE.Mesh;
}

export interface CarBody {
  name: string;
  blurb: string;
  build(k: BodyKit): void;
}

export const CAR_BODIES: CarBody[] = [
  {
    name: 'Scout',
    blurb: 'Boxy hot hatch. Short nose, tall flat roof, easy to read in the air.',
    build(k) {
      const { hw, hh, hl } = k;
      // Stubby nose, fast windscreen, flat roof running most of the length, blunt tail.
      k.shell([
        [-hl, -hh * 0.62],
        [-hl, -hh * 0.02],
        [-hl * 0.93, hh * 0.3],
        [-hl * 0.46, hh * 0.4],
        [-hl * 0.14, hh * 0.99],
        [hl * 0.5, hh * 0.99],
        [hl * 0.72, hh * 0.5],
        [hl * 0.99, hh * 0.36],
        [hl * 0.99, -hh * 0.62],
      ]);
      for (const side of [1, -1]) k.box(k.glass, 0.012, hh * 0.42, hl * 0.6, side * (hw - 0.004), hh * 0.6, hl * 0.16);
      k.pane(k.glass, -hl * 0.46, hh * 0.4, -hl * 0.14, hh * 0.99, hw * 1.84);
      k.pane(k.glass, hl * 0.5, hh * 0.99, hl * 0.72, hh * 0.5, hw * 1.84);
      k.front(k.trim, hw * 1.9, hh * 0.34, 0, -hh * 0.3, 0.02, 0.04); // bumper
      k.back(k.trim, hw * 1.9, hh * 0.34, 0, -hh * 0.3, 0.02, 0.04);
      k.front(k.chrome, hw * 1.2, hh * 0.16, 0, -hh * 0.1, 0.012); // grille bar
      for (const side of [1, -1]) {
        k.box(k.headlight, hw * 0.44, hh * 0.16, 0.03, side * hw * 0.62, hh * 0.16, -hl * 0.955);
        k.back(k.taillight, hw * 0.46, hh * 0.18, side * hw * 0.6, hh * 0.18);
      }
      k.box(k.trim, hw * 1.7, hh * 0.1, hl * 0.12, 0, hh * 1.04 + k.skin, hl * 0.52); // roof spoiler
    },
  },
  {
    name: 'Arrow',
    blurb: 'Low wedge supercar. Long sloping bonnet, fastback roof and a big rear wing.',
    build(k) {
      const { hw, hh, hl } = k;
      // Knife-edge nose rising along a long bonnet, raked screen, short roof, long fastback.
      k.shell([
        [-hl, -hh * 0.62],
        [-hl, -hh * 0.38],
        [-hl * 0.95, -hh * 0.24],
        [-hl * 0.38, hh * 0.12],
        [-hl * 0.04, hh * 0.76],
        [hl * 0.28, hh * 0.8],
        [hl * 0.86, hh * 0.3],
        [hl * 0.99, hh * 0.22],
        [hl * 0.99, -hh * 0.62],
      ]);
      k.pane(k.glass, -hl * 0.38, hh * 0.12, -hl * 0.04, hh * 0.76, hw * 1.7);
      k.pane(k.glass, hl * 0.28, hh * 0.8, hl * 0.62, hh * 0.5, hw * 1.5);
      // Side glass: a short teardrop band high on the flank.
      for (const side of [1, -1]) k.box(k.glass, 0.012, hh * 0.3, hl * 0.42, side * (hw - 0.004), hh * 0.45, hl * 0.1);
      // Side intakes behind the doors.
      for (const side of [1, -1]) k.box(k.trim, 0.014, hh * 0.32, hl * 0.26, side * (hw - 0.002), -hh * 0.08, hl * 0.5);
      // Front splitter, and slim headlights along the short slope at the tip of the nose.
      k.front(k.trim, hw * 2.02, 0.025, 0, -hh * 0.6, 0.03, 0.06);
      for (const side of [1, -1]) k.pane(k.headlight, -hl, -hh * 0.38, -hl * 0.95, -hh * 0.24, hw * 0.5, side * hw * 0.52);
      // Full-width tail-light bar over a diffuser.
      k.back(k.taillight, hw * 1.76, hh * 0.08, 0, hh * 0.08);
      k.back(k.trim, hw * 1.9, hh * 0.3, 0, -hh * 0.42, 0.02, 0.04);
      // Rear wing on two pylons, kept inside the hitbox height.
      for (const side of [1, -1]) k.box(k.trim, 0.03, hh * 0.55, 0.05, side * hw * 0.55, hh * 0.58, hl * 0.84);
      k.box(k.paint, hw * 1.96, 0.024, hl * 0.2, 0, hh * 0.88, hl * 0.86);
    },
  },
  {
    name: 'Bruiser',
    blurb: 'Square-jawed muscle truck. Tall bonnet, upright screen, flared arches and a light bar.',
    build(k) {
      const { hw, hh, hl } = k;
      // Tall blunt nose, long flat bonnet, near-upright screen, long flat roof, square tail.
      k.shell([
        [-hl, -hh * 0.62],
        [-hl, hh * 0.32],
        [-hl * 0.94, hh * 0.42],
        [-hl * 0.44, hh * 0.46],
        [-hl * 0.24, hh * 0.97],
        [hl * 0.92, hh * 0.97],
        [hl * 0.99, hh * 0.86],
        [hl * 0.99, -hh * 0.62],
      ]);
      k.pane(k.glass, -hl * 0.44, hh * 0.46, -hl * 0.24, hh * 0.97, hw * 1.8);
      k.back(k.glass, hw * 1.6, hh * 0.36, 0, hh * 0.6); // rear window
      for (const side of [1, -1]) k.box(k.glass, 0.012, hh * 0.36, hl * 0.95, side * (hw - 0.004), hh * 0.68, hl * 0.32);
      // Flared arches over each wheel.
      for (const side of [1, -1]) {
        for (const z of [k.frontAxleZ, k.rearAxleZ]) k.box(k.trim, 0.04, hh * 0.5, 0.36, side * (hw - 0.008), -hh * 0.36, z);
      }
      // Grille, square headlights, and a bull bar standing off the nose.
      k.front(k.chrome, hw * 0.74, hh * 0.34, 0, hh * 0.02, 0.006);
      for (const side of [1, -1]) k.front(k.headlight, hw * 0.3, hh * 0.22, side * hw * 0.66, hh * 0.06, 0.006);
      k.front(k.chrome, hw * 1.6, 0.035, 0, -hh * 0.35, 0.07, 0.035);
      for (const side of [1, -1]) k.front(k.chrome, 0.035, hh * 0.62, side * hw * 0.5, -hh * 0.22, 0.07, 0.07);
      // Light bar on the leading edge of the roof.
      k.box(k.trim, hw * 1.4, 0.03, 0.05, 0, hh * 0.97 + k.skin + 0.015, -hl * 0.18);
      k.box(k.headlight, hw * 1.3, 0.024, 0.012, 0, hh * 0.97 + k.skin + 0.015, -hl * 0.18 - 0.028);
      // Tall tail lights at the corners and a heavy rear bumper.
      for (const side of [1, -1]) k.back(k.taillight, hw * 0.16, hh * 0.52, side * hw * 0.82, hh * 0.25);
      k.back(k.trim, hw * 2.0, hh * 0.3, 0, -hh * 0.42, 0.03, 0.05);
    },
  },
];

/** Build a car's meshes: the chosen body, the shared skirt and accents, wheels and boost flame. */
export function buildCarMeshes(team: Team, bodyIndex: number): CarMeshes {
  const group = new THREE.Group();
  const body = new THREE.Group();
  body.position.copy(HITBOX_OFFSET);
  group.add(body);

  const hw = HITBOX_HALF.x; // 0.433 half width
  const hh = HITBOX_HALF.y; // 0.193 half height
  const hl = HITBOX_HALF.z; // 0.603 half length; the nose is at -z

  // Metallic flake paint under a glossy clear coat, as on a real car.
  const paint = new THREE.MeshPhysicalMaterial({ color: TEAM_PAINT[team], metalness: 0.2, roughness: 0.4, clearcoat: 1, clearcoatRoughness: 0.08 });
  const trim = new THREE.MeshStandardMaterial({ color: 0x14181f, roughness: 0.65, metalness: 0.1 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x0a1018, roughness: 0.05, metalness: 0.6 });
  const chrome = new THREE.MeshStandardMaterial({ color: 0xc9d1dc, roughness: 0.25, metalness: 0.5 });
  const headlight = new THREE.MeshBasicMaterial({ color: glow(0xfff4cf, 3) });
  // Kept under 2x: brighter reds wash out toward pink once tone mapped.
  const taillight = new THREE.MeshBasicMaterial({ color: glow(0xff2e2e, 1.6) });
  // Team-colour underglow strip along the sills.
  const accent = new THREE.MeshBasicMaterial({ color: glow(TEAM_GLOW[team], 2.5) });

  const box: BodyKit['box'] = (mat, sx, sy, sz, x, y, z) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), mat);
    m.position.set(x, y, z);
    body.add(m);
    return m;
  };
  const bevel = 0.014;
  let noseZ = -hl - bevel;
  let tailZ = hl + bevel;
  const kit: BodyKit = {
    hw,
    hh,
    hl,
    skin: bevel,
    paint,
    trim,
    glass,
    chrome,
    headlight,
    taillight,
    // Axles in body space: the body group sits at HITBOX_OFFSET inside the car.
    frontAxleZ: -OCTANE.frontWheelOffset.x - HITBOX_OFFSET.z,
    rearAxleZ: -OCTANE.rearWheelOffset.x - HITBOX_OFFSET.z,
    shell(profile) {
      const shape = new THREE.Shape();
      shape.moveTo(profile[0][0], profile[0][1]);
      for (let i = 1; i < profile.length; i++) shape.lineTo(profile[i][0], profile[i][1]);
      shape.closePath();
      noseZ = Math.min(...profile.map((p) => p[0])) - bevel;
      tailZ = Math.max(...profile.map((p) => p[0])) + bevel;
      const geo = new THREE.ExtrudeGeometry(shape, {
        depth: hw * 2 - bevel * 2,
        bevelEnabled: true,
        bevelThickness: bevel,
        bevelSize: bevel,
        bevelSegments: 2,
        curveSegments: 1,
      });
      // Extrusion runs along the shape's +Z; turn it so it runs across the car, and centre it.
      geo.rotateY(-Math.PI / 2);
      geo.translate(hw - bevel, 0, 0);
      body.add(new THREE.Mesh(geo, paint));
    },
    box,
    pane(mat, z0, y0, z1, y1, width, x = 0) {
      const dz = z1 - z0;
      const dy = y1 - y0;
      const len = Math.hypot(dz, dy);
      // Rotate the box's long (z) axis onto the edge, then lift it along the edge's outward
      // normal to the painted surface (skin), plus a hair so it never z-fights the shell.
      const lift = bevel + 0.004;
      const m = box(mat, width, 0.012, len * 0.9, x, (y0 + y1) / 2 + (dz / len) * lift, (z0 + z1) / 2 - (dy / len) * lift);
      m.rotation.x = Math.atan2(-dy, dz);
      return m;
    },
    front(mat, sx, sy, x, y, out = 0.004, depth = 0.016) {
      return box(mat, sx, sy, depth, x, y, noseZ - out + depth / 2);
    },
    back(mat, sx, sy, x, y, out = 0.004, depth = 0.016) {
      return box(mat, sx, sy, depth, x, y, tailZ + out - depth / 2);
    },
  };

  (CAR_BODIES[bodyIndex] ?? CAR_BODIES[0]).build(kit);

  // Shared by every body: dark lower skirt, and team-colour accent strips just above it.
  box(trim, hw * 2.02, hh * 0.3, hl * 1.98, 0, -hh * 0.78, 0);
  for (const side of [1, -1]) box(accent, 0.012, hh * 0.07, hl * 1.3, side * (hw + 0.004), -hh * 0.58, 0);

  // Wheels at RL's hardpoints and radii. Each pivot steers and rides the suspension; the holder
  // inside it spins, so steering and roll never fight each other.
  const wheelDefs = [
    { x: OCTANE.frontWheelOffset.y, z: -OCTANE.frontWheelOffset.x, r: OCTANE.frontWheelRadius, front: true },
    { x: -OCTANE.frontWheelOffset.y, z: -OCTANE.frontWheelOffset.x, r: OCTANE.frontWheelRadius, front: true },
    { x: OCTANE.rearWheelOffset.y, z: -OCTANE.rearWheelOffset.x, r: OCTANE.rearWheelRadius, front: false },
    { x: -OCTANE.rearWheelOffset.y, z: -OCTANE.rearWheelOffset.x, r: OCTANE.rearWheelRadius, front: false },
  ];
  const tyreMat = new THREE.MeshStandardMaterial({ color: 0x0d0f12, roughness: 0.92, metalness: 0 });
  // Satin rather than mirror metal: a mirror would only show the dark night stadium.
  const rimMat = new THREE.MeshStandardMaterial({ color: 0xc4ccd8, roughness: 0.35, metalness: 0.35 });
  const wheels: CarMeshes['wheels'] = [];
  for (const d of wheelDefs) {
    const pivot = new THREE.Group();
    const restY = d.r - OCTANE.restZ;
    pivot.position.set(d.x + Math.sign(d.x) * 0.035, restY, d.z);
    const holder = new THREE.Group();
    const width = 0.175;
    const tyre = new THREE.CylinderGeometry(d.r, d.r, width, 16);
    tyre.rotateZ(Math.PI / 2);
    const tyreMesh = new THREE.Mesh(tyre, tyreMat);
    const rim = new THREE.CylinderGeometry(d.r * 0.62, d.r * 0.62, width + 0.012, 12);
    rim.rotateZ(Math.PI / 2);
    tyreMesh.add(new THREE.Mesh(rim, rimMat));
    // Spokes: a couple of thin bars so the wheel visibly turns.
    for (let i = 0; i < 3; i++) {
      const spoke = new THREE.Mesh(new THREE.BoxGeometry(width + 0.014, d.r * 1.1, 0.035), rimMat);
      spoke.rotation.x = (i * Math.PI) / 3;
      tyreMesh.add(spoke);
    }
    holder.add(tyreMesh);
    pivot.add(holder);
    group.add(pivot);
    wheels.push({ pivot, mesh: holder, radius: d.r, front: d.front, restY });
  }

  // Everything solid so far casts a shadow (the flame and nameplate, added later, do not).
  group.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) o.castShadow = true;
  });

  const flameMaterial = new THREE.MeshBasicMaterial({ color: glow(0xffa62b, GLOW) });
  const flame = new THREE.Mesh(new THREE.ConeGeometry(0.15, 0.85, 8), flameMaterial);
  flame.rotation.x = Math.PI / 2; // tip points to the rear
  flame.position.set(0, -hh * 0.15, hl + 0.42);
  flame.visible = false;
  body.add(flame);

  return { group, wheels, flame, flameMaterial };
}
