import { build } from 'vite';
import { fileURLToPath } from 'node:url';

const mock = fileURLToPath(new URL('./mock-transport.ts', import.meta.url));
await build({ configFile: false, plugins: [{
  name: 'spectator-batching-test-transport', enforce: 'pre',
  resolveId(source, importer) {
    if (source === './transport' && /src\/net\/spectator\.ts$/.test(importer ?? '')) return mock;
  },
}], build: { ssr: 'qa/spectator-batching.ts', outDir: '.qa-build/spectator-batching', emptyOutDir: true, target: 'node24', minify: false } });
await import('../.qa-build/spectator-batching/spectator-batching.js');
