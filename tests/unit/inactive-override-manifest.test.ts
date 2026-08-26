import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const helper = join(repository, 'ops/scripts/create-inactive-override-manifest.py');
const scratch: string[] = [];

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('create-only production override manifest', () => {
  test('retains every historical YAML by hash without changing it and publishes once', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cauce-inactive-overrides-'));
    scratch.push(directory);
    const overrides = join(directory, 'overrides');
    await mkdir(overrides);
    const first = 'services:\n  gateway:\n    environment:\n      FLAG: old\n';
    const second = 'services:\n  terminal-relay:\n    image: old\n';
    await writeFile(join(overrides, 'z-last.yaml'), second);
    await writeFile(join(overrides, 'a-first.yml'), first);
    await writeFile(join(overrides, 'README.txt'), 'not an override\n');
    const output = join(overrides, 'release-rc.manifest');

    const result = spawnSync('python3', [helper, '--overrides-dir', overrides, '--output', output], {
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(await readFile(output, 'utf8')).toBe(
      `inactive ${digest(first)} a-first.yml\ninactive ${digest(second)} z-last.yaml\n`,
    );
    expect(await readFile(join(overrides, 'a-first.yml'), 'utf8')).toBe(first);
    expect(await readFile(join(overrides, 'z-last.yaml'), 'utf8')).toBe(second);
    expect((await stat(output)).mode & 0o777).toBe(0o600);

    const repeated = spawnSync('python3', [helper, '--overrides-dir', overrides, '--output', output], {
      encoding: 'utf8',
    });
    expect(repeated.status, repeated.stderr).toBe(0);
    expect(await readFile(output, 'utf8')).toContain(`inactive ${digest(first)} a-first.yml`);
  });

  test('publishes four active overrides in authorized order and retains three inactive', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cauce-initial-overrides-'));
    scratch.push(directory);
    const overrides = join(directory, 'overrides');
    await mkdir(overrides);
    const names = [
      'directiva-20260825.yaml', 'store-fanin.yaml', 'terminal-minrows.yaml',
      'telegram-bridge.active.yaml', 'old-a.yaml', 'old-b.yml', 'old-c.yaml',
    ];
    const bodies = new Map<string, string>();
    for (const name of names) {
      const body = `services:\n  ${name.replace(/[^a-z]/gu, '_')}: {}\n`;
      bodies.set(name, body);
      await writeFile(join(overrides, name), body);
    }
    const output = join(overrides, 'active.manifest');
    const active = [
      'telegram-bridge.active.yaml', 'store-fanin.yaml',
      'terminal-minrows.yaml', 'directiva-20260825.yaml',
    ];
    const args = [helper, '--overrides-dir', overrides, '--output', output,
      '--expected-yaml-count', '7',
      ...active.flatMap((name) => ['--active', name])];
    const result = spawnSync('python3', args, { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    const expectedActive = active.map(
      (name) => `active ${digest(bodies.get(name)!)} ${name}\n`,
    ).join('');
    const expectedInactive = ['old-a.yaml', 'old-b.yml', 'old-c.yaml'].map(
      (name) => `inactive ${digest(bodies.get(name)!)} ${name}\n`,
    ).join('');
    expect(await readFile(output, 'utf8')).toBe(expectedActive + expectedInactive);

    await writeFile(output, 'attacker replacement\n', { mode: 0o600 });
    const poisonedRetry = spawnSync('python3', args, { encoding: 'utf8' });
    expect(poisonedRetry.status).toBe(1);
    expect(poisonedRetry.stderr).toContain('differs from the idempotent manifest candidate');

    await writeFile(join(overrides, 'unexpected-eighth.yaml'), 'services: {}\n');
    await rm(output);
    const widenedInventory = spawnSync('python3', args, { encoding: 'utf8' });
    expect(widenedInventory.status).toBe(1);
    expect(widenedInventory.stderr).toContain('expected exactly 7 YAML files, found 8');
  });

  test('fails closed on a symlinked YAML instead of omitting or following it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cauce-inactive-overrides-'));
    scratch.push(directory);
    const overrides = join(directory, 'overrides');
    await mkdir(overrides);
    const target = join(directory, 'outside.yaml');
    await writeFile(target, 'services: {}\n');
    await symlink(target, join(overrides, 'linked.yaml'));
    const output = join(overrides, 'release-rc.manifest');
    const result = spawnSync('python3', [helper, '--overrides-dir', overrides, '--output', output], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('single-link regular file');
  });
});
