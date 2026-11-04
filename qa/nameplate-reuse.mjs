import assert from 'node:assert/strict';
import { build } from 'vite';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const entry = fileURLToPath(new URL('../src/render/renderer.ts', import.meta.url));
await build({ configFile: false, plugins: [{
  name: 'baseline-nameplates', enforce: 'pre',
  load(id) { if (id === entry) return execFileSync('git', ['show', '29cebbaf055d7e8bdd010c0e975a31afad19c527:src/render/renderer.ts'], { encoding: 'utf8' }); },
}], build: { ssr: entry, outDir: '.qa-build/nameplate-baseline', emptyOutDir: true, target: 'esnext', minify: false } });
const { Renderer: BaselineRenderer } = await import('../.qa-build/nameplate-baseline/renderer.js');
await build({ configFile: false, build: { ssr: entry, outDir: '.qa-build/nameplate-reuse', emptyOutDir: true, target: 'esnext', minify: false } });
const { Renderer } = await import('../.qa-build/nameplate-reuse/renderer.js');
const THREE = await import('three');
let canvasCount = 0;
const disposedTextures = new WeakSet();
const disposedMaterials = new WeakSet();
const textureDisposeCounts = new Map(), materialDisposeCounts = new Map(), geometryDisposeCounts = new Map();
const canvases = [];
globalThis.document = { createElement(tag) {
  assert.equal(tag, 'canvas'); canvasCount++;
  const calls = [];
  const ctx = { font: '', textAlign: '', textBaseline: '', lineWidth: 0, strokeStyle: '', fillStyle: '', clearRect(...a) { calls.push(['clear', ...a]); }, strokeText(...a) { calls.push(['stroke', ...a]); }, fillText(...a) { calls.push(['fill', ...a]); } };
  const canvas = { width: 0, height: 0, getContext: () => ctx, calls }; canvases.push(canvas); return canvas;
} };
const textureDispose = THREE.Texture.prototype.dispose;
THREE.Texture.prototype.dispose = function() { disposedTextures.add(this); textureDisposeCounts.set(this, (textureDisposeCounts.get(this) ?? 0) + 1); return textureDispose.call(this); };
const materialDispose = THREE.Material.prototype.dispose;
THREE.Material.prototype.dispose = function() { disposedMaterials.add(this); materialDisposeCounts.set(this, (materialDisposeCounts.get(this) ?? 0) + 1); return materialDispose.call(this); };
const geometryDispose = THREE.BufferGeometry.prototype.dispose;
THREE.BufferGeometry.prototype.dispose = function() { geometryDisposeCounts.set(this, (geometryDisposeCounts.get(this) ?? 0) + 1); return geometryDispose.call(this); };
function fixture(Type) {
const renderer = Object.create(Type.prototype);
renderer.cars = new Map(); renderer.scene = new THREE.Scene(); renderer.realShadows = false;
renderer.camera = new THREE.PerspectiveCamera(); renderer.tmpV = new THREE.Vector3();
renderer.buildCar = (team, body) => ({ group: new THREE.Group(), team, body, wheels: [], flame: new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial()), flameMaterial: new THREE.MeshBasicMaterial(), nameplate: null, name: '', trail: { mesh: new THREE.Group(), clear() {}, update() {}, addPoint() {} }, shadow: { mesh: new THREE.Group(), update() {} } });
return renderer;
}
const renderer = fixture(Renderer);
const base = { id: 2, team: 'blue', name: 'Alpha', body: 0, prev: { px: 0, py: 0, pz: 0, qx: 0, qy: 0, qz: 0, qw: 1 }, curr: { px: 1, py: 0, pz: 0, qx: 0, qy: 0, qz: 0, qw: 1 }, alpha: 1, forwardSpeed: 0, steer: 0, boosting: false, supersonic: false, demoed: false, offsetPos: null, offsetQuat: null, wheelY: null };
const sync = (state, local = 1) => renderer.syncCars([state], local, 1 / 60);
const baseline = fixture(BaselineRenderer);
for (let i = 0; i < 100; i++) baseline.syncCars([base], i % 2 === 0 ? 2 : 1, 1 / 60);
const baselineCanvases = canvasCount;
assert.equal(baselineCanvases, 50, '100 alternating views show the nameplate 50 times');
canvasCount = 0; canvases.length = 0;
// Actual baseline and candidate syncCars methods with the same Three.js fixture.
for (let i = 0; i < 100; i++) sync(base, i % 2 === 0 ? 2 : 1);
assert.equal(canvasCount, 1, '100 follow/overview switches allocate only the first per-car canvas');
const car = renderer.cars.get(2), sprite = car.nameplate, texture = sprite.material.map, material = sprite.material;
assert.equal(sprite.visible, true);
assert.deepEqual(canvases[0].calls.filter(c => c[0] === 'fill').map(c => c[1]), ['Alpha']);
sync({ ...base, demoed: true }); assert.equal(sprite.visible, false);
sync(base); assert.equal(sprite.visible, true, 'respawn restores nameplate visibility');
sync({ ...base, name: '' }); assert.equal(sprite.visible, false);
sync({ ...base, name: 'Renamed' }, 2); assert.equal(sprite.visible, false, 'rename while hidden stays hidden');
sync({ ...base, name: 'Renamed' }, 1); assert.equal(car.nameplate, sprite); assert.equal(texture, sprite.material.map);
assert.deepEqual(canvases[0].calls.filter(c => c[0] === 'fill').map(c => c[1]), ['Alpha', 'Renamed']);
sync({ ...base, body: 1 }); assert(disposedTextures.has(texture)); assert(disposedMaterials.has(material));
const rebuilt = renderer.cars.get(2).nameplate; assert.notEqual(rebuilt, sprite);
renderer.removeCar(2); assert(disposedTextures.has(rebuilt.material.map));
renderer.removeCar(2); assert.equal(canvasCount, 2, 'repeated removal is harmless');
assert.equal(textureDisposeCounts.get(texture), 1);
assert.equal(materialDisposeCounts.get(material), 1);
assert.equal(textureDisposeCounts.get(rebuilt.material.map), 1);
assert.equal(geometryDisposeCounts.get(sprite.geometry) ?? 0, 0, 'shared Sprite geometry is not disposed');
assert.equal(disposedTextures.has(texture), true); assert.equal(disposedMaterials.has(material), true);
sync(base); const replacement = renderer.cars.get(2).nameplate; assert.notEqual(replacement, sprite); assert.equal(canvasCount, 3);
assert.equal(disposedTextures.has(replacement.material.map), false, 'readded car owns fresh live resources');
renderer.removeCar(2);
console.log(`nameplate reuse: 100 alternating views = ${baselineCanvases} baseline vs 1 candidate canvas/texture; visibility, rename, removal, and re-add passed`);
