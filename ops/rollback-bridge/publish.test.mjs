import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const bridgeDirectory = dirname(fileURLToPath(import.meta.url));
const repository = resolve(bridgeDirectory, '../..');
const patchPath = join(bridgeDirectory, 'rollback-bridge-schema029.patch');
const metadataPath = join(bridgeDirectory, 'metadata.json');
const publisherPath = join(bridgeDirectory, 'publish.sh');
const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
const publication = metadata.imagePublication;
const patchSha256 = metadata.patchSetSha256;
const resultTree = metadata.resultingBridgeTree;
const nodeBase = publication.pinnedNodeBaseRepositoryDigest;
const pythonBase = publication.pinnedPythonBaseRepositoryDigest;
const targetPlatform = publication.targetPlatform;
const manifestMediaType = 'application/vnd.oci.image.manifest.v1+json';
const indexMediaType = 'application/vnd.oci.image.index.v1+json';
const nodeId = `sha256:${'1'.repeat(64)}`;
const pythonId = `sha256:${'2'.repeat(64)}`;
const imageId = `sha256:${'3'.repeat(64)}`;
const recoveredMismatchId = `sha256:${'4'.repeat(64)}`;
const repositoryDigest = `registry.invalid/cauce/bridge@sha256:${'5'.repeat(64)}`;
const sourceDigest = `sha256:${'6'.repeat(64)}`;
const scratch = [];

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

async function executable(path, content) {
  await writeFile(path, content);
  await chmod(path, 0o755);
}

function git(cwd, args, options = {}) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', ...options });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function baseInspect(reference, id, overrides = {}) {
  return {
    Id: id,
    RepoDigests: [reference],
    Descriptor: { digest: reference.split('@')[1], mediaType: manifestMediaType, size: 1 },
    Os: 'linux',
    Architecture: 'amd64',
    ...overrides,
  };
}

function runtimeLabels(overrides = {}) {
  return {
    'io.cauce.schema.compatible-through': '037_console_publish_intent_indexes.sql',
    'io.cauce.source.digest': sourceDigest,
    'io.cauce.source.runtime': sourceDigest,
    'io.cauce.rollback-bridge.tree': resultTree,
    'io.cauce.rollback-bridge.patch-sha256': patchSha256,
    'io.cauce.rollback-bridge.read-only': 'server-v2',
    'io.cauce.base.node.repository-digest': nodeBase,
    'io.cauce.base.python.repository-digest': pythonBase,
    'io.cauce.target-platform': targetPlatform,
    'org.opencontainers.image.base.name': nodeBase,
    ...overrides,
  };
}

function runtimeInspect({ published = false, id = imageId, mediaType = manifestMediaType,
  os = 'linux', architecture = 'amd64', labels = runtimeLabels() } = {}) {
  return {
    Id: id,
    RepoDigests: published ? [repositoryDigest] : [],
    Descriptor: {
      digest: published ? repositoryDigest.split('@')[1] : imageId,
      mediaType,
      size: 1,
    },
    Os: os,
    Architecture: architecture,
    Config: { Labels: labels },
  };
}

