import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import { timeoutRetryBackoffSeconds } from '@cauce/store';

const testStackUrl = new URL('../../ops/compose.test.yaml', import.meta.url);
const seedUrl = new URL('../../ops/harness/seed-test-fleet.mjs', import.meta.url);
const dockerfileUrl = new URL('../../deploy/Dockerfile', import.meta.url);

describe('test stack fleet seed', () => {
  test('seeds the harness topology agents before gateway and dispatcher start', async () => {
    const [stack, seed] = await Promise.all([
      readFile(testStackUrl, 'utf8'),
      readFile(seedUrl, 'utf8'),
    ]);
    expect(stack).toContain('command: ["node", "ops/harness/seed-test-fleet.mjs"]');
    expect(stack).toContain('seed:\n        condition: service_completed_successfully');
    expect(seed).toContain("from './fleet.mjs'");
    expect(seed).toContain('topology');
    expect(seed).toContain('INSERT INTO agents');
    expect(seed).toContain('ON CONFLICT (tenant_id, alias) DO NOTHING');
    expect(seed).toContain('harness_id');
    expect(seed).toContain('enabled');
  });

  test('harness retry wait covers the attempt-1 stale backoff', async () => {
    const stack = await readFile(testStackUrl, 'utf8');
    const match = stack.match(/CAUCE_RETRY_TIMEOUT_MS:\s*"(\d+)"/);
    expect(match).not.toBeNull();
    const waitMs = Number(match?.[1]);
    expect(waitMs).toBeGreaterThan(timeoutRetryBackoffSeconds(1) * 1000);
  });

  test('qa-runtime resolves pg for the seed script', async () => {
    const dockerfile = await readFile(dockerfileUrl, 'utf8');
    const qaStage = dockerfile.slice(dockerfile.indexOf('FROM runtime AS qa-runtime'));
    expect(qaStage).toContain('node_modules/pg');
  });
});
