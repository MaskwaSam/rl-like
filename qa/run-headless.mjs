import { build } from 'vite';
import { fileURLToPath } from 'node:url';

const mock = fileURLToPath(new URL('./mock-transport.ts', import.meta.url));
const suite = process.argv[2] ?? 'headless';
if (!['headless', 'modes', 'sessions'].includes(suite)) throw new Error('Choose headless, modes or sessions');
await build({
  configFile: false,
  plugins: [{
    name: 'headless-test-transport',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source === './transport' && /src\/net\/(host|client)\.ts$/.test(importer ?? '')) return mock;
    },
  }],
  build: { ssr: `qa/${suite}.ts`, outDir: `.qa-build/${suite}`, emptyOutDir: true, target: 'esnext', minify: false },
});
await import(`../.qa-build/${suite}/${suite}.js`);
