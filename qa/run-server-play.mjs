// Prerequisites (rebuild after source changes): npm run build && npm run server:build
// Run: node qa/run-server-play.mjs (two clients); SERVER_PLAY_TEAM_SIZE=4 for eight.
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'vite';
for (const file of ['dist/.vite/manifest.json', '.server-build/index.js', '.server-build/worker.js']) {
  await access(file).catch(() => { throw new Error(`Missing ${file}; run npm run build && npm run server:build first`); });
}
await build({ configFile: false, resolve: { alias: { './transport': resolve('qa/mock-transport.ts') } },
  build: { ssr: 'qa/server-play.ts', outDir: '.qa-build/server-play', emptyOutDir: true, target: 'node24', minify: false } });
try { await import('../.qa-build/server-play/server-play.js'); }
catch (error) { console.error(String(error?.stack ?? error).slice(0, 4000)); process.exitCode = 1; }