async function publisherFixture({
  node = baseInspect(nodeBase, nodeId),
  python = baseInspect(pythonBase, pythonId),
  built = runtimeInspect(),
  published = runtimeInspect({ published: true }),
  pull = '0',
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'cauce-bridge-publisher-test.'));
  scratch.push(root);
  const scriptDirectory = join(root, 'ops/rollback-bridge');
  const context = join(scriptDirectory, 'context');
  const evidenceDirectory = join(root, 'private-evidence');
  const fakeBin = join(root, 'bin');
  await Promise.all([
    mkdir(join(context, 'deploy'), { recursive: true }),
    mkdir(join(context, 'ops/scripts'), { recursive: true }),
    mkdir(evidenceDirectory, { mode: 0o700 }),
    mkdir(fakeBin),
  ]);
  const dockerfile = [
    `ARG CAUCE_NODE_BASE=${nodeBase}`,
    `ARG CAUCE_PYTHON_BASE=${pythonBase}`,
    `ARG CAUCE_TARGET_PLATFORM=${targetPlatform}`,
    'FROM ${CAUCE_NODE_BASE} AS build',
    'FROM ${CAUCE_NODE_BASE} AS production-dependencies',
    'FROM ${CAUCE_PYTHON_BASE} AS python-runtime',
    'FROM ${CAUCE_NODE_BASE} AS runtime',
    'COPY --from=python-runtime /usr/local /usr/local',
    'COPY deploy/fleet-snapshot.mjs deploy/runtime-package-smoke.mjs ./deploy/',
    'LABEL io.cauce.schema.compatible-through=${CAUCE_SCHEMA_COMPATIBLE_THROUGH} \\',
    '  io.cauce.source.digest=${CAUCE_SOURCE_DIGEST} \\',
    '  io.cauce.rollback-bridge.tree=${CAUCE_BRIDGE_TREE} \\',
    '  io.cauce.rollback-bridge.patch-sha256=${CAUCE_BRIDGE_PATCH_SHA256} \\',
    '  io.cauce.rollback-bridge.read-only=server-v2 \\',
    '  io.cauce.base.node.repository-digest=${CAUCE_NODE_BASE} \\',
    '  io.cauce.base.python.repository-digest=${CAUCE_PYTHON_BASE} \\',
    '  io.cauce.target-platform=${CAUCE_TARGET_PLATFORM} \\',
    '  org.opencontainers.image.base.name=${CAUCE_NODE_BASE}',
    '',
  ].join('\n');
  const publisherSource = (await readFile(publisherPath, 'utf8')).replace(
    'system_path=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    `system_path=${fakeBin}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
  );
  assert.notEqual(publisherSource, await readFile(publisherPath, 'utf8'));
  await Promise.all([
    writeFile(join(scriptDirectory, 'publish.sh'), publisherSource),
    writeFile(join(scriptDirectory, 'rollback-bridge-schema029.patch'), await readFile(patchPath)),
    writeFile(join(scriptDirectory, 'metadata.json'), await readFile(metadataPath)),
    writeFile(join(context, 'deploy/Dockerfile'), dockerfile),
    writeFile(join(context, 'deploy/fleet-snapshot.mjs'), 'process.stdout.write("fleet snapshot fixture\\n");\n'),
    writeFile(join(context, 'deploy/runtime-package-smoke.mjs'), 'process.stdout.write("package fixture\\n");\n'),
  ]);
  await executable(
    join(context, 'ops/scripts/source-digest.py'),
    `#!/usr/bin/env python3\nprint(${JSON.stringify(sourceDigest)})\n`,
  );
  await executable(
    join(scriptDirectory, 'build.sh'),
    `#!/bin/sh
set -eu
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
tar -cf "$1" -C "$script_dir/context" .
`,
  );
  const dockerLog = join(root, 'docker.log');
  await executable(
    join(fakeBin, 'docker'),
    `#!/bin/sh
set -eu
printf 'buildkit=%s %s host=%s context=%s config=%s\n' \
  "\${DOCKER_BUILDKIT:-unset}" "$*" "\${DOCKER_HOST:-}" "\${DOCKER_CONTEXT:-}" \
  "\${DOCKER_CONFIG:-}" >> "$FAKE_DOCKER_LOG"
if [ "$1" = build ] && [ "\${2:-}" = --help ]; then [ "\${DOCKER_BUILDKIT:-unset}" = 0 ]; exit; fi
if [ "$1" = build ] || [ "$1" = run ] || [ "$1" = tag ] || [ "$1" = push ] || [ "$1" = pull ]; then exit 0; fi
if [ "$1" = image ] && [ "$2" = inspect ]; then
  last=
  for value in "$@"; do last=$value; done
  case "$*" in
    *'{{json .RepoDigests}}'*) printf '%s\n' "$FAKE_REPO_DIGESTS" ;;
    *'{{json .}}'*)
      if [ "$last" = "$CAUCE_BRIDGE_NODE_BASE" ]; then value=$FAKE_NODE_INSPECT
      elif [ "$last" = "$CAUCE_BRIDGE_PYTHON_BASE" ]; then value=$FAKE_PYTHON_INSPECT
      elif echo "$last" | grep -q '@sha256:'; then value=$FAKE_PUBLISHED_INSPECT
      else value=$FAKE_BUILT_INSPECT
      fi
      [ -n "$value" ] || exit 1
      printf '%s\n' "$value" ;;
    *) exit 1 ;;
  esac
  exit 0
fi
exit 1
`,
  );
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'bridge@test.invalid']);
  git(root, ['config', 'user.name', 'Bridge Test']);
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'bridge publisher fixture']);
  const commit = git(root, ['rev-parse', 'HEAD']);
  const bindPatchSource = (value) => ({
    ...value,
    Config: {
      ...value.Config,
      Labels: {
        ...value.Config.Labels,
        'io.cauce.rollback-bridge.patch-source-commit': commit,
      },
    },
  });
  built = bindPatchSource(built);
  published = bindPatchSource(published);
  return {
    root,
    commit,
    dockerLog,
    output: join(evidenceDirectory, 'bridge-build.json'),
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      FAKE_DOCKER_LOG: dockerLog,
      FAKE_NODE_INSPECT: node === undefined ? '' : JSON.stringify(node),
      FAKE_PYTHON_INSPECT: python === undefined ? '' : JSON.stringify(python),
      FAKE_BUILT_INSPECT: JSON.stringify(built),
      FAKE_PUBLISHED_INSPECT: JSON.stringify(published),
      FAKE_REPO_DIGESTS: JSON.stringify([repositoryDigest]),
      CAUCE_BRIDGE_RUNTIME_REPOSITORY: 'registry.invalid/cauce/bridge',
      CAUCE_BRIDGE_NODE_BASE: nodeBase,
      CAUCE_BRIDGE_PYTHON_BASE: pythonBase,
      CAUCE_BRIDGE_PATCH_SOURCE_COMMIT: commit,
      CAUCE_BRIDGE_PULL: pull,
    },
  };
}

