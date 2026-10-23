import { build } from 'vite';
await build({ configFile: false, build: { ssr: 'qa/private-rooms.ts', outDir: '.qa-build/private', emptyOutDir: true, target: 'node24', minify: false } });
await import('../.qa-build/private/private-rooms.js');
