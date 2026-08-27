#!/usr/bin/env node
// Guards the source-digest domain split.
//
// The split exists because binding every evidence artifact to one whole-tree digest made an
// apps/console edit invalidate the compose-authentic fault-injection evidence, which costs a full
// release-host run to regenerate and has no causal relationship with the console. Expensive
// evidence plus spurious invalidation equals hand-edited evidence, which already happened.
//
// Narrowing a digest is the dangerous direction: it LOOSENS the gate. These tests pin the exact
// shape of the narrowing so nobody can widen the hole later without a test turning red:
//   * the only thing the runtime domain drops relative to the union is apps/console;
//   * everything that reaches the runtime image is still covered, including the lockfile, so a
//     console dependency change still moves the runtime digest;
//   * the harness that produces authentic evidence is covered by a domain of its own, closing the
//     opposite hole (evidence that proves less than it claims);
//   * every release consumer really passes --domain instead of silently taking the default.
//   * only the exact operator-owned _grafo scratch prefix is absent from every release digest.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ops = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(ops, '..');
const script = path.join(ops, 'scripts/source-digest.py');
const DIGEST = /^sha256:[a-f0-9]{64}$/u;

function run(args, options = {}) {
  return execFileSync('python3', [script, ...args], {
    encoding: 'utf8',
    cwd: root,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    ...options,
  }).trim();
}

function digestOf(domain, tree) {
  const args = ['--domain', domain];
  if (tree) args.push('--root', tree);
  const value = run(args);
  assert.match(value, DIGEST, `${domain} digest is malformed`);
  return value;
}

function pathsOf(domain, tree) {
  const args = ['--domain', domain, '--list'];
  if (tree) args.push('--root', tree);
  const listing = run(args);
  return new Set(listing ? listing.split('\n') : []);
}

// 1. Domain composition: full is exactly the union, and nothing is stranded outside every domain.
const runtimePaths = pathsOf('runtime');
const consolePaths = pathsOf('console');
const harnessPaths = pathsOf('harness');
const testcontainersPaths = pathsOf('testcontainers');
const verificationPaths = pathsOf('verification');
const fullPaths = pathsOf('full');
const union = new Set([
  ...runtimePaths, ...consolePaths, ...harnessPaths, ...testcontainersPaths, ...verificationPaths,
]);
assert.deepEqual([...fullPaths].sort(), [...union].sort(), 'full domain must be the exact union of the declared domains');

// 2. The ONLY narrowing: relative to the two image domains combined -- which is byte-for-byte the
//    set the pre-split whole-tree digest covered -- the runtime domain drops apps/console and
//    nothing else. This is the assertion that keeps the loosening from creeping.
const imageUnion = new Set([...runtimePaths, ...consolePaths]);
const missingFromRuntime = [...imageUnion].filter((entry) => !runtimePaths.has(entry));
assert(missingFromRuntime.length > 0, 'the console domain must actually contain files');
for (const entry of missingFromRuntime) {
  assert(
    entry.startsWith('apps/console/'),
    `runtime domain excludes '${entry}', which is not apps/console; every exclusion must be justified by an absent causal path to the runtime image`,
  );
}

// 3. Nothing under apps/console leaks into the runtime domain, and the console domain owns it all.
assert(
  ![...runtimePaths].some((entry) => entry.startsWith('apps/console/')),
  'runtime domain must not contain apps/console',
);
assert(
  runtimePaths.has('services/gateway/src/test-fixtures/mtls-server-certificate.pem'),
  'versioned PEM fixtures are source and must remain covered',
);
assert(
  ![...fullPaths].some((entry) => entry.startsWith('tests/fleet-release/artifacts/')),
  'timestamped fleet-release outputs must not enter verification/full',
);
assert(
  ![...fullPaths].some((entry) => entry.startsWith('tests/fleet-release/.matrix-state/')),
  'ephemeral fleet matrix state must not enter verification/full',
);
assert(
  ![...fullPaths].some((entry) => /(?:^|\/)cauce\.bak-/u.test(entry)),
  'Git-ignored operator backups must not enter verification/full',
);

