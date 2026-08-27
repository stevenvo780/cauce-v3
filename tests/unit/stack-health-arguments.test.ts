import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const stackHealth = join(repository, 'ops/scripts/stack-health.sh');

describe('stack health arguments', () => {
  test('health entry point rejects misplaced maintenance arguments', () => {
    expect(spawnSync(stackHealth, ['dev', '--maintenance-offline-zeus'], { encoding: 'utf8' }).status).toBe(2);
    expect(spawnSync(stackHealth, ['prod', '--maintenance-offline-kant'], { encoding: 'utf8' }).status).toBe(2);
  });
});
