import assert from 'node:assert/strict';
import * as THREE from 'three';
import { build } from 'vite';
import { fileURLToPath } from 'node:url';

const rendererEntry = fileURLToPath(new URL('../src/render/renderer.ts', import.meta.url));
const outDir = fileURLToPath(new URL('../.qa-build/pad-render-updates', import.meta.url));
await build({
  configFile: false,
  build: { ssr: rendererEntry, outDir, emptyOutDir: true, target: 'esnext', minify: false },
});
const { Renderer } = await import('../.qa-build/pad-render-updates/renderer.js');

const pads = [
  { x: 0, y: 0, z: 0, big: true, cooldown: 0 },
  { x: 2, y: 0, z: 0, big: false, cooldown: 0 },
  { x: 4, y: 0, z: 0, big: false, cooldown: 0 },
];
const canvasContext = {
  createRadialGradient: () => ({ addColorStop() {} }),
  fillRect() {},
  set fillStyle(_value) {},
};
globalThis.document = {
  createElement: () => ({ width: 0, height: 0, getContext: () => canvasContext }),
};
const renderer = Object.create(Renderer.prototype);
Object.assign(renderer, {
  scene: new THREE.Scene(),
  pads: [],
  padMatrix: new THREE.Matrix4(),
  padColorOn: new THREE.Color(0xffc46b).multiplyScalar(2.5),
  padColorOff: new THREE.Color(0x2f3d33),
  padTime: 0,
  tmpV: new THREE.Vector3(),
  padPops: [{ age: 99, sprite: { visible: false, position: new THREE.Vector3(), scale: new THREE.Vector3(), material: { opacity: 1 } } }],
  prevPadCooldown: [],
});
renderer.buildPads(pads);

const counters = { colorWrites: 0, matrixWrites: 0 };
for (const mesh of [renderer.bigRings, renderer.smallRings]) {
  const setColorAt = mesh.setColorAt.bind(mesh);
  mesh.setColorAt = (...args) => { counters.colorWrites++; return setColorAt(...args); };
}
const setMatrixAt = renderer.bigOrbs.setMatrixAt.bind(renderer.bigOrbs);
renderer.bigOrbs.setMatrixAt = (...args) => { counters.matrixWrites++; return setMatrixAt(...args); };
const snapshot = () => ({
  colorWrites: counters.colorWrites,
  bigColorVersion: renderer.bigRings.instanceColor.version,
  smallColorVersion: renderer.smallRings.instanceColor.version,
  orbMatrixVersion: renderer.bigOrbs.instanceMatrix.version,
});
const delta = (before, after) => Object.fromEntries(Object.keys(before).map((k) => [k, after[k] - before[k]]));

// Instrument the former unconditional per-frame work against the same real meshes.
const oldPathBefore = snapshot();
for (const pad of renderer.pads) {
  (pad.big ? renderer.bigRings : renderer.smallRings).setColorAt(pad.index, renderer.padColorOn);
}
renderer.bigRings.instanceColor.needsUpdate = true;
renderer.smallRings.instanceColor.needsUpdate = true;
const oldPathPerFrame = {
  colorWrites: counters.colorWrites,
  colorAttributeVersionChanges: {
    big: renderer.bigRings.instanceColor.version - oldPathBefore.bigColorVersion,
    small: renderer.smallRings.instanceColor.version - oldPathBefore.smallColorVersion,
  },
};
counters.colorWrites = 0;

// Initialization writes all colors once; subsequent steady frames write no color orbs.
let before = snapshot();
renderer.syncPads(pads, 1 / 60);
let after = snapshot();
assert.deepEqual(delta(before, after), { colorWrites: 0, bigColorVersion: 0, smallColorVersion: 0, orbMatrixVersion: 1 });
assert.equal(counters.matrixWrites, 1, 'big orb bob/rotation matrix is still updated every frame');
before = snapshot();
renderer.syncPads(pads, 1 / 60);
after = snapshot();
assert.deepEqual(delta(before, after), { colorWrites: 0, bigColorVersion: 0, smallColorVersion: 0, orbMatrixVersion: 1 });

// One small pad pickup dirties only the small ring color attribute.
pads[1].cooldown = 10;
before = snapshot();
renderer.syncPads(pads, 1 / 60);
after = snapshot();
assert.deepEqual(delta(before, after), { colorWrites: 1, bigColorVersion: 0, smallColorVersion: 1, orbMatrixVersion: 1 });

// A changing inactive cooldown is not a color transition; expiry is.
pads[1].cooldown = 9.9;
before = snapshot();
renderer.syncPads(pads, 1 / 60);
after = snapshot();
assert.deepEqual(delta(before, after), { colorWrites: 0, bigColorVersion: 0, smallColorVersion: 0, orbMatrixVersion: 1 });
pads[1].cooldown = 0;
before = snapshot();
renderer.syncPads(pads, 1 / 60);
after = snapshot();
assert.deepEqual(delta(before, after), { colorWrites: 1, bigColorVersion: 0, smallColorVersion: 1, orbMatrixVersion: 1 });

// Same active colors still allow the existing 0 -> cooldown pop edge detection.
pads[1].cooldown = 0;
renderer.prevPadCooldown = [0, 0, 0];
const pop = renderer.padPops[0];
renderer.padPops = [pop];
pads[1].cooldown = 10;
renderer.syncPads(pads, 1 / 60);
assert.equal(pop.age, 1 / 60, 'pickup pop starts and advances by dt');

// A changed roster rebuilds instance meshes and initializes each color from cooldown state.
const replacement = [...pads, { x: 6, y: 0, z: 0, big: true, cooldown: 2 }];
renderer.syncPads(replacement, 1 / 60);
assert.equal(renderer.pads.length, replacement.length);
assert.equal(renderer.pads[3].active, false);
assert.equal(renderer.prevPadCooldown.length, replacement.length);

console.log(JSON.stringify({
  fixture: 'production Renderer.syncPads with real THREE.InstancedMesh (no WebGL)',
  checks: 6,
  oldPathPerFrame,
  steadyFrameColorWrites: 0,
  steadyFrameColorAttributeVersionChanges: 0,
  transitionColorWrites: 1,
  transitionAttributeVersionChanges: { affectedMesh: 1, otherRingMesh: 0 },
  steadyFrameBigOrbMatrixWrites: 1,
}, null, 2));
