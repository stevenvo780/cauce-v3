import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Resolution configuration mapping local `@cauce/*` packages to `src/` in the current workspace.
 */
const paquete = (nombre: string): string =>
  fileURLToPath(new URL(`./packages/${nombre}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@cauce\/protocol$/, replacement: paquete('protocol') },
      { find: /^@cauce\/store$/, replacement: paquete('store') },
      { find: /^@cauce\/adapter-sdk$/, replacement: paquete('adapter-sdk') }
    ]
  },
  test: {
    globals: true,
    pool: 'forks',
    fileParallelism: false,
    hookTimeout: 120_000,
    testTimeout: 120_000,
    // Agent worktrees live under .claude/worktrees/ INSIDE the checkout, so a bare
    // `vitest run tests/...` collected every branch's copy of the same file and ran the suite
    // once per worktree — against stale code, with the ports and containers of the real run.
    exclude: ['**/node_modules/**', '**/dist/**', '.claude/**'],
    coverage: { reporter: ['text', 'json-summary'] }
  }
});