for (const sentinel of [
  'tests/e2e/real-qa.test.ts',
  'tests/helpers/postgres.ts',
  'ops/harness/runner.mjs',
  'ops/scripts/run-testcontainers.sh',
  'ops/scripts/validate-testcontainers-evidence.py',
  'ops/schemas/testcontainers-evidence.schema.json',
]) {
  assert(testcontainersPaths.has(sentinel), `testcontainers domain lost coverage of ${sentinel}`);
}
for (const sentinel of [
  'ops/tests/source-digest-domains.test.mjs',
  'ops/Makefile',
  'ops/cli/cauce-huerfanas',
  'ops/compose.test.yaml',
  'ops/container-aliases.json',
  'ops/container-runtime/cauce-container-runtime.py',
  'ops/generated/systemd/SHA256SUMS',
  'ops/guardias/cauce-huerfanas.sh',
  'ops/manifests/kant.yaml',
  'ops/observability/alerts.yaml',
  'ops/runbooks/deploy.md',
  'ops/schemas/build-evidence.schema.json',
  'ops/scripts/source-digest.py',
  'eslint.config.js',
]) {
  assert(verificationPaths.has(sentinel), `verification domain lost coverage of ${sentinel}`);
}
assert(
  [...consolePaths].some((entry) => entry.startsWith('apps/console/src/')),
  'console domain must contain apps/console sources',
);

// 4. Everything that reaches the runtime image is still covered. These sentinels are the families
//    the `runtime` stage of deploy/Dockerfile copies from, plus the dependency-graph manifests that
//    keep a console dependency change visible to the runtime digest.
for (const sentinel of [
  '.dockerignore',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.json',
  'tsconfig.build.json',
  'deploy/Dockerfile',
  'deploy/runtime-entrypoint.sh',
  'deploy/runtime-store.package.json',
  'services/gateway/src/app.ts',
  'services/dispatcher/package.json',
  'services/telegram-bridge/package.json',
  'services/terminal-relay/package.json',
  'packages/protocol/package.json',
  'packages/store/package.json',
  'packages/adapter-sdk/package.json',
]) {
  assert(runtimePaths.has(sentinel), `runtime domain lost coverage of ${sentinel}`);
}

// 5. The harness domain covers the apparatus that decides what an authentic run reports.
for (const sentinel of [
  'ops/harness/authentic-runner.mjs',
  'ops/harness/authentic-external-server.mjs',
  'ops/harness/authentic-unix-target.mjs',
  'ops/harness/authentic-fixture-init.mjs',
  'ops/compose.authentic.yaml',
  'ops/scripts/fault-compose.sh',
  'ops/scripts/fault-runtime.sh',
  'ops/scripts/smoke-compose-authentic.sh',
  'ops/scripts/smoke-runtime-authentic.sh',
]) {
  assert(harnessPaths.has(sentinel), `harness domain lost coverage of ${sentinel}`);
}
assert(
  ![...runtimePaths].some((entry) => entry.startsWith('ops/')),
  'the harness must stay a separate domain; folding it into runtime would invalidate image evidence on harness edits',
);

// 6. Excluded families never contribute to any digest.
for (const entry of fullPaths) {
  for (const part of entry.split('/')) {
    assert(
      ![
        'node_modules', 'dist', 'coverage', '.git', '.serena', '.test-state', '.claude',
        '__pycache__', '.pytest_cache',
      ].includes(part),
      `excluded family leaked into a digest: ${entry}`,
    );
  }
  assert(!path.basename(entry).startsWith('.env'), `private env file leaked into a digest: ${entry}`);
  assert(!entry.endsWith('.pyc') && !entry.endsWith('.pyo'), `Python bytecode leaked into a digest: ${entry}`);
}

// 7. Determinism and distinctness.
assert.equal(digestOf('runtime'), digestOf('runtime'), 'digest must be deterministic');
const distinct = new Set([
  digestOf('runtime'), digestOf('console'), digestOf('harness'),
  digestOf('testcontainers'), digestOf('verification'), digestOf('full'),
]);
assert.equal(distinct.size, 6, 'each domain must produce its own digest');

// 8. An undeclared caller must fail CLOSED: the default is the strictest domain, never runtime.
assert.equal(run([]), digestOf('full'), 'the default domain must be full so a forgotten --domain over-covers instead of under-covering');
assert.throws(
  () => run(['--domain', 'everything'], { stdio: ['ignore', 'pipe', 'ignore'] }),
  'an unknown domain must be rejected rather than silently defaulted',
);

