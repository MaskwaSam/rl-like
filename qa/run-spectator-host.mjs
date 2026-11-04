import { build } from 'vite';
await build({ configFile: false, build: { ssr: 'qa/spectator-host.ts', outDir: '.qa-build/spectator-host', emptyOutDir: true, target: 'node24', minify: false } });
await import('../.qa-build/spectator-host/spectator-host.js');
