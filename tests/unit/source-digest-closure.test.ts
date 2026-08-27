import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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

describe('source digest verification closure', () => {
  test('the live full resolver covers the test orchestrator and operational sources it exercises', () => {
    const result = spawnSync('python3', [sourceDigest, '--domain', 'full', '--list'], {
      cwd: repository,
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    const paths = result.stdout.split('\n');
    for (const source of [
      'scripts/test-all.mjs',
      'ops/scripts/check-postgres-tls.mjs',
      'ops/scripts/compose-files.sh',
      'ops/scripts/run-testcontainers.sh',
      'ops/scripts/source-digest.py',
      'ops/scripts/validate.sh',
      'ops/schemas/testcontainers-evidence.schema.json',
    ]) {
      expect(paths, source).toContain(source);
    }
  });

  test('mutating a root script moves verification and full without relabelling runtime', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cauce-source-digest-closure-'));
    scratch.push(root);
    for (const directory of ['scripts', 'packages/store', 'services/gateway', 'deploy']) {
      await mkdir(join(root, directory), { recursive: true });
    }
    for (const [relative, content] of [
      ['package.json', '{}\n'],
      ['pnpm-lock.yaml', 'lockfileVersion: 9\n'],
      ['pnpm-workspace.yaml', 'packages: []\n'],
      ['tsconfig.json', '{}\n'],
      ['tsconfig.build.json', '{}\n'],
      ['vitest.config.ts', 'export default {};\n'],
      ['scripts/test-all.mjs', 'export const suites = 7;\n'],
      ['packages/store/index.ts', 'export const store = 1;\n'],
      ['services/gateway/index.ts', 'export const gateway = 1;\n'],
      ['deploy/Dockerfile', 'FROM scratch\n'],
    ] as const) {
      await writeFile(join(root, relative), content);
    }

    const before = Object.fromEntries(['runtime', 'verification', 'full'].map((domain) => {
      const result = run(root, '--domain', domain);
      expect(result.status, result.stderr).toBe(0);
      return [domain, result.stdout.trim()];
    }));
    await writeFile(join(root, 'scripts/test-all.mjs'), 'export const suites = 0; // silently skip all\n');
    const after = Object.fromEntries(['runtime', 'verification', 'full'].map((domain) => {
      const result = run(root, '--domain', domain);
      expect(result.status, result.stderr).toBe(0);
      return [domain, result.stdout.trim()];
    }));

    expect(after.runtime).toBe(before.runtime);
    expect(after.verification).not.toBe(before.verification);
    expect(after.full).not.toBe(before.full);
    expect(await readFile(join(root, 'scripts/test-all.mjs'), 'utf8')).toContain('silently skip all');
  });

  test('mutating current or newly added operational sources invalidates old verification reports', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cauce-source-digest-operations-'));
    scratch.push(root);
    for (const [relative, contents] of [
      ['package.json', '{}\n'],
      ['pnpm-lock.yaml', 'lockfileVersion: 9\n'],
      ['pnpm-workspace.yaml', 'packages: []\n'],
      ['tsconfig.json', '{}\n'],
      ['services/gateway/index.ts', 'export const gateway = 1;\n'],
      ['ops/scripts/check-postgres-tls.mjs', 'process.exit(0);\n'],
      ['ops/scripts/compose-files.sh', '#!/bin/sh\nexit 0\n'],
      ['ops/scripts/run-testcontainers.sh', '#!/bin/sh\nexit 0\n'],
      ['ops/scripts/validate.sh', '#!/bin/sh\nexit 0\n'],
      ['ops/schemas/testcontainers-evidence.schema.json', '{"type":"object"}\n'],
    ] as const) {
      await writeTree(root, relative, contents);
    }

    const runtime = digest(root, 'runtime');
    let verification = digest(root, 'verification');
    let full = digest(root, 'full');
    for (const [relative, contents] of [
      ['ops/scripts/check-postgres-tls.mjs', 'process.exit(7);\n'],
      ['ops/scripts/compose-files.sh', '#!/bin/sh\nexit 7\n'],
      ['ops/scripts/run-testcontainers.sh', '#!/bin/sh\nexit 7\n'],
      ['ops/scripts/validate.sh', '#!/bin/sh\nexit 7\n'],
      ['ops/schemas/testcontainers-evidence.schema.json', '{"additionalProperties":true}\n'],
      ['ops/scripts/future-operational-gate.py', 'print("future gate")\n'],
      ['ops/schemas/future-operational-evidence.schema.json', '{"type":"string"}\n'],
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

  test('timestamped operational artifacts regenerate without moving initial or final source digests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cauce-source-digest-generated-artifacts-'));
    scratch.push(root);
    for (const [relative, contents] of [
      ['package.json', '{}\n'],
      ['pnpm-lock.yaml', 'lockfileVersion: 9\n'],
      ['pnpm-workspace.yaml', 'packages: []\n'],
      ['tsconfig.json', '{}\n'],
      ['ops/artifacts/report.json', '{"generatedAt":"initial"}\n'],
      ['ops/artifacts/junit.xml', '<testsuite timestamp="initial"/>\n'],
      ['ops/artifacts/SHA256SUMS', 'initial sums\n'],
      ['tests/unit/artifacts/fixture.pem', 'versioned PEM fixture\n'],
    ] as const) {
      await writeTree(root, relative, contents);
    }

    const initial = {
      verification: digest(root, 'verification'),
      full: digest(root, 'full'),
    };
    for (const timestamp of ['2026-08-26T13:00:00Z', '2026-08-26T13:01:00Z', '2026-08-26T13:02:00Z']) {
      await writeTree(root, 'ops/artifacts/report.json', `${JSON.stringify({ generatedAt: timestamp })}\n`);
      await writeTree(root, 'ops/artifacts/junit.xml', `<testsuite timestamp="${timestamp}"/>\n`);
      await writeTree(root, 'ops/artifacts/SHA256SUMS', `${timestamp} sums\n`);
      expect(digest(root, 'verification'), timestamp).toBe(initial.verification);
      expect(digest(root, 'full'), timestamp).toBe(initial.full);
    }

    const listing = run(root, '--domain', 'full', '--list');
    expect(listing.status, listing.stderr).toBe(0);
    expect(listing.stdout).not.toContain('ops/artifacts/');
    expect(listing.stdout.split('\n')).toContain('tests/unit/artifacts/fixture.pem');
  });

  test('Git-ignored backups stay out while untracked source and tracked PEM fixtures stay covered', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cauce-source-digest-git-ignore-'));
    scratch.push(root);
    for (const [relative, contents] of [
      ['.gitignore', '*.bak-*\n*.pem\n'],
      ['package.json', '{}\n'],
      ['pnpm-lock.yaml', 'lockfileVersion: 9\n'],
      ['pnpm-workspace.yaml', 'packages: []\n'],
      ['tsconfig.json', '{}\n'],
      ['ops/cli/cauce', '#!/bin/sh\nexit 0\n'],
      ['services/gateway/src/test-fixtures/mtls-server-certificate.pem', 'tracked PEM fixture\n'],
    ] as const) {
      await writeTree(root, relative, contents);
    }
    const initialized = spawnSync('git', ['init', '--quiet'], { cwd: root, encoding: 'utf8' });
    expect(initialized.status, initialized.stderr).toBe(0);
    const staged = spawnSync(
      'git',
      ['add', '-f', '.gitignore', 'ops/cli/cauce', 'services/gateway/src/test-fixtures/mtls-server-certificate.pem'],
      { cwd: root, encoding: 'utf8' },
    );
    expect(staged.status, staged.stderr).toBe(0);

    const initial = {
      runtime: digest(root, 'runtime'),
      verification: digest(root, 'verification'),
      full: digest(root, 'full'),
    };
    await writeTree(root, 'ops/cli/cauce.bak-login-20260823T000500Z', 'ignored operator backup\n');
    await symlink('/var/tmp/cauce-ignored-external-target', join(root, 'ops/cli/cauce.bak-ignored-link'));
    expect(digest(root, 'runtime')).toBe(initial.runtime);
    expect(digest(root, 'verification')).toBe(initial.verification);
    expect(digest(root, 'full')).toBe(initial.full);
    let listing = run(root, '--domain', 'full', '--list');
    expect(listing.status, listing.stderr).toBe(0);
    expect(listing.stdout).not.toContain('ops/cli/cauce.bak-login-20260823T000500Z');
    expect(listing.stdout).not.toContain('ops/cli/cauce.bak-ignored-link');
    expect(listing.stdout.split('\n')).toContain('services/gateway/src/test-fixtures/mtls-server-certificate.pem');

    await writeTree(root, 'ops/scripts/untracked-operational-check.py', 'print("new source")\n');
    const withUntrackedSource = {
      verification: digest(root, 'verification'),
      full: digest(root, 'full'),
    };
    expect(withUntrackedSource.verification).not.toBe(initial.verification);
    expect(withUntrackedSource.full).not.toBe(initial.full);
    listing = run(root, '--domain', 'full', '--list');
    expect(listing.stdout.split('\n')).toContain('ops/scripts/untracked-operational-check.py');

    await writeTree(
      root,
      'services/gateway/src/test-fixtures/mtls-server-certificate.pem',
      'mutated tracked PEM fixture\n',
    );
    expect(digest(root, 'runtime')).not.toBe(initial.runtime);
    expect(digest(root, 'full')).not.toBe(withUntrackedSource.full);
  });

  test('all non-ignored operational symlinks fail closed without exposing their targets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cauce-source-digest-symlink-'));
    scratch.push(root);
    for (const [relative, contents] of [
      ['package.json', '{}\n'],
      ['pnpm-lock.yaml', 'lockfileVersion: 9\n'],
      ['pnpm-workspace.yaml', 'packages: []\n'],
      ['tsconfig.json', '{}\n'],
      ['scripts/gate-a.sh', '#!/bin/sh\nexit 0\n'],
      ['scripts/gate-b.sh', '#!/bin/sh\nexit 7\n'],
      ['ops/scripts/guard-check.sh', '#!/bin/sh\nexit 0\n'],
      ['unselected/gate.sh', '#!/bin/sh\nexit 9\n'],
    ] as const) {
      await writeTree(root, relative, contents);
    }
    const before = {
      runtime: digest(root, 'runtime'),
      verification: digest(root, 'verification'),
      full: digest(root, 'full'),
    };
    const link = join(root, 'ops/scripts/future-operational-check.sh');
    for (const target of [
      '../../scripts/gate-a.sh',
      '../../scripts/gate-b.sh',
      '../../unselected/gate.sh',
      '../../unselected/missing.sh',
      '/var/tmp/cauce-sensitive-external-target',
    ]) {
      await symlink(target, link);
      for (const arguments_ of [
        ['--domain', 'verification'],
        ['--domain', 'full', '--list'],
      ] as const) {
        const rejected = run(root, ...arguments_);
        expect(rejected.status).toBe(2);
        expect(rejected.stderr).toContain('source digest rejects symlinks in covered inputs');
        expect(rejected.stderr).not.toContain(target);
        expect(rejected.stdout).toBe('');
      }
      expect(digest(root, 'runtime')).toBe(before.runtime);
      await rm(link);
      expect(digest(root, 'verification')).toBe(before.verification);
      expect(digest(root, 'full')).toBe(before.full);
    }
  });

  test('cache directories and Python bytecode are excluded from every domain', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cauce-source-digest-caches-'));
    scratch.push(root);
    for (const [relative, contents] of [
      ['package.json', '{}\n'],
      ['pnpm-lock.yaml', 'lockfileVersion: 9\n'],
      ['pnpm-workspace.yaml', 'packages: []\n'],
      ['tsconfig.json', '{}\n'],
      ['services/gateway/index.ts', 'export const runtime = 1;\n'],
      ['console/src/App.tsx', 'export const console = 1;\n'],
      ['ops/harness/contract-runner.mjs', 'export const harness = 1;\n'],
      ['tests/e2e/real-qa.test.ts', 'export const qa = 1;\n'],
      ['ops/scripts/validate.sh', '#!/bin/sh\nexit 0\n'],
    ] as const) {
      await writeTree(root, relative, contents);
    }
    const domains = ['runtime', 'console', 'testcontainers', 'verification', 'full'] as const;
    const before = Object.fromEntries(domains.map((domain) => [domain, digest(root, domain)]));

    for (const [relative, contents] of [
      ['services/gateway/__pycache__/runtime.pyc', 'runtime cache'],
      ['services/gateway/runtime.pyo', 'runtime optimized cache'],
      ['console/.pytest_cache/v/cache/nodeids', 'console cache'],
      ['console/src/console.pyc', 'console bytecode'],
      ['ops/harness/__pycache__/harness.pyc', 'harness cache'],
      ['ops/harness/harness.pyo', 'harness optimized cache'],
      ['tests/e2e/.pytest_cache/state.json', 'testcontainers cache'],
      ['tests/e2e/qa.pyc', 'testcontainers bytecode'],
      ['ops/scripts/__pycache__/deploy.pyc', 'verification cache'],
      ['ops/scripts/deploy.pyo', 'verification optimized cache'],
    ] as const) {
      await writeTree(root, relative, contents);
    }

    for (const domain of domains) expect(digest(root, domain), domain).toBe(before[domain]);
    const listing = run(root, '--domain', 'full', '--list');
    expect(listing.status, listing.stderr).toBe(0);
    expect(listing.stdout).not.toMatch(/(?:^|\/)__(?:pycache)__(?:\/|$)/mu);
    expect(listing.stdout).not.toMatch(/(?:^|\/)\.pytest_cache(?:\/|$)/mu);
    expect(listing.stdout).not.toMatch(/\.(?:pyc|pyo)$/mu);
  });
});