function publish(fixture, environment = {}) {
  return spawnSync('bash', [join(fixture.root, 'ops/rollback-bridge/publish.sh'), fixture.output], {
    cwd: fixture.root,
    env: { ...fixture.env, ...environment },
    encoding: 'utf8',
  });
}

test.afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test('the pinned patch reproduces one tree with exact migrations and a pinned Python stage', async () => {
  assert.equal(metadata.schemaVersion, 7);
  assert.equal(publication.targetPlatform, 'linux/amd64');
  assert.equal(publication.lifecycleEvidenceSchemaVersion, 11);
  assert.equal(metadata.schemaContract.schemaLatest, '037_console_publish_intent_indexes.sql');
  assert.deepEqual(Object.keys(metadata.schemaContract.candidateMigrationInputs), [
    '024_agent_role_templates.sql',
    '026_agent_profile.sql',
    '027_rol_agent_notify.sql',
    '028_canonical_agent_role.sql',
    '029_reconcile_declared_fleet.sql',
    '030_dlq_causal_reconciliation.sql',
    '031_connection_session_fencing.sql',
    '032_terminal_session_claim_fencing.sql',
    '033_terminal_browser_owner_fencing.sql',
    '034_terminal_relay_instance_fencing.sql',
    '035_agent_profile_runtime_adoption.sql',
    '036_shadow_router_target_phase.sql',
    '037_console_publish_intent_indexes.sql',
  ]);
  assert.deepEqual(Object.keys(metadata.schemaContract.candidateDownMigrationInputs), [
    '024_agent_role_templates.sql',
    '026_agent_profile.sql',
    '028_canonical_agent_role.sql',
    '029_reconcile_declared_fleet.sql',
    '030_dlq_causal_reconciliation.sql',
    '031_connection_session_fencing.sql',
    '032_terminal_session_claim_fencing.sql',
    '033_terminal_browser_owner_fencing.sql',
    '034_terminal_relay_instance_fencing.sql',
    '035_agent_profile_runtime_adoption.sql',
    '036_shadow_router_target_phase.sql',
    '037_console_publish_intent_indexes.sql',
  ]);
  const patch = await readFile(patchPath);
  assert.equal(sha256(patch), metadata.patchSetSha256);
  for (const [migration, expectedDigest] of Object.entries(metadata.schemaContract.candidateMigrationInputs)) {
    const source = await readFile(join(repository, 'packages/store/migrations', migration));
    assert.equal(sha256(source), expectedDigest, `candidate migration digest drifted: ${migration}`);
  }
  for (const [migration, expectedDigest] of Object.entries(metadata.schemaContract.candidateDownMigrationInputs)) {
    const source = await readFile(join(repository, 'packages/store/migrations/down', migration));
    assert.equal(sha256(source), expectedDigest, `candidate down migration digest drifted: ${migration}`);
  }

  const directory = await mkdtemp(join(tmpdir(), 'cauce-bridge-index-test.'));
  scratch.push(directory);
  const index = join(directory, 'index');
  const env = { ...process.env, GIT_INDEX_FILE: index };
  git(repository, ['read-tree', `${metadata.originBaseCommit}^{tree}`], { env });
  const applied = spawnSync('git', ['apply', '--cached', '--whitespace=nowarn', patchPath], {
    cwd: repository, env, encoding: 'utf8',
  });
  assert.equal(applied.status, 0, applied.stderr);
  const tree = git(repository, ['write-tree'], { env });
  assert.equal(tree, metadata.resultingBridgeTree);

  for (const [directory, inputs] of [
    ['packages/store/migrations', metadata.schemaContract.candidateMigrationInputs],
    ['packages/store/migrations/down', metadata.schemaContract.candidateDownMigrationInputs],
  ]) {
    for (const [migration, expectedDigest] of Object.entries(inputs)) {
      const shown = spawnSync('git', ['show', `${tree}:${directory}/${migration}`], { cwd: repository });
      assert.equal(shown.status, 0, shown.stderr.toString());
      assert.equal(sha256(shown.stdout), expectedDigest, `bridge tree migration drifted: ${directory}/${migration}`);
    }
  }

  const dockerfile = git(repository, ['show', `${tree}:deploy/Dockerfile`]);
  const fleetSnapshot = git(repository, ['show', `${tree}:deploy/fleet-snapshot.mjs`]);
  const packageSmoke = git(repository, ['show', `${tree}:deploy/runtime-package-smoke.mjs`]);
  assert.equal(fleetSnapshot, (await readFile(join(repository, 'deploy/fleet-snapshot.mjs'), 'utf8')).trimEnd());
  assert.match(dockerfile, new RegExp(`ARG CAUCE_NODE_BASE=${nodeBase}`, 'u'));
  assert.match(dockerfile, new RegExp(`ARG CAUCE_PYTHON_BASE=${pythonBase}`, 'u'));
  assert.match(dockerfile, /FROM \$\{CAUCE_PYTHON_BASE\} AS python-runtime/u);
  assert.match(dockerfile, /COPY --from=python-runtime \/usr\/local \/usr\/local/u);
  assert.doesNotMatch(dockerfile, /^\s*RUN\s+apk\s+add\b/mu);
  assert.doesNotMatch(dockerfile, /^\s*COPY\b.*--chmod=/mu);
  assert.match(dockerfile, /io\.cauce\.base\.python\.repository-digest/u);
  assert.match(dockerfile, /io\.cauce\.target-platform/u);
  assert.match(dockerfile, /io\.cauce\.rollback-bridge\.read-only=server-v2/u);
  const runtimeCopy = dockerfile.split('\n').find((line) => (
    line.startsWith('COPY --chown=node:node deploy/readiness-probe.mjs ')
  ));
  assert.ok(runtimeCopy);
  for (const path of [
    'deploy/fleet-snapshot.mjs',
    'deploy/outbox-metrics-core.mjs',
    'deploy/release-state-metrics.mjs',
    'deploy/runtime-package-smoke.mjs',
    'deploy/rollback-bridge-http-probe.mjs',
  ]) assert.ok(runtimeCopy.includes(path), `runtime image omits ${path}`);
  assert.match(packageSmoke, /const harnessStartStderr = '<<cauce:harness-started>>\\n';/u);
});

