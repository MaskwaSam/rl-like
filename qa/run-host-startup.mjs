import { build } from 'vite';
import { fileURLToPath } from 'node:url';

const mock = fileURLToPath(new URL('./mock-transport.ts', import.meta.url));
await build({
  configFile: false,
  plugins: [{
    name: 'host-startup-test-transport',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source === './transport' && /src\/net\/host\.ts$/.test(importer ?? '')) return mock;
    },
  }],
  build: { ssr: 'qa/host-startup.ts', outDir: '.qa-build/host-startup', emptyOutDir: true, target: 'esnext', minify: false },
});
await import('../.qa-build/host-startup/host-startup.js');