// 9. Behavioural proof on a synthetic tree: this is the actual claim being made about the redesign.
const sandbox = await mkdtemp(path.join(os.tmpdir(), 'cauce-source-domains-'));
try {
  const write = async (relative, contents) => {
    await mkdir(path.join(sandbox, path.dirname(relative)), { recursive: true });
    await writeFile(path.join(sandbox, relative), contents, 'utf8');
  };
  await write('package.json', '{"name":"fake"}\n');
  await write('.dockerignore', 'node_modules\n.env*\n');
  await write('pnpm-lock.yaml', 'lockfileVersion: 9\n');
  await write('pnpm-workspace.yaml', 'packages:\n  - packages/*\n');
  await write('tsconfig.json', '{}\n');
  await write('tsconfig.build.json', '{}\n');
  await write('vitest.config.ts', 'export default {};\n');
  await write('packages/store/src/index.ts', 'export const store = 1;\n');
  await write('services/gateway/src/app.ts', 'export const app = 1;\n');
  await write('deploy/runtime-entrypoint.sh', '#!/bin/sh\nexec "$@"\n');
  await write('scripts/gate-a.sh', '#!/bin/sh\nexit 0\n');
  await write('scripts/gate-b.sh', '#!/bin/sh\nexit 7\n');
  await write('unselected/gate.sh', '#!/bin/sh\nexit 9\n');
  await write('apps/console/src/App.tsx', 'export const App = () => null;\n');
  await write('apps/console/src/theme.css', '.panel { color: red; }\n');
  await write('apps/console/src/features/_grafo/consultas-grafo.sql', 'SELECT 1;\n');
  await write('ops/harness/authentic-runner.mjs', 'export const run = 1;\n');
  await write('ops/harness/runner.mjs', 'export const run = 1;\n');
  await write('ops/compose.authentic.yaml', 'services: {}\n');
  await write('ops/scripts/fault-runtime.sh', '#!/bin/sh\n');
  await write('ops/scripts/run-testcontainers.sh', '#!/bin/sh\n');
  await write('ops/scripts/validate-testcontainers-evidence.py', 'print("ok")\n');
  await write('ops/scripts/source-hygiene.py', 'print("hygiene")\n');
  await write('ops/scripts/migration-gate.mjs', 'export const migration = true;\n');
  await write('ops/scripts/physical-fleet-gate.py', 'print("fleet")\n');
  await write('ops/scripts/validate-fleet-release-evidence.py', 'print("evidence")\n');
  await write('ops/scripts/source-digest.py', '# fixture\n');
  await write('ops/scripts/validate.sh', '#!/bin/sh\nexit 0\n');
  await write('ops/schemas/build-evidence.schema.json', '{}\n');
  await write('ops/schemas/testcontainers-evidence.schema.json', '{}\n');
  await write('ops/tests/gate.test.mjs', 'export const gate = 1;\n');
  await write('tests/e2e/real-qa.test.ts', 'export const qa = 1;\n');
  await write('tests/helpers/postgres.ts', 'export const postgres = 1;\n');
  await write('tests/unit/example.test.ts', 'export const unit = 1;\n');
  await write('tests/unit/artifacts/fixture.pem', 'versioned fixture bytes\n');
  await write('tests/fleet-release/artifacts/report.json', '{"generatedAt":"2026-01-01T00:00:00Z"}\n');
  await write('tests/fleet-release/artifacts/junit.xml', '<testsuite timestamp="old"/>\n');
  await write('tests/fleet-release/artifacts/SHA256SUMS', 'old sums\n');
  await write('tests/fleet-release/.matrix-state/harness-logs/worker.log', 'initial harness state\n');
  await write('eslint.config.js', 'export default [];\n');
  await write('node_modules/evil/index.js', 'module.exports = 1;\n');
  await write('.env.production', 'SECRET=must-never-be-hashed\n');

  const before = {
    runtime: digestOf('runtime', sandbox),
    console: digestOf('console', sandbox),
    harness: digestOf('harness', sandbox),
    testcontainers: digestOf('testcontainers', sandbox),
    verification: digestOf('verification', sandbox),
    full: digestOf('full', sandbox),
  };

  // 9a. The fleet generator rewrites timestamped evidence. It must leave the initial source digest
  //     unchanged, while a same-named directory outside the producer-owned output root remains a
  //     covered fixture rather than being excluded by basename.
  await write('tests/fleet-release/artifacts/report.json', '{"generatedAt":"2026-08-26T13:45:00Z"}\n');
  await write('tests/fleet-release/artifacts/junit.xml', '<testsuite timestamp="new"/>\n');
  await write('tests/fleet-release/artifacts/SHA256SUMS', 'new sums\n');
  await write('tests/fleet-release/.matrix-state/harness-logs/worker.log', 'rewritten harness state\n');
  for (const domain of ['runtime', 'console', 'harness', 'testcontainers', 'verification', 'full']) {
    assert.equal(digestOf(domain, sandbox), before[domain], `fleet artifact generation changed ${domain}`);
  }
  const fixtureBase = digestOf('verification', sandbox);
  await write('tests/unit/artifacts/fixture.pem', 'mutated versioned fixture bytes\n');
  assert.notEqual(
    digestOf('verification', sandbox),
    fixtureBase,
    'an artifacts-named source fixture must remain covered',
  );
  await write('tests/unit/artifacts/fixture.pem', 'versioned fixture bytes\n');
  assert.equal(digestOf('verification', sandbox), fixtureBase, 'restoring the fixture must restore its digest');

  // 9b. Interpreter and test-runner caches are never source. Place one in a family owned by each
  //     domain and prove that neither membership nor bytes can move any digest.
  for (const [relative, contents] of [
    ['services/gateway/__pycache__/runtime.cpython-313.pyc', 'runtime bytecode v1'],
    ['services/gateway/runtime.pyo', 'optimized runtime bytecode v1'],
    ['apps/console/.pytest_cache/v/cache/nodeids', 'console pytest state v1'],
    ['apps/console/src/cached.pyc', 'console bytecode v1'],
    ['ops/harness/__pycache__/faults.pyc', 'harness bytecode v1'],
    ['ops/harness/faults.pyo', 'harness optimized bytecode v1'],
    ['tests/e2e/.pytest_cache/state.json', '{"testcontainers":1}\n'],
    ['tests/e2e/qa.pyc', 'Testcontainers bytecode v1'],
    ['ops/scripts/__pycache__/source-hygiene.cpython-313.pyc', 'verification bytecode v1'],
    ['ops/scripts/verification.pyo', 'verification optimized bytecode v1'],
  ]) {
    await write(relative, contents);
  }
  for (const domain of ['runtime', 'console', 'harness', 'testcontainers', 'verification', 'full']) {
    assert.equal(digestOf(domain, sandbox), before[domain], `cache files changed the ${domain} digest`);
  }
  const cacheListing = pathsOf('full', sandbox);
  assert(![...cacheListing].some((entry) => entry.includes('/__pycache__/')), '__pycache__ leaked into full');
  assert(![...cacheListing].some((entry) => entry.includes('/.pytest_cache/')), '.pytest_cache leaked into full');
  assert(![...cacheListing].some((entry) => entry.endsWith('.pyc')), '*.pyc leaked into full');
  assert(![...cacheListing].some((entry) => entry.endsWith('.pyo')), '*.pyo leaked into full');

  // 9c. The one approved operator scratch path is intentionally outside every release digest.
  //     A directory with the same basename anywhere else remains covered.
  await write('apps/console/src/features/_grafo/consultas-grafo.sql', 'SELECT 2;\n');
  for (const domain of ['runtime', 'console', 'harness', 'testcontainers', 'verification', 'full']) {
    assert.equal(digestOf(domain, sandbox), before[domain], `_grafo scratch changed the ${domain} digest`);
  }
  await write('apps/console/src/other/_grafo/query.sql', 'SELECT 3;\n');
  assert.notEqual(digestOf('console', sandbox), before.console, 'the exclusion must not apply to another _grafo path');
  assert.notEqual(digestOf('full', sandbox), before.full, 'the full domain must cover another _grafo path');
  await rm(path.join(sandbox, 'apps/console/src/other'), { recursive: true });
  assert.equal(digestOf('console', sandbox), before.console, 'removing the covered control path must restore the digest');

  // 9d. THE FIX. A console-only change must not move the runtime digest, because no console file
  //     reaches the runtime image. It must still move the console and full digests.
  await write('apps/console/src/theme.css', '.panel { color: blue; }\n');
  assert.equal(digestOf('runtime', sandbox), before.runtime, 'a console CSS edit must not invalidate runtime fault evidence');
  assert.equal(digestOf('harness', sandbox), before.harness, 'a console CSS edit must not invalidate harness binding');
  assert.equal(digestOf('testcontainers', sandbox), before.testcontainers, 'a console CSS edit must not invalidate Testcontainers harness binding');
  assert.equal(digestOf('verification', sandbox), before.verification, 'a console CSS edit must not invalidate verification apparatus');
  assert.notEqual(digestOf('console', sandbox), before.console, 'a console edit must still invalidate console evidence');
  assert.notEqual(digestOf('full', sandbox), before.full, 'a console edit must still invalidate full-domain verification evidence');
  const afterConsole = {
    runtime: digestOf('runtime', sandbox),
    console: digestOf('console', sandbox),
    harness: digestOf('harness', sandbox),
  };

  // 9d. The gate must not be loosened for anything that DOES reach the runtime image.
  await write('services/gateway/src/app.ts', 'export const app = 2;\n');
  assert.notEqual(digestOf('runtime', sandbox), afterConsole.runtime, 'a service change must invalidate runtime evidence');
  const afterService = digestOf('runtime', sandbox);

  // 9e. A console dependency change is still visible to the runtime digest through the lockfile,
  //     which is why dropping apps/console from the runtime domain is safe.
  await write('pnpm-lock.yaml', 'lockfileVersion: 9\npackages:\n  react: 19\n');
  assert.notEqual(digestOf('runtime', sandbox), afterService, 'a lockfile change must invalidate runtime evidence');
  const afterLock = digestOf('runtime', sandbox);

  // 9f. deploy/ still counts as runtime.
  await write('deploy/runtime-entrypoint.sh', '#!/bin/sh\nexec env "$@"\n');
  assert.notEqual(digestOf('runtime', sandbox), afterLock, 'a deploy change must invalidate runtime evidence');

  // 9g. Build-context policy affects both final images and must move both domains.
  const beforeDockerignore = {
    runtime: digestOf('runtime', sandbox),
    console: digestOf('console', sandbox),
  };
  await write('.dockerignore', 'node_modules\n.env*\nlocal-scratch\n');
  assert.notEqual(digestOf('runtime', sandbox), beforeDockerignore.runtime,
    'a .dockerignore change must invalidate runtime build evidence');
  assert.notEqual(digestOf('console', sandbox), beforeDockerignore.console,
    'a .dockerignore change must invalidate console build evidence');

  // 9h. Weakening the harness must move the harness digest without touching the image digests.
  const beforeHarness = {
    runtime: digestOf('runtime', sandbox),
    console: digestOf('console', sandbox),
    harness: digestOf('harness', sandbox),
  };
  await write('ops/harness/authentic-runner.mjs', 'export const run = 0; // faults now always pass\n');
  assert.notEqual(digestOf('harness', sandbox), beforeHarness.harness, 'a harness change must invalidate authentic evidence');
  assert.equal(digestOf('runtime', sandbox), beforeHarness.runtime, 'a harness change must not invalidate the image build evidence');
  assert.equal(digestOf('console', sandbox), beforeHarness.console, 'a harness change must not invalidate console evidence');

  // 9i. Testcontainers and global verification apparatus are independently bound.
  const beforeTestcontainers = {
    runtime: digestOf('runtime', sandbox),
    harness: digestOf('harness', sandbox),
    testcontainers: digestOf('testcontainers', sandbox),
    verification: digestOf('verification', sandbox),
    full: digestOf('full', sandbox),
  };
  await write('tests/e2e/real-qa.test.ts', 'export const qa = 0; // weakened\n');
  assert.equal(digestOf('runtime', sandbox), beforeTestcontainers.runtime,
    'an E2E harness edit must not relabel runtime image evidence');
  assert.equal(digestOf('harness', sandbox), beforeTestcontainers.harness,
    'a Testcontainers edit must not invalidate the authentic-image harness');
  assert.notEqual(digestOf('testcontainers', sandbox), beforeTestcontainers.testcontainers,
    'an E2E harness edit must invalidate Testcontainers evidence');
  assert.notEqual(digestOf('verification', sandbox), beforeTestcontainers.verification,
    'the global verification domain must cover root tests');
  assert.notEqual(digestOf('full', sandbox), beforeTestcontainers.full,
    'full must cover the Testcontainers harness');

  const beforeOpsTest = {
    runtime: digestOf('runtime', sandbox),
    testcontainers: digestOf('testcontainers', sandbox),
    verification: digestOf('verification', sandbox),
    full: digestOf('full', sandbox),
  };
  await write('ops/tests/gate.test.mjs', 'export const gate = 0;\n');
  assert.equal(digestOf('runtime', sandbox), beforeOpsTest.runtime, 'an ops gate test must not move runtime image evidence');
  assert.equal(digestOf('testcontainers', sandbox), beforeOpsTest.testcontainers,
    'an unrelated ops gate test must not move Testcontainers evidence');
  assert.notEqual(digestOf('verification', sandbox), beforeOpsTest.verification,
    'ops gate tests must move verification evidence');
  assert.notEqual(digestOf('full', sandbox), beforeOpsTest.full, 'full must cover ops gate tests');

  // 9j. Global verification is bound to every operational source family its tests execute.
  const operationallyIndependent = {
    runtime: digestOf('runtime', sandbox),
    console: digestOf('console', sandbox),
    harness: digestOf('harness', sandbox),
    testcontainers: digestOf('testcontainers', sandbox),
  };
  let priorVerification = digestOf('verification', sandbox);
  let priorFull = digestOf('full', sandbox);
  for (const [relative, contents] of [
    ['ops/scripts/source-hygiene.py', 'print("hygiene disabled")\n'],
    ['ops/scripts/migration-gate.mjs', 'export const migration = false;\n'],
    ['ops/scripts/physical-fleet-gate.py', 'print("fleet disabled")\n'],
    ['ops/scripts/validate-fleet-release-evidence.py', 'print("evidence disabled")\n'],
    ['ops/schemas/build-evidence.schema.json', '{"additionalProperties":true}\n'],
    ['ops/scripts/future-operational-gate.py', 'print("new gate")\n'],
    ['ops/schemas/future-operational-evidence.schema.json', '{"type":"object"}\n'],
  ]) {
    await write(relative, contents);
    const nextVerification = digestOf('verification', sandbox);
    const nextFull = digestOf('full', sandbox);
    assert.notEqual(nextVerification, priorVerification, `${relative} must invalidate verification evidence`);
    assert.notEqual(nextFull, priorFull, `${relative} must invalidate full three-round evidence`);
    assert.equal(digestOf('runtime', sandbox), operationallyIndependent.runtime, `${relative} moved runtime evidence`);
    assert.equal(digestOf('console', sandbox), operationallyIndependent.console, `${relative} moved console evidence`);
    assert.equal(digestOf('harness', sandbox), operationallyIndependent.harness, `${relative} moved harness evidence`);
    assert.equal(
      digestOf('testcontainers', sandbox),
      operationallyIndependent.testcontainers,
      `${relative} moved Testcontainers evidence`,
    );
    priorVerification = nextVerification;
    priorFull = nextFull;
  }

  const beforeSymlink = {
    runtime: digestOf('runtime', sandbox),
    verification: digestOf('verification', sandbox),
    full: digestOf('full', sandbox),
  };
  const futureGate = path.join(sandbox, 'ops/scripts/future-operational-gate.sh');
  for (const target of [
    '../../scripts/gate-a.sh',
    '../../scripts/gate-b.sh',
    '../../unselected/gate.sh',
    '../../unselected/missing.sh',
    '/var/tmp/cauce-external-gate.sh',
  ]) {
    await symlink(target, futureGate);
    for (const args of [
      ['--domain', 'verification', '--root', sandbox],
      ['--domain', 'full', '--list', '--root', sandbox],
    ]) {
      assert.throws(() => run(args, { stdio: ['ignore', 'pipe', 'pipe'] }), (error) => {
        const stderr = String(error?.stderr ?? '');
        assert.match(stderr, /source digest rejects symlinks in covered inputs/u);
        assert(!stderr.includes(target), 'sanitized symlink rejection exposed its target');
        return true;
      }, `source digest accepted symlink target ${target}`);
    }
    assert.equal(digestOf('runtime', sandbox), beforeSymlink.runtime, 'an ops symlink must not relabel runtime');
    await rm(futureGate);
    assert.equal(digestOf('verification', sandbox), beforeSymlink.verification, 'removing symlink must restore verification');
    assert.equal(digestOf('full', sandbox), beforeSymlink.full, 'removing symlink must restore full');
  }

  // 9k. Renames are observable: paths are hashed alongside bytes.
  const renameBase = digestOf('runtime', sandbox);
  await write('services/gateway/src/app2.ts', 'export const app = 2;\n');
  await rm(path.join(sandbox, 'services/gateway/src/app.ts'));
  assert.notEqual(digestOf('runtime', sandbox), renameBase, 'a rename must move the digest');

  // 9l. Secrets and caches stay out even when they sit inside a covered family.
  const listing = pathsOf('full', sandbox);
  assert(!listing.has('node_modules/evil/index.js'), 'node_modules must never be hashed');
  assert(!listing.has('.env.production'), 'private env files must never be hashed');
  assert(!listing.has('apps/console/src/features/_grafo/consultas-grafo.sql'), 'operator scratch leaked into full digest');
  assert(![...listing].some((entry) => entry.startsWith('tests/fleet-release/artifacts/')),
    'fleet generator outputs must never be hashed');
  assert(![...listing].some((entry) => entry.startsWith('tests/fleet-release/.matrix-state/')),
    'fleet ephemeral matrix state must never be hashed');
  assert(listing.has('tests/unit/artifacts/fixture.pem'), 'a source fixture named artifacts must remain hashed');
  assert(![...listing].some((entry) => entry.includes('/__pycache__/')), '__pycache__ must never be hashed');
  assert(![...listing].some((entry) => entry.includes('/.pytest_cache/')), '.pytest_cache must never be hashed');
  assert(![...listing].some((entry) => entry.endsWith('.pyc')), '*.pyc must never be hashed');
  assert(![...listing].some((entry) => entry.endsWith('.pyo')), '*.pyo must never be hashed');
} finally {
  await rm(sandbox, { recursive: true, force: true });
}

