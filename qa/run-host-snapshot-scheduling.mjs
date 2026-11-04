import { build } from 'vite';
import { fileURLToPath } from 'node:url';

const mock = fileURLToPath(new URL('./mock-transport.ts', import.meta.url));
await build({
  configFile: false,
  plugins: [{
    name: 'headless-test-transport',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source === './transport' && /src\/net\/(host|client|spectator)\.ts$/.test(importer ?? '')) return mock;
    },
  }],
  build: { ssr: 'qa/host-snapshot-scheduling.ts', outDir: '.qa-build/host-snapshot-scheduling', emptyOutDir: true, target: 'esnext', minify: false },
});
await import('../.qa-build/host-snapshot-scheduling/host-snapshot-scheduling.js');