test('pull=0 uses local child manifests, emits platform evidence and never pulls', async () => {
  const fixture = await publisherFixture();
  const result = publish(fixture);
  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(await readFile(fixture.output, 'utf8'));
  assert.equal((await stat(fixture.output)).mode & 0o777, 0o600);
  assert.equal(evidence.schemaVersion, 2);
  assert.deepEqual(evidence.baseImages.node, {
    role: 'node', repositoryDigest: nodeBase, manifestDigest: nodeBase.split('@')[1],
    mediaType: manifestMediaType, platform: { os: 'linux', architecture: 'amd64' }, imageId: nodeId,
  });
  assert.deepEqual(evidence.baseImages.python, {
    role: 'python', repositoryDigest: pythonBase, manifestDigest: pythonBase.split('@')[1],
    mediaType: manifestMediaType, platform: { os: 'linux', architecture: 'amd64' }, imageId: pythonId,
  });
  assert.equal(evidence.sourceRevision.resultingBridgeTree, resultTree);
  assert.equal(evidence.runtime.repositoryDigest, repositoryDigest);
  assert.equal(evidence.runtime.imageId, imageId);
  assert.equal(evidence.runtime.manifestDigest, repositoryDigest.split('@')[1]);
  assert.equal(evidence.runtime.mediaType, manifestMediaType);
  assert.deepEqual(evidence.runtime.platform, { os: 'linux', architecture: 'amd64' });
  assert.deepEqual(evidence.runtime.labels, {
    ...runtimeLabels(),
    'io.cauce.rollback-bridge.patch-source-commit': fixture.commit,
  });
  assert.equal(evidence.verification.registryPullPerformed, false);
  assert.equal(evidence.verification.repositoryDigestRecoveredImageId, false);
  assert.equal(evidence.verification.repositoryDigestResolvedToTestedImageId, true);
  assert.equal(evidence.verification.pythonRuntimeSmoke, 'passed');

  const calls = await readFile(fixture.dockerLog, 'utf8');
  assert.match(calls, /buildkit=0 build --platform linux\/amd64/u);
  assert.match(calls, new RegExp(`--build-arg CAUCE_PYTHON_BASE=${pythonBase}`, 'u'));
  assert.match(calls, /run --rm --network none --platform linux\/amd64 --entrypoint python3/u);
  assert.match(calls, new RegExp(`push registry\\.invalid/cauce/bridge:schema037-${resultTree}-${'3'.repeat(64)}`, 'u'));
  assert.doesNotMatch(calls, /(?:^|\n)buildkit=\S+ pull\b/u);
  assert.doesNotMatch(calls, /build --pull\b/u);
  assert.doesNotMatch(calls, /buildx/u);
});