// 10. Wiring: every live consumer must declare a domain explicitly. A consumer that reverts to
//     the bare invocation silently goes back to whole-tree binding, which is the bug being fixed.
const wiring = [
  ['scripts/smoke-compose-authentic.sh', ['--domain runtime', '--domain harness']],
  ['scripts/smoke-runtime-authentic.sh', ['--domain runtime', '--domain harness']],
  ['scripts/validate-fleet-release-evidence.py', ['"--domain", "runtime"']],
  ['scripts/validate-testcontainers-evidence.py', ['source_digest("runtime")', 'source_digest("testcontainers")']],
];
for (const [relative, needles] of wiring) {
  const contents = await readFile(path.join(ops, relative), 'utf8');
  for (const needle of needles) {
    assert(contents.includes(needle), `ops/${relative} must pass ${needle} to source-digest.py`);
  }
}
const fleetWiring = [
  ['tests/fleet-release/fleet-release.test.ts', "'--domain', SOURCE_DIGEST_DOMAIN"],
  ['tests/fleet-release/host-smoke.mjs', "'--domain', SOURCE_DIGEST_DOMAIN"],
  ['tests/fleet-release/aggregate-host-smoke.mjs', "'--domain', SOURCE_DIGEST_DOMAIN"],
];
for (const [relative, needle] of fleetWiring) {
  const contents = await readFile(path.join(root, relative), 'utf8');
  assert(contents.includes(needle), `${relative} must pass ${needle} to source-digest.py`);
}

