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
    manifestDigest: string;
  };
  console: {
    repositoryDigest: string;
    manifestDigest: string;
    publishJournalCapability: string;
  };
  baseImages: {
    node: { role: string; repositoryDigest: string; manifestDigest: string; imageId: string };
    python: { role: string; repositoryDigest: string; manifestDigest: string; imageId: string };
    nginx: { role: string; repositoryDigest: string; manifestDigest: string; imageId: string };
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isReleaseBuildEvidence(value: unknown): value is ReleaseBuildEvidence {
  if (!isRecord(value) || !isRecord(value.sourceRevision)
    || !isRecord(value.runtime) || !isRecord(value.console) || !isRecord(value.baseImages)
    || !isRecord(value.baseImages.node) || !isRecord(value.baseImages.python)
    || !isRecord(value.baseImages.nginx)) {
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
    && typeof value.runtime.manifestDigest === 'string'
    && typeof value.console.repositoryDigest === 'string'
    && typeof value.console.manifestDigest === 'string'
    && typeof value.console.publishJournalCapability === 'string'
    && typeof value.baseImages.node.role === 'string'
    && typeof value.baseImages.node.repositoryDigest === 'string'
    && typeof value.baseImages.node.manifestDigest === 'string'
    && typeof value.baseImages.node.imageId === 'string'
    && typeof value.baseImages.python.role === 'string'
    && typeof value.baseImages.python.repositoryDigest === 'string'
    && typeof value.baseImages.python.manifestDigest === 'string'
    && typeof value.baseImages.python.imageId === 'string'
    && typeof value.baseImages.nginx.role === 'string'
    && typeof value.baseImages.nginx.repositoryDigest === 'string'
    && typeof value.baseImages.nginx.manifestDigest === 'string'
    && typeof value.baseImages.nginx.imageId === 'string';
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
  await writeFile(join(root, 'deploy/Dockerfile'), [
    'ARG CAUCE_NODE_BASE',
    'ARG CAUCE_PYTHON_BASE',
    'ARG CAUCE_NGINX_BASE',
    'FROM ${CAUCE_NODE_BASE} AS build',
    'FROM ${CAUCE_NODE_BASE} AS production-dependencies',
    'FROM ${CAUCE_PYTHON_BASE} AS python-runtime',
    'FROM ${CAUCE_NODE_BASE} AS runtime',
    'FROM runtime AS qa-runtime',
    'FROM runtime AS authentic-harness',
    'FROM ${CAUCE_NGINX_BASE} AS console-base',
    'FROM console-base AS console-dev',
    'FROM console-base AS console',
    '',
  ].join('\n'));
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
if [ "\${DOCKER_BUILDKIT:-0}" = 1 ]; then
  printf 'release test fixture has no buildx plugin\n' >&2
  exit 86
fi
printf '%s\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = build ] && [ "\${2:-}" = --help ]; then exit 0; fi
if [ "$1" = build ] || [ "$1" = run ] || [ "$1" = push ] || [ "$1" = pull ]; then exit 0; fi
if [ "$1" = image ] && [ "$2" = inspect ]; then
  last=
  for value in "$@"; do last=$value; done
  if echo " $* " | grep -Fq '{{json .}}'; then
    base_json() {
      role=$1
      reference=$2
      identifier=$3
      manifest=\${reference##*@}
      media=application/vnd.oci.image.manifest.v1+json
      architecture=amd64
      if [ "\${FAKE_MULTIARCH_BASE:-}" = "$role" ]; then
        media=application/vnd.oci.image.index.v1+json
      fi
      if [ "\${FAKE_BASE_PLATFORM:-}" = "$role" ]; then architecture=arm64; fi
      printf '{"Id":"%s","Descriptor":{"digest":"%s","mediaType":"%s"},"RepoDigests":["%s"],"Os":"linux","Architecture":"%s","Config":{"Labels":{}}}\n' \
        "$identifier" "$manifest" "$media" "$reference" "$architecture"
    }
    final_json() {
      kind=$1
      reference=$2
      identifier=$3
      source=$4
      manifest=\${reference##*@}
      architecture=amd64
      if [ "\${FAKE_FINAL_PLATFORM:-}" = "$kind" ]; then architecture=arm64; fi
      if [ "\${FAKE_RECOVERY_MISMATCH:-0}" = 1 ] && [ "$kind" = runtime ]; then
        identifier=sha256:${'d'.repeat(64)}
      fi
      if [ "$kind" = runtime ]; then
        node_base=$CAUCE_NODE_BASE_IMAGE
        if [ "\${FAKE_RECOVERED_LABEL_MISMATCH:-0}" = 1 ]; then node_base=$CAUCE_NGINX_BASE_IMAGE; fi
        labels=$(printf '"io.cauce.source.digest":"%s","org.opencontainers.image.revision":"%s","org.opencontainers.image.base.name":"%s","io.cauce.base.node.repository-digest":"%s","io.cauce.base.python.repository-digest":"%s","io.cauce.target-platform":"linux/amd64","io.cauce.schema.compatible-through":"029_release.sql"' \
          "$source" "$CAUCE_RELEASE_COMMIT" "$node_base" "$node_base" "$CAUCE_PYTHON_BASE_IMAGE")
      else
        labels=$(printf '"io.cauce.source.digest":"%s","org.opencontainers.image.revision":"%s","org.opencontainers.image.base.name":"%s","io.cauce.base.nginx.repository-digest":"%s","io.cauce.console.publish-journal":"multi-intent-v1","io.cauce.target-platform":"linux/amd64"' \
          "$source" "$CAUCE_RELEASE_COMMIT" "$CAUCE_NGINX_BASE_IMAGE" "$CAUCE_NGINX_BASE_IMAGE")
      fi
      printf '{"Id":"%s","Descriptor":{"digest":"%s","mediaType":"application/vnd.oci.image.manifest.v1+json"},"RepoDigests":["%s"],"Os":"linux","Architecture":"%s","Config":{"Labels":{%s}}}\n' \
        "$identifier" "$manifest" "$reference" "$architecture" "$labels"
    }
    case "$last" in
      "$CAUCE_NODE_BASE_IMAGE") base_json node "$last" sha256:${'8'.repeat(64)} ;;
      "$CAUCE_PYTHON_BASE_IMAGE")
        python_id=sha256:${'9'.repeat(64)}
        if [ "\${FAKE_BASE_SAME_ID:-0}" = 1 ]; then python_id=sha256:${'8'.repeat(64)}; fi
        base_json python "$last" "$python_id" ;;
      "$CAUCE_NGINX_BASE_IMAGE") base_json nginx "$last" sha256:${'e'.repeat(64)} ;;
      *cauce/runtime@sha256:*) final_json runtime "$last" sha256:${'0'.repeat(63)}6 sha256:${'1'.repeat(64)} ;;
      *cauce/console@sha256:*) final_json console "$last" sha256:${'0'.repeat(63)}7 sha256:${'2'.repeat(64)} ;;
      *) exit 1 ;;
    esac
    exit 0
  fi
  case " $* " in
    *io.cauce.schema.compatible-through*) printf '029_release.sql\n' ;;
    *io.cauce.source.digest*)
      case "$last" in
        *runtime*) printf '%s\n' 'sha256:${'1'.repeat(64)}' ;;
        *) printf '%s\n' 'sha256:${'2'.repeat(64)}' ;;
      esac ;;
    *org.opencontainers.image.revision*) printf '%s\n' "$CAUCE_RELEASE_COMMIT" ;;
    *io.cauce.base.node.repository-digest*) printf '%s\n' "$CAUCE_NODE_BASE_IMAGE" ;;
    *io.cauce.base.python.repository-digest*) printf '%s\n' "$CAUCE_PYTHON_BASE_IMAGE" ;;
    *io.cauce.base.nginx.repository-digest*) printf '%s\n' "$CAUCE_NGINX_BASE_IMAGE" ;;
    *io.cauce.console.publish-journal*) printf 'multi-intent-v1\n' ;;
    *io.cauce.target-platform*) printf 'linux/amd64\n' ;;
    *org.opencontainers.image.base.name*)
      if [ "\${FAKE_PROVENANCE_MISMATCH:-0}" = 1 ]; then
        printf '%s\n' "$CAUCE_NGINX_BASE_IMAGE"
      else
        case "$last" in
          *runtime*) printf '%s\n' "$CAUCE_NODE_BASE_IMAGE" ;;
          *) printf '%s\n' "$CAUCE_NGINX_BASE_IMAGE" ;;
        esac
      fi ;;
    *RepoDigests*)
      case "$last" in
        *runtime*) printf '["registry.invalid/cauce/runtime@sha256:%064d"]\n' 4 ;;
        *) printf '["registry.invalid/cauce/console@sha256:%064d"]\n' 5 ;;
      esac ;;
    *)
      case "$last" in
        *runtime*)
          printf 'sha256:%064d\n' 6 ;;
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
      CAUCE_NODE_BASE_IMAGE: `docker.io/library/node@sha256:${'a'.repeat(64)}`,
      CAUCE_PYTHON_BASE_IMAGE: `docker.io/library/python@sha256:${'c'.repeat(64)}`,
      CAUCE_NGINX_BASE_IMAGE: `docker.io/nginxinc/nginx-unprivileged@sha256:${'b'.repeat(64)}`,
      CAUCE_RELEASE_PULL: '0',
      DOCKER_BUILDKIT: '0',
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
    expect(evidence.schemaVersion).toBe(7);
    expect(evidence.console.publishJournalCapability).toBe('multi-intent-v1');
    expect(evidence.sourceRevision).toMatchObject({
      commit: value.commit,
      worktreeStatus: 'tracked-and-index-clean',
      untrackedPolicy: 'only-apps-console-src-features-grafo',
      excludedUntrackedPresent: false,
      buildContext: 'git-archive',
    });
    expect(evidence.runtime.imageId).toBe(`sha256:${'0'.repeat(63)}6`);
    expect(evidence.runtime.repositoryDigest).toBe(`registry.invalid/cauce/runtime@sha256:${'0'.repeat(63)}4`);
    expect(evidence.runtime.manifestDigest).toBe(`sha256:${'0'.repeat(63)}4`);
    expect(evidence.console.repositoryDigest).toBe(`registry.invalid/cauce/console@sha256:${'0'.repeat(63)}5`);
    expect(evidence.console.manifestDigest).toBe(`sha256:${'0'.repeat(63)}5`);
    expect(evidence.baseImages).toEqual({
      node: {
        role: 'node',
        repositoryDigest: `docker.io/library/node@sha256:${'a'.repeat(64)}`,
        manifestDigest: `sha256:${'a'.repeat(64)}`,
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        platform: { os: 'linux', architecture: 'amd64' },
        imageId: `sha256:${'8'.repeat(64)}`,
      },
      python: {
        role: 'python',
        repositoryDigest: `docker.io/library/python@sha256:${'c'.repeat(64)}`,
        manifestDigest: `sha256:${'c'.repeat(64)}`,
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        platform: { os: 'linux', architecture: 'amd64' },
        imageId: `sha256:${'9'.repeat(64)}`,
      },
      nginx: {
        role: 'nginx',
        repositoryDigest: `docker.io/nginxinc/nginx-unprivileged@sha256:${'b'.repeat(64)}`,
        manifestDigest: `sha256:${'b'.repeat(64)}`,
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
        platform: { os: 'linux', architecture: 'amd64' },
        imageId: `sha256:${'e'.repeat(64)}`,
      },
    });
    const calls = await readFile(value.log, 'utf8');
    expect(calls).toContain(`push registry.invalid/cauce/runtime:rc-${value.commit}`);
    expect(calls).toContain(`pull --platform linux/amd64 registry.invalid/cauce/runtime@sha256:${'0'.repeat(63)}4`);
    expect(calls).not.toContain(`pull --platform linux/amd64 ${value.env.CAUCE_NODE_BASE_IMAGE}`);
    expect(calls).not.toContain(`pull --platform linux/amd64 ${value.env.CAUCE_PYTHON_BASE_IMAGE}`);
    expect(calls).not.toContain(`pull --platform linux/amd64 ${value.env.CAUCE_NGINX_BASE_IMAGE}`);
    expect(calls.match(/build --provenance=false --platform linux\/amd64/g)).toHaveLength(2);
    expect(calls).toContain(`--build-arg CAUCE_NODE_BASE=${value.env.CAUCE_NODE_BASE_IMAGE}`);
    expect(calls).toContain(`--build-arg CAUCE_PYTHON_BASE=${value.env.CAUCE_PYTHON_BASE_IMAGE}`);
    expect(calls).toContain(`--build-arg CAUCE_NGINX_BASE=${value.env.CAUCE_NGINX_BASE_IMAGE}`);
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
    expect(result.stderr).toContain('recovered runtime identity, labels or platform mismatch');
    await expect(readFile(join(value.root, 'ops/artifacts/release/build.json'))).rejects.toThrow();
  });

  test('does not publish images whose final provenance labels diverge from the pinned inputs', async () => {
    const value = await fixture();
    const result = spawnSync(join(value.root, 'ops/scripts/release-build.sh'), [], {
      cwd: value.root,
      env: { ...value.env, FAKE_PROVENANCE_MISMATCH: '1' },
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('final image provenance labels mismatch');
    const calls = await readFile(value.log, 'utf8');
    expect(calls).not.toContain('push registry.invalid/cauce/runtime');
    await expect(readFile(join(value.root, 'ops/artifacts/release/build.json'))).rejects.toThrow();
  });

  test('refuses mutable or missing base selectors before building or publishing', async () => {
    const value = await fixture();
    const mutable = spawnSync(join(value.root, 'ops/scripts/release-build.sh'), [], {
      cwd: value.root,
      env: { ...value.env, CAUCE_NODE_BASE_IMAGE: 'node:22-alpine' },
      encoding: 'utf8',
    });
    expect(mutable.status).toBe(2);
    expect(mutable.stderr).toContain('Node base must be an immutable canonical RepoDigest');
    expect(await readFile(value.log, 'utf8').catch(() => '')).not.toContain('build --target');
  });

  test('pulls all role-specific bases only in online mode', async () => {
    const value = await fixture();
    const result = spawnSync(join(value.root, 'ops/scripts/release-build.sh'), [], {
      cwd: value.root,
      env: { ...value.env, CAUCE_RELEASE_PULL: '1' },
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    const calls = await readFile(value.log, 'utf8');
    for (const reference of [
      value.env.CAUCE_NODE_BASE_IMAGE,
      value.env.CAUCE_PYTHON_BASE_IMAGE,
      value.env.CAUCE_NGINX_BASE_IMAGE,
    ]) {
      expect(calls).toContain(`pull --platform linux/amd64 ${reference}`);
    }
  });

  test('refuses a multiarch index, wrong platform, duplicated base ID, or wrong repository role', async () => {
    for (const [overrides, diagnostic] of [
      [{ FAKE_MULTIARCH_BASE: 'node' }, 'Node base is not a locally bound linux/amd64 child manifest'],
      [{ FAKE_BASE_PLATFORM: 'python' }, 'Python base is not a locally bound linux/amd64 child manifest'],
      [{ FAKE_BASE_SAME_ID: '1' }, 'base manifests and image IDs must be role-distinct'],
      [{
        CAUCE_PYTHON_BASE_IMAGE: `docker.io/library/node@sha256:${'c'.repeat(64)}`,
      }, 'Python base has the wrong repository role'],
    ] as const) {
      const value = await fixture();
      const result = spawnSync(join(value.root, 'ops/scripts/release-build.sh'), [], {
        cwd: value.root,
        env: { ...value.env, ...overrides },
        encoding: 'utf8',
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(diagnostic);
      expect(await readFile(value.log, 'utf8').catch(() => '')).not.toContain('push registry.invalid/cauce/runtime');
    }
  });

  test('refuses recovered final images with forged labels or a different platform', async () => {
    for (const overrides of [
      { FAKE_RECOVERED_LABEL_MISMATCH: '1' },
      { FAKE_FINAL_PLATFORM: 'runtime' },
    ]) {
      const value = await fixture();
      const result = spawnSync(join(value.root, 'ops/scripts/release-build.sh'), [], {
        cwd: value.root,
        env: { ...value.env, ...overrides },
        encoding: 'utf8',
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('recovered runtime identity, labels or platform mismatch');
      await expect(readFile(join(value.root, 'ops/artifacts/release/build.json'))).rejects.toThrow();
    }
  });

  test('refuses a committed Dockerfile that routes a final stage around the pinned bases', async () => {
    const value = await fixture();
    const dockerfile = join(value.root, 'deploy/Dockerfile');
    await writeFile(dockerfile, (await readFile(dockerfile, 'utf8')).replace(
      'FROM ${CAUCE_NGINX_BASE} AS console-base',
      'FROM scratch AS console-base',
    ));
    spawnSync('git', ['add', 'deploy/Dockerfile'], { cwd: value.root });
    const committed = spawnSync('git', ['commit', '-qm', 'malicious lineage fixture'], {
      cwd: value.root, encoding: 'utf8',
    });
    expect(committed.status, committed.stderr).toBe(0);
    const commit = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: value.root, encoding: 'utf8',
    }).stdout.trim();
    const result = spawnSync(join(value.root, 'ops/scripts/release-build.sh'), [], {
      cwd: value.root,
      env: { ...value.env, CAUCE_RELEASE_COMMIT: commit },
      encoding: 'utf8',
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Dockerfile stage lineage is not bound to the pinned bases');
    expect(await readFile(value.log, 'utf8').catch(() => '')).not.toContain('build --target');
  });

  test('keeps the release Dockerfile portable when buildx is unavailable', async () => {
    const dockerfile = await readFile(join(repository, 'deploy/Dockerfile'), 'utf8');
    expect(dockerfile).not.toMatch(/^\s*COPY\b.*--chmod=/mu);
    expect(dockerfile).not.toContain('apk add');
    expect(dockerfile).toContain(
      'ARG CAUCE_NODE_BASE=docker.io/library/node@sha256:56a687b4d23e7a6cb49114924f5e257fcfbd33ad1f28f5c67aea9365996f2819',
    );
    expect(dockerfile).toContain(
      'ARG CAUCE_PYTHON_BASE=docker.io/library/python@sha256:53739acebd52a300f19f52d93f2a6165f63300689bdf6f8af2bff0d63780e5e6',
    );
    expect(dockerfile).toContain(
      'ARG CAUCE_NGINX_BASE=docker.io/nginxinc/nginx-unprivileged@sha256:28d91bdce70ad09025ea901458fdd149259d8e05982ade79d4ef2c0d9470eb48',
    );
    expect(dockerfile).toContain('COPY --from=python-runtime /usr/local /usr/local');
    expect(dockerfile).toContain('RUN chmod -R 0555 ./packages/adapter-sdk/dist/bridge');
    expect(dockerfile).toContain(
      'FROM console-base AS console\nUSER root\n'
      + 'COPY deploy/nginx-console-tls.conf /etc/nginx/conf.d/default.conf\n'
      + 'RUN chmod 0644 /etc/nginx/conf.d/default.conf\nUSER 101\n',
    );
  });
});
