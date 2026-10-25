import { defineConfig } from 'vitest/config';

export default defineConfig({ test: {
  include: ['tests/e2e/v4-fleet-image-refresh*-real.test.ts'],
  maxWorkers: 1,
  hookTimeout: 240_000,
  testTimeout: 120_000,
} });
