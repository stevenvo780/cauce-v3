import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sourceDigest = join(repository, 'ops/scripts/source-digest.py');
const scratch: string[] = [];

function run(root: string, ...arguments_: string[]) {
  return spawnSync('python3', [sourceDigest, '--root', root, ...arguments_], {
    cwd: repository,
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
}

function digest(root: string, domain: string): string {
  const result = run(root, '--domain', domain);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toMatch(/^sha256:[a-f0-9]{64}$/u);
  return result.stdout.trim();
}

async function writeTree(root: string, relative: string, contents: string): Promise<void> {
  const destination = join(root, relative);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, contents);
}

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('release machinery source digest closure', () => {
  test('the full resolver covers the release operational sources it exercises', () => {
    const result = spawnSync('python3', [sourceDigest, '--domain', 'full', '--list'], {
      cwd: repository,
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    const paths = result.stdout.split('\n');
    for (const source of [
      'ops/scripts/deploy-release.sh',
      'ops/scripts/rollback.sh',
      'ops/scripts/pin-production-release.py',
      'ops/scripts/release-writer-state.py',
      'ops/schemas/build-evidence.schema.json',
      'ops/schemas/rollback-bridge.schema.json',
    ]) {
      expect(paths, source).toContain(source);
    }
  });

  test('mutating critical release sources invalidates old verification reports', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cauce-source-digest-operations-'));
    scratch.push(root);
    for (const [relative, contents] of [
      ['package.json', '{}\n'],
      ['pnpm-lock.yaml', 'lockfileVersion: 9\n'],
      ['pnpm-workspace.yaml', 'packages: []\n'],
      ['tsconfig.json', '{}\n'],
      ['services/gateway/index.ts', 'export const gateway = 1;\n'],
      ['ops/scripts/deploy-release.sh', '#!/bin/sh\nexit 0\n'],
      ['ops/scripts/rollback.sh', '#!/bin/sh\nexit 0\n'],
      ['ops/scripts/pin-production-release.py', 'print("locked")\n'],
      ['ops/scripts/release-writer-state.py', 'print("validated")\n'],
      ['ops/schemas/build-evidence.schema.json', '{"type":"object"}\n'],
    ] as const) {
      await writeTree(root, relative, contents);
    }

    const runtime = digest(root, 'runtime');
    let verification = digest(root, 'verification');
    let full = digest(root, 'full');
    for (const [relative, contents] of [
      ['ops/scripts/deploy-release.sh', '#!/bin/sh\nexit 7\n'],
      ['ops/scripts/rollback.sh', '#!/bin/sh\nexit 7\n'],
      ['ops/scripts/pin-production-release.py', 'print("unlocked")\n'],
      ['ops/scripts/release-writer-state.py', 'print("unvalidated")\n'],
      ['ops/schemas/build-evidence.schema.json', '{"additionalProperties":true}\n'],
    ] as const) {
      await writeTree(root, relative, contents);
      const nextVerification = digest(root, 'verification');
      const nextFull = digest(root, 'full');
      expect(nextVerification, relative).not.toBe(verification);
      expect(nextFull, relative).not.toBe(full);
      expect(digest(root, 'runtime'), relative).toBe(runtime);
      verification = nextVerification;
      full = nextFull;
    }
  });
});
