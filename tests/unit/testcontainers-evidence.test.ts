import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const validator = join(repository, 'ops/scripts/validate-testcontainers-evidence.py');
const sourceDigest = join(repository, 'ops/scripts/source-digest.py');
const scratch: string[] = [];

function digest(domain: 'runtime' | 'testcontainers'): string {
  const result = spawnSync('python3', [sourceDigest, '--domain', domain], {
    cwd: repository,
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function writeSuite(
  root: string,
  name: 'real' | 'restarts',
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const directory = join(root, name);
  await mkdir(directory);
  const now = new Date().toISOString();
  const report = `${JSON.stringify({
    schemaVersion: 2,
    suite: name === 'real' ? 'cauce-v3-real-e2e' : 'cauce-v3-restart-e2e',
    evidenceClass: 'testcontainers-source-execution',
    mode: 'real',
    executionTarget: {
      application: 'source-tree', database: 'immutable-testcontainer-image', finalCauceImageExecuted: false,
    },
    sourceDigest: digest('runtime'),
    sourceDigestDomain: 'runtime',
    harnessDigest: digest('testcontainers'),
    harnessDigestDomain: 'testcontainers',
    databaseImage: {
      role: 'postgresql-test-dependency',
      repositoryDigest: `docker.io/library/postgres@sha256:${'a'.repeat(64)}`,
      imageId: `sha256:${'b'.repeat(64)}`,
      containerConfigImage: 'postgres:16-alpine',
      containerIdSha256: `sha256:${'c'.repeat(64)}`,
      verifiedAgainstRunningContainer: true,
    },
    startedAt: now,
    finishedAt: now,
    summary: { tests: 1, passed: 1, failed: 0, skipped: 0, criticalSkipped: 0, real: 1, mocked: 0 },
    tests: [{ name: `${name} proof`, status: 'passed', evidence: 'real' }],
    ...overrides,
  }, null, 2)}\n`;
  const junit = `<?xml version="1.0"?><testsuite tests="1" failures="0" skipped="0"/>\n`;
  await writeFile(join(directory, 'report.json'), report);
  await writeFile(join(directory, 'junit.xml'), junit);
  await writeFile(join(directory, 'SHA256SUMS'), `${sha(report)}  report.json\n${sha(junit)}  junit.xml\n`);
}

async function fixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'cauce-testcontainers-evidence-'));
  scratch.push(directory);
  await writeSuite(directory, 'real');
  await writeSuite(directory, 'restarts');
  return directory;
}

function run(directory: string) {
  return spawnSync('python3', [validator, '--run-dir', directory], {
    cwd: repository,
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
}

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('Testcontainers release evidence', () => {
  test('accepts only source/harness-bound all-passing reports with one actual immutable DB image', async () => {
    const directory = await fixture();
    const result = run(directory);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('Testcontainers evidence passed\n');
  });

  test('rejects manifest mutation and another image between real and restart reports', async () => {
    const mutated = await fixture();
    await writeFile(join(mutated, 'real/junit.xml'), '<testsuite/>\n');
    const mutation = run(mutated);
    expect(mutation.status).toBe(1);
    expect(mutation.stderr).toContain('differs from SHA256SUMS');

    const imageDrift = await mkdtemp(join(tmpdir(), 'cauce-testcontainers-image-drift-'));
    scratch.push(imageDrift);
    await writeSuite(imageDrift, 'real');
    const original: unknown = JSON.parse(await readFile(join(imageDrift, 'real/report.json'), 'utf8'));
    if (typeof original !== 'object' || original === null) throw new Error('fixture report invalid');
    const changedImage = {
      ...(original as Record<string, unknown>),
      suite: 'cauce-v3-restart-e2e',
      databaseImage: {
        ...((original as { databaseImage: Record<string, unknown> }).databaseImage),
        imageId: `sha256:${'d'.repeat(64)}`,
      },
    };
    await writeSuite(imageDrift, 'restarts', changedImage);
    const drift = run(imageDrift);
    expect(drift.status).toBe(1);
    expect(drift.stderr).toContain('exercised different Testcontainers images');
  });
});
