import { defineConfig } from 'vitest/config';

export default defineConfig({
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
