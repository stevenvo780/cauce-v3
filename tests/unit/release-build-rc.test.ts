import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const releaseBuild = join(repository, 'ops/scripts/release-build.sh');
const scratch: string[] = [];

type Fixture = { root: string; env: NodeJS.ProcessEnv; log: string; commit: string };

type ReleaseBuildEvidence = {
  schemaVersion: number;
  sourceRevision: {
    commit: string;
    worktreeStatus: string;
    untrackedPolicy: string;
    excludedUntrackedPresent: boolean;
    buildContext: string;
  };
  runtime: {
    imageId: string;
    repositoryDigest: string;
  };
  console: {
    repositoryDigest: string;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isReleaseBuildEvidence(value: unknown): value is ReleaseBuildEvidence {
  if (!isRecord(value) || !isRecord(value.sourceRevision)
    || !isRecord(value.runtime) || !isRecord(value.console)) {
    return false;
  }
  return typeof value.schemaVersion === 'number'
    && typeof value.sourceRevision.commit === 'string'
    && typeof value.sourceRevision.worktreeStatus === 'string'
    && typeof value.sourceRevision.untrackedPolicy === 'string'
    && typeof value.sourceRevision.excludedUntrackedPresent === 'boolean'
    && typeof value.sourceRevision.buildContext === 'string'
    && typeof value.runtime.imageId === 'string'
    && typeof value.runtime.repositoryDigest === 'string'
    && typeof value.console.repositoryDigest === 'string';
}

function parseReleaseBuildEvidence(text: string): ReleaseBuildEvidence {
  const parsed: unknown = JSON.parse(text);
  if (!isReleaseBuildEvidence(parsed)) {
    throw new Error('release build evidence does not match the required test shape');
  }
  return parsed;
}

async function executable(path: string, content: string) {
  await writeFile(path, content);
  await chmod(path, 0o755);
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'cauce-release-build-'));
  scratch.push(root);
  for (const directory of ['ops/scripts', 'packages/store/migrations', 'deploy', 'bin']) {
    await mkdir(join(root, directory), { recursive: true });
  }
  await writeFile(join(root, '.dockerignore'), 'node_modules\napps/console/src/features/_grafo/\n');
  await writeFile(join(root, '.gitignore'), 'ops/artifacts/\ndocker.log\n');
  await writeFile(join(root, 'deploy/Dockerfile'), 'FROM scratch AS runtime\nFROM scratch AS console\n');
  await writeFile(join(root, 'deploy/runtime-package-smoke.mjs'), 'process.exit(0);\n');
  await writeFile(join(root, 'packages/store/migrations/029_release.sql'), 'SELECT 1;\n');
  await writeFile(join(root, 'ops/scripts/release-build.sh'), await readFile(releaseBuild));
  await chmod(join(root, 'ops/scripts/release-build.sh'), 0o755);
  await executable(
    join(root, 'ops/scripts/source-digest.py'),
    `#!/usr/bin/env python3
import sys
print('sha256:' + ('2' if 'console' in sys.argv else '1') * 64)
`,
  );
  await executable(
    join(root, 'ops/scripts/container_ops_digest.py'),
    `#!/usr/bin/env python3
print('sha256:' + '3' * 64)
`,
  );
  await executable(
    join(root, 'ops/scripts/manifest.sh'),
    `#!/bin/sh
set -eu
directory=$1
(cd "$directory" && sha256sum build.json > SHA256SUMS)
`,
  );
  const log = join(root, 'docker.log');
  await executable(
    join(root, 'bin/docker'),
    `#!/bin/sh
set -eu
printf '%s\t%s\n' "\${DOCKER_BUILDKIT:-}" "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = build ] && [ "\${2:-}" = --help ]; then exit 0; fi
if [ "$1" = build ] || [ "$1" = run ] || [ "$1" = push ] || [ "$1" = pull ]; then exit 0; fi
if [ "$1" = image ] && [ "$2" = inspect ]; then
  last=
  for value in "$@"; do last=$value; done
  case " $* " in
    *io.cauce.schema.compatible-through*) printf '029_release.sql\n' ;;
    *RepoDigests*)
      case "$last" in
        *runtime*) printf '["registry.invalid/cauce/runtime@sha256:%064d"]\n' 4 ;;
        *) printf '["registry.invalid/cauce/console@sha256:%064d"]\n' 5 ;;
      esac ;;
    *)
      case "$last" in
        *runtime*)
          if [ "\${FAKE_RECOVERY_MISMATCH:-0}" = 1 ] && echo "$last" | grep -q '@sha256:'; then
            printf 'sha256:%064d\n' 9
          else
            printf 'sha256:%064d\n' 6
          fi ;;
        *) printf 'sha256:%064d\n' 7 ;;
      esac ;;
  esac
  exit 0
fi
exit 1
`,
  );
  spawnSync('git', ['init', '-q'], { cwd: root });
  spawnSync('git', ['config', 'user.email', 'release@test.invalid'], { cwd: root });
  spawnSync('git', ['config', 'user.name', 'Release Test'], { cwd: root });
  spawnSync('git', ['add', '.'], { cwd: root });
  const committed = spawnSync('git', ['commit', '-qm', 'release fixture'], { cwd: root, encoding: 'utf8' });
  expect(committed.status, committed.stderr).toBe(0);
  const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
  return {
    root,
    log,
    commit,
    env: {
      ...process.env,
      PATH: `${join(root, 'bin')}:${process.env.PATH ?? ''}`,
      FAKE_DOCKER_LOG: log,
      CAUCE_RELEASE_COMMIT: commit,
      CAUCE_RUNTIME_REPOSITORY: 'registry.invalid/cauce/runtime',
      CAUCE_CONSOLE_REPOSITORY: 'registry.invalid/cauce/console',
      CAUCE_RELEASE_PULL: '0',
    },
  };
}

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('release build clean RC and registry evidence', () => {
  test('builds the committed archive, pushes/pulls exact RepoDigests, and records clean revision', async () => {
    const value = await fixture();
    const result = spawnSync(join(value.root, 'ops/scripts/release-build.sh'), [], {
      cwd: value.root, env: value.env, encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    const evidence = parseReleaseBuildEvidence(
      await readFile(join(value.root, 'ops/artifacts/release/build.json'), 'utf8'),
    );
    expect(evidence.schemaVersion).toBe(5);
    expect(evidence.sourceRevision).toMatchObject({
      commit: value.commit,
      worktreeStatus: 'tracked-and-index-clean',
      untrackedPolicy: 'only-apps-console-src-features-grafo',
      excludedUntrackedPresent: false,
      buildContext: 'git-archive',
    });
    expect(evidence.runtime.imageId).toBe(`sha256:${'0'.repeat(63)}6`);
    expect(evidence.runtime.repositoryDigest).toBe(`registry.invalid/cauce/runtime@sha256:${'0'.repeat(63)}4`);
    expect(evidence.console.repositoryDigest).toBe(`registry.invalid/cauce/console@sha256:${'0'.repeat(63)}5`);
    const calls = await readFile(value.log, 'utf8');
    expect(calls).toMatch(/^1\tbuild --help$/m);
    expect(calls).toMatch(/^1\tbuild .*--target runtime/m);
    expect(calls).toContain(`push registry.invalid/cauce/runtime:rc-${value.commit}`);
    expect(calls).toContain(`pull registry.invalid/cauce/runtime@sha256:${'0'.repeat(63)}4`);
  });

  test('preserves only the approved _grafo scratch and refuses every other untracked or mismatched RC', async () => {
    const approved = await fixture();
    await mkdir(join(approved.root, 'apps/console/src/features/_grafo'), { recursive: true });
    await writeFile(join(approved.root, 'apps/console/src/features/_grafo/consultas-grafo.sql'), 'SELECT 1;\n');
    const approvedResult = spawnSync(join(approved.root, 'ops/scripts/release-build.sh'), [], {
      cwd: approved.root, env: approved.env, encoding: 'utf8',
    });
    expect(approvedResult.status, approvedResult.stderr).toBe(0);
    const approvedEvidence = parseReleaseBuildEvidence(
      await readFile(join(approved.root, 'ops/artifacts/release/build.json'), 'utf8'),
    );
    expect(approvedEvidence.sourceRevision.excludedUntrackedPresent).toBe(true);

    const otherUntracked = await fixture();
    await writeFile(join(otherUntracked.root, 'release-notes.local'), 'not an approved release input\n');
    const dirtyResult = spawnSync(join(otherUntracked.root, 'ops/scripts/release-build.sh'), [], {
      cwd: otherUntracked.root, env: otherUntracked.env, encoding: 'utf8',
    });
    expect(dirtyResult.status).toBe(2);
    expect(dirtyResult.stderr).toContain('unapproved untracked path');
    const dirtyCalls = await readFile(otherUntracked.log, 'utf8').catch(() => '');
    expect(dirtyCalls).not.toContain('build --target');

    const trackedDirty = await fixture();
    await writeFile(join(trackedDirty.root, 'deploy/Dockerfile'), 'FROM scratch AS changed\n');
    const trackedResult = spawnSync(join(trackedDirty.root, 'ops/scripts/release-build.sh'), [], {
      cwd: trackedDirty.root, env: trackedDirty.env, encoding: 'utf8',
    });
    expect(trackedResult.status).toBe(2);
    expect(trackedResult.stderr).toContain('index or tracked worktree is not clean');
    const trackedCalls = await readFile(trackedDirty.log, 'utf8').catch(() => '');
    expect(trackedCalls).not.toContain('build --target');

    const mismatch = await fixture();
    const mismatchResult = spawnSync(join(mismatch.root, 'ops/scripts/release-build.sh'), [], {
      cwd: mismatch.root,
      env: { ...mismatch.env, CAUCE_RELEASE_COMMIT: 'f'.repeat(40) },
      encoding: 'utf8',
    });
    expect(mismatchResult.status).toBe(2);
    expect(mismatchResult.stderr).toContain('does not equal');
  });

  test('does not publish passing evidence when a pulled digest resolves to another image ID', async () => {
    const value = await fixture();
    const result = spawnSync(join(value.root, 'ops/scripts/release-build.sh'), [], {
      cwd: value.root,
      env: { ...value.env, FAKE_RECOVERY_MISMATCH: '1' },
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('did not recover the tested image ID');
    await expect(readFile(join(value.root, 'ops/artifacts/release/build.json'))).rejects.toThrow();
  });
});
