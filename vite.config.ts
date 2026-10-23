import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

/**
 * Stamp the build with the commit it came from, so a screenshot or a bug report identifies
 * exactly which code is running. Shown on the menu and logged at startup. Falls back to
 * "unknown" when git is unavailable (e.g. building from a source tarball).
 */
function buildInfo(): { sha: string; date: string; dirty: boolean } {
  const git = (cmd: string) => execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  try {
    return {
      sha: git('git rev-parse --short=7 HEAD'),
      date: git('git log -1 --format=%cI').slice(0, 16).replace('T', ' '),
      // Local edits that are not committed yet: worth flagging, since the sha alone would lie.
      dirty: git('git status --porcelain').length > 0,
    };
  } catch {
    return { sha: 'unknown', date: '', dirty: false };
  }
}

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };
const info = buildInfo();

export default defineConfig({
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_SHA__: JSON.stringify(info.sha),
    __BUILD_DATE__: JSON.stringify(info.date),
    __BUILD_DIRTY__: JSON.stringify(info.dirty),
  },
  server: {
    port: 5173,
    host: '127.0.0.1',
    proxy: { '/game': { target: 'http://127.0.0.1:4100', ws: true } },
  },
  build: {
    manifest: true,
    target: 'es2022',
  },
});
