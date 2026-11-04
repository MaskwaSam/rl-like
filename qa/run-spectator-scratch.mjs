import { build } from 'vite';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Load the exact parent implementation alongside the candidate; no checkout or source rewrite.
const baselineId = '\0spectator-scratch-baseline.ts';
const root = fileURLToPath(new URL('../', import.meta.url));
const mock = fileURLToPath(new URL('./mock-transport.ts', import.meta.url));
const baseline = execFileSync('git', ['show', '29cebba:src/net/spectator.ts'], { cwd: root, encoding: 'utf8' });
function instrument(source, label) {
  const replace = (before, after) => {
    if (!source.includes(before)) throw new Error(`Missing ${label} allocation probe: ${before}`);
    source = source.replaceAll(before, after);
  };
  if (label === 'baseline') {
    replace('new Map<number, BodyState>()', "(scratchProbe('maps'), new Map<number, BodyState>())");
    replace('{ ...body }', "(scratchProbe('bodies'), scratchProbe('copies'), { ...body })");
    for (const name of ['oldBall', 'oldPrevBall']) {
      const field = name === 'oldBall' ? 'curr' : 'prev';
      replace(`const ${name} = { ...game.${field}.ball };`, `const ${name} = (scratchProbe('bodies'), scratchProbe('copies'), { ...game.${field}.ball });`);
    }
    replace('game.step(new Map(), TICK_DT)', "game.step((scratchProbe('inputMaps'), new Map()), TICK_DT)");
  } else {
    replace('new Map<number, BodyState>()', "(scratchProbe('maps'), new Map<number, BodyState>())");
    replace('= emptyState();', "= (scratchProbe('bodies'), emptyState());");
    replace('copy = emptyState()', "copy = (scratchProbe('bodies'), emptyState())");
    replace('Object.assign(copy, body)', "(scratchProbe('copies'), Object.assign(copy, body))");
    for (const field of ['curr', 'prev']) {
      const name = field === 'curr' ? 'oldBall' : 'oldPrevBall';
      replace(`Object.assign(${name}, game.${field}.ball)`, `(scratchProbe('copies'), Object.assign(${name}, game.${field}.ball))`);
    }
    replace('= new Map();', "= (scratchProbe('inputMaps'), new Map());");
  }
  return `function scratchProbe(kind: string) { const all = (globalThis as any).__spectatorScratchMetrics; if (all) all['${label}'][kind]++; }\n${source}`;
}
await build({ configFile: false, plugins: [{
  name: 'spectator-scratch-parent-and-probes', enforce: 'pre',
  resolveId(source, importer) {
    if (source === 'spectator-scratch:baseline') return baselineId;
    if (importer === baselineId && source.startsWith('.')) {
      if (source === './transport') return mock;
      return this.resolve(`${root}src/net/${source}`, `${root}src/net/spectator.ts`, { skipSelf: true });
    }
    if (source === './transport' && /src\/net\/spectator\.ts$/.test(importer ?? '')) return mock;
  },
  load(id) { if (id === baselineId) return instrument(baseline, 'baseline'); },
  transform(source, id) { if (id === `${root}src/net/spectator.ts`) return { code: instrument(source, 'candidate'), map: null }; },
}], build: { ssr: 'qa/spectator-scratch.ts', outDir: '.qa-build/spectator-scratch', emptyOutDir: true, target: 'esnext', minify: false } });
await import('../.qa-build/spectator-scratch/spectator-scratch.js');
