import { build } from 'vite';
await build({ configFile: false, build: { ssr: 'qa/retry.ts', outDir: '.qa-build/retry', emptyOutDir: true, target: 'node24', minify: false } });
await import('../.qa-build/retry/retry.js');
