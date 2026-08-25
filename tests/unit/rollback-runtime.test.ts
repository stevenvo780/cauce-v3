import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const rollback = join(repository, 'ops/scripts/rollback.sh');
const scratch: string[] = [];
const current = `registry.invalid/cauce/runtime@sha256:${'c'.repeat(64)}`;
const previous = `registry.invalid/cauce/runtime@sha256:${'a'.repeat(64)}`;
const currentId = `sha256:${'d'.repeat(64)}`;
const previousId = `sha256:${'b'.repeat(64)}`;
const currentConsole = `registry.invalid/cauce/console@sha256:${'e'.repeat(64)}`;
const previousConsole = `registry.invalid/cauce/console@sha256:${'f'.repeat(64)}`;
const currentConsoleId = `sha256:${'1'.repeat(64)}`;
const previousConsoleId = `sha256:${'2'.repeat(64)}`;
const baselineSha = `sha256:${'4'.repeat(64)}`;

async function harness(running: string, mismatch = '', currentSchema = '029_reconcile_declared_fleet.sql') {
  const directory = await mkdtemp(join(tmpdir(), 'cauce-rollback-'));
  scratch.push(directory);
  const bin = join(directory, 'bin');
  const overrides = join(directory, 'overrides');
  const log = join(directory, 'docker.log');
  const envFile = join(directory, 'prod.env');
  const currentManifest = join(directory, 'current.manifest');
  const previousManifest = join(directory, 'previous.manifest');
  const bridgeEvidence = join(directory, 'rollback-bridge.json');
  const baseline = join(directory, 'rollback-baseline.json');
  await mkdir(bin);
  await mkdir(overrides);
  await writeFile(currentManifest, '');
  await writeFile(previousManifest, '');
  await chmod(currentManifest, 0o600);
  await chmod(previousManifest, 0o600);
  await writeFile(bridgeEvidence, '{}\n', { mode: 0o600 });
  await chmod(bridgeEvidence, 0o600);
  await writeFile(baseline, '{}\n', { mode: 0o600 });
  await chmod(baseline, 0o600);
  const copiedPin = join(directory, 'pin-production-release.py');
  await copyFile(join(repository, 'ops/scripts/pin-production-release.py'), copiedPin);
  await chmod(copiedPin, 0o755);
  const fakeBaseline = join(directory, 'rollback-baseline.py');
  await writeFile(fakeBaseline, '#!/usr/bin/python3\nraise SystemExit(0)\n', { mode: 0o755 });
  await chmod(fakeBaseline, 0o755);
  await writeFile(
    envFile,
    [
      'COMPOSE_PROJECT_NAME=rollback-fixture',
      'CAUCE_LOCAL_POSTGRES=0',
      `CAUCE_COMPOSE_OVERRIDES_DIR=${overrides}`,
      `CAUCE_RUNTIME_IMAGE=${current}`,
      `CAUCE_CONSOLE_IMAGE=${currentConsole}`,
      `CAUCE_COMPOSE_OVERRIDE_MANIFEST=${currentManifest}`,
      `CAUCE_ROLLBACK_BASELINE_FILE=${baseline}`,
      `CAUCE_ROLLBACK_BASELINE_SHA256=${baselineSha}`,
      'PRIVATE_SENTINEL=never-print-this-value',
    ].join('\n') + '\n',
    { mode: 0o600 },
  );
  await chmod(envFile, 0o600);
  const fakeDocker = join(bin, 'docker');
  await writeFile(
    fakeDocker,
    `#!/bin/sh
set -eu
printf '%s\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = pull ]; then exit 0; fi
if [ "$1" = image ] && [ "$2" = inspect ]; then
  last=
  for value in "$@"; do last=$value; done
  case " $* " in
    *RepoDigests*) printf '%s\n' "$last" ;;
    *)
      case "$last" in
        "$FAKE_PREVIOUS_REF") printf '%s\n' "$FAKE_PREVIOUS_ID" ;;
        "$FAKE_CURRENT_REF") printf '%s\n' "$FAKE_CURRENT_ID" ;;
        "$FAKE_PREVIOUS_CONSOLE_REF") printf '%s\n' "$FAKE_PREVIOUS_CONSOLE_ID" ;;
        "$FAKE_CURRENT_CONSOLE_REF") printf '%s\n' "$FAKE_CURRENT_CONSOLE_ID" ;;
        *) exit 1 ;;
      esac ;;
  esac
  exit 0
fi
if [ "$1" = inspect ]; then
  last=
  for value in "$@"; do last=$value; done
  if [ "$last" = cid-console ]; then
    selected_ref=$(sed -n 's/^CAUCE_CONSOLE_IMAGE=//p' "$CAUCE_ENV_FILE")
    if [ "$selected_ref" = "$FAKE_PREVIOUS_CONSOLE_REF" ]; then selected_id=$FAKE_PREVIOUS_CONSOLE_ID; is_target=1; else selected_id=$FAKE_CURRENT_CONSOLE_ID; is_target=0; fi
  else
    selected_ref=$(sed -n 's/^CAUCE_RUNTIME_IMAGE=//p' "$CAUCE_ENV_FILE")
    if [ "$selected_ref" = "$FAKE_PREVIOUS_REF" ]; then selected_id=$FAKE_PREVIOUS_ID; is_target=1; else selected_id=$FAKE_CURRENT_ID; is_target=0; fi
  fi
  if [ -n "\${FAKE_MISMATCH:-}" ] && [ "$is_target" = 1 ] && [ "$last" = "cid-\${FAKE_MISMATCH}" ]; then
    printf 'sha256:%064d\n' 9
  else
    printf '%s\n' "$selected_id"
  fi
  exit 0
fi
if [ "$1" = compose ]; then
  expected_manifest=$(sed -n 's/^CAUCE_COMPOSE_OVERRIDE_MANIFEST=//p' "$CAUCE_ENV_FILE")
  [ "\${CAUCE_COMPOSE_OVERRIDE_MANIFEST:-}" = "$expected_manifest" ] || exit 91
  [ "\${CAUCE_LOCAL_POSTGRES:-}" = 0 ] || exit 92
  [ -z "\${CAUCE_RUNTIME_IMAGE+x}" ] || exit 93
  [ -z "\${CAUCE_CONSOLE_IMAGE+x}" ] || exit 94
  case " $* " in
    *' version'*) exit 0 ;;
    *' exec -T gateway node deploy/schema-version.mjs '*) printf '%s\n' "$FAKE_CURRENT_SCHEMA"; exit 0 ;;
    *' ps --services --status running '*) printf '%s\n' "$FAKE_RUNNING"; exit 0 ;;
    *' ps -q '*) last=; for value in "$@"; do last=$value; done; printf 'cid-%s\n' "$last"; exit 0 ;;
    *' config --services '*) printf '%s\n' gateway dispatcher outbox-metrics; exit 0 ;;
    *) exit 0 ;;
  esac
fi
exit 1
`,
  );
  await chmod(fakeDocker, 0o755);
  const fakePython = join(bin, 'python3');
  await writeFile(
    fakePython,
    `#!/bin/sh
case " $* " in
  *pin-production-release.py*) shift; exec /usr/bin/python3 "$FAKE_PIN_HELPER" "$@" ;;
  *rollback-baseline.py*' field '*)
    name=; previous=;
    for value in "$@"; do if [ "$previous" = --name ]; then name=$value; fi; previous=$value; done
    case "$name" in
      forward-release-commit) printf '%s\n' "$FAKE_FORWARD_COMMIT" ;;
      forward-runtime-image) printf '%s\n' "$FAKE_CURRENT_REF" ;;
      forward-runtime-source-digest) printf '%s\n' "$FAKE_FORWARD_SOURCE" ;;
      bridge-runtime-image) printf '%s\n' "$FAKE_PREVIOUS_REF" ;;
      console-image) printf '%s\n' "$FAKE_PREVIOUS_CONSOLE_REF" ;;
      override-manifest) printf '%s\n' "$FAKE_PREVIOUS_MANIFEST" ;;
      bridge-evidence) printf '%s\n' "$FAKE_BRIDGE_EVIDENCE" ;;
      bridge-evidence-sha256) printf '%s\n' "$FAKE_BRIDGE_SHA" ;;
      *) exit 1 ;;
    esac
    exit 0 ;;
  *validate-rollback-bridge-evidence.py*) printf 'validator %s\n' "$*" >> "$FAKE_DOCKER_LOG"; [ "\${FAKE_BRIDGE_VALID:-1}" = 1 ]; exit ;;
  *fleet-parity.py*) exit 0 ;;
  *) exec /usr/bin/python3 "$@" ;;
esac
`,
  );
  await chmod(fakePython, 0o755);
  const environment = { ...process.env };
  Object.assign(environment, {
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    FAKE_DOCKER_LOG: log,
    FAKE_CURRENT_ID: currentId,
    FAKE_PREVIOUS_ID: previousId,
    FAKE_CURRENT_REF: current,
    FAKE_PREVIOUS_REF: previous,
    FAKE_CURRENT_CONSOLE_ID: currentConsoleId,
    FAKE_PREVIOUS_CONSOLE_ID: previousConsoleId,
    FAKE_CURRENT_CONSOLE_REF: currentConsole,
    FAKE_PREVIOUS_CONSOLE_REF: previousConsole,
    FAKE_RUNNING: running,
    FAKE_MISMATCH: mismatch,
    FAKE_CURRENT_SCHEMA: currentSchema,
    FAKE_BRIDGE_VALID: '1',
    FAKE_PIN_HELPER: copiedPin,
    FAKE_FORWARD_COMMIT: '7'.repeat(40),
    FAKE_FORWARD_SOURCE: `sha256:${'8'.repeat(64)}`,
    FAKE_PREVIOUS_MANIFEST: previousManifest,
    FAKE_BRIDGE_EVIDENCE: bridgeEvidence,
    FAKE_BRIDGE_SHA: `sha256:${'3'.repeat(64)}`,
    CAUCE_ENV_FILE: envFile,
    CAUCE_CURRENT_RUNTIME_IMAGE: 'ambient/current-runtime:mutable',
    CAUCE_PREVIOUS_RUNTIME_IMAGE: previous,
    CAUCE_CURRENT_CONSOLE_IMAGE: 'ambient/current-console:mutable',
    CAUCE_CURRENT_OVERRIDE_MANIFEST: '/ambient/current.manifest',
    CAUCE_CURRENT_ROLLBACK_BASELINE_FILE: '/ambient/current-baseline.json',
    CAUCE_CURRENT_ROLLBACK_BASELINE_SHA256: `sha256:${'0'.repeat(64)}`,
    CAUCE_ROLLBACK_CONFIRM:
      `release-selectors:runtime:${current}|${currentConsole}|${currentManifest}|${baseline}|${baselineSha}`
      + `->${previous}|${currentConsole}|${previousManifest}|${baseline}|${baselineSha}`,
    // These hostile caller values must not win over the canonical env file.
    CAUCE_RUNTIME_IMAGE: 'ambient/runtime:mutable',
    CAUCE_CONSOLE_IMAGE: 'ambient/console:mutable',
    CAUCE_COMPOSE_OVERRIDE_MANIFEST: '/ambient/manifest',
    CAUCE_COMPOSE_OVERRIDES_DIR: '/ambient/overrides',
    CAUCE_LOCAL_POSTGRES: '1',
  });
  return { directory, environment, log, envFile, currentManifest, previousManifest, bridgeEvidence, baseline };
}

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('runtime rollback', () => {
  test('persists image and manifest, recreates the exact running set, and never invokes migrator', async () => {
    const fixture = await harness(
      ['gateway', 'dispatcher', 'outbox-metrics', 'terminal-relay', 'telegram-bridge'].join('\n'),
    );
    const result = spawnSync(rollback, ['runtime'], { encoding: 'utf8', env: fixture.environment });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('completed for 5 running service(s)');
    expect(result.stdout + result.stderr).not.toContain('never-print-this-value');
    const env = await readFile(fixture.envFile, 'utf8');
    expect(env).toContain(`CAUCE_RUNTIME_IMAGE=${previous}\n`);
    expect(env).toContain(`CAUCE_CONSOLE_IMAGE=${currentConsole}\n`);
    expect(env).toContain(`CAUCE_COMPOSE_OVERRIDE_MANIFEST=${fixture.previousManifest}\n`);
    const calls = await readFile(fixture.log, 'utf8');
    expect(calls).toContain('terminal-relay');
    expect(calls).toContain('telegram-bridge');
    expect(calls).toContain(`--expected-repository-digest ${previous}`);
    expect(calls).toContain(`--expected-image-id ${previousId}`);
    expect(calls).not.toContain('deploy/migrate.mjs');
    expect(calls).toContain('--no-deps --wait --wait-timeout 180');
  });

  test('rolls back only console through the complete selector CAS without probing schema', async () => {
    const fixture = await harness('console');
    Object.assign(fixture.environment, {
      CAUCE_PREVIOUS_CONSOLE_IMAGE: previousConsole,
      CAUCE_ROLLBACK_CONFIRM:
        `release-selectors:console:${current}|${currentConsole}|${fixture.currentManifest}|${fixture.baseline}|${baselineSha}`
        + `->${current}|${previousConsole}|${fixture.currentManifest}|${fixture.baseline}|${baselineSha}`,
    });
    const result = spawnSync(rollback, ['console'], { encoding: 'utf8', env: fixture.environment });
    expect(result.status, result.stderr).toBe(0);
    const env = await readFile(fixture.envFile, 'utf8');
    expect(env).toContain(`CAUCE_RUNTIME_IMAGE=${current}\n`);
    expect(env).toContain(`CAUCE_CONSOLE_IMAGE=${previousConsole}\n`);
    expect(env).toContain(`CAUCE_COMPOSE_OVERRIDE_MANIFEST=${fixture.currentManifest}\n`);
    const calls = await readFile(fixture.log, 'utf8');
    expect(calls).not.toContain('deploy/schema-version.mjs');
    expect(calls).toContain('pull console');
    expect(calls).not.toContain(' up -d --no-build --no-deps --wait --wait-timeout 180 gateway');
  });

  test('rolls back runtime, console, and manifest as one complete release transition', async () => {
    const fixture = await harness(['gateway', 'dispatcher', 'outbox-metrics', 'console'].join('\n'));
    Object.assign(fixture.environment, {
      CAUCE_PREVIOUS_CONSOLE_IMAGE: previousConsole,
      CAUCE_ROLLBACK_CONFIRM:
        `release-selectors:release:${current}|${currentConsole}|${fixture.currentManifest}|${fixture.baseline}|${baselineSha}`
        + `->${previous}|${previousConsole}|${fixture.previousManifest}|${fixture.baseline}|${baselineSha}`,
    });
    const result = spawnSync(rollback, ['release'], { encoding: 'utf8', env: fixture.environment });
    expect(result.status, result.stderr).toBe(0);
    const env = await readFile(fixture.envFile, 'utf8');
    expect(env).toContain(`CAUCE_RUNTIME_IMAGE=${previous}\n`);
    expect(env).toContain(`CAUCE_CONSOLE_IMAGE=${previousConsole}\n`);
    expect(env).toContain(`CAUCE_COMPOSE_OVERRIDE_MANIFEST=${fixture.previousManifest}\n`);
    const calls = await readFile(fixture.log, 'utf8');
    expect(calls).toContain('pull gateway dispatcher outbox-metrics console');
  });

  test('compensates both durable selectors and services after target verification fails', async () => {
    const fixture = await harness(
      ['gateway', 'dispatcher', 'outbox-metrics', 'terminal-relay'].join('\n'),
      'terminal-relay',
    );
    const result = spawnSync(rollback, ['runtime'], { encoding: 'utf8', env: fixture.environment });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('prior durable release selectors and running services were restored');
    const env = await readFile(fixture.envFile, 'utf8');
    expect(env).toContain(`CAUCE_RUNTIME_IMAGE=${current}\n`);
    expect(env).toContain(`CAUCE_COMPOSE_OVERRIDE_MANIFEST=${fixture.currentManifest}\n`);
    const calls = await readFile(fixture.log, 'utf8');
    expect(calls.match(/ up -d /gu)).toHaveLength(2);
  });

  test('fails before durable mutation when a mandatory service was not running', async () => {
    const fixture = await harness(['gateway', 'dispatcher'].join('\n'));
    const result = spawnSync(rollback, ['runtime'], { encoding: 'utf8', env: fixture.environment });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('mandatory service was not running');
    expect(await readFile(fixture.envFile, 'utf8')).toContain(`CAUCE_RUNTIME_IMAGE=${current}\n`);
    const calls = await readFile(fixture.log, 'utf8');
    expect(calls).not.toContain(' up -d ');
  });

  test('fails before durable mutation when the bridge evidence gate rejects the target image', async () => {
    const fixture = await harness(
      ['gateway', 'dispatcher', 'outbox-metrics'].join('\n'),
    );
    fixture.environment.FAKE_BRIDGE_VALID = '0';
    const result = spawnSync(rollback, ['runtime'], { encoding: 'utf8', env: fixture.environment });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('lacks exact passing rollback bridge evidence');
    expect(await readFile(fixture.envFile, 'utf8')).toContain(`CAUCE_RUNTIME_IMAGE=${current}\n`);
    const calls = await readFile(fixture.log, 'utf8');
    expect(calls).not.toContain(' up -d ');
  });

  test('refuses bridge evidence against any database schema other than exact 029', async () => {
    const fixture = await harness(
      ['gateway', 'dispatcher', 'outbox-metrics'].join('\n'), '', '028_canonical_agent_role.sql',
    );
    const result = spawnSync(rollback, ['runtime'], { encoding: 'utf8', env: fixture.environment });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('valid only for exact schema 029');
    expect(await readFile(fixture.envFile, 'utf8')).toContain(`CAUCE_RUNTIME_IMAGE=${current}\n`);
  });
});
