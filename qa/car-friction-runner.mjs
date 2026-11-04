import { build } from 'vite';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const baseline = '29cebbaf055d7e8bdd010c0e975a31afad19c527';
const ids = new Map();
for (const variant of ['baseline', 'candidate']) {
  for (const file of ['game', 'car']) ids.set(`car-friction:${variant}/${file}.ts`, { variant, file });
}
function instrument(source) {
  const start = source.indexOf('  private applyWheelFriction(');
  const end = source.indexOf('\n  /** Central force', start);
  if (start < 0 || end < 0) throw new Error('Friction instrumentation boundary changed');
  let method = source.slice(start, end);
  const stats = '__carFrictionStats';
  for (const marker of ['    const forwardSpeed', '      const def = WHEELS[i];', '      this.debug.frictionDvY += J.y / CAR.mass;']) {
    if (method.split(marker).length !== 2) throw new Error(`Instrumentation marker changed: ${marker}`);
  }
  method = method.replace('    const forwardSpeed', `    ${stats}.calls++;\n    const forwardSpeed`)
    .replace('      const def = WHEELS[i];', `      ${stats}.contacts++;\n      const def = WHEELS[i];`)
    .replace(/const (impulses|points): Vector3\[\] = \[\];/g, (_, name) => `const ${name}: Vector3[] = (${stats}.arrays++, []);`)
    .replace(/new Vector3\(\)/g, `(${stats}.vectors++, new Vector3())`)
    .replace('      this.debug.frictionDvY += J.y / CAR.mass;', `      ${stats}.impulses.push(this.id, J.x, J.y, J.z, p.x, p.y, p.z);\n      this.debug.frictionDvY += J.y / CAR.mass;`);
  // Guard the array/vector allocation forms counted here; object argument literals remain unchanged.
  const uncounted = method.replace(/\(__carFrictionStats.vectors\+\+, new Vector3\(\)\)/g, '').replace(/\(__carFrictionStats.arrays\+\+, \[\]\)/g, '');
  if (/\bnew\b|=\s*\[|\.map\(|\.push\((?!this.id)/.test(uncounted.replace(/impulses.push\(J\);|points.push\(p\);/g, ''))) throw new Error('Review new allocation site in friction method');
  return source.slice(0, start) + method + source.slice(end) + `\nexport const ${stats} = { calls: 0, contacts: 0, arrays: 0, vectors: 0, impulses: [] as number[] };\n`;
}
await build({ configFile: false, plugins: [{
  name: 'car-friction-baseline-and-allocation-sites', enforce: 'pre',
  resolveId(source, importer) {
    if (ids.has(source)) return source;
    if (ids.has(importer)) {
      const { variant, file } = ids.get(importer);
      if (file === 'game' && source === './car') return `car-friction:${variant}/car.ts`;
      if (source.startsWith('.')) return this.resolve(resolve('src/sim', source), undefined, { skipSelf: true });
      return this.resolve(source, resolve('src/sim', `${file}.ts`), { skipSelf: true });
    }
  },
  async load(id) {
    if (!ids.has(id)) return;
    const { variant, file } = ids.get(id);
    const source = variant === 'baseline'
      ? execFileSync('git', ['show', `${baseline}:src/sim/${file}.ts`], { encoding: 'utf8' })
      : await (await import('node:fs/promises')).readFile(resolve('src/sim', `${file}.ts`), 'utf8');
    return { code: file === 'car' ? instrument(source) : source, map: null };
  },
}], build: { ssr: 'qa/car-friction-allocation.ts', outDir: '.qa-build/car-friction', emptyOutDir: true, target: 'esnext', minify: false },
});
await import('../.qa-build/car-friction/car-friction-allocation.js');
