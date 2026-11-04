import { build } from 'vite';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('./spectator-admission-test.ts', import.meta.url));
const mock = fileURLToPath(new URL('./mock-transport.ts', import.meta.url));
await build({ configFile: false, plugins: [{
  name: 'spectator-admission-test-transport',
  enforce: 'pre',
  resolveId(source, importer) {
    if (source === './transport' && /src\/net\/spectator\.ts$/.test(importer ?? '')) return mock;
  },
}], build: { ssr: entry, outDir: '.qa-build/spectator-admission', emptyOutDir: true, target: 'node24', minify: false } });
await import('../.qa-build/spectator-admission/spectator-admission-test.js');
