import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { build } from 'vite';

const baselineCommit = 'c57fd439b5d89cab43e384c5f43ef7aeba23588b';
const root = fileURLToPath(new URL('../', import.meta.url));
const baseline = execFileSync('git', ['show', `${baselineCommit}:src/render/effects.ts`], { cwd: root, encoding: 'utf8' });
const candidate = await readFile(new URL('../src/render/effects.ts', import.meta.url), 'utf8');

// Instrument only the actual TrailPoint and owned Vector3 creation sites, leaving
// their expressions and Three implementations intact. Fail if either site changes.
function instrument(source, old) {
  const site = old ? '{ pos: p.clone(), age: 0 }' : '{ pos: new THREE.Vector3(), age: 0 }';
  assert.equal(source.split(site).length - 1, 1, 'one target allocation site');
  const vector = old ? 'p.clone()' : 'new THREE.Vector3()';
  return `
export const allocationCounts = { points: 0, vectors: 0 };
function countPoint<T>(value: T): T { allocationCounts.points++; return value; }
function countVector<T>(value: T): T { allocationCounts.vectors++; return value; }
` + source.replace(site, `countPoint(${site.replace(vector, `countVector(${vector})`)})`);
}
const sources = { baseline: instrument(baseline, true), candidate: instrument(candidate, false) };
await build({
  configFile: false,
  root,
  plugins: [{
    name: 'ribbon-baseline-from-git',
    resolveId(id) { if (id.startsWith('virtual:ribbon-')) return `\0${id}.ts`; },
    load(id) { if (id.startsWith('\0virtual:ribbon-')) return sources[id.slice('\0virtual:ribbon-'.length, -3)]; },
  }],
  build: {
    ssr: true,
    outDir: fileURLToPath(new URL('../.qa-build/ribbon-reuse', import.meta.url)),
    emptyOutDir: true,
    target: 'esnext',
    minify: false,
    rollupOptions: { input: { baseline: 'virtual:ribbon-baseline', candidate: 'virtual:ribbon-candidate' } },
  },
});
const old = await import('../.qa-build/ribbon-reuse/baseline.js');
const next = await import('../.qa-build/ribbon-reuse/candidate.js');
let comparisons = 0;
const scenarios = [];
function pair(args) {
  const ribbons = [new old.Ribbon(...args), new next.Ribbon(...args)];
  assert.ok(ribbons.every(r => r.mesh instanceof THREE.Mesh && r.mesh.geometry instanceof THREE.BufferGeometry));
  return ribbons;
}
function compare(ribbons, label) {
  const [a, b] = ribbons;
  const ag = a.mesh.geometry, bg = b.mesh.geometry;
  assert.deepEqual(bg.attributes.position.array, ag.attributes.position.array, `${label}: full positions, including inactive tail`);
  assert.deepEqual(bg.attributes.color.array, ag.attributes.color.array, `${label}: full colors, including inactive tail`);
  assert.deepEqual(bg.index.array, ag.index.array, `${label}: indices`);
  assert.deepEqual(bg.drawRange, ag.drawRange, `${label}: draw range`);
  assert.equal(b.mesh.visible, a.mesh.visible, `${label}: visibility`);
  for (const name of ['position', 'color']) {
    assert.equal(bg.attributes[name].version, ag.attributes[name].version, `${label}: ${name} dirty version`);
  }
  assert.deepEqual(b.points.map(p => [p.pos.x, p.pos.y, p.pos.z, p.age]), a.points.map(p => [p.pos.x, p.pos.y, p.pos.z, p.age]), `${label}: ordering and ages`);
  const retained = [...b.points, ...b.freePoints];
  assert.equal(new Set(retained).size, retained.length, `${label}: unique retained points`);
  assert.equal(new Set(retained.map(p => p.pos)).size, retained.length, `${label}: unique owned vectors`);
  assert.ok(retained.length <= Math.max(1, b.maxPoints), `${label}: bounded retained pool`);
  comparisons++;
}
function add(ribbons, p, label) { ribbons.forEach(r => r.addPoint(p)); compare(ribbons, `${label} add`); }
function update(ribbons, dt, camera, label) { ribbons.forEach(r => r.update(dt, camera)); compare(ribbons, `${label} update`); }
function clear(ribbons, label) { ribbons.forEach(r => r.clear()); compare(ribbons, `${label} clear`); }
const emitter = new THREE.Vector3();
const camera = new THREE.Vector3(8, 6, 12);
for (const maxPoints of [0, 1, 2, 10, 16]) {
  const ribbons = pair([maxPoints, 0.42, 0xdfe8ff, 0.28, 0.7, 2]);
  compare(ribbons, 'initial');
  update(ribbons, 0, camera, 'empty');
  for (let i = 0; i < 240; i++) {
    emitter.set(i * 0.08, Math.sin(i * 0.2), Math.cos(i * 0.11));
    add(ribbons, emitter, `motion ${i}`);
    // A real caller reuses/mutates its emitter vector; retained positions must be copies.
    emitter.set(999, 999, 999);
    camera.set(Math.sin(i * 0.07) * 15, 6 + Math.cos(i * 0.09), 12 - i * 0.1);
    update(ribbons, i % 13 === 0 ? 0.04 : 1 / 120, camera, `motion ${i}`);
  }
  const newest = ribbons[0].points[0]?.pos.clone() ?? new THREE.Vector3();
  for (let i = 0; i < 60; i++) {
    add(ribbons, newest, 'stationary/expiry');
    update(ribbons, 1 / 60, camera, 'stationary/expiry');
  }
  for (let cycle = 0; cycle < 20; cycle++) {
    clear(ribbons, 'repeated clear');
    clear(ribbons, 'empty clear');
    for (let i = 0; i < maxPoints + 5; i++) {
      // Camera and segment exactly collinear triggers the existing side fallback.
      emitter.set(i, 0, 0);
      camera.set(100 + cycle, 0, 0);
      add(ribbons, emitter, 'clear reuse/collinear/capacity');
      update(ribbons, 0, camera, 'clear reuse/collinear/capacity');
    }
    update(ribbons, 0.28, camera, 'exact lifetime boundary');
    update(ribbons, Number.EPSILON, camera, 'strictly beyond lifetime');
    update(ribbons, 10, camera, 'fully expired');
  }
  clear(ribbons, 'before threshold');
  for (const x of [0, 0.019999, 0.02, 0.020001, 0.04, 0.040001]) {
    add(ribbons, emitter.set(x, 0, 0), 'movement threshold');
    update(ribbons, 0, camera, 'movement threshold');
  }
  ribbons.forEach(r => { r.mesh.geometry.dispose(); r.mesh.material.dispose(); });
  scenarios.push({ maxPoints, cases: 'motion, camera movement, stationary, fade/expiry, exact lifetime, clear/reuse, wrap, collinear, movement threshold, emitter aliasing' });
}

