import { chmod, copyFile, link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const helper = join(repository, 'ops/scripts/pin-production-release.py');
const scratch: string[] = [];
const current = `registry.invalid/cauce/runtime@sha256:${'a'.repeat(64)}`;
const target = `registry.invalid/cauce/runtime@sha256:${'b'.repeat(64)}`;
const currentConsole = `registry.invalid/cauce/console@sha256:${'c'.repeat(64)}`;
const targetConsole = `registry.invalid/cauce/console@sha256:${'d'.repeat(64)}`;
const currentBaselineSha = `sha256:${'e'.repeat(64)}`;
const targetBaselineSha = `sha256:${'f'.repeat(64)}`;

type Fixture = {
  directory: string;
  envFile: string;
  currentManifest: string;
  targetManifest: string;
  currentBaseline: string;
  targetBaseline: string;
  pinHelper: string;
  secret: string;
};

async function fixture(): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'cauce-production-pin-'));
  scratch.push(directory);
  const manifests = join(directory, 'manifests');
  await mkdir(manifests);
  const currentManifest = join(manifests, 'current.manifest');
  const targetManifest = join(manifests, 'target.manifest');
  await writeFile(currentManifest, `inactive ${'1'.repeat(64)} old.yaml\n`);
  await writeFile(targetManifest, `inactive ${'2'.repeat(64)} new.yaml\n`);
  await chmod(currentManifest, 0o600);
  await chmod(targetManifest, 0o600);
  const currentBaseline = join(directory, 'current-baseline.json');
  const targetBaseline = join(directory, 'target-baseline.json');
  await writeFile(currentBaseline, '{}\n', { mode: 0o600 });
  await writeFile(targetBaseline, '{}\n', { mode: 0o600 });
  await chmod(currentBaseline, 0o600);
  await chmod(targetBaseline, 0o600);
  const pinHelper = join(directory, 'pin-production-release.py');
  await copyFile(helper, pinHelper);
  await chmod(pinHelper, 0o755);
  const fakeBaseline = join(directory, 'rollback-baseline.py');
  await writeFile(fakeBaseline, '#!/usr/bin/env python3\nraise SystemExit(0)\n', { mode: 0o755 });
  await chmod(fakeBaseline, 0o755);
  const envFile = join(directory, 'prod.env');
  const secret = 'SENTINEL_SECRET_MUST_NEVER_BE_PRINTED';
  await writeFile(
    envFile,
    [
      '# preserved comment',
      `SECRET_PATH=${secret}`,
      `CAUCE_RUNTIME_IMAGE=${current}`,
      `CAUCE_CONSOLE_IMAGE=${currentConsole}`,
      `CAUCE_COMPOSE_OVERRIDE_MANIFEST=${currentManifest}`,
      `CAUCE_ROLLBACK_BASELINE_FILE=${currentBaseline}`,
      `CAUCE_ROLLBACK_BASELINE_SHA256=${currentBaselineSha}`,
      'UNCHANGED=value with spaces',
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  await chmod(envFile, 0o600);
  return {
    directory, envFile, currentManifest, targetManifest,
    currentBaseline, targetBaseline, pinHelper, secret,
  };
}

function argumentsFor(value: Fixture, expected = current, next = target): string[] {
  return [
    'swap',
    '--env-file', value.envFile,
    '--expected-runtime-image', expected,
    '--target-runtime-image', next,
    '--expected-console-image', currentConsole,
    '--target-console-image', targetConsole,
    '--expected-override-manifest', value.currentManifest,
    '--target-override-manifest', value.targetManifest,
    '--expected-rollback-baseline', value.currentBaseline,
    '--target-rollback-baseline', value.targetBaseline,
    '--expected-rollback-baseline-sha256', currentBaselineSha,
    '--target-rollback-baseline-sha256', targetBaselineSha,
    '--baseline-forward-release-commit', '1'.repeat(40),
    '--baseline-forward-runtime-image', next,
    '--baseline-forward-runtime-source-digest', `sha256:${'9'.repeat(64)}`,
  ];
}

function run(value: Fixture, args: string[]) {
  return spawnSync('python3', [value.pinHelper, ...args], { encoding: 'utf8' });
}

function runAsync(value: Fixture, args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('python3', [value.pinHelper, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status) => resolvePromise({ status, stdout, stderr }));
  });
}

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('production release pin CAS', () => {
  test('atomically swaps image and manifest together, preserves unrelated bytes, and reverses', async () => {
    const value = await fixture();
    const before = await readFile(value.envFile, 'utf8');
    const result = run(value, argumentsFor(value));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('production release pin swap passed\n');
    expect(result.stdout + result.stderr).not.toContain(value.secret);
    const pinned = await readFile(value.envFile, 'utf8');
    expect(pinned).toBe(
      before
        .replace(`CAUCE_RUNTIME_IMAGE=${current}`, `CAUCE_RUNTIME_IMAGE=${target}`)
        .replace(`CAUCE_CONSOLE_IMAGE=${currentConsole}`, `CAUCE_CONSOLE_IMAGE=${targetConsole}`)
        .replace(
          `CAUCE_COMPOSE_OVERRIDE_MANIFEST=${value.currentManifest}`,
          `CAUCE_COMPOSE_OVERRIDE_MANIFEST=${value.targetManifest}`,
        )
        .replace(
          `CAUCE_ROLLBACK_BASELINE_FILE=${value.currentBaseline}`,
          `CAUCE_ROLLBACK_BASELINE_FILE=${value.targetBaseline}`,
        )
        .replace(
          `CAUCE_ROLLBACK_BASELINE_SHA256=${currentBaselineSha}`,
          `CAUCE_ROLLBACK_BASELINE_SHA256=${targetBaselineSha}`,
        ),
    );
    expect((await readdir(value.directory)).some((name) => name.includes('.release-pin-'))).toBe(false);

    const reverse = run(value, [
      'swap', '--env-file', value.envFile,
      '--expected-runtime-image', target, '--target-runtime-image', current,
      '--expected-console-image', targetConsole, '--target-console-image', currentConsole,
      '--expected-override-manifest', value.targetManifest,
      '--target-override-manifest', value.currentManifest,
      '--expected-rollback-baseline', value.targetBaseline,
      '--target-rollback-baseline', value.currentBaseline,
      '--expected-rollback-baseline-sha256', targetBaselineSha,
      '--target-rollback-baseline-sha256', currentBaselineSha,
      '--baseline-forward-release-commit', '1'.repeat(40),
      '--baseline-forward-runtime-image', current,
      '--baseline-forward-runtime-source-digest', `sha256:${'9'.repeat(64)}`,
    ]);
    expect(reverse.status, reverse.stderr).toBe(0);
    expect(await readFile(value.envFile, 'utf8')).toBe(before);
  });

  test('check is read-only and a stale expected pair cannot overwrite the file', async () => {
    const value = await fixture();
    const before = await readFile(value.envFile);
    const check = run(value, ['check', ...argumentsFor(value).slice(1)]);
    expect(check.status, check.stderr).toBe(0);
    expect(await readFile(value.envFile)).toEqual(before);

    const stale = run(value, argumentsFor(value, target, current));
    expect(stale.status).toBe(1);
    expect(stale.stderr).toContain('compare-and-swap failed');
    expect(stale.stdout + stale.stderr).not.toContain(value.secret);
    expect(await readFile(value.envFile)).toEqual(before);
  });

  test('serializes concurrent writers so exactly one matching CAS succeeds', async () => {
    const value = await fixture();
    const results = await Promise.all([
      runAsync(value, argumentsFor(value)), runAsync(value, argumentsFor(value)),
    ]);
    expect(results.filter((result) => result.status === 0)).toHaveLength(1);
    expect(results.filter((result) => result.status === 1)).toHaveLength(1);
    const pinned = await readFile(value.envFile, 'utf8');
    expect(pinned).toContain(`CAUCE_RUNTIME_IMAGE=${target}\n`);
    expect(pinned).toContain(`CAUCE_CONSOLE_IMAGE=${targetConsole}\n`);
    expect(pinned).toContain(`CAUCE_COMPOSE_OVERRIDE_MANIFEST=${value.targetManifest}\n`);
    expect(pinned).toContain(`CAUCE_ROLLBACK_BASELINE_FILE=${value.targetBaseline}\n`);
    expect(pinned).toContain(`CAUCE_ROLLBACK_BASELINE_SHA256=${targetBaselineSha}\n`);
  });

  test('rejects mutable refs, duplicate selectors, unsafe files, and manifest symlinks', async () => {
    const mutable = await fixture();
    const mutableBefore = await readFile(mutable.envFile);
    const badRef = run(mutable, argumentsFor(mutable, current, 'registry.invalid/cauce/runtime:latest'));
    expect(badRef.status).toBe(1);
    expect(await readFile(mutable.envFile)).toEqual(mutableBefore);

    const duplicate = await fixture();
    await writeFile(
      duplicate.envFile,
      `${await readFile(duplicate.envFile, 'utf8')}CAUCE_RUNTIME_IMAGE=${current}\n`,
      { mode: 0o600 },
    );
    await chmod(duplicate.envFile, 0o600);
    expect(run(duplicate, argumentsFor(duplicate)).status).toBe(1);

    const broad = await fixture();
    await chmod(broad.envFile, 0o640);
    expect(run(broad, argumentsFor(broad)).status).toBe(1);

    const hardlinked = await fixture();
    await link(hardlinked.envFile, join(hardlinked.directory, 'prod.env.other-link'));
    expect(run(hardlinked, argumentsFor(hardlinked)).status).toBe(1);

    const linkedEnv = await fixture();
    const envLink = join(linkedEnv.directory, 'prod.env.link');
    await symlink(linkedEnv.envFile, envLink);
    expect(run(linkedEnv, argumentsFor({ ...linkedEnv, envFile: envLink })).status).toBe(1);

    const linkedManifest = await fixture();
    const manifestLink = join(linkedManifest.directory, 'target.manifest.link');
    await symlink(linkedManifest.targetManifest, manifestLink);
    expect(run(linkedManifest, argumentsFor({ ...linkedManifest, targetManifest: manifestLink })).status).toBe(1);
  });
});
