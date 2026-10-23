/**
 * Build identity, injected by vite.config.ts from git at build time. Shown on the menu and
 * logged at startup so a screenshot or a bug report says exactly which build it came from.
 */
declare const __APP_VERSION__: string;
declare const __BUILD_SHA__: string;
declare const __BUILD_DATE__: string;
declare const __BUILD_DIRTY__: boolean;

export const BUILD = {
  version: __APP_VERSION__,
  sha: __BUILD_SHA__,
  date: __BUILD_DATE__,
  dirty: __BUILD_DIRTY__,
};

/** Short form for the menu, e.g. `v0.1.0 · a1b2c3d · 2026-09-19 14:22`. */
export function buildLabel(): string {
  const parts = [`v${BUILD.version}`, BUILD.sha];
  if (BUILD.dirty) parts.push('uncommitted');
  if (BUILD.date) parts.push(BUILD.date);
  return parts.join(' · ');
}
