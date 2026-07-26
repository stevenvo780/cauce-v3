#!/usr/bin/env node

import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const artifactDirectory = path.join(root, 'ops/artifacts/verification');
const suiteStarted = new Date();

const commands = [
  { name: 'install-frozen', argv: ['pnpm', 'install', '--frozen-lockfile'] },
  { name: 'lint-global', argv: ['pnpm', 'lint'] },
  { name: 'typecheck-global', argv: ['pnpm', 'typecheck'] },
  { name: 'build-global', argv: ['pnpm', 'build'] },
  { name: 'test-round-one', argv: ['pnpm', 'test'] },
  { name: 'test-round-two', argv: ['pnpm', 'test'] },
  { name: 'test-round-three', argv: ['pnpm', 'test'] },
  { name: 'fleet-release', argv: ['pnpm', 'test:fleet-release'] },
  { name: 'testcontainers-qa', argv: ['pnpm', 'qa:testcontainers'] },
  { name: 'mock-contract-separated', argv: ['pnpm', 'qa:contract'] },
  // Guards the domain split itself: proves the runtime domain still covers everything that reaches
  // the runtime image and that the ONLY thing it drops is apps/console.
  { name: 'source-digest-domains', argv: ['node', 'ops/tests/source-digest-domains.test.mjs'] },
  {
    name: 'ops-static-validation',
    argv: ['pnpm', 'ops:validate'],
  },
  { name: 'manifests-generate', argv: ['pnpm', 'ops:manifests'] },
  {
    name: 'manifests-sha-verify',
    argv: ['sha256sum', '-c', 'SHA256SUMS'],
    cwd: path.join(root, 'ops/generated/systemd'),
  },
  {
    name: 'container-units-sha-verify',
    argv: ['sha256sum', '-c', 'SHA256SUMS'],
    cwd: path.join(root, 'ops/generated/container-systemd'),
  },
];

// Three-round verification is the one artifact that legitimately depends on EVERY domain: the
// command list below runs lint:console, typecheck:console and build:console, the console vitest
// project, tests/gateway-hardening/console-api-contract.test.ts (which reads apps/console sources)
// and ops:validate (which exercises the harness). Narrowing this to the runtime domain would make
// the evidence claim more than it proves. ops/scripts/source-digest.py explains the domains.
const SOURCE_DIGEST_DOMAIN = 'full';

async function sourceDigest() {
  const { stdout } = await execFileAsync(
    'python3',
    [path.join(root, 'ops/scripts/source-digest.py'), '--domain', SOURCE_DIGEST_DOMAIN],
    { cwd: root, encoding: 'utf8' },
  );
  const value = stdout.trim();
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) throw new Error('source digest script returned an invalid digest');
  return value;
}

async function execute(specification) {
  const startedAt = new Date();
  const started = performance.now();
  const [command, ...args] = specification.argv;
  const exitCode = await new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: specification.cwd ?? root,
      env: { ...process.env, ...specification.environment },
      stdio: 'inherit',
      shell: false,
    });
    child.once('error', () => resolve(127));
    child.once('exit', (code) => resolve(code ?? 1));
  });
  const finishedAt = new Date();
  return {
    name: specification.name,
    argv: specification.argv,
    critical: true,
    status: exitCode === 0 ? 'passed' : 'failed',
    exitCode,
    timestamps: { startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString() },
    durationMs: Math.max(0, Math.round(performance.now() - started)),
  };
}

function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

const initialDigest = await sourceDigest();
const results = [];
for (const command of commands) results.push(await execute(command));
const finalDigest = await sourceDigest();
if (finalDigest !== initialDigest) {
  const now = new Date().toISOString();
  results.push({
    name: 'source-digest-stability',
    argv: ['python3', 'ops/scripts/source-digest.py', '--domain', SOURCE_DIGEST_DOMAIN],
    critical: true,
    status: 'failed',
    exitCode: 1,
    timestamps: { startedAt: now, finishedAt: now },
    durationMs: 0,
  });
}

const failed = results.filter((result) => result.status === 'failed').length;
const report = {
  schemaVersion: 1,
  suite: 'cauce-v3-verification-three-rounds',
  sourceDigest: finalDigest,
  sourceDigestDomain: SOURCE_DIGEST_DOMAIN,
  timestamps: { startedAt: suiteStarted.toISOString(), finishedAt: new Date().toISOString() },
  summary: {
    commands: results.length,
    passed: results.length - failed,
    failed,
    skipped: 0,
    criticalSkipped: 0,
    testRounds: 3,
  },
  commands: results,
};

await mkdir(artifactDirectory, { recursive: true, mode: 0o755 });
const json = `${JSON.stringify(report, null, 2)}\n`;
const cases = results.map((result) => {
  const failure = result.status === 'failed'
    ? `<failure message="exit code ${result.exitCode}"/>`
    : '';
  return `  <testcase classname="cauce.verification" name="${xmlEscape(result.name)}" time="${(result.durationMs / 1_000).toFixed(3)}">${failure}</testcase>`;
}).join('\n');
const junit = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  `<testsuite name="cauce-v3-verification-three-rounds" tests="${results.length}" failures="${failed}" skipped="0" timestamp="${report.timestamps.startedAt}">`,
  `  <properties><property name="sourceDigest" value="${report.sourceDigest}"/></properties>`,
  cases,
  '</testsuite>',
  '',
].join('\n');
const digest = (value) => createHash('sha256').update(value).digest('hex');
await writeFile(path.join(artifactDirectory, 'report.json'), json, { mode: 0o644 });
await writeFile(path.join(artifactDirectory, 'junit.xml'), junit, { mode: 0o644 });
await writeFile(
  path.join(artifactDirectory, 'SHA256SUMS'),
  `${digest(json)}  report.json\n${digest(junit)}  junit.xml\n`,
  { mode: 0o644 },
);

if (failed > 0) process.exitCode = 1;
