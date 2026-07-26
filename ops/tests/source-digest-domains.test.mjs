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

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
const fullPaths = pathsOf('full');
const union = new Set([...runtimePaths, ...consolePaths, ...harnessPaths]);
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
  [...consolePaths].some((entry) => entry.startsWith('apps/console/src/')),
  'console domain must contain apps/console sources',
);

// 4. Everything that reaches the runtime image is still covered. These sentinels are the families
//    the `runtime` stage of deploy/Dockerfile copies from, plus the dependency-graph manifests that
//    keep a console dependency change visible to the runtime digest.
for (const sentinel of [
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
  'services/relay-worker/package.json',
  'services/shadow-router/package.json',
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
      !['node_modules', 'dist', 'coverage', '.git', '.serena', '.test-state', '.claude'].includes(part),
      `excluded family leaked into a digest: ${entry}`,
    );
  }
  assert(!path.basename(entry).startsWith('.env'), `private env file leaked into a digest: ${entry}`);
}

// 7. Determinism and distinctness.
assert.equal(digestOf('runtime'), digestOf('runtime'), 'digest must be deterministic');
const distinct = new Set([digestOf('runtime'), digestOf('console'), digestOf('harness'), digestOf('full')]);
assert.equal(distinct.size, 4, 'each domain must produce its own digest');

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
  await write('pnpm-lock.yaml', 'lockfileVersion: 9\n');
  await write('pnpm-workspace.yaml', 'packages:\n  - packages/*\n');
  await write('tsconfig.json', '{}\n');
  await write('tsconfig.build.json', '{}\n');
  await write('vitest.config.ts', 'export default {};\n');
  await write('packages/store/src/index.ts', 'export const store = 1;\n');
  await write('services/gateway/src/app.ts', 'export const app = 1;\n');
  await write('deploy/runtime-entrypoint.sh', '#!/bin/sh\nexec "$@"\n');
  await write('apps/console/src/App.tsx', 'export const App = () => null;\n');
  await write('apps/console/src/theme.css', '.panel { color: red; }\n');
  await write('ops/harness/authentic-runner.mjs', 'export const run = 1;\n');
  await write('ops/compose.authentic.yaml', 'services: {}\n');
  await write('ops/scripts/fault-runtime.sh', '#!/bin/sh\n');
  await write('node_modules/evil/index.js', 'module.exports = 1;\n');
  await write('.env.production', 'SECRET=must-never-be-hashed\n');

  const before = {
    runtime: digestOf('runtime', sandbox),
    console: digestOf('console', sandbox),
    harness: digestOf('harness', sandbox),
    full: digestOf('full', sandbox),
  };

  // 9a. THE FIX. A console-only change must not move the runtime digest, because no console file
  //     reaches the runtime image. It must still move the console and full digests.
  await write('apps/console/src/theme.css', '.panel { color: blue; }\n');
  assert.equal(digestOf('runtime', sandbox), before.runtime, 'a console CSS edit must not invalidate runtime fault evidence');
  assert.equal(digestOf('harness', sandbox), before.harness, 'a console CSS edit must not invalidate harness binding');
  assert.notEqual(digestOf('console', sandbox), before.console, 'a console edit must still invalidate console evidence');
  assert.notEqual(digestOf('full', sandbox), before.full, 'a console edit must still invalidate full-domain verification evidence');
  const afterConsole = {
    runtime: digestOf('runtime', sandbox),
    console: digestOf('console', sandbox),
    harness: digestOf('harness', sandbox),
  };

  // 9b. The gate must not be loosened for anything that DOES reach the runtime image.
  await write('services/gateway/src/app.ts', 'export const app = 2;\n');
  assert.notEqual(digestOf('runtime', sandbox), afterConsole.runtime, 'a service change must invalidate runtime evidence');
  const afterService = digestOf('runtime', sandbox);

  // 9c. A console dependency change is still visible to the runtime digest through the lockfile,
  //     which is why dropping apps/console from the runtime domain is safe.
  await write('pnpm-lock.yaml', 'lockfileVersion: 9\npackages:\n  react: 19\n');
  assert.notEqual(digestOf('runtime', sandbox), afterService, 'a lockfile change must invalidate runtime evidence');
  const afterLock = digestOf('runtime', sandbox);

  // 9d. deploy/ still counts as runtime.
  await write('deploy/runtime-entrypoint.sh', '#!/bin/sh\nexec env "$@"\n');
  assert.notEqual(digestOf('runtime', sandbox), afterLock, 'a deploy change must invalidate runtime evidence');

  // 9e. Weakening the harness must move the harness digest without touching the image digests.
  const beforeHarness = {
    runtime: digestOf('runtime', sandbox),
    console: digestOf('console', sandbox),
    harness: digestOf('harness', sandbox),
  };
  await write('ops/harness/authentic-runner.mjs', 'export const run = 0; // faults now always pass\n');
  assert.notEqual(digestOf('harness', sandbox), beforeHarness.harness, 'a harness change must invalidate authentic evidence');
  assert.equal(digestOf('runtime', sandbox), beforeHarness.runtime, 'a harness change must not invalidate the image build evidence');
  assert.equal(digestOf('console', sandbox), beforeHarness.console, 'a harness change must not invalidate console evidence');

  // 9f. Renames are observable: paths are hashed alongside bytes.
  const renameBase = digestOf('runtime', sandbox);
  await write('services/gateway/src/app2.ts', 'export const app = 2;\n');
  await rm(path.join(sandbox, 'services/gateway/src/app.ts'));
  assert.notEqual(digestOf('runtime', sandbox), renameBase, 'a rename must move the digest');

  // 9g. Secrets and caches stay out even when they sit inside a covered family.
  const listing = pathsOf('full', sandbox);
  assert(!listing.has('node_modules/evil/index.js'), 'node_modules must never be hashed');
  assert(!listing.has('.env.production'), 'private env files must never be hashed');
} finally {
  await rm(sandbox, { recursive: true, force: true });
}

// 10. Wiring: every release consumer must declare a domain explicitly. A consumer that reverts to
//     the bare invocation silently goes back to whole-tree binding, which is the bug being fixed.
const wiring = [
  ['scripts/release-build.sh', ['--domain runtime', '--domain console']],
  ['scripts/smoke-compose-authentic.sh', ['--domain runtime', '--domain harness']],
  ['scripts/smoke-runtime-authentic.sh', ['--domain runtime', '--domain harness']],
  ['scripts/validate-release-evidence.py', ['"--domain", domain']],
  ['scripts/validate-fleet-release-evidence.py', ['"--domain", "runtime"']],
  ['scripts/release-candidate.py', ['"--domain", domain']],
  ['scripts/verification-rounds.mjs', ["'--domain', SOURCE_DIGEST_DOMAIN"]],
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
  ['ops/schemas/build-evidence.schema.json', 'runtime'],
  ['ops/schemas/test-evidence.schema.json', 'runtime'],
  ['ops/schemas/verification-evidence.schema.json', 'full'],
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
const candidate = JSON.parse(await readFile(path.join(ops, 'schemas/release-candidate.schema.json'), 'utf8'));
assert(
  candidate.properties.evidence.items.required.includes('sourceDigestDomain'),
  'the release candidate must record which domain backs each aggregated artifact',
);

process.stdout.write('source digest domain tests passed\n');
