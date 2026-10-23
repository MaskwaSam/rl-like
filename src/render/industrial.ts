import * as THREE from 'three';
import { ARENA } from '../sim/rl';

/** An original warehouse shell outside the common playable collision geometry. */
export function buildIndustrial(): THREE.Group {
  const group = new THREE.Group();
  const steel = new THREE.MeshStandardMaterial({ color: 0x566470, roughness: 0.55, metalness: 0.55 });
  const concrete = new THREE.MeshStandardMaterial({ color: 0x737a7b, roughness: 0.94, side: THREE.DoubleSide });
  const panels = new THREE.MeshStandardMaterial({ color: 0x343f49, roughness: 0.72, metalness: 0.35, side: THREE.DoubleSide });
  const lamp = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xf6e8c7).multiplyScalar(2.6) });
  const blue = new THREE.MeshBasicMaterial({ color: 0x4e9cff });
  const orange = new THREE.MeshBasicMaterial({ color: 0xf7a651 });
  const x = ARENA.extentX + 7, z = ARENA.extentY + 18, roofY = 42;
  const box = (w: number, h: number, d: number, px: number, py: number, pz: number, mat: THREE.Material) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    mesh.position.set(px, py, pz); group.add(mesh); return mesh;
  };
  const beam = (a: THREE.Vector3, b: THREE.Vector3, width = 0.4) => {
    const direction = b.clone().sub(a);
    const mesh = box(width, direction.length(), width, 0, 0, 0, steel);
    mesh.position.copy(a).add(b).multiplyScalar(0.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
  };
  for (const side of [-1, 1]) {
    box(0.8, 10, z * 2, side * x, 5, 0, concrete);
    box(0.8, 32, z * 2, side * x, 26, 0, panels);
    box(x * 2, 10, 0.8, 0, 5, side * z, concrete);
    box(x * 2, 32, 0.8, 0, 26, side * z, panels);
    // Inward facing team strips keep each end readable through the safety mesh.
    box(x * 2 - 1, 0.3, 0.25, 0, 11, side * (z - 0.6), side < 0 ? blue : orange);
    for (let pz = -z; pz <= z; pz += 10) {
      box(0.7, roofY, 0.7, side * (x - 0.6), roofY / 2, pz, steel);
      box(0.2, 0.3, 9.8, side * (x - 0.6), 16, pz + 5, steel);
      box(0.2, 0.3, 9.8, side * (x - 0.6), 28, pz + 5, steel);
    }
  }
  // Roof and repeated triangular trusses are above the game's original ceiling.
  box(x * 2 + 1, 0.6, z * 2 + 1, 0, roofY, 0, panels);
  for (let pz = -z + 7; pz < z; pz += 16) {
    box(x * 2, 0.45, 0.45, 0, 37, pz, steel);
    box(x * 2, 0.4, 0.4, 0, 41, pz, steel);
    for (let px = -x; px < x; px += 8) {
      beam(new THREE.Vector3(px, 37, pz), new THREE.Vector3(Math.min(x, px + 8), 41, pz));
      beam(new THREE.Vector3(px, 41, pz), new THREE.Vector3(Math.min(x, px + 8), 37, pz));
    }
    for (const px of [-24, 0, 24]) box(9, 0.2, 1.2, px, 36.7, pz, lamp);
  }
  // Warm loading-bay rails and painted diagonal hazard stripes, outside the field.
  const yellow = new THREE.MeshBasicMaterial({ color: 0xd5a843 });
  const black = new THREE.MeshBasicMaterial({ color: 0x20282e });
  for (const side of [-1, 1]) {
    box(0.4, 0.4, z * 2, side * (x - 1.2), 3, 0, yellow);
    for (let pz = -z + 2; pz < z; pz += 3) {
      const stripe = box(0.15, 1.7, 0.65, side * (x - 0.7), 8, pz, black);
      stripe.rotation.x = -Math.PI / 5;
    }
  }
  return group;
}
