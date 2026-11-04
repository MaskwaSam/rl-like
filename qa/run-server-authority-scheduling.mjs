import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

// Compile the real historical authority independently, with its relative imports
// resolved from server/. Never derive the baseline by undoing candidate changes.
const baselineRef = '0998166fba124cb4ea3fea87ecde2aa3c14ac0a0';
const baseline = execFileSync('git', ['show', `${baselineRef}:server/authority.ts`], { encoding: 'utf8' });
const baselineId = '\0server-authority-scheduling-baseline.ts';
const authorityPath = fileURLToPath(new URL('../server/authority.ts', import.meta.url));
let instrumented = false;
await build({
  configFile: false,
  plugins: [{
    name: 'independent-authority-baseline-and-encode-counter',
    enforce: 'pre',
    async resolveId(source, importer) {
      if (source === '../server/authority-baseline') return baselineId;
      if (importer === baselineId && source.startsWith('.')) return this.resolve(source, authorityPath, { skipSelf: true });
    },
    load(id) { if (id === baselineId) return baseline; },
    transform(code, id) {
      if (!id.endsWith('/src/net/protocol.ts')) return;
      const signature = 'export function encodeSnapshot(state: ArrayBuffer, lastInputTick: number, hostTimeMs: number): ArrayBuffer {';
      if (!code.includes(signature)) throw new Error('Snapshot encoder instrumentation no longer matches');
      instrumented = true;
      return code.replace(signature, signature + '\n  globalThis.__authoritySchedulingEncodes++;');
    },
  }],
  build: { ssr: 'qa/server-authority-scheduling.ts', outDir: '.qa-build/server-authority-scheduling', emptyOutDir: true, target: 'node24', minify: false },
});
if (!instrumented) throw new Error('Snapshot encoder was not instrumented');
console.log(`Independent authority baseline: ${baselineRef}`);
await import('../.qa-build/server-authority-scheduling/server-authority-scheduling.js');
