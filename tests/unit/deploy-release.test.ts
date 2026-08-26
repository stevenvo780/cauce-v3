import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import {
  chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { GenericContainer, Wait } from 'testcontainers';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sourceScript = join(repository, 'ops/scripts/deploy-release.sh');
const sourceReleaseCandidate = join(repository, 'ops/scripts/release-candidate.py');
const captureWriterScript = join(repository, 'ops/scripts/capture-release-writer-snapshot.sh');
const composeFile = join(repository, 'deploy/compose.yaml');
const sourceSchema = join(repository, 'ops/schemas/build-evidence.schema.json');
const makefile = join(repository, 'ops/Makefile');
const deployRunbook = join(repository, 'ops/runbooks/deploy.md');
const rollbackRunbook = join(repository, 'ops/runbooks/rollback.md');
const operationsDigest = join(repository, 'ops/scripts/container_ops_digest.py');
const systemdComposeUnit = join(repository, 'ops/systemd/cauce-v3-compose@.service');
const systemdStackWrapper = join(repository, 'ops/scripts/systemd-stack.sh');
const sourceTargetMigration = join(
  repository,
  'packages/store/migrations/037_console_publish_intent_indexes.sql',
);
const sourcePreTargetMigration = join(
  repository,
  'packages/store/migrations/036_shadow_router_target_phase.sql',
);
const sourcePrerequisiteMigration = join(
  repository,
  'packages/store/migrations/035_agent_profile_runtime_adoption.sql',
);
const scratch: string[] = [];
const prerequisiteSchema = '035_agent_profile_runtime_adoption.sql';
const preTargetSchema = '036_shadow_router_target_phase.sql';
const targetSchema = '037_console_publish_intent_indexes.sql';

type Fixture = {
  root: string;
  script: string;
  envFile: string;
  log: string;
  state: string;
  env: NodeJS.ProcessEnv;
  values: Record<string, string>;
};
type RealPostgres = { containerId: string; user: string; database: string };

const digest = (character: string): string => `sha256:${character.repeat(64)}`;
const image = (name: string, character: string): string =>
  `127.0.0.1:5000/cauce/${name}@${digest(character)}`;
const contentDigest = (content: string): string =>
  `sha256:${createHash('sha256').update(content).digest('hex')}`;

afterEach(async () => {
  await Promise.all(scratch.splice(0).map(async (path) => rm(path, { recursive: true, force: true })));
});

async function executable(path: string, content: string): Promise<void> {
  await writeFile(path, content);
  await chmod(path, 0o755);
}

function buildEvidence(values: Record<string, string>): object {
  const mediaType = 'application/vnd.oci.image.manifest.v1+json';
  const platform = { os: 'linux', architecture: 'amd64' };
  const base = (role: string, repositoryDigest: string, character: string) => ({
    role,
    repositoryDigest,
    manifestDigest: digest(character),
    mediaType,
    platform,
    imageId: digest(character),
  });
  return {
    schemaVersion: 7,
    evidenceClass: 'release-build',
    mechanism: 'docker-build-push-pull-final-image',
    imageDigest: values.targetRuntimeId,
    sourceDigest: values.targetSource,
    sourceDigestDomain: 'runtime',
    operationsDigest: digest('1'),
    timestamps: { startedAt: '2026-08-26T00:00:00Z', finishedAt: '2026-08-26T00:01:00Z' },
    dockerfileSha256: digest('2'),
    dockerignoreSha256: digest('3'),
    sourceRevision: {
      commit: values.targetCommit,
      tree: '4'.repeat(40),
      worktreeStatus: 'tracked-and-index-clean',
      untrackedPolicy: 'only-apps-console-src-features-grafo',
      excludedUntrackedPresent: false,
      buildContext: 'git-archive',
    },
    baseImages: {
      node: base('node', `docker.io/library/node@${digest('5')}`, '5'),
      python: base('python', `docker.io/library/python@${digest('6')}`, '6'),
      nginx: base('nginx', `docker.io/nginxinc/nginx-unprivileged@${digest('7')}`, '7'),
    },
    runtime: {
      tag: '127.0.0.1:5000/cauce/runtime:rc-test',
      imageId: values.targetRuntimeId,
      imageDigest: values.targetRuntimeId,
      repositoryDigest: values.targetRuntime,
      manifestDigest: values.targetRuntime!.split('@')[1]!,
      mediaType,
      platform,
      sourceDigest: values.targetSource,
      sourceDigestDomain: 'runtime',
    },
    console: {
      tag: '127.0.0.1:5000/cauce/console:rc-test',
      imageId: values.targetConsoleId,
      imageDigest: values.targetConsoleId,
      repositoryDigest: values.targetConsole,
      manifestDigest: values.targetConsole!.split('@')[1]!,
      mediaType,
      platform,
      sourceDigest: digest('c'),
      sourceDigestDomain: 'console',
      publishJournalCapability: 'multi-intent-v1',
    },
    runtimePackage: {
      mechanism: 'docker-run-final-image-package-smoke',
      status: 'passed',
      components: [
        'gateway', 'dispatcher', 'relay-worker', 'telegram-bridge', 'shadow-router',
        'terminal-relay', 'outbox-metrics',
      ],
    },
    schemaCompatibility: {
      label: 'io.cauce.schema.compatible-through',
      compatibleThrough: values.targetSchema,
    },
  };
}

async function fixture(realPostgres?: RealPostgres, writerCount = 0): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'cauce-deploy-release-'));
  scratch.push(root);
  const ops = join(root, 'ops');
  const scripts = join(ops, 'scripts');
  const schemas = join(ops, 'schemas');
  const release = join(ops, 'artifacts/release');
  const bin = join(root, 'bin');
  await Promise.all([
    mkdir(scripts, { recursive: true }),
    mkdir(schemas, { recursive: true }),
    mkdir(release, { recursive: true }),
    mkdir(bin, { recursive: true }),
  ]);

  const writerSnapshotContent = `${JSON.stringify({ writersExpectedCandidate: writerCount })}\n`;
  const values = {
    currentRuntime: image('runtime', '1'),
    currentConsole: image('console', '2'),
    targetRuntime: image('runtime', '3'),
    targetConsole: image('console', '4'),
    bridgeRuntime: image('runtime-bridge', 'f'),
    currentRuntimeId: digest('5'),
    currentConsoleId: digest('6'),
    targetRuntimeId: digest('7'),
    targetConsoleId: digest('8'),
    bridgeRuntimeId: digest('f'),
    currentCommit: '9'.repeat(40),
    targetCommit: 'a'.repeat(40),
    currentSource: digest('b'),
    targetSource: digest('c'),
    preTargetSchema,
    targetSchema,
    currentManifest: join(root, 'current.manifest'),
    targetManifest: join(root, 'target.manifest'),
    currentBaseline: join(root, 'current-baseline.json'),
    targetBaseline: join(root, 'target-baseline.json'),
    currentBaselineSha: digest('d'),
    targetBaselineSha: digest('e'),
    bridgeEvidence: join(root, 'rollback-bridge.json'),
    bridgeEvidenceSha: digest('0'),
    currentManifestSha: contentDigest('# current\n'),
    targetManifestSha: contentDigest('# target inactive\n'),
    currentWriterSnapshot: join(root, 'current-writers.json'),
    targetWriterSnapshot: join(root, 'target-writers.json'),
    rotationWriterSnapshot: join(root, 'rotation-writers.json'),
    currentWriterSnapshotSha: contentDigest(writerSnapshotContent),
    targetWriterSnapshotSha: contentDigest(writerSnapshotContent),
  };
  const envFile = join(root, 'prod.env');
  const log = join(root, 'calls.log');
  const state = join(root, 'fake-state.json');
  await Promise.all([
    writeFile(values.currentManifest, '# current\n', { mode: 0o600 }),
    writeFile(values.targetManifest, '# target inactive\n', { mode: 0o600 }),
    writeFile(values.currentBaseline, '{}\n', { mode: 0o600 }),
    writeFile(values.targetBaseline, '{}\n', { mode: 0o600 }),
    writeFile(values.bridgeEvidence, '{}\n', { mode: 0o600 }),
    writeFile(values.currentWriterSnapshot, writerSnapshotContent, { mode: 0o600 }),
    writeFile(values.targetWriterSnapshot, writerSnapshotContent, { mode: 0o600 }),
    writeFile(log, ''),
    writeFile(state, '{}\n'),
    writeFile(join(release, 'build.json'), `${JSON.stringify(buildEvidence(values), null, 2)}\n`),
    writeFile(join(release, 'SHA256SUMS'), 'synthetic\n'),
  ]);
  await writeFile(envFile, [
    'COMPOSE_PROJECT_NAME=cauce-v3-prod',
    'COMPOSE_PROFILES=',
    `CAUCE_RUNTIME_IMAGE=${values.currentRuntime}`,
    `CAUCE_CONSOLE_IMAGE=${values.currentConsole}`,
    `CAUCE_COMPOSE_OVERRIDE_MANIFEST=${values.currentManifest}`,
    `CAUCE_COMPOSE_OVERRIDE_MANIFEST_SHA256=${values.currentManifestSha}`,
    `CAUCE_ROLLBACK_BASELINE_FILE=${values.currentBaseline}`,
    `CAUCE_ROLLBACK_BASELINE_SHA256=${values.currentBaselineSha}`,
    `CAUCE_ROLLBACK_WRITER_SNAPSHOT_FILE=${values.currentWriterSnapshot}`,
    `CAUCE_ROLLBACK_WRITER_SNAPSHOT_SHA256=${values.currentWriterSnapshotSha}`,
    'PRIVATE_PATH=/not/printed',
    '',
  ].join('\n'), { mode: 0o600 });
  const deploySource = await readFile(sourceScript, 'utf8');
  const targetMigrationSql = await readFile(sourceTargetMigration, 'utf8');
  const fixtureDeploySource = deploySource.replace(
    'system_path=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    `system_path=${bin}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
  );
  if (fixtureDeploySource === deploySource) throw new Error('deploy fixture could not inject its fake-bin path');
  await writeFile(
    join(scripts, 'deploy-release.sh'),
    fixtureDeploySource,
  );
  await chmod(join(scripts, 'deploy-release.sh'), 0o755);
  await copyFile(sourceSchema, join(schemas, 'build-evidence.schema.json'));

  await executable(join(scripts, 'pin-production-release.py'), `#!/usr/bin/env node
const fs = require('node:fs');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const args = process.argv.slice(2);
const fixture = ${JSON.stringify(values)};
const state = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8'));
const log = (message) => fs.appendFileSync(${JSON.stringify(log)}, message + '\\n');
const option = (name) => { const index = args.indexOf(name); return index < 0 ? '' : args[index + 1]; };
const parseEnv = (path) => Object.fromEntries(fs.readFileSync(path, 'utf8').split(/\\r?\\n/u).filter(Boolean).filter((line) => line.includes('=')).map((line) => { const index = line.indexOf('='); return [line.slice(0,index), line.slice(index+1)]; }));
const guardedIndex = args.indexOf('guarded-exec');
if (guardedIndex >= 0) {
  const separator = args.indexOf('--', guardedIndex + 1);
  const command = args.slice(separator + 1);
  if (separator < 0 || command.length === 0) process.exit(96);
  log('REMOTE_GUARD_BEGIN');
  const result = cp.spawnSync(command[0], command.slice(1), {
    env: {
      ...process.env,
      CAUCE_WRITER_REMOTE_GUARD_FD: '8',
      CAUCE_WRITER_REMOTE_GUARD_MANAGERS_SHA256: 'a'.repeat(64),
      CAUCE_WRITER_REMOTE_GUARDS: '[]',
    },
    stdio: 'inherit',
  });
  log('REMOTE_GUARD_END status=' + (result.status ?? 1));
  process.exit(result.status ?? 1);
}
if (args[0] === 'locked-exec') {
  const separator = args.indexOf('--');
  const command = args.slice(separator + 1);
  log('LOCKED_BEGIN');
  const result = cp.spawnSync(command[0], command.slice(1), {
    env: { ...process.env, CAUCE_RELEASE_TRANSITION_LOCK_FD: '9', CAUCE_RELEASE_TRANSITION_LOCK_TOKEN: 'f'.repeat(64) },
    stdio: 'inherit',
  });
  log('LOCKED_END status=' + (result.status ?? 1));
  process.exit(result.status ?? 1);
}
const envFile = option('--env-file');
const selected = parseEnv(envFile);
const lock = option('--lock-fd');
log('PIN ' + args[0] + ' lock=' + lock);
if (lock !== '9') process.exit(91);
if (args[0] === 'field') {
  process.stdout.write(selected[option('--name')] + '\\n');
  process.exit(0);
}
if (args[0] === 'manifest') {
  const path = option('--path');
  if (args.includes('--require-selected') && selected.CAUCE_COMPOSE_OVERRIDE_MANIFEST !== path) process.exit(92);
  const observed = 'sha256:' + crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex');
  const expected = option('--expected-sha256');
  if (args.includes('--require-selected') && selected.CAUCE_COMPOSE_OVERRIDE_MANIFEST_SHA256 !== observed) process.exit(94);
  if (args.includes('--require-selected') && expected && selected.CAUCE_COMPOSE_OVERRIDE_MANIFEST_SHA256 !== expected) process.exit(95);
  if (expected && expected !== observed) process.exit(93);
  process.stdout.write(expected ? 'production override manifest passed\\n' : observed + '\\n');
  process.exit(0);
}
if (args[0] === 'check' && state.FAKE_FAIL_STAGE === 'admission') process.exit(41);
const pairs = [
  ['CAUCE_RUNTIME_IMAGE','--expected-runtime-image','--target-runtime-image'],
  ['CAUCE_CONSOLE_IMAGE','--expected-console-image','--target-console-image'],
  ['CAUCE_COMPOSE_OVERRIDE_MANIFEST','--expected-override-manifest','--target-override-manifest'],
  ['CAUCE_COMPOSE_OVERRIDE_MANIFEST_SHA256','--expected-override-manifest-sha256','--target-override-manifest-sha256'],
  ['CAUCE_ROLLBACK_BASELINE_FILE','--expected-rollback-baseline','--target-rollback-baseline'],
  ['CAUCE_ROLLBACK_BASELINE_SHA256','--expected-rollback-baseline-sha256','--target-rollback-baseline-sha256'],
  ['CAUCE_ROLLBACK_WRITER_SNAPSHOT_FILE','--expected-writer-snapshot','--target-writer-snapshot'],
  ['CAUCE_ROLLBACK_WRITER_SNAPSHOT_SHA256','--expected-writer-snapshot-sha256','--target-writer-snapshot-sha256'],
];
for (const [key, expected] of pairs) if (selected[key] !== option(expected)) process.exit(42);
if (args[0] === 'swap') {
  const nextRuntime = option('--target-runtime-image');
  const expectedWriter = option('--expected-writer-snapshot');
  const nextWriter = option('--target-writer-snapshot');
  const rotationForward = expectedWriter === fixture.currentWriterSnapshot &&
    nextWriter === fixture.rotationWriterSnapshot;
  const rotationInverse = expectedWriter === fixture.rotationWriterSnapshot &&
    nextWriter === fixture.currentWriterSnapshot;
  const inverse = nextRuntime === fixture.currentRuntime && !rotationForward;
  const bridge = nextRuntime === fixture.bridgeRuntime;
  if (rotationForward && state.FAKE_FAIL_ROTATION_CAS_BEFORE_WRITE) process.exit(49);
  if ((inverse || bridge) && state.FAKE_FAIL_COMPENSATION === 'selector') process.exit(43);
  const next = { ...selected };
  for (const [key,, target] of pairs) next[key] = option(target);
  if (rotationForward && state.FAKE_PARTIAL_ROTATION_CAS) {
    next.CAUCE_ROLLBACK_WRITER_SNAPSHOT_SHA256 = selected.CAUCE_ROLLBACK_WRITER_SNAPSHOT_SHA256;
  }
  const original = fs.readFileSync(envFile, 'utf8').split(/\\r?\\n/u);
  const output = original.map((line) => {
    const index = line.indexOf('=');
    if (index < 0) return line;
    const key = line.slice(0,index);
    return Object.hasOwn(next,key) ? key + '=' + next[key] : line;
  }).join('\\n');
  fs.writeFileSync(envFile, output);
  log('SWAP ' + (rotationForward ? 'rotation-forward' : rotationInverse ? 'rotation-inverse' :
    inverse ? 'inverse' : bridge ? 'bridge' : 'forward') + ' lock=' + lock);
  if (rotationForward && state.FAKE_PARTIAL_ROTATION_CAS) process.exit(50);
  if (rotationForward && state.FAKE_FAIL_ROTATION_CAS_RESPONSE) process.exit(51);
  if (!inverse && !bridge && state.FAKE_FAIL_FORWARD_SWAP_RESPONSE) process.exit(46);
  if (inverse && state.FAKE_FAIL_INVERSE_SWAP_RESPONSE) process.exit(47);
  if (bridge && state.FAKE_FAIL_BRIDGE_SWAP_RESPONSE) process.exit(48);
}
`);

  await executable(join(scripts, 'rollback-baseline.py'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const fixture = ${JSON.stringify(values)};
const state = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8'));
const option = (name) => { const index = args.indexOf(name); return index < 0 ? '' : args[index + 1]; };
fs.appendFileSync(${JSON.stringify(log)}, 'BASELINE ' + args[0] + ' lock=' + (process.env.CAUCE_RELEASE_TRANSITION_LOCK_FD || '') + '\\n');
const target = option('--baseline') === fixture.targetBaseline;
if (args[0] === 'check') process.exit(state.FAKE_FAIL_STAGE === 'baseline' ? 44 : 0);
const current = {
  'forward-release-commit': fixture.currentCommit,
  'forward-runtime-image': fixture.currentRuntime,
  'forward-runtime-source-digest': fixture.currentSource,
  'bridge-runtime-image': fixture.bridgeRuntime,
  'console-image': fixture.currentConsole,
  'override-manifest': fixture.currentManifest,
  'override-manifest-sha256': fixture.currentManifestSha,
};
const next = {
  'forward-release-commit': fixture.targetCommit,
  'forward-runtime-image': fixture.targetRuntime,
  'forward-runtime-source-digest': fixture.targetSource,
  'bridge-runtime-image': state.FAKE_TARGET_ROLLBACK_RUNTIME || fixture.bridgeRuntime,
  'bridge-runtime-image-id': fixture.bridgeRuntimeId,
  'console-image': state.FAKE_TARGET_ROLLBACK_CONSOLE || fixture.currentConsole,
  'console-image-id': fixture.currentConsoleId,
  'override-manifest': fixture.currentManifest,
  'override-manifest-sha256': fixture.currentManifestSha,
  'bridge-evidence': fixture.bridgeEvidence,
  'bridge-evidence-sha256': fixture.bridgeEvidenceSha,
};
process.stdout.write((target ? next : current)[option('--name')] + '\\n');
`);

  await executable(join(scripts, 'compose-files.sh'), `#!/usr/bin/env node
require('node:fs').appendFileSync(${JSON.stringify(log)}, 'COMPOSE_FILES lock=' + (process.env.CAUCE_RELEASE_TRANSITION_LOCK_FD || '') + '\\n');
`);
  await executable(join(scripts, 'verify-manifest.sh'), `#!/usr/bin/env node
require('node:fs').appendFileSync(${JSON.stringify(log)}, 'VERIFY_MANIFEST lock=' + (process.env.CAUCE_RELEASE_TRANSITION_LOCK_FD || '') + '\\n');
`);
  await executable(join(scripts, 'validate-release-evidence.py'), `#!/usr/bin/env node
require('node:fs').appendFileSync(${JSON.stringify(log)}, 'VALIDATE_RELEASE_EVIDENCE lock=' + (process.env.CAUCE_RELEASE_TRANSITION_LOCK_FD || '') + '\\n');
`);
  await executable(join(scripts, 'release-writer-state.py'), `#!/usr/bin/env node
const fs = require('node:fs');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const args = process.argv.slice(2);
const statePath = ${JSON.stringify(state)};
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const option = (name) => { const index = args.indexOf(name); return index < 0 ? '' : args[index + 1]; };
const guardedIndex = args.indexOf('guarded-exec');
if (guardedIndex >= 0) {
  const separator = args.indexOf('--', guardedIndex + 1);
  const command = args.slice(separator + 1);
  if (separator < 0 || command.length === 0) process.exit(96);
  fs.appendFileSync(${JSON.stringify(log)}, 'REMOTE_GUARD_BEGIN lock=' +
    (process.env.CAUCE_RELEASE_TRANSITION_LOCK_FD || '') + '\\n');
  const result = cp.spawnSync(command[0], command.slice(1), {
    env: {
      ...process.env,
      CAUCE_WRITER_REMOTE_GUARD_FD: '8',
      CAUCE_WRITER_REMOTE_GUARD_MANAGERS_SHA256: 'a'.repeat(64),
      CAUCE_WRITER_REMOTE_GUARDS: '[]',
    },
    stdio: 'inherit',
  });
  fs.appendFileSync(${JSON.stringify(log)}, 'REMOTE_GUARD_END status=' +
    (result.status ?? 1) + '\\n');
  process.exit(result.status ?? 1);
}
const action = args.find((item) => ['capture','publish','rotation-check','compose-model','validate','check','fence','stop','restore','marker','marker-check'].includes(item));
fs.appendFileSync(${JSON.stringify(log)}, 'WRITER ' + action +
  (action === 'marker' || action === 'marker-check'
    ? ' mode=' + option('--mode') + ' expected=' + option('--writers-expected') +
      ' observed=' + option('--writers-observed') : '') +
  ' lock=' + (process.env.CAUCE_RELEASE_TRANSITION_LOCK_FD || '') + '\\n');
if (action === 'compose-model') {
  const model = JSON.parse(fs.readFileSync(0, 'utf8'));
  const roles = {
    migrator: 'migrator', gateway: 'core', dispatcher: 'core', 'outbox-metrics': 'core',
    console: 'console', 'relay-worker': 'writer', 'terminal-relay': 'writer',
    'telegram-bridge': 'writer', 'shadow-router': 'writer', 'shadow-guard': 'writer',
    'otel-collector': 'observability', prometheus: 'observability', alertmanager: 'observability',
    postgres: 'infrastructure',
  };
  for (const name of Object.keys(model.services).sort()) {
    if (!roles[name]) process.exit(81);
    process.stdout.write(roles[name] + '\\t' + name + '\\t' + model.services[name].image + '\\n');
  }
  process.exit(0);
}
if (action === 'capture') {
  const composeWriters = args.filter((item, index) => index > 0 && args[index - 1] === '--compose-writer');
  const body = { composeWriters, writersExpectedCandidate: ${writerCount + 1}, zeusActive: true };
  process.stdout.write(JSON.stringify(body) + '\\n');
  process.exit(0);
}
if (action === 'publish') {
  const body = fs.readFileSync(0);
  const destination = option('--path');
  if (fs.existsSync(destination)) {
    if (!args.includes('--allow-identical') || !fs.readFileSync(destination).equals(body)) process.exit(89);
  } else {
    fs.writeFileSync(destination, body, { mode: 0o600 });
  }
  process.stdout.write('sha256:' + crypto.createHash('sha256').update(body).digest('hex') + '\\n');
  process.exit(0);
}
if (action === 'rotation-check') {
  if (state.FAKE_OTHER_ACTIVE_SET_DRIFT || state.FAKE_ZEUS_INACTIVE) process.exit(90);
  process.exit(0);
}
if (action === 'validate') {
  const body = fs.readFileSync(option('--snapshot'));
  const observed = 'sha256:' + crypto.createHash('sha256').update(body).digest('hex');
  process.exit(observed === option('--expected-sha256') ? 0 : 82);
}
if (action === 'marker') {
  if (option('--snapshot') === ${JSON.stringify(values.rotationWriterSnapshot)} &&
      state.FAKE_FAIL_ROTATION_MARKER) process.exit(91);
  const body = JSON.stringify({
    kind: 'cauce-v3-release-state', mode: option('--mode'), releaseId: option('--release-id'),
    schemaVersion: 1, snapshotPath: option('--snapshot'),
    snapshotSha256: option('--expected-sha256'), updatedAt: '2026-08-26T00:00:00Z',
    writersExpected: Number(option('--writers-expected')),
    writersObserved: Number(option('--writers-observed')),
  }) + '\\n';
  const markerPath = option('--path');
  if (fs.existsSync(markerPath)) fs.chmodSync(markerPath, 0o600);
  fs.writeFileSync(markerPath, body, { mode: 0o600 });
  fs.chmodSync(markerPath, 0o444);
}
if (action === 'marker-check' && option('--snapshot') === ${JSON.stringify(values.rotationWriterSnapshot)} &&
    !fs.existsSync(option('--path'))) process.exit(92);
if ((action === 'fence' || action === 'stop') && !state.FAKE_STOP_UNIT_FAILURE) state.WRITERS_STOPPED = true;
if (action === 'restore' && !state.FAKE_RESTORE_UNIT_FAILURE) state.WRITERS_STOPPED = false;
if (action === 'fence' || action === 'stop' || action === 'restore') fs.writeFileSync(statePath, JSON.stringify(state));
if ((action === 'fence' || action === 'stop') && (state.FAKE_STOP_UNIT_FAILURE || state.FAKE_LOST_STOP_RESPONSE)) process.exit(84);
if (action === 'restore' && (state.FAKE_RESTORE_UNIT_FAILURE || state.FAKE_LOST_RESTORE_RESPONSE)) process.exit(85);
if (action === 'check') {
  const mode = option('--mode');
  if (state.FAKE_FAIL_WRITER_CHECK) process.exit(83);
  if (mode === 'restored' && option('--snapshot') === ${JSON.stringify(values.currentWriterSnapshot)} &&
      state.ZEUS_ACTIVE) process.exit(93);
  if ((mode === 'fenced' || mode === 'stopped') && state.FAKE_FAIL_STOPPED_CHECK) process.exit(88);
  if ((mode === 'fenced' || mode === 'stopped') && !state.WRITERS_STOPPED) process.exit(86);
  if ((mode === 'captured' || mode === 'restored') && state.WRITERS_STOPPED) process.exit(87);
}
`);

  await executable(join(scripts, 'compose.sh'), `#!/usr/bin/env node
const fs = require('node:fs');
const cp = require('node:child_process');
const args = process.argv.slice(2);
const fixture = ${JSON.stringify(values)};
const postgres = ${JSON.stringify(realPostgres ?? null)};
const targetMigrationSql = ${JSON.stringify(targetMigrationSql)};
const statePath = ${JSON.stringify(state)};
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const hasFragmentedServices = Boolean(state.FAKE_FRAGMENTED_SERVICE || state.FAKE_FRAGMENTED_SERVICES);
const selected = Object.fromEntries(fs.readFileSync(process.env.CAUCE_ENV_FILE, 'utf8').split(/\\r?\\n/u).filter((line) => line.includes('=')).map((line) => { const i=line.indexOf('='); return [line.slice(0,i),line.slice(i+1)]; }));
const runtime = process.env.CAUCE_RUNTIME_IMAGE || selected.CAUCE_RUNTIME_IMAGE;
const consoleImage = process.env.CAUCE_CONSOLE_IMAGE || selected.CAUCE_CONSOLE_IMAGE;
const isTarget = runtime === fixture.targetRuntime;
const isBridge = runtime === fixture.bridgeRuntime;
const releaseState = isTarget ? 'target' : isBridge ? 'bridge' : 'current';
const lock = process.env.CAUCE_RELEASE_TRANSITION_LOCK_FD || '';
const psql = (sql, tuples = false) => cp.execFileSync('/usr/local/bin/docker', [
  'exec', postgres.containerId, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', postgres.user,
  '-d', postgres.database, ...(tuples ? ['-At'] : []), '-c', sql,
], { encoding: 'utf8' });
fs.appendFileSync(${JSON.stringify(log)}, 'COMPOSE ' + args.join(' ') + ' state=' + releaseState + ' lock=' + lock +
  ' project=' + (process.env.COMPOSE_PROJECT_NAME || '') + ' profiles=' + (process.env.COMPOSE_PROFILES || '') +
  ' dockerHost=' + (process.env.DOCKER_HOST || '') + ' dockerContext=' + (process.env.DOCKER_CONTEXT || '') +
  ' poisonInterpolation=' + (process.env.PRIVATE_PATH || '') + '\\n');
if (args.includes('config') && args.includes('--hash')) {
  const fragmentOverride = args.includes('-f') && args[args.indexOf('-f') + 1] === '-';
  const configuredHash = fragmentOverride && state.FAKE_FRAGMENT_CONFIG_HASH
    ? state.FAKE_FRAGMENT_CONFIG_HASH : 'a'.repeat(64);
  process.stdout.write(args.at(-1) + ' ' + configuredHash + '\\n');
  process.exit(0);
}
if (args.includes('config') && args.includes('--quiet')) process.exit(0);
if (args.includes('config') && args.includes('json')) {
  const service = (image) => ({ image });
  const services = {
    migrator: service(runtime), gateway: service(runtime), dispatcher: service(runtime),
    'outbox-metrics': service(runtime), console: service(consoleImage),
  };
  if (state.FAKE_WITH_WRITERS) {
    services['relay-worker'] = service(runtime);
    services['terminal-relay'] = service(runtime);
  }
  process.stdout.write(JSON.stringify({ services }));
  process.exit(0);
}
if (args[1] === 'ps' && args.includes('--services')) {
  let services = ['gateway', 'dispatcher', 'outbox-metrics', 'console'];
  if (state.FAKE_WITH_WRITERS) services.push('relay-worker', 'terminal-relay');
  if (state.FAKE_WRITERS_ABSENT && !args.includes('--status')) {
    services = services.filter((item) => !['relay-worker', 'terminal-relay'].includes(item));
  }
  if (state.FAKE_DISPATCHER_ABSENT && !args.includes('--status')) {
    services = services.filter((item) => item !== 'dispatcher');
  }
  if (state.COMPOSE_WRITERS_STOPPED && args.includes('--status')) {
    services = services.filter((item) => !['relay-worker', 'terminal-relay'].includes(item));
  }
  if (state.DISPATCHER_STOPPED && args.includes('--status')) {
    services = services.filter((item) => item !== 'dispatcher');
  }
  if (state.RELEASE_PLANE_STOPPED && args.includes('--status')) {
    services = services.filter((item) => !['gateway', 'outbox-metrics', 'console'].includes(item));
  }
  if (state.FAKE_STOPPED_SERVICE && args.includes('--status')) services = services.filter((item) => item !== state.FAKE_STOPPED_SERVICE);
  if (state.FAKE_EXTRA_SERVICE) services.push(state.FAKE_EXTRA_SERVICE);
  process.stdout.write(services.join('\\n') + '\\n');
  process.exit(0);
}
if (args[1] === 'ps' && args.includes('-q')) {
  if (state.FAKE_DISPATCHER_ABSENT && args.at(-1) === 'dispatcher') process.exit(0);
  if (state.FAKE_WRITERS_ABSENT && ['relay-worker', 'terminal-relay'].includes(args.at(-1))) {
    process.exit(0);
  }
  if (state.FAKE_FRAGMENT_CONTAINER_DRIFT_AFTER && args.at(-1) === 'dispatcher') {
    state.FRAGMENT_DISPATCHER_CONTAINER_READS = (state.FRAGMENT_DISPATCHER_CONTAINER_READS || 0) + 1;
    fs.writeFileSync(statePath, JSON.stringify(state));
    if (state.FRAGMENT_DISPATCHER_CONTAINER_READS > Number(state.FAKE_FRAGMENT_CONTAINER_DRIFT_AFTER)) {
      process.stdout.write('cid-drifted-dispatcher\\n');
      process.exit(0);
    }
  }
  process.stdout.write('cid-' + args.at(-1) + '\\n');
  process.exit(0);
}
if (args[1] === 'run' && args.includes('deploy/fleet-snapshot.mjs')) {
  const leases = state.FAKE_EXTERNAL_WRITER ? [{ tenant_id: 'Steven', alias: 'kant', active: !state.WRITERS_STOPPED }] : [];
  if (state.ZEUS_ACTIVE) leases.push({ tenant_id: 'Steven', alias: 'zeus', active: true });
  process.stdout.write(JSON.stringify({ schemaVersion: 3, leases }) + '\\n');
  process.exit(0);
}
if (args[1] === 'exec') {
  if (args.includes('dispatcher') && state.DISPATCHER_STOPPED) process.exit(91);
  if (args.includes('outbox-metrics') && args.includes('-e')) {
    const rotation = process.env.CAUCE_ROLLBACK_WRITER_SNAPSHOT_FILE === fixture.rotationWriterSnapshot;
    const count = rotation ? ${writerCount + 1} : ${writerCount};
    const active = isBridge ? (state.DISPATCHER_STOPPED ? 0 : 1) : count;
    process.stdout.write('cauce_release_rollback_bridge_degraded ' + (isBridge ? '1' : '0') +
      '\\ncauce_release_writers_expected ' + (isBridge ? '0' : count) +
      '\\ncauce_release_writers_declared ' + (isBridge ? '0' : count) +
      '\\ncauce_release_writer_leases_active ' + active +
      (state.FAKE_DUPLICATE_ROTATION_METRICS
        ? '\\ncauce_release_writers_expected 999'
        : '') + '\\n');
  }
  process.exit(0);
}
if (args[1] === 'run' && args.includes('deploy/schema-version.mjs')) {
  if (postgres) {
    process.stdout.write(psql('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1', true));
    process.exit(0);
  }
  const refreshed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  process.stdout.write((refreshed.DATABASE_SCHEMA || fixture.preTargetSchema) + '\\n');
  process.exit(refreshed.FAKE_FAIL_SCHEMA_PROBE ||
    (refreshed.FAKE_FAIL_SCHEMA_PROBE_AFTER_MIGRATOR && refreshed.MIGRATOR_ATTEMPTED) ? 54 : 0);
}
if (args[1] === 'run' && args.includes('deploy/migration-integrity.mjs')) {
  if (args.includes('pre') && state.FAKE_SIGNAL_DURING_PREFLIGHT) {
    process.kill(process.ppid, 'SIGTERM');
  }
  if (postgres) psql('SELECT count(*) FROM schema_migrations');
  process.exit(0);
}
if (args[1] === 'run' && isTarget) {
  if (postgres) {
    psql("BEGIN;\\n" + targetMigrationSql + "\\nINSERT INTO schema_migrations(version) VALUES ('" + fixture.targetSchema + "') ON CONFLICT DO NOTHING;\\nCOMMIT;");
    if (state.FAKE_FAIL_STAGE === 'migrator') process.exit(51);
    process.exit(0);
  }
  if (state.FAKE_MIGRATOR_COMMITTED) {
    state.DATABASE_SCHEMA = fixture.targetSchema;
    fs.writeFileSync(statePath, JSON.stringify(state));
  }
  if (state.FAKE_FAIL_STAGE === 'migrator') {
    state.MIGRATOR_ATTEMPTED = true;
    fs.writeFileSync(statePath, JSON.stringify(state));
    process.exit(51);
  }
  state.DATABASE_SCHEMA = fixture.targetSchema;
  fs.writeFileSync(statePath, JSON.stringify(state));
}
if (args.includes('up')) {
  const fragmentOverride = args.includes('-f') && args[args.indexOf('-f') + 1] === '-';
  if (fragmentOverride && hasFragmentedServices) {
    state.FRAGMENT_NORMALIZED = false;
    fs.writeFileSync(statePath, JSON.stringify(state));
    if (state.FAKE_FAIL_FRAGMENT_RESTORE) process.exit(56);
  } else if (!isTarget && !isBridge && hasFragmentedServices) {
    state.FRAGMENT_NORMALIZED = true;
    state.NORMALIZED_CONFIG_IMAGE_CHECKS = 0;
    if (state.FAKE_TAMPER_FRAGMENT_BEFORE_COMPENSATION && state.CAUCE_DEPLOY_LEGACY_SNAPSHOT_FILE) {
      fs.appendFileSync(state.CAUCE_DEPLOY_LEGACY_SNAPSHOT_FILE, 'tampered-after-publication\\n');
    }
    fs.writeFileSync(statePath, JSON.stringify(state));
    if (state.FAKE_FAIL_NORMALIZATION) process.exit(55);
  }
  if (isTarget && state.FAKE_FAIL_STAGE === 'recreate') process.exit(52);
  if (!isTarget && state.FAKE_FAIL_COMPENSATION === 'services') process.exit(53);
  if (args.some((item) => ['relay-worker', 'terminal-relay'].includes(item)) ||
      (state.FAKE_WITH_WRITERS && !args.includes('--no-deps'))) {
    state.COMPOSE_WRITERS_STOPPED = false;
    state.FAKE_WRITERS_ABSENT = false;
  }
  if (args.includes('dispatcher')) {
    state.DISPATCHER_STOPPED = false;
    state.FAKE_DISPATCHER_ABSENT = false;
  }
  if (args.some((item) => ['gateway', 'outbox-metrics', 'console'].includes(item))) {
    state.RELEASE_PLANE_STOPPED = false;
  }
  fs.writeFileSync(statePath, JSON.stringify(state));
}
if (args.includes('stop')) {
  if (args.some((item) => ['gateway', 'outbox-metrics', 'console'].includes(item))) {
    if (!state.FAKE_STOP_RELEASE_PLANE_FAILURE) state.RELEASE_PLANE_STOPPED = true;
    fs.writeFileSync(statePath, JSON.stringify(state));
    if (state.FAKE_STOP_RELEASE_PLANE_FAILURE) process.exit(58);
  }
  if (args.includes('dispatcher')) {
    if (!state.FAKE_STOP_RELEASE_PLANE_FAILURE) state.DISPATCHER_STOPPED = true;
    fs.writeFileSync(statePath, JSON.stringify(state));
    if (state.FAKE_STOP_RELEASE_PLANE_FAILURE) process.exit(58);
  }
  if (args.some((item) => ['relay-worker', 'terminal-relay'].includes(item))) {
    if (!state.FAKE_STOP_COMPOSE_FAILURE) state.COMPOSE_WRITERS_STOPPED = true;
    fs.writeFileSync(statePath, JSON.stringify(state));
    if (state.FAKE_STOP_COMPOSE_FAILURE) process.exit(57);
  }
}
if (args[1] === 'rm') {
  if (args.includes('dispatcher')) {
    state.DISPATCHER_STOPPED = true;
    state.FAKE_DISPATCHER_ABSENT = true;
  }
  if (args.some((item) => ['relay-worker', 'terminal-relay'].includes(item))) {
    state.COMPOSE_WRITERS_STOPPED = true;
    state.FAKE_WRITERS_ABSENT = true;
  }
  fs.writeFileSync(statePath, JSON.stringify(state));
}
`);

  await executable(join(scripts, 'stack-health.sh'), `#!/usr/bin/env node
const fs = require('node:fs');
const fixture = ${JSON.stringify(values)};
const state = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8'));
const selected = Object.fromEntries(fs.readFileSync(process.env.CAUCE_ENV_FILE, 'utf8').split(/\\r?\\n/u).filter((line) => line.includes('=')).map((line) => { const i=line.indexOf('='); return [line.slice(0,i),line.slice(i+1)]; }));
const target = selected.CAUCE_RUNTIME_IMAGE === fixture.targetRuntime;
const bridge = selected.CAUCE_RUNTIME_IMAGE === fixture.bridgeRuntime;
fs.appendFileSync(${JSON.stringify(log)}, 'HEALTH state=' + (target ? 'target' : bridge ? 'bridge' : 'current') + ' lock=' + (process.env.CAUCE_RELEASE_TRANSITION_LOCK_FD || '') + ' args=' + process.argv.slice(2).join(' ') + '\\n');
if (target && state.FAKE_FAIL_STAGE === 'health') process.exit(61);
`);
  await executable(join(scripts, 'release-gate.sh'), `#!/usr/bin/env node
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8'));
fs.appendFileSync(${JSON.stringify(log)}, 'RELEASE_GATE lock=' + (process.env.CAUCE_RELEASE_TRANSITION_LOCK_FD || '') +
  ' change=' + (process.env.CAUCE_CHANGE_ID || '') + ' confirm=' + (process.env.CAUCE_MAINTENANCE_CONFIRM || '') +
  ' args=' + process.argv.slice(2).join(' ') + '\\n');
if (state.FAKE_FAIL_STAGE === 'maintenance-release-gate') process.exit(62);
`);
  await executable(join(scripts, 'release-candidate.py'), `#!/usr/bin/env node
const fs = require('node:fs');
const fixture = ${JSON.stringify(values)};
const state = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8'));
const args = process.argv.slice(2);
const selected = Object.fromEntries(fs.readFileSync(process.env.CAUCE_ENV_FILE, 'utf8').split(/\\r?\\n/u).filter((line) => line.includes('=')).map((line) => { const i=line.indexOf('='); return [line.slice(0,i),line.slice(i+1)]; }));
fs.appendFileSync(${JSON.stringify(log)}, 'RELEASE_CANDIDATE lock=' + (process.env.CAUCE_RELEASE_TRANSITION_LOCK_FD || '') + ' args=' + args.join(' ') + '\\n');
if (args.includes('--release-host-ready') && state.ZEUS_ACTIVE &&
    selected.CAUCE_ROLLBACK_WRITER_SNAPSHOT_FILE === fixture.currentWriterSnapshot) process.exit(64);
if (args.includes('--release-host-ready') && state.FAKE_FAIL_STAGE === 'release-host-ready') process.exit(63);
`);

  await executable(join(bin, 'docker'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const fixture = ${JSON.stringify(values)};
const state = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8'));
const fragmentedServices = String(state.FAKE_FRAGMENTED_SERVICES || state.FAKE_FRAGMENTED_SERVICE || '')
  .split(',').filter(Boolean);
const selected = Object.fromEntries(fs.readFileSync(process.env.CAUCE_ENV_FILE, 'utf8').split(/\\r?\\n/u).filter((line) => line.includes('=')).map((line) => { const i=line.indexOf('='); return [line.slice(0,i),line.slice(i+1)]; }));
const id = (reference) => {
  if (reference === fixture.currentRuntime) return fixture.currentRuntimeId;
  if (reference === fixture.currentConsole) return fixture.currentConsoleId;
  if (reference === fixture.targetRuntime) return fixture.targetRuntimeId;
  if (reference === fixture.targetConsole) return fixture.targetConsoleId;
  if (reference === fixture.bridgeRuntime) return fixture.bridgeRuntimeId;
  return '';
};
fs.appendFileSync(${JSON.stringify(log)}, 'DOCKER ' + args.join(' ') + ' lock=' + (process.env.CAUCE_RELEASE_TRANSITION_LOCK_FD || '') +
  ' host=' + (process.env.DOCKER_HOST || '') + ' context=' + (process.env.DOCKER_CONTEXT || '') + '\\n');
if (args[0] === 'pull') {
  const reference = args.at(-1);
  state.PULL_COUNTS = state.PULL_COUNTS || {};
  state.PULL_COUNTS[reference] = (state.PULL_COUNTS[reference] || 0) + 1;
  fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(state));
  if (state.FAKE_FAIL_FRAGMENT_PULL && reference === fixture.targetRuntime && state.PULL_COUNTS[reference] > 1) process.exit(64);
  process.exit(0);
}
if (args[0] === 'image' && args[1] === 'inspect') {
  const reference = args.at(-1);
  const format = args[3];
  if (format.includes('{{json .}}')) {
    const runtime = reference === fixture.targetRuntime || reference === fixture.bridgeRuntime;
    const bases = {
      node: 'docker.io/library/node@' + '${digest('5')}',
      python: 'docker.io/library/python@' + '${digest('6')}',
      nginx: 'docker.io/nginxinc/nginx-unprivileged@' + '${digest('7')}',
    };
    const labels = runtime ? {
      'io.cauce.source.digest': fixture.targetSource,
      'org.opencontainers.image.revision': fixture.targetCommit,
      'io.cauce.target-platform': 'linux/amd64',
      'org.opencontainers.image.base.name': bases.node,
      'io.cauce.base.node.repository-digest': bases.node,
      'io.cauce.base.python.repository-digest': bases.python,
      'io.cauce.schema.compatible-through': reference === fixture.bridgeRuntime && state.FAKE_BRIDGE_SCHEMA
        ? state.FAKE_BRIDGE_SCHEMA : fixture.targetSchema,
      ...(reference === fixture.bridgeRuntime
        ? { 'io.cauce.rollback-bridge.read-only': 'server-v2' } : {}),
    } : {
      'io.cauce.source.digest': '${digest('c')}',
      'org.opencontainers.image.revision': fixture.targetCommit,
      'io.cauce.target-platform': 'linux/amd64',
      'org.opencontainers.image.base.name': bases.nginx,
      'io.cauce.base.nginx.repository-digest': bases.nginx,
      'io.cauce.console.publish-journal': 'multi-intent-v1',
    };
    process.stdout.write(JSON.stringify({
      Id: id(reference), Os: 'linux', Architecture: 'amd64', RepoDigests: [reference],
      Descriptor: { digest: reference.split('@')[1], mediaType: 'application/vnd.oci.image.manifest.v1+json' },
      Config: { Labels: labels },
    }) + '\\n');
  } else if (format.includes('.Id')) process.stdout.write(id(reference) + '\\n');
  else process.stdout.write(reference + '\\n');
  process.exit(0);
}
if (args[0] === 'inspect') {
  const service = args.at(-1).slice(4);
  if (args[2].includes('.State.Running')) {
    const stopped = (state.COMPOSE_WRITERS_STOPPED && ['relay-worker', 'terminal-relay'].includes(service))
      || (state.DISPATCHER_STOPPED && service === 'dispatcher')
      || (state.RELEASE_PLANE_STOPPED && ['gateway', 'outbox-metrics', 'console'].includes(service));
    process.stdout.write(stopped ? 'false 0\\n' : 'true 1234\\n');
    process.exit(0);
  }
  let reference = service === 'console' ? selected.CAUCE_CONSOLE_IMAGE : selected.CAUCE_RUNTIME_IMAGE;
  if (fragmentedServices.includes(service) && !state.FRAGMENT_NORMALIZED) {
    reference = service === 'console' ? fixture.targetConsole : fixture.targetRuntime;
  }
  if (args[2].includes('config-hash')) {
    process.stdout.write((state.FAKE_RUNNING_CONFIG_HASH || 'a'.repeat(64)) + '\\n');
  } else if (args[2].includes('.Config.Image')) {
    if (state.FRAGMENT_NORMALIZED && state.FAKE_DRIFT_AFTER_NORMALIZE) {
      state.NORMALIZED_CONFIG_IMAGE_CHECKS = (state.NORMALIZED_CONFIG_IMAGE_CHECKS || 0) + 1;
      fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(state));
      if (state.NORMALIZED_CONFIG_IMAGE_CHECKS > 4) reference = fixture.targetRuntime;
    }
    process.stdout.write(reference + '\\n');
  } else process.stdout.write(id(reference) + '\\n');
  process.exit(0);
}
process.exit(90);
`);
  await executable(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n');

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
    CAUCE_ENV_FILE: envFile,
    CAUCE_DEPLOY_TARGET_OVERRIDE_MANIFEST: values.targetManifest,
    CAUCE_DEPLOY_TARGET_OVERRIDE_MANIFEST_SHA256: values.targetManifestSha,
    CAUCE_DEPLOY_TARGET_ROLLBACK_BASELINE_FILE: values.targetBaseline,
    CAUCE_DEPLOY_TARGET_ROLLBACK_BASELINE_SHA256: values.targetBaselineSha,
    CAUCE_DEPLOY_TARGET_WRITER_SNAPSHOT_FILE: values.targetWriterSnapshot,
    CAUCE_DEPLOY_TARGET_WRITER_SNAPSHOT_SHA256: values.targetWriterSnapshotSha,
  };
  return { root, script: join(scripts, 'deploy-release.sh'), envFile, log, state, env, values };
}