test('publisher pins Docker daemon, context and credential directory despite ambient controls', async () => {
  const fixture = await publisherFixture();
  const result = publish(fixture, {
    DOCKER_HOST: 'tcp://poison.invalid:2376',
    DOCKER_CONTEXT: 'poison-context',
    DOCKER_CONFIG: '/tmp/poison-docker-config',
    DOCKER_TLS_VERIFY: '1',
    DOCKER_CERT_PATH: '/tmp/poison-certificates',
  });
  assert.equal(result.status, 0, result.stderr);
  const calls = await readFile(fixture.dockerLog, 'utf8');
  assert.doesNotMatch(calls, /poison/u);
  for (const line of calls.trim().split('\n')) {
    assert.match(line, / host=unix:\/\/\/var\/run\/docker\.sock context= config=\/[^\s]*\/\.docker$/u);
  }
});

test('publisher discards exported Bash functions before resolving Docker', async () => {
  const fixture = await publisherFixture();
  const poisonMarker = join(fixture.root, 'exported-docker-function-ran');
  const result = spawnSync('bash', [
    '-c',
    'docker() { /usr/bin/touch "$3"; return 42; }; export -f docker; exec bash "$1" "$2"',
    'publisher-function-probe',
    join(fixture.root, 'ops/rollback-bridge/publish.sh'),
    fixture.output,
    poisonMarker,
  ], {
    cwd: fixture.root,
    env: fixture.env,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  await assert.rejects(stat(poisonMarker));
  const calls = await readFile(fixture.dockerLog, 'utf8');
  assert.match(calls, /buildkit=0 build --platform linux\/amd64/u);
});

test('pull=1 pulls both bases and the published digest with one exact platform', async () => {
  const fixture = await publisherFixture({ pull: '1' });
  const result = publish(fixture);
  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(await readFile(fixture.output, 'utf8'));
  assert.equal(evidence.verification.registryPullPerformed, true);
  assert.equal(evidence.verification.repositoryDigestRecoveredImageId, true);
  const calls = await readFile(fixture.dockerLog, 'utf8');
  assert.match(calls, new RegExp(`pull --platform linux/amd64 ${nodeBase}`, 'u'));
  assert.match(calls, new RegExp(`pull --platform linux/amd64 ${pythonBase}`, 'u'));
  assert.match(calls, new RegExp(`pull --platform linux/amd64 ${repositoryDigest}`, 'u'));
  assert.match(calls, /build --pull --platform linux\/amd64/u);
});

test('pull=0 fails closed when a pinned base is not already locally inspectable', async () => {
  const fixture = await publisherFixture({ python: null });
  const result = publish(fixture);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Python base is not a locally bound linux\/amd64 child manifest/u);
  const calls = await readFile(fixture.dockerLog, 'utf8');
  assert.doesNotMatch(calls, /\bpull\b/u);
  assert.doesNotMatch(calls, /build .*--target runtime/u);
  assert.doesNotMatch(calls, /\bpush\b/u);
  await assert.rejects(readFile(fixture.output));
});

test('publisher rejects index manifests and foreign base architectures before build', async () => {
  for (const [role, replacement, error] of [
    ['node', baseInspect(nodeBase, nodeId, { Descriptor: { digest: nodeBase.split('@')[1], mediaType: indexMediaType } }), /Node base/u],
    ['python', baseInspect(pythonBase, pythonId, { Architecture: 'arm64' }), /Python base/u],
  ]) {
    const fixture = await publisherFixture({ [role]: replacement });
    const result = publish(fixture);
    assert.equal(result.status, 1);
    assert.match(result.stderr, error);
    const calls = await readFile(fixture.dockerLog, 'utf8');
    assert.doesNotMatch(calls, /build .*--target runtime/u);
    assert.doesNotMatch(calls, /\bpush\b/u);
    await assert.rejects(readFile(fixture.output));
  }
});

test('publisher rejects a built provenance mismatch before registry publication', async () => {
  const fixture = await publisherFixture({
    built: runtimeInspect({ labels: runtimeLabels({ 'io.cauce.rollback-bridge.tree': '0'.repeat(40) }) }),
  });
  const result = publish(fixture);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /built image identity, labels or platform mismatch/u);
  const calls = await readFile(fixture.dockerLog, 'utf8');
  assert.doesNotMatch(calls, /\bpush\b/u);
  await assert.rejects(readFile(fixture.output));
});