// 11. Every evidence schema must force its artifact to declare which domain backs it, so an
//     artifact can never be silently reinterpreted against a different domain.
const declared = [
  ['ops/schemas/test-evidence.schema.json', 'runtime'],
  ['tests/fleet-release/fleet-release-report.schema.json', 'runtime'],
  ['tests/fleet-release/host-smoke-evidence.schema.json', 'runtime'],
  ['tests/fleet-release/host-smoke-aggregate.schema.json', 'runtime'],
];
for (const [relative, domain] of declared) {
  const schema = JSON.parse(await readFile(path.join(root, relative), 'utf8'));
  assert(schema.required.includes('sourceDigestDomain'), `${relative} must require sourceDigestDomain`);
  assert.equal(schema.properties.sourceDigestDomain.const, domain, `${relative} must pin sourceDigestDomain to ${domain}`);
}
const testEvidence = JSON.parse(await readFile(path.join(ops, 'schemas/test-evidence.schema.json'), 'utf8'));
assert(testEvidence.required.includes('harnessDigest'), 'authentic evidence must be bound to the harness that produced it');
const testcontainersEvidence = JSON.parse(await readFile(path.join(ops, 'schemas/testcontainers-evidence.schema.json'), 'utf8'));
assert(testcontainersEvidence.required.includes('sourceDigest'), 'Testcontainers evidence must bind runtime sources');
assert(testcontainersEvidence.required.includes('harnessDigest'), 'Testcontainers evidence must bind its harness');
assert(testcontainersEvidence.required.includes('databaseImage'), 'Testcontainers evidence must bind its actual database image');
process.stdout.write('source digest domain tests passed\n');