function run(
  value: Fixture,
  action: string,
  environment: NodeJS.ProcessEnv = {},
): SpawnSyncReturns<string> {
  writeFileSync(value.state, `${JSON.stringify(environment)}\n`);
  return spawnSync(value.script, [action], {
    encoding: 'utf8',
    env: { ...value.env, ...environment },
  });
}

async function confirmation(value: Fixture, environment: NodeJS.ProcessEnv = {}): Promise<string> {
  const result = run(value, 'preflight', environment);
  const [calls, state] = await Promise.all([
    readFile(value.log, 'utf8'),
    readFile(value.state, 'utf8'),
  ]);
  expect(result.status, `${result.stdout}\n${result.stderr}\nstate=${state}\ncalls=${calls}`).toBe(0);
  const match = /CAUCE_DEPLOY_CONFIRM=(deploy-release:sha256:[a-f0-9]{64})/u.exec(result.stdout);
  expect(match).not.toBeNull();
  return match?.[1] ?? '';
}

function writerRotationEnvironment(
  value: Fixture,
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const changeId = 'CHG-ZEUS-ACTIVE-TEST';
  return {
    ZEUS_ACTIVE: '1',
    CAUCE_CHANGE_ID: changeId,
    CAUCE_WRITER_ROTATION_FILE: value.values.rotationWriterSnapshot,
    CAUCE_WRITER_ROTATION_CONFIRM: `active:Steven:zeus:${changeId}`,
    ...overrides,
  };
}