test('publisher rejects published ID, manifest media, platform and label drift', async () => {
  const cases = [
    runtimeInspect({ published: true, id: recoveredMismatchId }),
    runtimeInspect({ published: true, mediaType: indexMediaType }),
    runtimeInspect({ published: true, architecture: 'arm64' }),
    runtimeInspect({ published: true, labels: runtimeLabels({ 'io.cauce.target-platform': 'linux/arm64' }) }),
  ];
  for (const published of cases) {
    const fixture = await publisherFixture({ published });
    const result = publish(fixture);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /published image identity, manifest, labels or platform mismatch/u);
    await assert.rejects(readFile(fixture.output));
  }
});

test('publisher refuses mutable and unapproved Node/Python base references', async () => {
  for (const [variable, value, error] of [
    ['CAUCE_BRIDGE_NODE_BASE', 'node:22-alpine', /Node base must be an immutable canonical RepoDigest/u],
    ['CAUCE_BRIDGE_NODE_BASE', `docker.io/library/node@sha256:${'7'.repeat(64)}`, /Node base differs from the tested pinned RepoDigest/u],
    ['CAUCE_BRIDGE_PYTHON_BASE', 'python:3-alpine', /Python base must be an immutable canonical RepoDigest/u],
    ['CAUCE_BRIDGE_PYTHON_BASE', `docker.io/library/python@sha256:${'8'.repeat(64)}`, /Python base differs from the tested pinned RepoDigest/u],
  ]) {
    const fixture = await publisherFixture();
    const result = publish(fixture, { [variable]: value });
    assert.equal(result.status, 2);
    assert.match(result.stderr, error);
    const calls = await readFile(fixture.dockerLog, 'utf8');
    assert.doesNotMatch(calls, /build .*--target runtime/u);
    assert.doesNotMatch(calls, /\bpush\b/u);
    await assert.rejects(readFile(fixture.output));
  }
});

test('publisher binds every executing bridge input to the exact source HEAD', async () => {
  const fixture = await publisherFixture();
  git(fixture.root, ['commit', '--allow-empty', '-qm', 'later unrelated source']);
  const result = publish(fixture);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /patch source commit must equal HEAD/u);
  const calls = await readFile(fixture.dockerLog, 'utf8');
  assert.doesNotMatch(calls, /build .*--target runtime/u);
  assert.doesNotMatch(calls, /\bpush\b/u);
  await assert.rejects(readFile(fixture.output));
});
