import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../../scripts/test.sh', import.meta.url));
const owner = '11111111-2222-4333-8444-555555555555';

function runScript(network: NodeJS.ProcessEnv = {}) {
  const parent = { ...process.env };
  const directory = mkdtempSync(join(tmpdir(), 'cauce-test-network-'));
  const environment: NodeJS.ProcessEnv = { ...parent, PATH: directory };
  delete environment.CAUCE_TEST_DOCKER_NETWORK;
  delete environment.CAUCE_TEST_DOCKER_NETWORK_OWNER;
  Object.assign(environment, network);
  try {
    writeFileSync(join(directory, 'docker'), '#!/bin/sh\nprintf "unexpected docker discovery\\n" >&2\nprintf "shared-network \\n"\n', { mode: 0o700 });
    writeFileSync(join(directory, 'pnpm'), '#!/bin/sh\nprintf "args=%s\\n" "$*"\nprintf "network=%s\\n" "${CAUCE_TEST_DOCKER_NETWORK-unset}"\nprintf "owner=%s\\n" "${CAUCE_TEST_DOCKER_NETWORK_OWNER-unset}"\n', { mode: 0o700 });
    return spawnSync('/bin/sh', [script, 'tests/example file.test.ts', '--testTimeout=180000'],
      { env: environment, encoding: 'utf8', timeout: 5_000 });
  } finally {
    rmSync(directory, { recursive: true, force: true });
    expect(Object.keys(process.env).sort()).toEqual(Object.keys(parent).sort());
    expect(Object.keys(parent).filter((key) => process.env[key] !== parent[key])).toEqual([]);
  }
}

describe('test shell Docker network ownership', () => {
  it('uses default published ports without discovering a shared Docker network', () => {
    const result = runScript();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('args=exec vitest run tests/example file.test.ts --testTimeout=180000\n');
    expect(result.stdout).toContain('network=unset\nowner=unset\n');
  });

  it.each([
    { CAUCE_TEST_DOCKER_NETWORK: 'owned-network' },
    { CAUCE_TEST_DOCKER_NETWORK_OWNER: owner },
    { CAUCE_TEST_DOCKER_NETWORK: '', CAUCE_TEST_DOCKER_NETWORK_OWNER: owner },
    { CAUCE_TEST_DOCKER_NETWORK: 'owned-network', CAUCE_TEST_DOCKER_NETWORK_OWNER: '' },
  ])('rejects an incomplete network ownership pair: %j', (environment) => {
    const result = runScript(environment);
    expect(result.status).toBe(2);
    expect(result.stderr).toBe('an optional Docker bridge requires both its name and owner UUID\n');
    expect(result.stdout).toBe('');
  });

  it('preserves an explicitly supplied complete network ownership pair', () => {
    const result = runScript({ CAUCE_TEST_DOCKER_NETWORK: 'owned-network', CAUCE_TEST_DOCKER_NETWORK_OWNER: owner });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain(`network=owned-network\nowner=${owner}\n`);
  });
});