describe('canonical forward release transaction', () => {
  test('preflight is read-only and binds the exact transition confirmation', async () => {
    const value = await fixture();
    const before = await readFile(value.envFile, 'utf8');
    const result = run(value, 'preflight');
    const calls = await readFile(value.log, 'utf8');

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/CAUCE_DEPLOY_CONFIRM=deploy-release:sha256:[a-f0-9]{64}/u);
    expect(await readFile(value.envFile, 'utf8')).toBe(before);
    expect(calls).not.toContain('SWAP ');
    expect(calls).not.toContain('DOCKER pull');
    expect(calls).not.toMatch(/COMPOSE prod run --rm --no-deps -T migrator state=/u);
    expect(calls).not.toContain('COMPOSE prod up');
  });

  test('success keeps one lock through CAS, migrator, recreation, health and release-host-ready', async () => {
    const value = await fixture();
    const token = await confirmation(value);
    await writeFile(value.log, '');
    const result = run(value, 'deploy', { CAUCE_DEPLOY_CONFIRM: token });
    const calls = await readFile(value.log, 'utf8');
    const selected = await readFile(value.envFile, 'utf8');

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('strict release-host-ready evidence');
    expect(selected).toContain(`CAUCE_RUNTIME_IMAGE=${value.values.targetRuntime}`);
    expect(selected).toContain(`CAUCE_CONSOLE_IMAGE=${value.values.targetConsole}`);
    expect(selected).toContain(`CAUCE_COMPOSE_OVERRIDE_MANIFEST_SHA256=${value.values.targetManifestSha}`);
    expect(calls).toMatch(/LOCKED_BEGIN[\s\S]*SWAP forward lock=9[\s\S]*COMPOSE prod run --rm --no-deps -T migrator state=target lock=9[\s\S]*COMPOSE prod up[\s\S]*HEALTH state=target lock=9[\s\S]*RELEASE_CANDIDATE lock=9 args=--release-host-ready[\s\S]*LOCKED_END status=0/u);
    const ingressStop = calls.indexOf('COMPOSE prod stop --timeout 45 console dispatcher gateway outbox-metrics');
    const databasePreflight = calls.indexOf('deploy/migration-integrity.mjs pre');
    const selectorCas = calls.indexOf('SWAP forward lock=9');
    expect(ingressStop).toBeGreaterThanOrEqual(0);
    expect(databasePreflight).toBeGreaterThan(ingressStop);
    expect(selectorCas).toBeGreaterThan(databasePreflight);
    expect(result.stderr).toMatch(/release mutation gate CLOSED[\s\S]*release GO BEGIN[\s\S]*release GO COMMITTED/u);
    expect(calls).not.toMatch(/DOCKER tag/u);
    expect(calls).toContain(`DOCKER pull ${value.values.targetRuntime} lock=9`);
    expect(calls).toContain(`DOCKER pull ${value.values.targetConsole} lock=9`);
  });

  test('admission failure happens before CAS and leaves the old selectors untouched', async () => {
    const value = await fixture();
    const token = await confirmation(value);
    await writeFile(value.log, '');
    const before = await readFile(value.envFile, 'utf8');
    const result = run(value, 'deploy', { CAUCE_DEPLOY_CONFIRM: token, FAKE_FAIL_STAGE: 'admission' });
    const calls = await readFile(value.log, 'utf8');

    expect(result.status).not.toBe(0);
    expect(await readFile(value.envFile, 'utf8')).toBe(before);
    expect(calls).not.toContain('SWAP forward');
    expect(calls).not.toMatch(/COMPOSE prod run --rm --no-deps -T migrator state=/u);
  });

  test('migrator transaction failure restores exact expected-old selectors and services', async () => {
    const value = await fixture();
    const token = await confirmation(value);
    await writeFile(value.log, '');
    const before = await readFile(value.envFile, 'utf8');
    const result = run(value, 'deploy', { CAUCE_DEPLOY_CONFIRM: token, FAKE_FAIL_STAGE: 'migrator' });
    const calls = await readFile(value.log, 'utf8');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('failed safely before durable migration');
    expect(await readFile(value.envFile, 'utf8')).toBe(before);
    expect(calls).toMatch(/SWAP forward lock=9[\s\S]*SWAP inverse lock=9[\s\S]*COMPOSE prod up[\s\S]*state=current lock=9[\s\S]*HEALTH state=current lock=9/u);
  });

  test.each(['recreate', 'health', 'release-host-ready'])(
    '%s failure after migration selects the accredited bridge and prior console/manifest',
    async (stage) => {
      const value = await fixture();
      const token = await confirmation(value);
      await writeFile(value.log, '');
      const result = run(value, 'deploy', { CAUCE_DEPLOY_CONFIRM: token, FAKE_FAIL_STAGE: stage });
      const calls = await readFile(value.log, 'utf8');
      const selected = await readFile(value.envFile, 'utf8');

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('failed safely after durable migration: accredited target-schema bridge');
      expect(selected).toContain(`CAUCE_RUNTIME_IMAGE=${value.values.bridgeRuntime}`);
      expect(selected).toContain(`CAUCE_CONSOLE_IMAGE=${value.values.currentConsole}`);
      expect(selected).toContain(`CAUCE_COMPOSE_OVERRIDE_MANIFEST=${value.values.currentManifest}`);
      expect(selected).toContain(`CAUCE_COMPOSE_OVERRIDE_MANIFEST_SHA256=${value.values.currentManifestSha}`);
      expect(selected).toContain(`CAUCE_ROLLBACK_BASELINE_FILE=${value.values.targetBaseline}`);
      expect(calls).toMatch(/SWAP forward lock=9[\s\S]*SWAP bridge lock=9[\s\S]*WRITER marker mode=rollback_bridge_degraded expected=0 observed=0 lock=9[\s\S]*COMPOSE prod up[\s\S]*state=bridge lock=9[\s\S]*COMPOSE prod exec -T outbox-metrics[\s\S]*state=bridge lock=9/u);
      const bridgeUp = calls.split('\n').find((line) =>
        line.includes('COMPOSE prod up') && line.includes('state=bridge'));
      expect(bridgeUp).toBeDefined();
      expect(bridgeUp).not.toContain('dispatcher');
      expect(calls).not.toContain('COMPOSE prod exec -T dispatcher');
      const finalState = JSON.parse(await readFile(value.state, 'utf8')) as {
        DISPATCHER_STOPPED?: boolean;
      };
      expect(finalState.DISPATCHER_STOPPED).toBe(true);
    },
  );

  test('a lost migrator response after durable commit probes schema and selects the bridge', async () => {
    const value = await fixture();
    const token = await confirmation(value);
    const result = run(value, 'deploy', {
      CAUCE_DEPLOY_CONFIRM: token,
      FAKE_FAIL_STAGE: 'migrator',
      FAKE_MIGRATOR_COMMITTED: '1',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('accredited target-schema bridge');
    expect(await readFile(value.envFile, 'utf8')).toContain(
      `CAUCE_RUNTIME_IMAGE=${value.values.bridgeRuntime}`,
    );
  });

  test('lost inverse-CAS response verifies durable old selectors before restoring services', async () => {
    const value = await fixture();
    const token = await confirmation(value);
    const before = await readFile(value.envFile, 'utf8');
    const result = run(value, 'deploy', {
      CAUCE_DEPLOY_CONFIRM: token,
      FAKE_FAIL_STAGE: 'migrator',
      FAKE_FAIL_INVERSE_SWAP_RESPONSE: '1',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('lost inverse-CAS response');
    expect(result.stderr).toContain('failed safely before durable migration');
    expect(await readFile(value.envFile, 'utf8')).toBe(before);
  });

  test('lost bridge-CAS response verifies durable bridge selectors and completes compensation', async () => {
    const value = await fixture();
    const token = await confirmation(value);
    const result = run(value, 'deploy', {
      CAUCE_DEPLOY_CONFIRM: token,
      FAKE_FAIL_STAGE: 'health',
      FAKE_FAIL_BRIDGE_SWAP_RESPONSE: '1',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('lost bridge-CAS response');
    expect(result.stderr).toContain('accredited target-schema bridge');
    expect(await readFile(value.envFile, 'utf8')).toContain(
      `CAUCE_RUNTIME_IMAGE=${value.values.bridgeRuntime}`,
    );
  });

  test('an unmeasurable migrator outcome refuses automatic compensation loudly', async () => {
    const value = await fixture();
    const token = await confirmation(value);
    const result = run(value, 'deploy', {
      CAUCE_DEPLOY_CONFIRM: token,
      FAKE_FAIL_STAGE: 'migrator',
      FAKE_FAIL_SCHEMA_PROBE_AFTER_MIGRATOR: '1',
    });
    const calls = await readFile(value.log, 'utf8');

    expect(result.status).toBe(72);
    expect(result.stderr).toContain('migration outcome is ambiguous');
    expect(await readFile(value.envFile, 'utf8')).toContain(
      `CAUCE_RUNTIME_IMAGE=${value.values.targetRuntime}`,
    );
    expect(calls).not.toContain('SWAP inverse');
    expect(calls).not.toContain('SWAP bridge');
  });

  test('selector compensation failure is loud and leaves an unmistakable exit code', async () => {
    const value = await fixture();
    const token = await confirmation(value);
    const result = run(value, 'deploy', {
      CAUCE_DEPLOY_CONFIRM: token,
      FAKE_FAIL_STAGE: 'health',
      FAKE_FAIL_COMPENSATION: 'selector',
    });

    expect(result.status).toBe(70);
    expect(result.stderr).toContain('CRITICAL: post-migration compensation could not select');
    expect(await readFile(value.envFile, 'utf8')).toContain(`CAUCE_RUNTIME_IMAGE=${value.values.targetRuntime}`);
  });

  test('service compensation failure is loud after bridge selectors return', async () => {
    const value = await fixture();
    const token = await confirmation(value);
    const result = run(value, 'deploy', {
      CAUCE_DEPLOY_CONFIRM: token,
      FAKE_FAIL_STAGE: 'health',
      FAKE_FAIL_COMPENSATION: 'services',
    });

    expect(result.status).toBe(71);
    expect(result.stderr).toContain('CRITICAL: post-migration compensation selected bridge selectors');
    expect(await readFile(value.envFile, 'utf8')).toContain(`CAUCE_RUNTIME_IMAGE=${value.values.bridgeRuntime}`);
  });

  test('post-durable compensation quiesces every Compose and external writer before selecting the bridge', async () => {
    const value = await fixture(undefined, 3);
    const writerFleet = { FAKE_WITH_WRITERS: '1', FAKE_EXTERNAL_WRITER: '1' };
    const token = await confirmation(value, writerFleet);
    await writeFile(value.log, '');
    const result = run(value, 'deploy', {
      ...writerFleet,
      CAUCE_DEPLOY_CONFIRM: token,
      FAKE_FAIL_STAGE: 'health',
    });
    const calls = await readFile(value.log, 'utf8');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('accredited target-schema bridge');
    expect(calls).toMatch(/COMPOSE prod stop --timeout 45 relay-worker terminal-relay[\s\S]*WRITER fence lock=9[\s\S]*WRITER check lock=9[\s\S]*SWAP bridge lock=9/u);
    expect(calls).toContain('WRITER marker mode=rollback_bridge_degraded expected=0 observed=0 lock=9');
    const bridgeUp = calls.split('\n').find((line) => line.includes('COMPOSE prod up') && line.includes('state=bridge'));
    expect(bridgeUp).toBeDefined();
    expect(bridgeUp).not.toMatch(/dispatcher|relay-worker|terminal-relay/u);
    expect(calls).not.toContain('COMPOSE prod exec -T dispatcher');
  });

  test('a lost external fence response is reconciled from observed state before bridge CAS', async () => {
    const value = await fixture(undefined, 3);
    const environment = {
      FAKE_WITH_WRITERS: '1',
      FAKE_EXTERNAL_WRITER: '1',
      FAKE_LOST_STOP_RESPONSE: '1',
      FAKE_FAIL_STAGE: 'health',
    };
    const token = await confirmation(value, environment);
    const result = run(value, 'deploy', { ...environment, CAUCE_DEPLOY_CONFIRM: token });
    const calls = await readFile(value.log, 'utf8');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('accredited target-schema bridge');
    expect(calls).toMatch(/WRITER fence lock=9[\s\S]*WRITER check lock=9[\s\S]*SWAP bridge lock=9/u);
  });

  test('a partial external writer stop before CAS restores the exact candidate without selecting target or bridge', async () => {
    const value = await fixture(undefined, 3);
    const environment = {
      FAKE_WITH_WRITERS: '1',
      FAKE_EXTERNAL_WRITER: '1',
      FAKE_STOP_UNIT_FAILURE: '1',
      FAKE_FAIL_STAGE: 'health',
    };
    const token = await confirmation(value, environment);
    await writeFile(value.log, '');
    const result = run(value, 'deploy', { ...environment, CAUCE_DEPLOY_CONFIRM: token });
    const calls = await readFile(value.log, 'utf8');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('all writers could not be proven stopped; restoring expected-old mode');
    expect(calls).not.toContain('SWAP forward');
    expect(calls).not.toContain('SWAP bridge');
    expect(calls).toMatch(
      /WRITER marker mode=candidate expected=3 observed=3 lock=9[\s\S]*COMPOSE prod up[\s\S]*WRITER restore lock=9/u,
    );
  });

  test('failed writer restoration after a pre-CAS partial stop is loud and leaves old selectors', async () => {
    const value = await fixture(undefined, 3);
    const environment = {
      FAKE_WITH_WRITERS: '1',
      FAKE_EXTERNAL_WRITER: '1',
      FAKE_LOST_STOP_RESPONSE: '1',
      FAKE_FAIL_STOPPED_CHECK: '1',
      FAKE_RESTORE_UNIT_FAILURE: '1',
      FAKE_FAIL_STAGE: 'health',
    };
    const token = await confirmation(value, environment);
    const result = run(value, 'deploy', { ...environment, CAUCE_DEPLOY_CONFIRM: token });

    expect(result.status).toBe(74);
    expect(result.stderr).toContain('CRITICAL: partial writer/ingress stop could not be restored exactly');
    expect(await readFile(value.envFile, 'utf8')).toContain(`CAUCE_RUNTIME_IMAGE=${value.values.currentRuntime}`);
  });

  test('console-then-runtime rollback has a canonical bridge-to-candidate roll-forward path', async () => {
    const value = await fixture(undefined, 3);
    const selected = (await readFile(value.envFile, 'utf8'))
      .replace(`CAUCE_RUNTIME_IMAGE=${value.values.currentRuntime}`, `CAUCE_RUNTIME_IMAGE=${value.values.bridgeRuntime}`)
      .replace(`CAUCE_ROLLBACK_BASELINE_FILE=${value.values.currentBaseline}`, `CAUCE_ROLLBACK_BASELINE_FILE=${value.values.targetBaseline}`)
      .replace(`CAUCE_ROLLBACK_BASELINE_SHA256=${value.values.currentBaselineSha}`, `CAUCE_ROLLBACK_BASELINE_SHA256=${value.values.targetBaselineSha}`)
      .replace(`CAUCE_ROLLBACK_WRITER_SNAPSHOT_FILE=${value.values.currentWriterSnapshot}`, `CAUCE_ROLLBACK_WRITER_SNAPSHOT_FILE=${value.values.targetWriterSnapshot}`)
      .replace(`CAUCE_ROLLBACK_WRITER_SNAPSHOT_SHA256=${value.values.currentWriterSnapshotSha}`, `CAUCE_ROLLBACK_WRITER_SNAPSHOT_SHA256=${value.values.targetWriterSnapshotSha}`);
    await writeFile(value.envFile, selected, { mode: 0o600 });
    const environment = {
      FAKE_WITH_WRITERS: '1',
      FAKE_EXTERNAL_WRITER: '1',
      COMPOSE_WRITERS_STOPPED: '1',
      DISPATCHER_STOPPED: '1',
      FAKE_DISPATCHER_ABSENT: '1',
      FAKE_WRITERS_ABSENT: '1',
      WRITERS_STOPPED: '1',
    };
    const token = await confirmation(value, environment);
    await writeFile(value.log, '');
    const result = run(value, 'deploy', { ...environment, CAUCE_DEPLOY_CONFIRM: token });
    const calls = await readFile(value.log, 'utf8');

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(calls).toMatch(/COMPOSE prod up[\s\S]*relay-worker terminal-relay state=target[\s\S]*WRITER restore lock=9/u);
    expect(calls).toContain('WRITER marker mode=candidate expected=3 observed=3 lock=9');
    expect(await readFile(value.envFile, 'utf8')).toContain(`CAUCE_RUNTIME_IMAGE=${value.values.targetRuntime}`);
    expect(await readFile(value.envFile, 'utf8')).toContain(`CAUCE_CONSOLE_IMAGE=${value.values.targetConsole}`);
  });

  test('bounded Zeus maintenance runs its gate but cannot claim strict release-host-ready', async () => {
    const maintenance = {
      CAUCE_CHANGE_ID: 'CHG-DEPLOY-TEST',
      CAUCE_MAINTENANCE_CONFIRM: 'offline:Steven:zeus:CHG-DEPLOY-TEST',
    };
    const value = await fixture();
    const preflight = spawnSync(value.script, ['preflight', '--maintenance-offline-zeus'], {
      encoding: 'utf8', env: { ...value.env, ...maintenance },
    });
    const match = /CAUCE_DEPLOY_CONFIRM=(deploy-release:sha256:[a-f0-9]{64})/u.exec(preflight.stdout);
    expect(preflight.status).toBe(0);
    await writeFile(value.log, '');
    const result = spawnSync(value.script, ['deploy', '--maintenance-offline-zeus'], {
      encoding: 'utf8',
      env: { ...value.env, ...maintenance, CAUCE_DEPLOY_CONFIRM: match?.[1] ?? '' },
    });
    const calls = await readFile(value.log, 'utf8');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('strict release-host-ready remains fail-closed');
    expect(calls).toContain('RELEASE_GATE lock=9 change=CHG-DEPLOY-TEST confirm=offline:Steven:zeus:CHG-DEPLOY-TEST args=--maintenance-offline-zeus');
    expect(calls).not.toContain('RELEASE_CANDIDATE lock=9 args=--release-host-ready');
  });

  test('Zeus reactivation rotates only snapshot selectors after marker/outbox publication and closes strict gates', async () => {
    const value = await fixture(undefined, 2);
    const environment = writerRotationEnvironment(value);
    writeFileSync(value.state, `${JSON.stringify(environment)}\n`);
    const staleGate = spawnSync(
      join(value.root, 'ops/scripts/release-candidate.py'),
      ['--release-host-ready'],
      { encoding: 'utf8', env: { ...value.env, ...environment } },
    );
    expect(staleGate.status).toBe(64);

    await writeFile(value.log, '');
    const result = run(value, 'rotate-writer-snapshot', environment);
    const [selected, calls] = await Promise.all([
      readFile(value.envFile, 'utf8'),
      readFile(value.log, 'utf8'),
    ]);

    expect(result.status, `${result.stdout}\n${result.stderr}\n${calls}`).toBe(0);
    expect(result.stdout).toContain('strict release-host-ready evidence');
    expect(selected).toContain(`CAUCE_RUNTIME_IMAGE=${value.values.currentRuntime}`);
    expect(selected).toContain(`CAUCE_CONSOLE_IMAGE=${value.values.currentConsole}`);
    expect(selected).toContain(`CAUCE_COMPOSE_OVERRIDE_MANIFEST=${value.values.currentManifest}`);
    expect(selected).toContain(`CAUCE_ROLLBACK_BASELINE_FILE=${value.values.currentBaseline}`);
    expect(selected).toContain(`CAUCE_ROLLBACK_WRITER_SNAPSHOT_FILE=${value.values.rotationWriterSnapshot}`);
    expect(calls).toMatch(
      /WRITER marker mode=candidate expected=3 observed=3 lock=9[\s\S]*COMPOSE prod up -d --force-recreate --no-build --no-deps --wait --wait-timeout 180 outbox-metrics[\s\S]*SWAP rotation-forward lock=9[\s\S]*WRITER check lock=9[\s\S]*RELEASE_CANDIDATE lock=9 args=--release-host-ready/u,
    );

    writeFileSync(value.state, `${JSON.stringify(environment)}\n`);
    const strictGate = spawnSync(
      join(value.root, 'ops/scripts/release-candidate.py'),
      ['--release-host-ready'],
      { encoding: 'utf8', env: { ...value.env, ...environment } },
    );
    expect(strictGate.status).toBe(0);
  });

  test('writer rotation rejects bridge mode and active-set drift outside Zeus before CAS/outbox mutation', async () => {
    const bridge = await fixture(undefined, 2);
    await writeFile(
      bridge.envFile,
      (await readFile(bridge.envFile, 'utf8')).replace(
        `CAUCE_RUNTIME_IMAGE=${bridge.values.currentRuntime}`,
        `CAUCE_RUNTIME_IMAGE=${bridge.values.bridgeRuntime}`,
      ),
      { mode: 0o600 },
    );
    const bridgeResult = run(bridge, 'rotate-writer-snapshot', writerRotationEnvironment(bridge));
    expect(bridgeResult.status).not.toBe(0);
    expect(bridgeResult.stderr).toContain('not the exact current candidate state');

    const drift = await fixture(undefined, 2);
    const driftResult = run(drift, 'rotate-writer-snapshot', writerRotationEnvironment(drift, {
      FAKE_OTHER_ACTIVE_SET_DRIFT: '1',
    }));
    const driftCalls = await readFile(drift.log, 'utf8');
    expect(driftResult.status).not.toBe(0);
    expect(driftResult.stderr).toContain('anything other than Zeus');
    expect(driftCalls).not.toContain('SWAP rotation-forward');
    expect(driftCalls).not.toContain('COMPOSE prod up -d --force-recreate');
  });

  test('writer rotation marker or strict-gate failure compensates old selector, marker and outbox', async () => {
    for (const failure of ['marker', 'release-host-ready'] as const) {
      const value = await fixture(undefined, 2);
      const overrides = failure === 'marker'
        ? { FAKE_FAIL_ROTATION_MARKER: '1' }
        : { FAKE_FAIL_STAGE: 'release-host-ready' };
      const result = run(
        value,
        'rotate-writer-snapshot',
        writerRotationEnvironment(value, overrides),
      );
      const [selected, calls] = await Promise.all([
        readFile(value.envFile, 'utf8'),
        readFile(value.log, 'utf8'),
      ]);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('old selector and marker consumer restored');
      expect(selected).toContain(`CAUCE_ROLLBACK_WRITER_SNAPSHOT_FILE=${value.values.currentWriterSnapshot}`);
      expect(calls).toMatch(
        /WRITER marker mode=candidate expected=2 observed=2 lock=9[\s\S]*COMPOSE prod up -d --force-recreate --no-build --no-deps --wait --wait-timeout 180 outbox-metrics/u,
      );
      if (failure === 'release-host-ready') expect(calls).toContain('SWAP rotation-inverse lock=9');
    }
  });

  test('writer rotation rejects duplicate contradictory metric series before CAS', async () => {
    const value = await fixture(undefined, 2);
    const result = run(value, 'rotate-writer-snapshot', writerRotationEnvironment(value, {
      FAKE_DUPLICATE_ROTATION_METRICS: '1',
    }));
    const calls = await readFile(value.log, 'utf8');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('marker/outbox could not be proven before CAS');
    expect(calls).not.toContain('SWAP rotation-forward');
    expect(await readFile(value.envFile, 'utf8')).toContain(
      `CAUCE_ROLLBACK_WRITER_SNAPSHOT_FILE=${value.values.currentWriterSnapshot}`,
    );
  });

  test('lost rotation CAS response is admitted as committed and an exact retry is idempotent', async () => {
    const value = await fixture(undefined, 2);
    const environment = writerRotationEnvironment(value, {
      FAKE_FAIL_ROTATION_CAS_RESPONSE: '1',
    });
    const first = run(value, 'rotate-writer-snapshot', environment);
    expect(first.status, `${first.stdout}\n${first.stderr}`).toBe(0);
    expect(first.stderr).toContain('lost forward-CAS response');
    expect(await readFile(value.envFile, 'utf8')).toContain(
      `CAUCE_ROLLBACK_WRITER_SNAPSHOT_FILE=${value.values.rotationWriterSnapshot}`,
    );

    await writeFile(value.log, '');
    const retry = run(value, 'rotate-writer-snapshot', writerRotationEnvironment(value));
    const retryCalls = await readFile(value.log, 'utf8');
    expect(retry.status, `${retry.stdout}\n${retry.stderr}\n${retryCalls}`).toBe(0);
    expect(retry.stdout).toContain('already committed and reverified');
    expect(retryCalls).not.toContain('WRITER capture');
    expect(retryCalls).not.toContain('WRITER publish');
    expect(retryCalls).not.toContain('SWAP rotation-forward');
    expect(retryCalls).toContain('RELEASE_CANDIDATE lock=9 args=--release-host-ready');
  });

  test('ambiguous partial writer rotation CAS fails loudly without guessing a selector', async () => {
    const value = await fixture(undefined, 2);
    const result = run(value, 'rotate-writer-snapshot', writerRotationEnvironment(value, {
      FAKE_PARTIAL_ROTATION_CAS: '1',
    }));
    const selected = await readFile(value.envFile, 'utf8');

    expect(result.status).toBe(75);
    expect(result.stderr).toContain('neither exact old nor exact new selectors');
    expect(result.stderr).toContain('could not restore the exact old selector');
    expect(selected).toContain(`CAUCE_ROLLBACK_WRITER_SNAPSHOT_FILE=${value.values.rotationWriterSnapshot}`);
    expect(selected).toContain(`CAUCE_ROLLBACK_WRITER_SNAPSHOT_SHA256=${value.values.currentWriterSnapshotSha}`);
  });

  test('a baseline may use a distinct bridge but must encode the exact old console and manifest', async () => {
    const value = await fixture();
    const result = run(value, 'preflight', { FAKE_TARGET_ROLLBACK_CONSOLE: image('console', '0') });
    const calls = await readFile(value.log, 'utf8');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('does not encode the exact current console/manifest rollback state');
    expect(calls).not.toContain('DOCKER ');
    expect(calls).not.toContain('SWAP ');
  });

  test('a bridge accredited only through an older schema is rejected before CAS or migration', async () => {
    const value = await fixture();
    const token = await confirmation(value);
    await writeFile(value.log, '');
    const result = run(value, 'deploy', {
      CAUCE_DEPLOY_CONFIRM: token,
      FAKE_BRIDGE_SCHEMA: '029_reconcile_declared_fleet.sql',
    });
    const calls = await readFile(value.log, 'utf8');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('rollback bridge image is not accredited through the target schema');
    expect(calls).not.toContain('SWAP ');
    expect(calls).not.toMatch(/COMPOSE prod run --rm --no-deps -T migrator state=/u);
  });

  test('fragmented running images require an explicit content-bound legacy snapshot before pull or CAS', async () => {
    const value = await fixture();
    const result = run(value, 'preflight', { FAKE_FRAGMENTED_SERVICE: 'dispatcher' });
    const calls = await readFile(value.log, 'utf8');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('fragmented expected-old requires CAUCE_DEPLOY_LEGACY_SNAPSHOT_FILE');
    expect(calls).not.toContain('DOCKER pull');
    expect(calls).not.toContain('SWAP ');
  });

  test('fragmented expected-old preflight proves exact reconstruction but remains read-only', async () => {
    const value = await fixture();
    const snapshot = join(value.root, 'legacy-fragment-snapshot.json');
    const result = run(value, 'preflight', {
      FAKE_FRAGMENTED_SERVICE: 'dispatcher',
      CAUCE_DEPLOY_LEGACY_SNAPSHOT_FILE: snapshot,
    });
    const calls = await readFile(value.log, 'utf8');

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toMatch(/CAUCE_DEPLOY_CONFIRM=deploy-release:sha256:[a-f0-9]{64}/u);
    await expect(readFile(snapshot, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(calls).toContain('COMPOSE prod -f - config --hash dispatcher state=current lock=9');
    expect(calls).not.toContain('DOCKER pull');
    expect(calls).not.toContain('SWAP ');
    expect(calls).not.toContain('COMPOSE prod up');
    expect(calls).not.toContain('COMPOSE prod -f - up');
  });

  test('container/config drift after preflight changes the snapshot digest and invalidates confirmation', async () => {
    const value = await fixture();
    const snapshot = join(value.root, 'legacy-fragment-snapshot.json');
    const fragment = {
      FAKE_FRAGMENTED_SERVICE: 'dispatcher',
      CAUCE_DEPLOY_LEGACY_SNAPSHOT_FILE: snapshot,
    };
    const token = await confirmation(value, fragment);
    await writeFile(value.log, '');
    const changedHash = 'b'.repeat(64);
    const result = run(value, 'deploy', {
      ...fragment,
      CAUCE_DEPLOY_CONFIRM: token,
      FAKE_RUNNING_CONFIG_HASH: changedHash,
      FAKE_FRAGMENT_CONFIG_HASH: changedHash,
    });
    const calls = await readFile(value.log, 'utf8');

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('CAUCE_DEPLOY_CONFIRM does not authorize this exact old-to-target transition');
    await expect(readFile(snapshot, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(calls).not.toContain('DOCKER pull');
    expect(calls).not.toContain('SWAP ');
    expect(calls).not.toContain('COMPOSE prod up');
  });

  test('a release-plane stop failure restores the candidate and never reaches SQL or CAS', async () => {
    const value = await fixture();
    const token = await confirmation(value);
    await writeFile(value.log, '');
    const before = await readFile(value.envFile, 'utf8');
    const result = run(value, 'deploy', {
      CAUCE_DEPLOY_CONFIRM: token,
      FAKE_STOP_RELEASE_PLANE_FAILURE: '1',
    });
    const calls = await readFile(value.log, 'utf8');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('central ingress could not be proven stopped');
    expect(await readFile(value.envFile, 'utf8')).toBe(before);
    expect(calls).not.toContain('deploy/migration-integrity.mjs pre');
    expect(calls).not.toContain('SWAP forward');
    expect(calls).toMatch(/COMPOSE prod stop --timeout 45 console dispatcher gateway outbox-metrics[\s\S]*COMPOSE prod up/u);
  });

  test('a signal during closed-ingress preflight restores the candidate before any CAS', async () => {
    const value = await fixture();
    const token = await confirmation(value);
    await writeFile(value.log, '');
    const before = await readFile(value.envFile, 'utf8');
    const result = run(value, 'deploy', {
      CAUCE_DEPLOY_CONFIRM: token,
      FAKE_SIGNAL_DURING_PREFLIGHT: '1',
    });
    const calls = await readFile(value.log, 'utf8');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('release signal TERM received');
    expect(await readFile(value.envFile, 'utf8')).toBe(before);
    expect(calls).not.toContain('SWAP forward');
    expect(calls).toMatch(/COMPOSE prod stop --timeout 45 console dispatcher gateway outbox-metrics[\s\S]*deploy\/migration-integrity\.mjs pre[\s\S]*COMPOSE prod up/u);
  });

  test('legacy snapshot publication is create-only if the destination appears after preflight', async () => {
    const value = await fixture();
    const snapshot = join(value.root, 'legacy-fragment-snapshot.json');
    const fragment = {
      FAKE_FRAGMENTED_SERVICE: 'dispatcher',
      CAUCE_DEPLOY_LEGACY_SNAPSHOT_FILE: snapshot,
    };
    const token = await confirmation(value, fragment);
    await writeFile(snapshot, 'operator-owned-existing-evidence\n', { mode: 0o600 });
    await writeFile(value.log, '');
    const result = run(value, 'deploy', { ...fragment, CAUCE_DEPLOY_CONFIRM: token });
    const calls = await readFile(value.log, 'utf8');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('legacy snapshot destination already exists');
    expect(await readFile(snapshot, 'utf8')).toBe('operator-owned-existing-evidence\n');
    expect(calls).not.toContain('DOCKER pull');
    expect(calls).not.toContain('SWAP ');
  });

  test('physical fragment drift is rejected immediately before snapshot publication', async () => {
    const value = await fixture();
    const snapshot = join(value.root, 'legacy-fragment-snapshot.json');
    const fragment = {
      FAKE_FRAGMENTED_SERVICE: 'dispatcher',
      CAUCE_DEPLOY_LEGACY_SNAPSHOT_FILE: snapshot,
    };
    const token = await confirmation(value, fragment);
    await writeFile(value.log, '');
    const result = run(value, 'deploy', {
      ...fragment,
      CAUCE_DEPLOY_CONFIRM: token,
      FAKE_FRAGMENT_CONTAINER_DRIFT_AFTER: '1',
    });
    const calls = await readFile(value.log, 'utf8');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('physical fleet changed before evidence publication');
    await expect(readFile(snapshot, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(calls).not.toContain('COMPOSE prod up');
    expect(calls).not.toContain('SWAP ');
  });

  test('physical fragment drift after publication is rejected immediately before normalization', async () => {
    const value = await fixture();
    const snapshot = join(value.root, 'legacy-fragment-snapshot.json');
    const fragment = {
      FAKE_FRAGMENTED_SERVICE: 'dispatcher',
      CAUCE_DEPLOY_LEGACY_SNAPSHOT_FILE: snapshot,
    };
    const token = await confirmation(value, fragment);
    await writeFile(value.log, '');
    const result = run(value, 'deploy', {
      ...fragment,
      CAUCE_DEPLOY_CONFIRM: token,
      FAKE_FRAGMENT_CONTAINER_DRIFT_AFTER: '3',
    });
    const calls = await readFile(value.log, 'utf8');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('changed after evidence publication and before normalization');
    expect((await stat(snapshot)).mode & 0o777).toBe(0o600);
    expect(calls).not.toContain('COMPOSE prod up');
    expect(calls).not.toContain('SWAP ');
  });

  test('first canonical deploy snapshots and normalizes a fragmented fleet before CAS', async () => {
    const value = await fixture();
    const snapshot = join(value.root, 'legacy-fragment-snapshot.json');
    const fragment = {
      FAKE_FRAGMENTED_SERVICES: 'dispatcher,outbox-metrics,console',
      CAUCE_DEPLOY_LEGACY_SNAPSHOT_FILE: snapshot,
    };
    const token = await confirmation(value, fragment);
    await writeFile(value.log, '');
    const result = run(value, 'deploy', { ...fragment, CAUCE_DEPLOY_CONFIRM: token });
    const calls = await readFile(value.log, 'utf8');
    const report = JSON.parse(await readFile(snapshot, 'utf8')) as {
      kind: string;
      selectors: { manifestSha256: string };
      services: Array<Record<string, string>>;
    };
    const metadata = await stat(snapshot);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(metadata.mode & 0o777).toBe(0o600);
    expect(report.kind).toBe('cauce-v3-fragmented-legacy-release-snapshot');
    expect(report.selectors.manifestSha256).toBe(value.values.currentManifestSha);
    expect(report.services).toContainEqual(expect.objectContaining({
      service: 'dispatcher',
      image: value.values.targetRuntime,
      imageId: value.values.targetRuntimeId,
      canonicalImage: value.values.currentRuntime,
      containerIdBefore: 'cid-dispatcher',
    }));
    expect(report.services).toContainEqual(expect.objectContaining({
      service: 'console',
      image: value.values.targetConsole,
      imageId: value.values.targetConsoleId,
      canonicalImage: value.values.currentConsole,
    }));
    expect(calls).toMatch(/COMPOSE prod up .*state=current lock=9[\s\S]*SWAP forward lock=9[\s\S]*COMPOSE prod run --rm --no-deps -T migrator state=target lock=9/u);
    expect(calls).not.toContain('COMPOSE prod -f - up');
    expect(await readFile(value.envFile, 'utf8')).toContain(
      `CAUCE_RUNTIME_IMAGE=${value.values.targetRuntime}`,
    );
  });

  test('partial normalization failure restores the exact fragmented snapshot before CAS', async () => {
    const value = await fixture();
    const snapshot = join(value.root, 'legacy-fragment-snapshot.json');
    const fragment = {
      FAKE_FRAGMENTED_SERVICE: 'dispatcher',
      CAUCE_DEPLOY_LEGACY_SNAPSHOT_FILE: snapshot,
      FAKE_FAIL_NORMALIZATION: '1',
    };
    const token = await confirmation(value, fragment);
    const before = await readFile(value.envFile, 'utf8');
    await writeFile(value.log, '');
    const result = run(value, 'deploy', { ...fragment, CAUCE_DEPLOY_CONFIRM: token });
    const calls = await readFile(value.log, 'utf8');
    const finalState = JSON.parse(await readFile(value.state, 'utf8')) as { FRAGMENT_NORMALIZED?: boolean };

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('exact fragmented expected-old fleet and health were restored');
    expect(await readFile(value.envFile, 'utf8')).toBe(before);
    expect(finalState.FRAGMENT_NORMALIZED).toBe(false);
    expect(calls).toMatch(/COMPOSE prod up .*state=current lock=9[\s\S]*COMPOSE prod -f - up .*state=current lock=9/u);
    expect(calls).not.toContain('SWAP ');
    expect(calls).not.toMatch(/COMPOSE prod run --rm --no-deps -T migrator state=/u);
    expect((await stat(snapshot)).mode & 0o777).toBe(0o600);
  });

  test('post-normalization TOCTOU is re-admitted before CAS and restores the exact fragments', async () => {
    const value = await fixture();
    const snapshot = join(value.root, 'legacy-fragment-snapshot.json');
    const fragment = {
      FAKE_FRAGMENTED_SERVICE: 'dispatcher',
      CAUCE_DEPLOY_LEGACY_SNAPSHOT_FILE: snapshot,
      FAKE_DRIFT_AFTER_NORMALIZE: '1',
    };
    const token = await confirmation(value, fragment);
    await writeFile(value.log, '');
    const result = run(value, 'deploy', { ...fragment, CAUCE_DEPLOY_CONFIRM: token });
    const calls = await readFile(value.log, 'utf8');
    const finalState = JSON.parse(await readFile(value.state, 'utf8')) as { FRAGMENT_NORMALIZED?: boolean };

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('post-normalization drift was rejected');
    expect(finalState.FRAGMENT_NORMALIZED).toBe(false);
    expect(calls).toContain('COMPOSE prod -f - up');
    expect(calls).not.toContain('SWAP ');
    expect(calls).not.toMatch(/COMPOSE prod run --rm --no-deps -T migrator state=/u);
  });

  test('fragment RepoDigest recovery failure stops before snapshot publication or production mutation', async () => {
    const value = await fixture();
    const snapshot = join(value.root, 'legacy-fragment-snapshot.json');
    const fragment = {
      FAKE_FRAGMENTED_SERVICE: 'dispatcher',
      CAUCE_DEPLOY_LEGACY_SNAPSHOT_FILE: snapshot,
      FAKE_FAIL_FRAGMENT_PULL: '1',
    };
    const token = await confirmation(value, fragment);
    await writeFile(value.log, '');
    const result = run(value, 'deploy', { ...fragment, CAUCE_DEPLOY_CONFIRM: token });
    const calls = await readFile(value.log, 'utf8');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('immutable registry image could not be recovered');
    await expect(readFile(snapshot, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(calls).not.toContain('SWAP ');
    expect(calls).not.toContain('COMPOSE prod up');
    expect(calls).not.toMatch(/COMPOSE prod run --rm --no-deps -T migrator state=/u);
  });

  test('fragment restore failure is loud and uses the dedicated critical exit code', async () => {
    const value = await fixture();
    const snapshot = join(value.root, 'legacy-fragment-snapshot.json');
    const fragment = {
      FAKE_FRAGMENTED_SERVICE: 'dispatcher',
      CAUCE_DEPLOY_LEGACY_SNAPSHOT_FILE: snapshot,
      FAKE_FAIL_NORMALIZATION: '1',
      FAKE_FAIL_FRAGMENT_RESTORE: '1',
    };
    const token = await confirmation(value, fragment);
    const result = run(value, 'deploy', { ...fragment, CAUCE_DEPLOY_CONFIRM: token });
    const calls = await readFile(value.log, 'utf8');

    expect(result.status).toBe(74);
    expect(result.stderr).toContain('CRITICAL: fragmented expected-old normalization failed');
    expect(calls).toContain('COMPOSE prod -f - up');
    expect(calls).not.toContain('SWAP ');
  });

  test('compensation re-admits the immutable fragment snapshot before recreating services', async () => {
    const value = await fixture();
    const snapshot = join(value.root, 'legacy-fragment-snapshot.json');
    const fragment = {
      FAKE_FRAGMENTED_SERVICE: 'dispatcher',
      CAUCE_DEPLOY_LEGACY_SNAPSHOT_FILE: snapshot,
      FAKE_FAIL_NORMALIZATION: '1',
      FAKE_TAMPER_FRAGMENT_BEFORE_COMPENSATION: '1',
    };
    const token = await confirmation(value, fragment);
    await writeFile(value.log, '');
    const result = run(value, 'deploy', { ...fragment, CAUCE_DEPLOY_CONFIRM: token });
    const calls = await readFile(value.log, 'utf8');

    expect(result.status).toBe(74);
    expect(result.stderr).toContain('exact service/config/image snapshot could not be restored');
    expect(await readFile(snapshot, 'utf8')).toContain('tampered-after-publication');
    expect(calls).not.toContain('COMPOSE prod -f - up');
    expect(calls).not.toContain('SWAP ');
  });

  test('lost forward-CAS response detects selected target and restores exact mosaic before migration', async () => {
    const value = await fixture();
    const snapshot = join(value.root, 'legacy-fragment-snapshot.json');
    const fragment = {
      FAKE_FRAGMENTED_SERVICE: 'dispatcher',
      CAUCE_DEPLOY_LEGACY_SNAPSHOT_FILE: snapshot,
      FAKE_FAIL_FORWARD_SWAP_RESPONSE: '1',
    };
    const token = await confirmation(value, fragment);
    const before = await readFile(value.envFile, 'utf8');
    await writeFile(value.log, '');
    const result = run(value, 'deploy', { ...fragment, CAUCE_DEPLOY_CONFIRM: token });
    const calls = await readFile(value.log, 'utf8');
    const finalState = JSON.parse(await readFile(value.state, 'utf8')) as { FRAGMENT_NORMALIZED?: boolean };

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('lost forward-CAS response');
    expect(result.stderr).toContain('failed safely before migration');
    expect(await readFile(value.envFile, 'utf8')).toBe(before);
    expect(finalState.FRAGMENT_NORMALIZED).toBe(false);
    expect(calls).toMatch(/SWAP forward lock=9[\s\S]*SWAP inverse lock=9[\s\S]*COMPOSE prod -f - up/u);
    expect(calls).not.toMatch(/COMPOSE prod run --rm --no-deps -T migrator state=/u);
  });

  test('pre-durable target failure restores selectors and the original fragmented services', async () => {
    const value = await fixture();
    const snapshot = join(value.root, 'legacy-fragment-snapshot.json');
    const fragment = {
      FAKE_FRAGMENTED_SERVICE: 'dispatcher',
      CAUCE_DEPLOY_LEGACY_SNAPSHOT_FILE: snapshot,
      FAKE_FAIL_STAGE: 'migrator',
    };
    const token = await confirmation(value, fragment);
    const before = await readFile(value.envFile, 'utf8');
    await writeFile(value.log, '');
    const result = run(value, 'deploy', { ...fragment, CAUCE_DEPLOY_CONFIRM: token });
    const calls = await readFile(value.log, 'utf8');
    const finalState = JSON.parse(await readFile(value.state, 'utf8')) as { FRAGMENT_NORMALIZED?: boolean };

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('failed safely before durable migration');
    expect(await readFile(value.envFile, 'utf8')).toBe(before);
    expect(finalState.FRAGMENT_NORMALIZED).toBe(false);
    expect(calls).toMatch(/COMPOSE prod up .*state=current lock=9[\s\S]*SWAP forward lock=9[\s\S]*SWAP inverse lock=9[\s\S]*COMPOSE prod -f - up .*state=current lock=9/u);
  });

  test('post-durable failure from a fragmented baseline selects the target-schema bridge, never old fragments', async () => {
    const value = await fixture();
    const snapshot = join(value.root, 'legacy-fragment-snapshot.json');
    const fragment = {
      FAKE_FRAGMENTED_SERVICES: 'dispatcher,outbox-metrics,console',
      CAUCE_DEPLOY_LEGACY_SNAPSHOT_FILE: snapshot,
      FAKE_FAIL_STAGE: 'health',
    };
    const token = await confirmation(value, fragment);
    await writeFile(value.log, '');
    const result = run(value, 'deploy', { ...fragment, CAUCE_DEPLOY_CONFIRM: token });
    const calls = await readFile(value.log, 'utf8');
    const selected = await readFile(value.envFile, 'utf8');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('accredited target-schema bridge');
    expect(selected).toContain(`CAUCE_RUNTIME_IMAGE=${value.values.bridgeRuntime}`);
    expect(selected).toContain(`CAUCE_CONSOLE_IMAGE=${value.values.currentConsole}`);
    expect(calls).toContain('SWAP bridge lock=9');
    expect(calls).not.toContain('COMPOSE prod -f - up');
  });

  test.each([
    ['extra materialized service', { FAKE_EXTRA_SERVICE: 'rogue' }],
    ['configured stopped service', { FAKE_STOPPED_SERVICE: 'dispatcher' }],
  ])('%s is rejected before registry pull or CAS', async (_label, poison) => {
    const value = await fixture();
    const result = run(value, 'preflight', poison);
    const calls = await readFile(value.log, 'utf8');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('differ from the exact selected release mode');
    expect(calls).not.toContain('DOCKER pull');
    expect(calls).not.toContain('SWAP ');
  });

  test('closed execution environment ignores project, profile, daemon and interpolation poison', async () => {
    const value = await fixture();
    const result = run(value, 'preflight', {
      COMPOSE_PROJECT_NAME: 'attacker-project',
      COMPOSE_PROFILES: 'shadow,telegram',
      DOCKER_HOST: 'tcp://attacker.invalid:2375',
      DOCKER_CONTEXT: 'attacker-context',
      PRIVATE_PATH: 'ambient-interpolation-wins',
      CAUCE_RUNTIME_IMAGE: image('poison', '0'),
      PATH: '/attacker/controlled/path',
    });
    const calls = await readFile(value.log, 'utf8');

    expect(result.status, result.stderr).toBe(0);
    expect(calls).toContain('project=cauce-v3-prod profiles= dockerHost=unix:///var/run/docker.sock');
    expect(calls).toContain('dockerContext= poisonInterpolation=');
    expect(calls).not.toContain('attacker-project');
    expect(calls).not.toContain('attacker-context');
    expect(calls).not.toContain('ambient-interpolation-wins');
    expect(calls).not.toContain(image('poison', '0'));
  });

  test.each([
    ['wrong project', 'COMPOSE_PROJECT_NAME=attacker-project'],
    ['unsupported profile', 'COMPOSE_PROFILES=shadow,attacker-profile'],
    ['env-file daemon redirect', 'DOCKER_HOST=tcp://attacker.invalid:2375'],
    ['env-file context redirect', 'DOCKER_CONTEXT=attacker-context'],
  ])('%s in the private env fails closed before Compose, Docker or CAS', async (_label, poison) => {
    const value = await fixture();
    const original = await readFile(value.envFile, 'utf8');
    const key = poison.slice(0, poison.indexOf('='));
    const existing = new RegExp(`^${key}=.*$`, 'mu');
    const poisoned = existing.test(original)
      ? original.replace(existing, poison)
      : `${original}${poison}\n`;
    await writeFile(value.envFile, poisoned, { mode: 0o600 });
    const result = run(value, 'preflight');
    const calls = await readFile(value.log, 'utf8');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Docker/Compose controls are ambiguous or unsafe');
    expect(calls).not.toContain('COMPOSE ');
    expect(calls).not.toContain('DOCKER ');
    expect(calls).not.toContain('SWAP ');
  });

  test('target manifest bytes are hash-bound between confirmation and every mutation', async () => {
    const value = await fixture();
    const token = await confirmation(value);
    const before = await readFile(value.envFile, 'utf8');
    await writeFile(value.values.targetManifest!, '# target changed after confirmation\n', { mode: 0o600 });
    await writeFile(value.log, '');
    const result = run(value, 'deploy', { CAUCE_DEPLOY_CONFIRM: token });
    const calls = await readFile(value.log, 'utf8');

    expect(result.status).not.toBe(0);
    expect(await readFile(value.envFile, 'utf8')).toBe(before);
    expect(calls).not.toContain('DOCKER pull');
    expect(calls).not.toContain('SWAP ');
  });

  test('a later production mutation rejects drift from the persistently selected manifest SHA', async () => {
    const value = await fixture();
    const token = await confirmation(value);
    expect(run(value, 'deploy', { CAUCE_DEPLOY_CONFIRM: token }).status).toBe(0);
    await writeFile(value.values.targetManifest!, '# selected manifest tampered later\n', { mode: 0o600 });
    await writeFile(value.log, '');

    const result = run(value, 'prod-up');
    const calls = await readFile(value.log, 'utf8');
    expect(result.status).not.toBe(0);
    expect(calls).not.toContain('COMPOSE prod up');
  });

  test('prod-up repairs daemon-revived bridge mutators and starts only the canonical safe topology', async () => {
    const value = await fixture(undefined, 3);
    const selected = (await readFile(value.envFile, 'utf8'))
      .replace(`CAUCE_RUNTIME_IMAGE=${value.values.currentRuntime}`, `CAUCE_RUNTIME_IMAGE=${value.values.bridgeRuntime}`)
      .replace(`CAUCE_ROLLBACK_BASELINE_FILE=${value.values.currentBaseline}`, `CAUCE_ROLLBACK_BASELINE_FILE=${value.values.targetBaseline}`)
      .replace(`CAUCE_ROLLBACK_BASELINE_SHA256=${value.values.currentBaselineSha}`, `CAUCE_ROLLBACK_BASELINE_SHA256=${value.values.targetBaselineSha}`)
      .replace(`CAUCE_ROLLBACK_WRITER_SNAPSHOT_FILE=${value.values.currentWriterSnapshot}`, `CAUCE_ROLLBACK_WRITER_SNAPSHOT_FILE=${value.values.targetWriterSnapshot}`)
      .replace(`CAUCE_ROLLBACK_WRITER_SNAPSHOT_SHA256=${value.values.currentWriterSnapshotSha}`, `CAUCE_ROLLBACK_WRITER_SNAPSHOT_SHA256=${value.values.targetWriterSnapshotSha}`);
    await writeFile(value.envFile, selected, { mode: 0o600 });
    const result = run(value, 'prod-up', {
      FAKE_WITH_WRITERS: '1',
      FAKE_EXTERNAL_WRITER: '1',
    });
    const calls = await readFile(value.log, 'utf8');
    const bridgeUp = calls.split('\n').find((line) =>
      line.includes('COMPOSE prod up') && line.includes('state=bridge'));
    const finalState = JSON.parse(await readFile(value.state, 'utf8')) as {
      DISPATCHER_STOPPED?: boolean;
      FAKE_DISPATCHER_ABSENT?: boolean;
      FAKE_WRITERS_ABSENT?: boolean;
      WRITERS_STOPPED?: boolean;
    };

    expect(result.status, result.stderr).toBe(0);
    expect(bridgeUp).toBeDefined();
    expect(bridgeUp).toContain('--no-deps');
    expect(bridgeUp).not.toMatch(/dispatcher|relay-worker|terminal-relay/u);
    expect(calls).not.toContain('COMPOSE prod exec -T dispatcher');
    expect(finalState.DISPATCHER_STOPPED).toBeTruthy();
    expect(finalState.FAKE_DISPATCHER_ABSENT).toBeTruthy();
    expect(finalState.FAKE_WRITERS_ABSENT).toBeTruthy();
    expect(finalState.WRITERS_STOPPED).toBeTruthy();
    expect(calls).toContain('WRITER fence');
    expect(calls).toContain('COMPOSE prod rm -f dispatcher relay-worker terminal-relay');
  });

  test.each([
    ['prod-up', /COMPOSE prod up -d --no-build --no-deps --wait/u],
    ['prod-down', /COMPOSE prod down/u],
  ])('%s mutates only inside the authenticated lock', async (action, mutation) => {
    const value = await fixture();
    const result = run(value, action);
    const calls = await readFile(value.log, 'utf8');

    expect(result.status, result.stderr).toBe(0);
    expect(calls).toMatch(new RegExp(`LOCKED_BEGIN[\\s\\S]*${mutation.source}[\\s\\S]*LOCKED_END status=0`, 'u'));
    if (action === 'prod-up') {
      const up = calls.split('\n').find((line) => line.includes('COMPOSE prod up'));
      expect(up).toBeDefined();
      expect(up).not.toMatch(/\bmigrator\b/u);
    }
  });

  test('direct migrate is a fail-closed tombstone and never reaches Compose', async () => {
    const value = await fixture();
    const result = run(value, 'migrate');
    const calls = await readFile(value.log, 'utf8');

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('direct production migration is disabled');
    expect(calls).not.toContain('COMPOSE ');
  });

  test('durable target schema in real PostgreSQL survives failure and is served by the accredited bridge', async () => {
    const [prerequisiteMigrationSql, preTargetMigrationSql] = await Promise.all([
      readFile(sourcePrerequisiteMigration, 'utf8'),
      readFile(sourcePreTargetMigration, 'utf8'),
    ]);
    const user = 'cauce_deploy_test';
    const database = 'cauce_deploy_test';
    const container = await new GenericContainer('postgres:16-alpine')
      .withEnvironment({ POSTGRES_USER: user, POSTGRES_PASSWORD: 'test-only-password', POSTGRES_DB: database })
      .withExposedPorts(5432)
      .withHealthCheck({
        test: ['CMD-SHELL', `pg_isready -U ${user} -d ${database}`],
        interval: 1_000,
        timeout: 3_000,
        retries: 60,
        startPeriod: 1_000,
      })
      .withWaitStrategy(Wait.forHealthCheck())
      .start();
    try {
      const initialized = await container.exec([
        'psql', '-v', 'ON_ERROR_STOP=1', '-U', user, '-d', database, '-c',
        `CREATE TABLE schema_migrations(version text PRIMARY KEY);
         CREATE TABLE audit_events(
           id bigserial PRIMARY KEY,tenant_id text NOT NULL,actor_alias text NOT NULL,
           action text NOT NULL,decision text NOT NULL,metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
           created_at timestamptz NOT NULL DEFAULT now()
         );
         CREATE TABLE connection_leases(tenant_id text NOT NULL, connection_token uuid NOT NULL);
         INSERT INTO connection_leases(tenant_id,connection_token)
           VALUES ('tenant-test','11111111-1111-4111-8111-111111111111');
         CREATE TABLE terminal_sessions(
           id uuid PRIMARY KEY,ticket_sha256 bytea NOT NULL,closed_at timestamptz,revoked_at timestamptz,
           relay_claim_epoch bigint NOT NULL DEFAULT 0,
           request_id uuid NOT NULL,request_sha256 bytea NOT NULL,
           browser_owner_sha256 bytea NOT NULL,browser_owner_generation bigint NOT NULL
         );
         INSERT INTO terminal_sessions(
           id,ticket_sha256,closed_at,request_id,request_sha256,
           browser_owner_sha256,browser_owner_generation
         ) VALUES (
           '22222222-2222-4222-8222-222222222222',decode(repeat('ab',32),'hex'),now(),
           '22222222-2222-4222-8222-222222222222',decode(repeat('ab',32),'hex'),
           decode(repeat('ab',32),'hex'),1
         );
         CREATE TABLE agent_profiles(
           tenant_id text NOT NULL,alias text NOT NULL,revision bigint NOT NULL DEFAULT 1,
           PRIMARY KEY(tenant_id,alias)
         );
         CREATE TABLE deliveries(id uuid PRIMARY KEY);
         CREATE TABLE shadow_router_inbox(
           id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
           direction text NOT NULL,source_event_id text NOT NULL,tenant_id text NOT NULL,
           mode text NOT NULL,correlation jsonb NOT NULL,envelope jsonb NOT NULL,
           status text NOT NULL DEFAULT 'pending',attempts integer NOT NULL DEFAULT 0,
           max_attempts integer NOT NULL DEFAULT 5,available_at timestamptz NOT NULL DEFAULT now(),
           claimed_by text,claim_token uuid,claim_expires_at timestamptz,last_error text,
           created_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz,
           UNIQUE(direction,source_event_id)
         );
         CREATE TABLE shadow_router_mappings(
           direction text NOT NULL,source_event_id text NOT NULL,tenant_id text NOT NULL,
           mode text NOT NULL,target_event_id uuid NOT NULL DEFAULT gen_random_uuid(),
           correlation jsonb NOT NULL,status text NOT NULL DEFAULT 'processing',
           created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
           PRIMARY KEY(direction,source_event_id),UNIQUE(target_event_id)
         );
         ${prerequisiteMigrationSql}
         INSERT INTO schema_migrations VALUES ('${prerequisiteSchema}');
         ${preTargetMigrationSql}
         INSERT INTO schema_migrations VALUES ('${preTargetSchema}');`,
      ]);
      expect(initialized.exitCode, initialized.stderr).toBe(0);
      const value = await fixture({ containerId: container.getId(), user, database }, 3);
      const writerFleet = { FAKE_WITH_WRITERS: '1', FAKE_EXTERNAL_WRITER: '1' };
      const token = await confirmation(value, writerFleet);
      const result = run(value, 'deploy', {
        ...writerFleet,
        CAUCE_DEPLOY_CONFIRM: token,
        FAKE_FAIL_STAGE: 'health',
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('accredited target-schema bridge');
      expect(await readFile(value.envFile, 'utf8')).toContain(
        `CAUCE_RUNTIME_IMAGE=${value.values.bridgeRuntime}`,
      );
      const observed = await container.exec([
        'psql', '-U', user, '-d', database, '-At', '-c',
        'SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1',
      ]);
      expect(observed.exitCode, observed.stderr).toBe(0);
      expect(observed.output.trim()).toBe(targetSchema);
      const calls = await readFile(value.log, 'utf8');
      expect(calls).toMatch(/WRITER check lock=9[\s\S]*SWAP bridge lock=9[\s\S]*WRITER marker mode=rollback_bridge_degraded expected=0 observed=0 lock=9/u);
      const bridgeUp = calls.split('\n').find((line) =>
        line.includes('COMPOSE prod up') && line.includes('state=bridge'));
      const finalState = JSON.parse(await readFile(value.state, 'utf8')) as {
        DISPATCHER_STOPPED?: boolean;
      };
      expect(bridgeUp).toBeDefined();
      expect(bridgeUp).not.toContain('dispatcher');
      expect(calls).not.toContain('COMPOSE prod exec -T dispatcher');
      expect(finalState.DISPATCHER_STOPPED).toBe(true);
      const adopted = await container.exec([
        'psql', '-U', user, '-d', database, '-At', '-c',
        `SELECT
           (SELECT count(*) FROM information_schema.columns
             WHERE table_schema='public' AND table_name IN (
               'agent_profile_runtime_expectations','agent_profile_runtime_adoptions'))::text || ':' ||
           (SELECT count(*) FROM pg_proc
             WHERE pronamespace='public'::regnamespace AND proname IN (
               'cauce_profile_runtime_documents_valid',
               'cauce_profile_runtime_adoption_matches_expectation'))::text || ':' ||
           (SELECT count(*) FROM pg_trigger
             WHERE tgrelid='agent_profile_runtime_adoptions'::regclass
               AND tgname='agent_profile_runtime_adoptions_expectation_guard'
               AND tgenabled='O' AND NOT tgisinternal)::text || ':' ||
           ((SELECT count(*) FROM agent_profile_runtime_expectations) +
            (SELECT count(*) FROM agent_profile_runtime_adoptions))::text || ':' ||
           (SELECT count(*) FROM pg_class
             WHERE relnamespace='public'::regnamespace
               AND relname IN (
                 'audit_events_console_publish_key_037_idx',
                 'audit_events_console_publish_nonce_037_idx',
                 'audit_events_console_publish_rate_037_idx',
                 'audit_events_console_publish_head_037_idx'
               ))::text`,
      ]);
      expect(adopted.exitCode, adopted.stderr).toBe(0);
      expect(adopted.output.trim()).toBe('17:2:1:0:4');
    } finally {
      await container.stop();
    }
  }, 120_000);

  test('source, Make, runbook and operations digest expose one canonical forward path', async () => {
    const [
      source, releaseCandidate, captureWriter, compose, make, runbook, rollback, systemdUnit,
      systemdWrapper, releaseCandidateMetadata,
    ] = await Promise.all([
      readFile(sourceScript, 'utf8'),
      readFile(sourceReleaseCandidate, 'utf8'),
      readFile(captureWriterScript, 'utf8'),
      readFile(composeFile, 'utf8'),
      readFile(makefile, 'utf8'),
      readFile(deployRunbook, 'utf8'),
      readFile(rollbackRunbook, 'utf8'),
      readFile(systemdComposeUnit, 'utf8'),
      readFile(systemdStackWrapper, 'utf8'),
      stat(sourceReleaseCandidate),
    ]);
    expect(source).not.toMatch(/^\s*docker\s+(?:build|tag|save|load)\b/mu);
    expect(source).not.toMatch(/^\s*(?:ssh|scp|rsync)\b/mu);
    expect(source).not.toMatch(/^\s*(?:source|\.)\s+.*CAUCE_ENV_FILE/mu);
    expect(source).toContain('pin-production-release.py');
    expect(source).toContain('locked-exec');
    expect(source).toContain('--lock-fd');
    expect(source).toContain('CAUCE_DEPLOY_TARGET_OVERRIDE_MANIFEST_SHA256');
    expect(source).toContain('direct production migration is disabled');
    expect(source).toContain('schemaCompatibility"]["compatibleThrough"');
    expect(source).not.toContain('030_dlq_causal_reconciliation.sql');
    expect(source).toContain('system_path=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin');
    const hostVerification = releaseCandidate.slice(
      releaseCandidate.indexOf('def verify_final_release_host'),
      releaseCandidate.indexOf('# Every artifact is compared'),
    );
    const broadGate = hostVerification.indexOf('"release-gate.sh"');
    expect(broadGate).toBeGreaterThan(0);
    expect(hostVerification.indexOf('verify_selected_writer_active_set')).toBeLessThan(broadGate);
    expect(hostVerification.lastIndexOf('verify_selected_writer_active_set')).toBeGreaterThan(broadGate);
    expect(releaseCandidateMetadata.mode & 0o111).toBe(0o111);
    expect(captureWriter).not.toMatch(/^\s*docker\s+(?:build|tag|save|load)\b/mu);
    expect(captureWriter).not.toMatch(/^\s*(?:ssh|scp|rsync)\b/mu);
    expect(captureWriter).not.toMatch(/^\s*(?:source|\.)\s+.*CAUCE_ENV_FILE/mu);
    expect(captureWriter).toContain('pin-production-release.py');
    expect(captureWriter).toContain('locked-exec');
    expect(captureWriter).toContain('release-writer-state.py');
    expect(compose).toContain('CAUCE_RELEASE_STATE_FILE: /run/secrets/release_state');
    expect(compose).toContain('restart: unless-stopped');
    expect(compose.match(/- source: release_state/gu)).toHaveLength(1);
    expect(compose).toContain('file: ${CAUCE_ROLLBACK_WRITER_SNAPSHOT_FILE:?set the selected writer snapshot}.state.json');
    expect(make).toMatch(/^release-deploy-preflight:/mu);
    expect(make).toMatch(/^release-deploy:/mu);
    expect(make).toMatch(/^release-rotate-writer-snapshot:/mu);
    expect(make).toMatch(/^release-bootstrap-legacy:/mu);
    expect(make).toMatch(/^release-bootstrap-manifest-sha:/mu);
    expect(make).toMatch(/^prod-up:[^\n]*\n\s+.*deploy-release\.sh prod-up/mu);
    expect(make).toMatch(/^prod-down:[^\n]*\n\s+.*deploy-release\.sh prod-down/mu);
    expect(make).toMatch(/^migrate:[^\n]*DESHABILITADO[^\n]*\n\s+@\.\/scripts\/migrate\.sh/mu);
    expect(make).not.toMatch(/^migrate:[^\n]*\n\s+.*deploy-release\.sh migrate/mu);
    expect(make).toContain('./scripts/deploy-release.sh');
    expect(make).not.toMatch(/^\s+.*pin-production-release\.py\s+swap\b/mu);
    expect(runbook).toContain('pin-production-release.py locked-exec');
    expect(runbook).toContain('release-deploy-preflight');
    expect(runbook).toContain('release-deploy');
    expect(runbook).toContain('release-bootstrap-legacy');
    expect(runbook).toContain('CAUCE_DEPLOY_TARGET_OVERRIDE_MANIFEST_SHA256');
    expect(runbook).toContain('CAUCE_DEPLOY_LEGACY_SNAPSHOT_FILE');
    expect(runbook).toContain('`make -C ops migrate` es un tombstone que falla cerrado');
    expect(runbook).toContain('Nunca vuelve al runtime viejo ni al mosaico después de esa frontera');
    expect(runbook).toContain('No invocar `pin-production-release.py swap` aisladamente.');
    expect(rollback).toContain('Nunca se restaura el runtime');
    expect(rollback).toContain('viejo ni el mosaico fragmentado después de esa frontera durable.');
    expect(rollback).toContain('código 72');
    expect(systemdUnit).toContain('ExecStart=/opt/cauce-v3/ops/scripts/systemd-stack.sh %i start');
    expect(systemdUnit).toContain('ExecReload=/opt/cauce-v3/ops/scripts/systemd-stack.sh %i reload');
    expect(systemdUnit).not.toContain('compose.sh %i up');
    expect(systemdWrapper).toContain('exec "$ROOT/scripts/deploy-release.sh" prod-up');
    expect(systemdWrapper).toContain('exec "$ROOT/scripts/deploy-release.sh" prod-down');

    const covered = spawnSync('python3', [operationsDigest, '--list'], { encoding: 'utf8' });
    expect(covered.status, covered.stderr).toBe(0);
    expect(covered.stdout.split('\n')).toContain('scripts/deploy-release.sh');
  });
});
