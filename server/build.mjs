import { build } from 'vite';
await build({ configFile: false, build: { ssr: true, target: 'node24', outDir: '.server-build', emptyOutDir: true,
  rollupOptions: { input: { index: 'server/index.ts', worker: 'server/worker.ts' }, output: { entryFileNames: '[name].js' } } } });
