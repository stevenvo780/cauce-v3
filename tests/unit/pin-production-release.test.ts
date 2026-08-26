import {
  chmod, copyFile, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat,
  symlink, writeFile,
} from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
const legacyRuntime = 'cauce-v3-runtime:legacy-fragment';
const legacyConsole = 'cauce-console:legacy-fragment';
const runtimeImageId = `sha256:${'e'.repeat(64)}`;
const consoleImageId = `sha256:${'f'.repeat(64)}`;
const sha256 = (content: string | Buffer): string =>
  `sha256:${createHash('sha256').update(content).digest('hex')}`;
const currentBaselineContent = '{"release":"current"}\n';
const targetBaselineContent = '{"release":"target"}\n';
const currentBaselineSha = sha256(currentBaselineContent);
const targetBaselineSha = sha256(targetBaselineContent);
const currentManifestContent = `inactive ${'1'.repeat(64)} old.yaml\n`;
const targetManifestContent = `inactive ${'2'.repeat(64)} new.yaml\n`;
const currentManifestSha = sha256(currentManifestContent);
const targetManifestSha = sha256(targetManifestContent);

type Fixture = {
  directory: string;
  envFile: string;
  currentManifest: string;
  targetManifest: string;
  currentBaseline: string;
  targetBaseline: string;
  currentWriterSnapshot: string;
  targetWriterSnapshot: string;
  currentWriterSnapshotSha: string;
  targetWriterSnapshotSha: string;
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
  await writeFile(currentManifest, currentManifestContent);
  await writeFile(targetManifest, targetManifestContent);
  await chmod(currentManifest, 0o600);
  await chmod(targetManifest, 0o600);
  const currentBaseline = join(directory, 'current-baseline.json');
  const targetBaseline = join(directory, 'target-baseline.json');
  await writeFile(currentBaseline, currentBaselineContent, { mode: 0o600 });
  await writeFile(targetBaseline, targetBaselineContent, { mode: 0o600 });
  await chmod(currentBaseline, 0o600);
  await chmod(targetBaseline, 0o600);
  const currentWriterSnapshot = join(directory, 'current-writers.json');
  const targetWriterSnapshot = join(directory, 'target-writers.json');
  const currentWriterContent = '{"kind":"writers","release":"current"}\n';
  const targetWriterContent = '{"kind":"writers","release":"target"}\n';
  await writeFile(currentWriterSnapshot, currentWriterContent, { mode: 0o600 });
  await writeFile(targetWriterSnapshot, targetWriterContent, { mode: 0o600 });
  const currentWriterSnapshotSha = sha256(currentWriterContent);
  const targetWriterSnapshotSha = sha256(targetWriterContent);
  const pinHelper = join(directory, 'pin-production-release.py');
  await copyFile(helper, pinHelper);
  await chmod(pinHelper, 0o755);
  const fakeDocker = join(directory, 'docker');
  await writeFile(fakeDocker, `#!/usr/bin/env python3
import json
import os
import sys

arguments = sys.argv[1:]
if arguments[:2] == ["--host", "unix:///var/run/docker.sock"]:
    arguments = arguments[2:]
runtime_target = ${JSON.stringify(current)}
console_target = ${JSON.stringify(currentConsole)}
runtime_tag = ${JSON.stringify(legacyRuntime)}
console_tag = ${JSON.stringify(legacyConsole)}
runtime_target_id = os.environ.get("CAUCE_TEST_RUNTIME_TARGET_ID", ${JSON.stringify(runtimeImageId)})
runtime_tag_id = os.environ.get("CAUCE_TEST_RUNTIME_TAG_ID", runtime_target_id)
runtime_container_id = os.environ.get("CAUCE_TEST_RUNTIME_CONTAINER_ID", runtime_target_id)
console_target_id = os.environ.get("CAUCE_TEST_CONSOLE_TARGET_ID", ${JSON.stringify(consoleImageId)})
console_tag_id = os.environ.get("CAUCE_TEST_CONSOLE_TAG_ID", console_target_id)
console_container_id = os.environ.get("CAUCE_TEST_CONSOLE_CONTAINER_ID", console_target_id)

def image(reference):
    if reference == runtime_target:
        return runtime_target_id, [runtime_target]
    if reference == runtime_tag:
        return runtime_tag_id, [runtime_target]
    if reference == console_target:
        return console_target_id, [console_target]
    if reference == console_tag:
        return console_tag_id, [console_target]
    if "@sha256:" in reference:
        return "sha256:" + "7" * 64, [reference]
    raise SystemExit(9)

if arguments[:3] == ["image", "inspect", "--format"] and len(arguments) == 5:
    identifier, digests = image(arguments[4])
    print(identifier + "\\t" + json.dumps(digests, separators=(",", ":")))
    raise SystemExit(0)
if arguments[:2] == ["container", "ls"]:
    print("a" * 12)
    print("b" * 12)
    raise SystemExit(0)
if arguments[:3] == ["container", "inspect", "--format"] and len(arguments) == 5:
    requested = arguments[4]
    if requested == "a" * 12:
        configured = runtime_tag
        identifier = runtime_container_id
        service = "gateway"
        full = "a" * 64
    elif requested == "b" * 12:
        configured = console_tag
        identifier = console_container_id
        service = "console"
        full = "b" * 64
    else:
        raise SystemExit(9)
    print("\\t".join([
        full, identifier, configured, "cauce-v3-prod", service, "1" * 64, "running",
    ]))
    raise SystemExit(0)
raise SystemExit(9)
`, { mode: 0o755 });
  await chmod(fakeDocker, 0o755);
  const fakeBaseline = join(directory, 'rollback-baseline.py');
  await writeFile(fakeBaseline, '#!/usr/bin/env python3\nraise SystemExit(0)\n', { mode: 0o755 });
  await chmod(fakeBaseline, 0o755);
  const envFile = join(directory, 'prod.env');
  const secret = 'SENTINEL_SECRET_MUST_NEVER_BE_PRINTED';
  await writeFile(
    envFile,
    [
      '# preserved comment',
      'COMPOSE_PROJECT_NAME=cauce-v3-prod',
      'COMPOSE_PROFILES=',
      `SECRET_PATH=${secret}`,
      `CAUCE_RUNTIME_IMAGE=${current}`,
      `CAUCE_CONSOLE_IMAGE=${currentConsole}`,
      `CAUCE_COMPOSE_OVERRIDE_MANIFEST=${currentManifest}`,
      `CAUCE_COMPOSE_OVERRIDE_MANIFEST_SHA256=${currentManifestSha}`,
      `CAUCE_ROLLBACK_BASELINE_FILE=${currentBaseline}`,
      `CAUCE_ROLLBACK_BASELINE_SHA256=${currentBaselineSha}`,
      `CAUCE_ROLLBACK_WRITER_SNAPSHOT_FILE=${currentWriterSnapshot}`,
      `CAUCE_ROLLBACK_WRITER_SNAPSHOT_SHA256=${currentWriterSnapshotSha}`,
      'UNCHANGED=value with spaces',
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  await chmod(envFile, 0o600);
  return {
    directory, envFile, currentManifest, targetManifest,
    currentBaseline, targetBaseline, pinHelper, secret,
    currentWriterSnapshot, targetWriterSnapshot,
    currentWriterSnapshotSha, targetWriterSnapshotSha,
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
    '--expected-override-manifest-sha256', currentManifestSha,
    '--target-override-manifest-sha256', targetManifestSha,
    '--expected-rollback-baseline', value.currentBaseline,
    '--target-rollback-baseline', value.targetBaseline,
    '--expected-rollback-baseline-sha256', currentBaselineSha,
    '--target-rollback-baseline-sha256', targetBaselineSha,
    '--expected-writer-snapshot', value.currentWriterSnapshot,
    '--target-writer-snapshot', value.targetWriterSnapshot,
    '--expected-writer-snapshot-sha256', value.currentWriterSnapshotSha,
    '--target-writer-snapshot-sha256', value.targetWriterSnapshotSha,
    '--baseline-forward-release-commit', '1'.repeat(40),
    '--baseline-forward-runtime-image', next,
    '--baseline-forward-runtime-source-digest', `sha256:${'9'.repeat(64)}`,
  ];
}

function processEnvironment(value: Fixture, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${value.directory}:${process.env.PATH ?? ''}`,
    ...overrides,
  };
}

function run(value: Fixture, args: string[], overrides: NodeJS.ProcessEnv = {}) {
  return spawnSync('python3', [value.pinHelper, ...args], {
    encoding: 'utf8',
    env: processEnvironment(value, overrides),
  });
}

function runAsync(
  value: Fixture,
  args: string[],
  overrides: NodeJS.ProcessEnv = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('python3', [value.pinHelper, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: processEnvironment(value, overrides),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status) => resolvePromise({ status, stdout, stderr }));
  });
}

async function sigkillAtBarrier(
  value: Fixture,
  args: string[],
  point: string,
): Promise<{ status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  const ready = join(value.directory, `${point}.sigkill.ready`);
  const release = join(value.directory, `${point}.sigkill.release`);
  const child = spawn('python3', [value.pinHelper, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: processEnvironment(value, {
      CAUCE_PIN_TEST_BARRIER: point,
      CAUCE_PIN_TEST_BARRIER_READY: ready,
      CAUCE_PIN_TEST_BARRIER_RELEASE: release,
    }),
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  const completed = new Promise<{
    status: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  }>((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('close', (status, signal) => {
      resolvePromise({ status, signal, stdout, stderr });
    });
  });
  await waitForFile(ready);
  if (!child.kill('SIGKILL')) {
    throw new Error(`failed to SIGKILL child at ${point}`);
  }
  return completed;
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      await readFile(path);
      return;
    } catch {
      await new Promise((resolvePromise) => { setTimeout(resolvePromise, 10); });
    }
  }
  throw new Error(`timed out waiting for ${path}`);
}

function asTwoSelector(complete: string): string {
  return complete
    .replace(current, legacyRuntime)
    .replace(currentConsole, legacyConsole)
    .replace(/CAUCE_COMPOSE_OVERRIDE_MANIFEST=.*\n/, '')
    .replace(/CAUCE_COMPOSE_OVERRIDE_MANIFEST_SHA256=.*\n/, '')
    .replace(/CAUCE_ROLLBACK_BASELINE_FILE=.*\n/, '')
    .replace(/CAUCE_ROLLBACK_BASELINE_SHA256=.*\n/, '')
    .replace(/CAUCE_ROLLBACK_WRITER_SNAPSHOT_FILE=.*\n/, '')
    .replace(/CAUCE_ROLLBACK_WRITER_SNAPSHOT_SHA256=.*\n/, '');
}

function twoSelectorArguments(value: Fixture, content: string, backup: string): string[] {
  return [
    'bootstrap-two-selector', '--env-file', value.envFile,
    '--expected-env-sha256', sha256(content),
    '--runtime-image', current,
    '--console-image', currentConsole,
    '--override-manifest', value.currentManifest,
    '--override-manifest-sha256', currentManifestSha,
    '--rollback-baseline', value.currentBaseline,
    '--rollback-baseline-sha256', currentBaselineSha,
    '--backup-env-file', backup,
  ];
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
          `CAUCE_COMPOSE_OVERRIDE_MANIFEST_SHA256=${currentManifestSha}`,
          `CAUCE_COMPOSE_OVERRIDE_MANIFEST_SHA256=${targetManifestSha}`,
        )
        .replace(
          `CAUCE_ROLLBACK_BASELINE_FILE=${value.currentBaseline}`,
          `CAUCE_ROLLBACK_BASELINE_FILE=${value.targetBaseline}`,
        )
        .replace(
          `CAUCE_ROLLBACK_BASELINE_SHA256=${currentBaselineSha}`,
          `CAUCE_ROLLBACK_BASELINE_SHA256=${targetBaselineSha}`,
        )
        .replace(
          `CAUCE_ROLLBACK_WRITER_SNAPSHOT_FILE=${value.currentWriterSnapshot}`,
          `CAUCE_ROLLBACK_WRITER_SNAPSHOT_FILE=${value.targetWriterSnapshot}`,
        )
        .replace(
          `CAUCE_ROLLBACK_WRITER_SNAPSHOT_SHA256=${value.currentWriterSnapshotSha}`,
          `CAUCE_ROLLBACK_WRITER_SNAPSHOT_SHA256=${value.targetWriterSnapshotSha}`,
        ),
    );
    expect((await readdir(value.directory)).some((name) => name.includes('.release-pin-'))).toBe(false);

    const reverse = run(value, [
      'swap', '--env-file', value.envFile,
      '--expected-runtime-image', target, '--target-runtime-image', current,
      '--expected-console-image', targetConsole, '--target-console-image', currentConsole,
      '--expected-override-manifest', value.targetManifest,
      '--target-override-manifest', value.currentManifest,
      '--expected-override-manifest-sha256', targetManifestSha,
      '--target-override-manifest-sha256', currentManifestSha,
      '--expected-rollback-baseline', value.targetBaseline,
      '--target-rollback-baseline', value.currentBaseline,
      '--expected-rollback-baseline-sha256', targetBaselineSha,
      '--target-rollback-baseline-sha256', currentBaselineSha,
      '--expected-writer-snapshot', value.targetWriterSnapshot,
      '--target-writer-snapshot', value.currentWriterSnapshot,
      '--expected-writer-snapshot-sha256', value.targetWriterSnapshotSha,
      '--target-writer-snapshot-sha256', value.currentWriterSnapshotSha,
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

  test('re-admits baseline bytes after the semantic validator and before selector CAS', async () => {
    const value = await fixture();
    const before = await readFile(value.envFile);
    const fakeBaseline = join(value.directory, 'rollback-baseline.py');
    await writeFile(fakeBaseline, `#!/usr/bin/env python3
import pathlib
import sys
arguments = sys.argv[1:]
path = pathlib.Path(arguments[arguments.index('--baseline') + 1])
path.write_text('{"release":"replaced-after-validation"}\\n', encoding='utf-8')
path.chmod(0o600)
raise SystemExit(0)
`, { mode: 0o755 });
    await chmod(fakeBaseline, 0o755);

    const result = run(value, argumentsFor(value));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('target rollback baseline differs from its authorized SHA-256');
    expect(await readFile(value.envFile)).toEqual(before);
  });

  test('restores the exact old selector bytes when a target artifact races post-CAS admission', async () => {
    const value = await fixture();
    const before = await readFile(value.envFile);
    const replacement = `${value.targetManifest}.atomic-replacement`;
    await writeFile(replacement, 'target-manifest-raced-post-cas\n', { mode: 0o600 });
    const ready = join(value.directory, 'complete-cas.artifact-read.ready');
    const release = join(value.directory, 'complete-cas.artifact-read.release');
    const raced = runAsync(value, argumentsFor(value), {
      CAUCE_PIN_TEST_ARTIFACT_PATH: value.targetManifest,
      CAUCE_PIN_TEST_ARTIFACT_OCCURRENCE: '3',
      CAUCE_PIN_TEST_BARRIER: 'artifact-digest-after-read',
      CAUCE_PIN_TEST_BARRIER_READY: ready,
      CAUCE_PIN_TEST_BARRIER_RELEASE: release,
    });
    await waitForFile(ready);
    await rename(replacement, value.targetManifest);
    await writeFile(release, 'continue\n', { mode: 0o600 });

    const result = await raced;
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('selector restored');
    expect(await readFile(value.envFile)).toEqual(before);
  });

  test('uses the authenticated env parent FD for compensation if its pathname is replaced', async () => {
    const value = await fixture();
    const before = await readFile(value.envFile);
    const movedDirectory = `${value.directory}-moved`;
    scratch.push(movedDirectory);
    const ready = join(value.directory, 'env-parent.race.ready');
    const release = join(value.directory, 'env-parent.race.release');
    const raced = runAsync(value, argumentsFor(value), {
      CAUCE_PIN_TEST_BARRIER: 'complete-selector-after-replace',
      CAUCE_PIN_TEST_BARRIER_READY: ready,
      CAUCE_PIN_TEST_BARRIER_RELEASE: release,
    });
    await waitForFile(ready);
    await rename(value.directory, movedDirectory);
    await mkdir(value.directory, { mode: 0o700 });
    await writeFile(release, 'continue\n', { mode: 0o600 });

    const result = await raced;
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('selector restored');
    expect(await readFile(join(movedDirectory, 'prod.env'))).toEqual(before);
    await expect(readFile(value.envFile)).rejects.toMatchObject({ code: 'ENOENT' });
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
    expect(pinned).toContain(`CAUCE_COMPOSE_OVERRIDE_MANIFEST_SHA256=${targetManifestSha}\n`);
    expect(pinned).toContain(`CAUCE_ROLLBACK_BASELINE_FILE=${value.targetBaseline}\n`);
    expect(pinned).toContain(`CAUCE_ROLLBACK_BASELINE_SHA256=${targetBaselineSha}\n`);
    expect(pinned).toContain(`CAUCE_ROLLBACK_WRITER_SNAPSHOT_FILE=${value.targetWriterSnapshot}\n`);
    expect(pinned).toContain(`CAUCE_ROLLBACK_WRITER_SNAPSHOT_SHA256=${value.targetWriterSnapshotSha}\n`);
  });

  test('holds one authenticated lock across an entire external transition', async () => {
    const value = await fixture();
    const ready = join(value.directory, 'transition-ready');
    const release = join(value.directory, 'transition-release');
    const holder = runAsync(value, [
      'locked-exec', '--env-file', value.envFile, '--', '/bin/sh', '-c',
      'set -eu; : > "$1"; while [ ! -e "$2" ]; do sleep 0.01; done',
      'locked-transition', ready, release,
    ]);
    await waitForFile(ready);

    let contenderSettled = false;
    const contender = runAsync(value, ['check', ...argumentsFor(value).slice(1)])
      .finally(() => { contenderSettled = true; });
    await new Promise((resolvePromise) => { setTimeout(resolvePromise, 120); });
    expect(contenderSettled).toBe(false);

    await writeFile(release, 'continue\n');
    const [held, checked] = await Promise.all([holder, contender]);
    expect(held.status, held.stderr).toBe(0);
    expect(checked.status, checked.stderr).toBe(0);

    const forged = run(value, [
      'field', '--env-file', value.envFile, '--name', 'CAUCE_RUNTIME_IMAGE', '--lock-fd', '999',
    ]);
    expect(forged.status).toBe(1);
    expect(forged.stderr).toContain('inherited production release lock');
  });

  test('rejects a correct lock inode and token when the inherited FD was initially unlocked', async () => {
    const value = await fixture();
    const probe = join(value.directory, 'unheld-fd-probe.py');
    await writeFile(probe, `
import os
import pathlib
import subprocess
import sys

env_file = pathlib.Path(${JSON.stringify(value.envFile)})
helper = ${JSON.stringify(value.pinHelper)}
lock_path = env_file.parent / f".{env_file.name}.release-pin.lock"
token = "f" * 64
descriptor = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_CLOEXEC, 0o600)
try:
    os.fchmod(descriptor, 0o600)
    os.ftruncate(descriptor, 0)
    os.pwrite(descriptor, (token + "\\n").encode("ascii"), 0)
    environment = os.environ.copy()
    environment["CAUCE_RELEASE_TRANSITION_LOCK_TOKEN"] = token
    result = subprocess.run(
        [sys.executable, helper, "field", "--env-file", os.fspath(env_file),
         "--name", "CAUCE_RUNTIME_IMAGE", "--lock-fd", str(descriptor)],
        env=environment,
        pass_fds=(descriptor,),
        text=True,
        capture_output=True,
        check=False,
    )
finally:
    os.close(descriptor)

if result.returncode == 0 or "not already exclusive" not in result.stderr:
    sys.stderr.write(result.stdout + result.stderr)
    raise SystemExit(1)
`);
    const result = spawnSync('/usr/bin/python3', [probe], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
  });

  test('allows only a hash-bound complete selector inside an explicit isolated evidence root', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cauce-isolated-pin-'));
    scratch.push(directory);
    await chmod(directory, 0o700);
    const envFile = join(directory, 'release.env');
    const candidateManifest = join(directory, 'candidate.manifest');
    const bridgeManifest = join(directory, 'bridge.manifest');
    const baseline = join(directory, 'rollback-baseline.json');
    const writerSnapshot = join(directory, 'writer-snapshot.json');
    await writeFile(candidateManifest, 'candidate\n', { mode: 0o600 });
    await writeFile(bridgeManifest, 'bridge\n', { mode: 0o600 });
    const baselineContent = '{"kind":"isolated-rollback-evidence-baseline","schemaVersion":1}\n';
    await writeFile(baseline, baselineContent, { mode: 0o600 });
    const writerSnapshotContent = '{"kind":"isolated-writers","schemaVersion":1}\n';
    await writeFile(writerSnapshot, writerSnapshotContent, { mode: 0o600 });
    const writerSnapshotDigest = sha256(writerSnapshotContent);
    const baselineDigest = `sha256:${createHash('sha256').update(baselineContent).digest('hex')}`;
    await writeFile(envFile, [
      `CAUCE_RUNTIME_IMAGE=${current}`,
      `CAUCE_CONSOLE_IMAGE=${current}`,
      `CAUCE_COMPOSE_OVERRIDE_MANIFEST=${candidateManifest}`,
      `CAUCE_COMPOSE_OVERRIDE_MANIFEST_SHA256=${sha256('candidate\n')}`,
      `CAUCE_ROLLBACK_BASELINE_FILE=${baseline}`,
      `CAUCE_ROLLBACK_BASELINE_SHA256=${baselineDigest}`,
      `CAUCE_ROLLBACK_WRITER_SNAPSHOT_FILE=${writerSnapshot}`,
      `CAUCE_ROLLBACK_WRITER_SNAPSHOT_SHA256=${writerSnapshotDigest}`,
      '',
    ].join('\n'), { mode: 0o600 });
    const args = [
      'swap', '--env-file', envFile,
      '--expected-runtime-image', current, '--target-runtime-image', target,
      '--expected-console-image', current, '--target-console-image', current,
      '--expected-override-manifest', candidateManifest,
      '--target-override-manifest', bridgeManifest,
      '--expected-override-manifest-sha256', sha256('candidate\n'),
      '--target-override-manifest-sha256', sha256('bridge\n'),
      '--expected-rollback-baseline', baseline, '--target-rollback-baseline', baseline,
      '--expected-rollback-baseline-sha256', baselineDigest,
      '--target-rollback-baseline-sha256', baselineDigest,
      '--expected-writer-snapshot', writerSnapshot, '--target-writer-snapshot', writerSnapshot,
      '--expected-writer-snapshot-sha256', writerSnapshotDigest,
      '--target-writer-snapshot-sha256', writerSnapshotDigest,
      '--baseline-forward-release-commit', '1'.repeat(40),
      '--baseline-forward-runtime-image', current,
      '--baseline-forward-runtime-source-digest', `sha256:${'9'.repeat(64)}`,
      '--isolated-evidence-root', directory,
    ];
    const environment = { ...process.env, CAUCE_ROLLBACK_EVIDENCE_MODE: 'isolated-compose-v1' };
    const accepted = spawnSync('python3', [helper, ...args], { encoding: 'utf8', env: environment });
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(await readFile(envFile, 'utf8')).toContain(`CAUCE_RUNTIME_IMAGE=${target}\n`);

    await chmod(directory, 0o755);
    const rejected = spawnSync('python3', [helper, ...args], { encoding: 'utf8', env: environment });
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain('owned canonical mode-0700');
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

  test('rejects a production env and lock parent writable by group or others', async () => {
    const value = await fixture();
    const before = await readFile(value.envFile);
    await chmod(value.directory, 0o777);

    const rejected = run(value, argumentsFor(value));
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain('parent is not owned and protected');
    expect(await readFile(value.envFile)).toEqual(before);
  });

  test('binds expected and target manifest bytes to explicit SHA-256 values on every CAS', async () => {
    const value = await fixture();
    const bound = argumentsFor(value);
    const check = run(value, ['check', ...bound.slice(1)]);
    expect(check.status, check.stderr).toBe(0);

    await writeFile(value.targetManifest, 'changed after authorization\n', { mode: 0o600 });
    const before = await readFile(value.envFile);
    const rejected = run(value, bound);
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain('authorized SHA-256');
    expect(await readFile(value.envFile)).toEqual(before);

    const selectedDigest = run(value, [
      'manifest', '--env-file', value.envFile, '--path', value.currentManifest, '--require-selected',
    ]);
    expect(selectedDigest.status, selectedDigest.stderr).toBe(0);
    expect(selectedDigest.stdout).toBe(`${currentManifestSha}\n`);
  });

  test('legacy bootstrap is create-only, hash-authorized and atomically publishes all selectors', async () => {
    const value = await fixture();
    const output = join(value.directory, 'canonical-prod.env');
    const candidate = join(value.directory, 'legacy-bootstrap.candidate.env');
    const candidateContent = [
      'COMPOSE_PROJECT_NAME=cauce-v3-prod',
      'COMPOSE_PROFILES=observability',
      `CAUCE_RUNTIME_IMAGE=${current}`,
      `CAUCE_CONSOLE_IMAGE=${currentConsole}`,
      `CAUCE_COMPOSE_OVERRIDE_MANIFEST=${value.currentManifest}`,
      `CAUCE_COMPOSE_OVERRIDE_MANIFEST_SHA256=${currentManifestSha}`,
      `CAUCE_ROLLBACK_BASELINE_FILE=${value.currentBaseline}`,
      `CAUCE_ROLLBACK_BASELINE_SHA256=${currentBaselineSha}`,
      `CAUCE_ROLLBACK_WRITER_SNAPSHOT_FILE=${value.currentWriterSnapshot}`,
      `CAUCE_ROLLBACK_WRITER_SNAPSHOT_SHA256=${value.currentWriterSnapshotSha}`,
      '',
    ].join('\n');
    await writeFile(candidate, candidateContent, { mode: 0o600 });
    const args = [
      'bootstrap', '--env-file', output,
      '--candidate-env-file', candidate,
      '--expected-candidate-env-sha256', sha256(candidateContent),
      '--expected-override-manifest-sha256', sha256(await readFile(value.currentManifest)),
    ];

    const result = run(value, args);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('production release legacy bootstrap passed\n');
    expect(await readFile(output, 'utf8')).toBe(candidateContent);

    const overwrite = run(value, args);
    expect(overwrite.status).toBe(1);
    expect(overwrite.stderr).toContain('already exists');
    expect(await readFile(output, 'utf8')).toBe(candidateContent);

    const staleOutput = join(value.directory, 'stale-prod.env');
    const stale = run(value, args.map((item) => item === output ? staleOutput : item).map(
      (item) => item === sha256(candidateContent) ? `sha256:${'0'.repeat(64)}` : item,
    ));
    expect(stale.status).toBe(1);
    await expect(readFile(staleOutput)).rejects.toMatchObject({ code: 'ENOENT' });

    const poisonedOutput = join(value.directory, 'poisoned-prod.env');
    const poisonedCandidate = join(value.directory, 'poisoned-bootstrap.candidate.env');
    const poisonedContent = candidateContent.replace(
      'COMPOSE_PROFILES=observability',
      'COMPOSE_PROFILES=observability\nDOCKER_CONTEXT=attacker-context',
    );
    await writeFile(poisonedCandidate, poisonedContent, { mode: 0o600 });
    const poisoned = run(value, [
      'bootstrap', '--env-file', poisonedOutput,
      '--candidate-env-file', poisonedCandidate,
      '--expected-candidate-env-sha256', sha256(poisonedContent),
      '--expected-override-manifest-sha256', sha256(await readFile(value.currentManifest)),
    ]);
    expect(poisoned.status).toBe(1);
    expect(poisoned.stderr).toContain('forbidden Docker/Compose controls');
    await expect(readFile(poisonedOutput)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('atomically upgrades an authorized two-selector env to six and preserves a restart-safe backup', async () => {
    const value = await fixture();
    const complete = await readFile(value.envFile, 'utf8');
    const twoSelectors = complete
      .replace(current, legacyRuntime)
      .replace(currentConsole, legacyConsole)
      .replace(`CAUCE_COMPOSE_OVERRIDE_MANIFEST=${value.currentManifest}\n`, '')
      .replace(`CAUCE_COMPOSE_OVERRIDE_MANIFEST_SHA256=${currentManifestSha}\n`, '')
      .replace(`CAUCE_ROLLBACK_BASELINE_FILE=${value.currentBaseline}\n`, '')
      .replace(`CAUCE_ROLLBACK_BASELINE_SHA256=${currentBaselineSha}\n`, '')
      .replace(`CAUCE_ROLLBACK_WRITER_SNAPSHOT_FILE=${value.currentWriterSnapshot}\n`, '')
      .replace(`CAUCE_ROLLBACK_WRITER_SNAPSHOT_SHA256=${value.currentWriterSnapshotSha}\n`, '');
    await writeFile(value.envFile, twoSelectors, { mode: 0o600 });
    const backup = join(value.directory, 'two-selector.backup.env');
    // Simula caída después de publicar el backup y antes del replace: el reintento debe admitir
    // exactamente esos mismos bytes, no exigir una edición manual ni crear otro respaldo.
    await writeFile(backup, twoSelectors, { mode: 0o600 });
    const baselineHelper = join(value.directory, 'rollback-baseline.py');
    await writeFile(
      baselineHelper,
      [
        '#!/usr/bin/env python3',
        'import sys',
        'args = sys.argv[1:]',
        `expected = ${JSON.stringify([
          '--expected-forward-runtime-image', current,
          '--expected-console-image', currentConsole,
          '--expected-override-manifest', value.currentManifest,
        ])}`,
        'raise SystemExit(0 if all(expected[i] in args and args[args.index(expected[i]) + 1] == expected[i + 1] for i in range(0, len(expected), 2)) else 9)',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    await chmod(baselineHelper, 0o755);
    const args = [
      'bootstrap-two-selector', '--env-file', value.envFile,
      '--expected-env-sha256', sha256(twoSelectors),
      '--runtime-image', current,
      '--console-image', currentConsole,
      '--override-manifest', value.currentManifest,
      '--override-manifest-sha256', currentManifestSha,
      '--rollback-baseline', value.currentBaseline,
      '--rollback-baseline-sha256', currentBaselineSha,
      '--backup-env-file', backup,
    ];
    const upgraded = run(value, args);
    expect(upgraded.status, upgraded.stderr).toBe(0);
    expect(upgraded.stdout).toBe('production release two-selector bootstrap passed\n');
    expect(upgraded.stdout + upgraded.stderr).not.toContain(value.secret);
    expect(await readFile(backup, 'utf8')).toBe(twoSelectors);
    const expected = twoSelectors
      .replace(`CAUCE_RUNTIME_IMAGE=${legacyRuntime}`, `CAUCE_RUNTIME_IMAGE=${current}`)
      .replace(
        `CAUCE_CONSOLE_IMAGE=${legacyConsole}\n`,
        [
          `CAUCE_CONSOLE_IMAGE=${currentConsole}`,
          `CAUCE_COMPOSE_OVERRIDE_MANIFEST=${value.currentManifest}`,
          `CAUCE_COMPOSE_OVERRIDE_MANIFEST_SHA256=${currentManifestSha}`,
          `CAUCE_ROLLBACK_BASELINE_FILE=${value.currentBaseline}`,
          `CAUCE_ROLLBACK_BASELINE_SHA256=${currentBaselineSha}`,
          '',
        ].join('\n'),
      );
    expect(await readFile(value.envFile, 'utf8')).toBe(expected);
    expect(
      expected
        .replace(`CAUCE_RUNTIME_IMAGE=${current}`, `CAUCE_RUNTIME_IMAGE=${legacyRuntime}`)
        .replace(`CAUCE_CONSOLE_IMAGE=${currentConsole}`, `CAUCE_CONSOLE_IMAGE=${legacyConsole}`)
        .replace(`CAUCE_COMPOSE_OVERRIDE_MANIFEST=${value.currentManifest}\n`, '')
        .replace(`CAUCE_COMPOSE_OVERRIDE_MANIFEST_SHA256=${currentManifestSha}\n`, '')
        .replace(`CAUCE_ROLLBACK_BASELINE_FILE=${value.currentBaseline}\n`, '')
        .replace(`CAUCE_ROLLBACK_BASELINE_SHA256=${currentBaselineSha}\n`, ''),
    ).toBe(twoSelectors);

    const repeated = run(value, args);
    expect(repeated.status, repeated.stderr).toBe(0);
    expect(repeated.stdout).toBe('production release two-selector bootstrap passed\n');
    expect(await readFile(value.envFile, 'utf8')).toBe(expected);
    expect(await readFile(backup, 'utf8')).toBe(twoSelectors);
  });

  test('two-selector bootstrap rejects stale, partial, mutable-target and concurrent mutation safely', async () => {
    const value = await fixture();
    const complete = await readFile(value.envFile, 'utf8');
    const twoSelectors = complete
      .replace(current, legacyRuntime)
      .replace(currentConsole, legacyConsole)
      .replace(`CAUCE_COMPOSE_OVERRIDE_MANIFEST=${value.currentManifest}\n`, '')
      .replace(`CAUCE_COMPOSE_OVERRIDE_MANIFEST_SHA256=${currentManifestSha}\n`, '')
      .replace(`CAUCE_ROLLBACK_BASELINE_FILE=${value.currentBaseline}\n`, '')
      .replace(`CAUCE_ROLLBACK_BASELINE_SHA256=${currentBaselineSha}\n`, '')
      .replace(`CAUCE_ROLLBACK_WRITER_SNAPSHOT_FILE=${value.currentWriterSnapshot}\n`, '')
      .replace(`CAUCE_ROLLBACK_WRITER_SNAPSHOT_SHA256=${value.currentWriterSnapshotSha}\n`, '');
    await writeFile(value.envFile, twoSelectors, { mode: 0o600 });
    const baseArgs = [
      'bootstrap-two-selector', '--env-file', value.envFile,
      '--expected-env-sha256', sha256(twoSelectors),
      '--runtime-image', current,
      '--console-image', currentConsole,
      '--override-manifest', value.currentManifest,
      '--override-manifest-sha256', currentManifestSha,
      '--rollback-baseline', value.currentBaseline,
      '--rollback-baseline-sha256', currentBaselineSha,
    ];
    const stale = run(value, [
      ...baseArgs,
      '--backup-env-file', join(value.directory, 'stale.backup.env'),
    ].map((item) => item === sha256(twoSelectors) ? `sha256:${'0'.repeat(64)}` : item));
    expect(stale.status).toBe(1);
    expect(await readFile(value.envFile, 'utf8')).toBe(twoSelectors);

    const mutableTarget = run(value, [
      ...baseArgs.map((item) => item === current ? 'runtime:mutable' : item),
      '--backup-env-file', join(value.directory, 'mutable.backup.env'),
    ]);
    expect(mutableTarget.status).toBe(1);
    expect(await readFile(value.envFile, 'utf8')).toBe(twoSelectors);

    const baselineHelper = join(value.directory, 'rollback-baseline.py');
    await writeFile(baselineHelper, '#!/usr/bin/env python3\nraise SystemExit(9)\n', { mode: 0o755 });
    await chmod(baselineHelper, 0o755);
    const rejectedBackup = join(value.directory, 'baseline-rejected.backup.env');
    const rejectedBaseline = run(value, [
      ...baseArgs,
      '--backup-env-file', rejectedBackup,
    ]);
    expect(rejectedBaseline.status).toBe(1);
    expect(rejectedBaseline.stderr).toContain('baseline did not pass');
    expect(await readFile(value.envFile, 'utf8')).toBe(twoSelectors);
    await expect(readFile(rejectedBackup)).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(baselineHelper, '#!/usr/bin/env python3\nraise SystemExit(0)\n', { mode: 0o755 });
    await chmod(baselineHelper, 0o755);

    const partial = twoSelectors.replace(
      `CAUCE_CONSOLE_IMAGE=${legacyConsole}\n`,
      `CAUCE_CONSOLE_IMAGE=${legacyConsole}\nCAUCE_COMPOSE_OVERRIDE_MANIFEST=${value.currentManifest}\n`,
    );
    await writeFile(value.envFile, partial, { mode: 0o600 });
    const partialResult = run(value, [
      ...baseArgs.map((item) => item === sha256(twoSelectors) ? sha256(partial) : item),
      '--backup-env-file', join(value.directory, 'partial.backup.env'),
    ]);
    expect(partialResult.status).toBe(1);
    expect(partialResult.stderr).toContain('exact two-selector legacy input');
    expect(await readFile(value.envFile, 'utf8')).toBe(partial);

    await writeFile(value.envFile, twoSelectors, { mode: 0o600 });
    const concurrentArgs = [
      ...baseArgs,
      '--backup-env-file', join(value.directory, 'concurrent.backup.env'),
    ];
    const results = await Promise.all([
      runAsync(value, concurrentArgs),
      runAsync(value, concurrentArgs),
    ]);
    expect(results.filter((result) => result.status === 0)).toHaveLength(2);
    expect(results.map((result) => result.stdout + result.stderr).join('')).not.toContain(value.secret);
  });

  test('two-selector backup cannot alias the selector, lock, artifacts, or an unsafe parent', async () => {
    const value = await fixture();
    const content = asTwoSelector(await readFile(value.envFile, 'utf8'));
    await writeFile(value.envFile, content, { mode: 0o600 });

    const sameEnv = run(value, twoSelectorArguments(value, content, value.envFile));
    expect(sameEnv.status).toBe(1);
    expect(sameEnv.stderr).toContain('backup aliases production env');

    const redundantDirectory = join(value.directory, 'redundant');
    await mkdir(redundantDirectory, { mode: 0o700 });
    const redundantEnv = `${redundantDirectory}/../prod.env`;
    const redundant = run(value, twoSelectorArguments(value, content, redundantEnv));
    expect(redundant.status).toBe(1);
    expect(redundant.stderr).toContain('path is not canonical');

    const lockPath = join(value.directory, '.prod.env.release-pin.lock');
    const lockAlias = run(value, twoSelectorArguments(value, content, lockPath));
    expect(lockAlias.status).toBe(1);
    expect(lockAlias.stderr).toContain('backup aliases production release lock');

    const artifactAlias = run(
      value,
      twoSelectorArguments(value, content, value.currentManifest),
    );
    expect(artifactAlias.status).toBe(1);
    expect(artifactAlias.stderr).toContain('backup aliases override manifest');

    const writableParent = join(value.directory, 'writable-parent');
    await mkdir(writableParent, { mode: 0o700 });
    const writableBackup = join(writableParent, 'prod.env.before');
    await writeFile(writableBackup, content, { mode: 0o600 });
    await chmod(writableParent, 0o777);
    const writable = run(value, twoSelectorArguments(value, content, writableBackup));
    expect(writable.status).toBe(1);
    expect(writable.stderr).toContain('parent is not owned and protected');

    const protectedParent = join(value.directory, 'protected-parent');
    const parentAlias = join(value.directory, 'parent-alias');
    await mkdir(protectedParent, { mode: 0o700 });
    await symlink(protectedParent, parentAlias);
    const symlinked = run(
      value,
      twoSelectorArguments(value, content, join(parentAlias, 'prod.env.before')),
    );
    expect(symlinked.status).toBe(1);
    expect(symlinked.stderr).toContain('parent must not contain symlink aliases');
    expect(await readFile(value.envFile, 'utf8')).toBe(content);
  });

  test('recovers every durable backup-publication crash boundary without losing the old selector', async () => {
    for (const fault of [
      'publish-after-file-fsync',
      'publish-after-link',
      'publish-after-unlink',
      'publish-after-directory-fsync',
    ]) {
      const value = await fixture();
      const content = asTwoSelector(await readFile(value.envFile, 'utf8'));
      await writeFile(value.envFile, content, { mode: 0o600 });
      const backup = join(value.directory, `${fault}.prod.env.before`);
      const args = twoSelectorArguments(value, content, backup);

      const crashed = run(value, args, { CAUCE_PIN_TEST_FAULT: fault });
      expect(crashed.status, `${fault}: ${crashed.stderr}`).toBe(86);
      expect(await readFile(value.envFile, 'utf8')).toBe(content);
      if (fault === 'publish-after-link') {
        expect((await stat(backup)).nlink).toBe(2);
      }

      const recovered = run(value, args);
      expect(recovered.status, `${fault}: ${recovered.stderr}`).toBe(0);
      expect(await readFile(backup, 'utf8')).toBe(content);
      expect((await lstat(backup)).nlink).toBe(1);
      expect(
        (await readdir(value.directory)).filter((name) => (
          name.startsWith(`.${fault}.prod.env.before.release-bootstrap-`)
        )),
      ).toEqual([]);
    }
  });

  test('recovers idempotently after SIGKILL immediately after the two-to-six replace', async () => {
    const value = await fixture();
    const original = asTwoSelector(await readFile(value.envFile, 'utf8'));
    await writeFile(value.envFile, original, { mode: 0o600 });
    const backup = join(value.directory, 'two-to-six.sigkill.backup.env');
    const args = twoSelectorArguments(value, original, backup);

    const killed = await sigkillAtBarrier(value, args, 'two-selector-after-replace');
    expect(killed.status).toBeNull();
    expect(killed.signal).toBe('SIGKILL');
    expect(await readFile(value.envFile, 'utf8')).not.toBe(original);

    const recovered = run(value, args);
    expect(recovered.status, recovered.stderr).toBe(0);
    expect(await readFile(backup, 'utf8')).toBe(original);
    expect(await readFile(value.envFile, 'utf8')).toContain(
      `CAUCE_COMPOSE_OVERRIDE_MANIFEST_SHA256=${currentManifestSha}\n`,
    );
  });

  test('normalizes only when legacy tags and live containers resolve to the target RepoDigests', async () => {
    const value = await fixture();
    const content = asTwoSelector(await readFile(value.envFile, 'utf8'));
    await writeFile(value.envFile, content, { mode: 0o600 });
    const backup = join(value.directory, 'live-proof.backup.env');
    const args = twoSelectorArguments(value, content, backup);

    const mismatchedTag = run(value, args, {
      CAUCE_TEST_RUNTIME_TAG_ID: `sha256:${'8'.repeat(64)}`,
    });
    expect(mismatchedTag.status).toBe(1);
    expect(mismatchedTag.stderr).toContain('runtime tag differs');
    await expect(readFile(backup)).rejects.toMatchObject({ code: 'ENOENT' });

    const mismatchedContainer = run(value, args, {
      CAUCE_TEST_RUNTIME_CONTAINER_ID: `sha256:${'9'.repeat(64)}`,
    });
    expect(mismatchedContainer.status).toBe(1);
    expect(mismatchedContainer.stderr).toContain('running container differs');
    expect(await readFile(value.envFile, 'utf8')).toBe(content);
    await expect(readFile(backup)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('compensates two-to-six if manifest or baseline changes after the selector replace', async () => {
    for (const artifact of ['manifest', 'baseline'] as const) {
      const value = await fixture();
      const content = asTwoSelector(await readFile(value.envFile, 'utf8'));
      await writeFile(value.envFile, content, { mode: 0o600 });
      const backup = join(value.directory, `${artifact}.race.backup.env`);
      const ready = join(value.directory, `${artifact}.race.ready`);
      const release = join(value.directory, `${artifact}.race.release`);
      const raced = runAsync(value, twoSelectorArguments(value, content, backup), {
        CAUCE_PIN_TEST_BARRIER: 'two-selector-after-replace',
        CAUCE_PIN_TEST_BARRIER_READY: ready,
        CAUCE_PIN_TEST_BARRIER_RELEASE: release,
      });
      await waitForFile(ready);
      const selectedArtifact = artifact === 'manifest'
        ? value.currentManifest
        : value.currentBaseline;
      await writeFile(selectedArtifact, `${artifact}-changed-after-replace\n`, { mode: 0o600 });
      await writeFile(release, 'continue\n', { mode: 0o600 });

      const result = await raced;
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain('selector restored');
      expect(await readFile(value.envFile, 'utf8')).toBe(content);
      expect(await readFile(backup, 'utf8')).toBe(content);
    }
  });

  test('compensates if the authenticated backup parent is replaced after selector publication', async () => {
    const value = await fixture();
    const content = asTwoSelector(await readFile(value.envFile, 'utf8'));
    await writeFile(value.envFile, content, { mode: 0o600 });
    const backupDirectory = join(value.directory, 'durable-backup');
    const movedDirectory = join(value.directory, 'durable-backup-moved');
    await mkdir(backupDirectory, { mode: 0o700 });
    const backup = join(backupDirectory, 'prod.env.before');
    const ready = join(value.directory, 'parent.race.ready');
    const release = join(value.directory, 'parent.race.release');
    const raced = runAsync(value, twoSelectorArguments(value, content, backup), {
      CAUCE_PIN_TEST_BARRIER: 'two-selector-after-replace',
      CAUCE_PIN_TEST_BARRIER_READY: ready,
      CAUCE_PIN_TEST_BARRIER_RELEASE: release,
    });
    await waitForFile(ready);
    await rename(backupDirectory, movedDirectory);
    await mkdir(backupDirectory, { mode: 0o700 });
    await writeFile(release, 'continue\n', { mode: 0o600 });

    const result = await raced;
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('selector restored');
    expect(await readFile(value.envFile, 'utf8')).toBe(content);
    expect(await readFile(join(movedDirectory, 'prod.env.before'), 'utf8')).toBe(content);
    await expect(readFile(backup)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('compensates six-to-eight if the writer snapshot changes after selector replace', async () => {
    const value = await fixture();
    const complete = await readFile(value.envFile, 'utf8');
    const sixSelectors = complete
      .replace(`CAUCE_ROLLBACK_WRITER_SNAPSHOT_FILE=${value.currentWriterSnapshot}\n`, '')
      .replace(`CAUCE_ROLLBACK_WRITER_SNAPSHOT_SHA256=${value.currentWriterSnapshotSha}\n`, '');
    await writeFile(value.envFile, sixSelectors, { mode: 0o600 });
    const ready = join(value.directory, 'writer.race.ready');
    const release = join(value.directory, 'writer.race.release');
    const raced = runAsync(value, [
      'bootstrap-writer-snapshot', '--env-file', value.envFile,
      '--expected-env-sha256', sha256(sixSelectors),
      '--writer-snapshot', value.currentWriterSnapshot,
      '--writer-snapshot-sha256', value.currentWriterSnapshotSha,
    ], {
      CAUCE_PIN_TEST_BARRIER: 'writer-snapshot-after-replace',
      CAUCE_PIN_TEST_BARRIER_READY: ready,
      CAUCE_PIN_TEST_BARRIER_RELEASE: release,
    });
    await waitForFile(ready);
    await writeFile(value.currentWriterSnapshot, 'writer-changed-after-replace\n', { mode: 0o600 });
    await writeFile(release, 'continue\n', { mode: 0o600 });

    const result = await raced;
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('selector restored');
    expect(await readFile(value.envFile, 'utf8')).toBe(sixSelectors);
  });

  test('authenticates manifest bytes before and after the six-to-eight replace', async () => {
    const value = await fixture();
    const complete = await readFile(value.envFile, 'utf8');
    const sixSelectors = complete
      .replace(`CAUCE_ROLLBACK_WRITER_SNAPSHOT_FILE=${value.currentWriterSnapshot}\n`, '')
      .replace(`CAUCE_ROLLBACK_WRITER_SNAPSHOT_SHA256=${value.currentWriterSnapshotSha}\n`, '');
    await writeFile(value.envFile, sixSelectors, { mode: 0o600 });
    const replacement = `${value.currentManifest}.atomic-replacement`;
    await writeFile(replacement, 'manifest-raced-during-six-to-eight\n', { mode: 0o600 });
    const ready = join(value.directory, 'six-manifest.artifact-read.ready');
    const release = join(value.directory, 'six-manifest.artifact-read.release');
    const raced = runAsync(value, [
      'bootstrap-writer-snapshot', '--env-file', value.envFile,
      '--expected-env-sha256', sha256(sixSelectors),
      '--writer-snapshot', value.currentWriterSnapshot,
      '--writer-snapshot-sha256', value.currentWriterSnapshotSha,
    ], {
      CAUCE_PIN_TEST_ARTIFACT_PATH: value.currentManifest,
      CAUCE_PIN_TEST_ARTIFACT_OCCURRENCE: '3',
      CAUCE_PIN_TEST_BARRIER: 'artifact-digest-after-read',
      CAUCE_PIN_TEST_BARRIER_READY: ready,
      CAUCE_PIN_TEST_BARRIER_RELEASE: release,
    });
    await waitForFile(ready);
    await rename(replacement, value.currentManifest);
    await writeFile(release, 'continue\n', { mode: 0o600 });

    const result = await raced;
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('selector restored');
    expect(await readFile(value.envFile, 'utf8')).toBe(sixSelectors);
  });

  test('recovers idempotently after SIGKILL immediately after the six-to-eight replace', async () => {
    const value = await fixture();
    const complete = await readFile(value.envFile, 'utf8');
    const sixSelectors = complete
      .replace(`CAUCE_ROLLBACK_WRITER_SNAPSHOT_FILE=${value.currentWriterSnapshot}\n`, '')
      .replace(`CAUCE_ROLLBACK_WRITER_SNAPSHOT_SHA256=${value.currentWriterSnapshotSha}\n`, '');
    await writeFile(value.envFile, sixSelectors, { mode: 0o600 });
    const args = [
      'bootstrap-writer-snapshot', '--env-file', value.envFile,
      '--expected-env-sha256', sha256(sixSelectors),
      '--writer-snapshot', value.currentWriterSnapshot,
      '--writer-snapshot-sha256', value.currentWriterSnapshotSha,
    ];

    const killed = await sigkillAtBarrier(value, args, 'writer-snapshot-after-replace');
    expect(killed.status).toBeNull();
    expect(killed.signal).toBe('SIGKILL');
    expect(await readFile(value.envFile, 'utf8')).toBe(complete);

    const recovered = run(value, args);
    expect(recovered.status, recovered.stderr).toBe(0);
    expect(await readFile(value.envFile, 'utf8')).toBe(complete);
  });

  test('atomically upgrades an authorized five-selector legacy env exactly once', async () => {
    const value = await fixture();
    const complete = await readFile(value.envFile, 'utf8');
    const sixSelectors = complete
      .replace(`CAUCE_ROLLBACK_WRITER_SNAPSHOT_FILE=${value.currentWriterSnapshot}\n`, '')
      .replace(`CAUCE_ROLLBACK_WRITER_SNAPSHOT_SHA256=${value.currentWriterSnapshotSha}\n`, '');
    const legacy = sixSelectors.replace(
      `CAUCE_COMPOSE_OVERRIDE_MANIFEST_SHA256=${currentManifestSha}\n`,
      '',
    );
    await writeFile(value.envFile, legacy, { mode: 0o600 });
    const args = [
      'bootstrap-manifest-sha', '--env-file', value.envFile,
      '--expected-env-sha256', sha256(legacy),
      '--expected-override-manifest', value.currentManifest,
      '--expected-override-manifest-sha256', currentManifestSha,
    ];

    const upgraded = run(value, args);
    expect(upgraded.status, upgraded.stderr).toBe(0);
    expect(upgraded.stdout).toBe('production release legacy manifest SHA-256 bootstrap passed\n');
    expect(await readFile(value.envFile, 'utf8')).toBe(sixSelectors);

    const repeated = run(value, args);
    expect(repeated.status).toBe(1);
    expect(repeated.stderr).toContain('already has a manifest SHA-256 selector');
    expect(await readFile(value.envFile, 'utf8')).toBe(sixSelectors);
  });

  test('atomically upgrades an authorized six-selector env with a durable writer snapshot', async () => {
    const value = await fixture();
    const complete = await readFile(value.envFile, 'utf8');
    const sixSelectors = complete
      .replace(`CAUCE_ROLLBACK_WRITER_SNAPSHOT_FILE=${value.currentWriterSnapshot}\n`, '')
      .replace(`CAUCE_ROLLBACK_WRITER_SNAPSHOT_SHA256=${value.currentWriterSnapshotSha}\n`, '');
    await writeFile(value.envFile, sixSelectors, { mode: 0o600 });
    const baselineHelper = join(value.directory, 'rollback-baseline.py');
    await writeFile(
      baselineHelper,
      [
        '#!/usr/bin/env python3',
        'import sys',
        'args = sys.argv[1:]',
        `expected = ${JSON.stringify([
          '--expected-forward-runtime-image', current,
          '--expected-console-image', currentConsole,
          '--expected-override-manifest', value.currentManifest,
        ])}`,
        'raise SystemExit(0 if all(expected[i] in args and args[args.index(expected[i]) + 1] == expected[i + 1] for i in range(0, len(expected), 2)) else 9)',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    await chmod(baselineHelper, 0o755);
    const args = [
      'bootstrap-writer-snapshot', '--env-file', value.envFile,
      '--expected-env-sha256', sha256(sixSelectors),
      '--writer-snapshot', value.currentWriterSnapshot,
      '--writer-snapshot-sha256', value.currentWriterSnapshotSha,
    ];
    const upgraded = run(value, args);
    expect(upgraded.status, upgraded.stderr).toBe(0);
    expect(await readFile(value.envFile, 'utf8')).toBe(complete);
    const repeated = run(value, args);
    expect(repeated.status, repeated.stderr).toBe(0);
    expect(repeated.stdout).toBe(
      'production release rollback writer snapshot bootstrap passed\n',
    );
  });
});
