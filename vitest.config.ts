import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    pool: 'forks',
    fileParallelism: false,
    hookTimeout: 120_000,
    testTimeout: 120_000,
    coverage: { reporter: ['text', 'json-summary'] }
  }
});