const allocationResults = [];
for (const args of [[16, 0.42, 0xdfe8ff, 0.28, 0.7, 2], [10, 0.13, 0x4f8cff, 0.11, 0.55, 3]]) {
  const ribbons = pair(args);
  for (let i = 0; i < args[0]; i++) {
    add(ribbons, emitter.set(i, 0, 0), 'warm capacity');
    update(ribbons, 0, camera, 'warm capacity');
  }
  const before = [old, next].map(m => ({ ...m.allocationCounts }));
  const frames = 10000;
  for (let i = 0; i < frames; i++) {
    add(ribbons, emitter.set(i + args[0], Math.sin(i * 0.1), 0), 'warmed motion');
    update(ribbons, 1 / 240, camera, 'warmed motion');
  }
  const moving = [old, next].map((m, i) => ({ points: m.allocationCounts.points - before[i].points, vectors: m.allocationCounts.vectors - before[i].vectors }));
  assert.deepEqual(moving, [{ points: frames, vectors: frames }, { points: 0, vectors: 0 }]);
  const reuseBefore = { ...next.allocationCounts };
  for (let cycle = 0; cycle < 100; cycle++) {
    if (cycle % 2) clear(ribbons, 'allocation clear');
    else update(ribbons, 100, camera, 'allocation expire');
    for (let i = 0; i < args[0] + 3; i++) {
      add(ribbons, emitter.set(i, cycle, 0), 'allocation refill');
      update(ribbons, 0, camera, 'allocation refill');
    }
  }
  assert.deepEqual(next.allocationCounts, reuseBefore, 'no target allocations after warmed clear/expiry/refill');
  const retained = ribbons[1].points.length + ribbons[1].freePoints.length;
  assert.equal(retained, args[0]);
  allocationResults.push({ maxPoints: args[0], warmedMovingFrames: frames, baseline: moving[0], candidate: moving[1], clearExpiryRefillCycles: 100, retainedPoints: retained, retainedVectors: retained });
  ribbons.forEach(r => { r.mesh.geometry.dispose(); r.mesh.material.dispose(); });
}
console.log(JSON.stringify({ baselineCommit, fixture: 'Vite-built exact Git baseline and candidate; actual Three Mesh/BufferGeometry/Vector3; no WebGL', comparisons, scenarios, allocationResults, limits: 'Counts cover TrailPoint objects and their owned Vector3 only, not all runtime allocations or heap bytes. No rendered visual or GPU/frame-time acceptance.' }, null, 2));
