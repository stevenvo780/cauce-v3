import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const resolver = join(repository, 'ops/scripts/compose-files.sh');
const compose = join(repository, 'ops/scripts/compose.sh');
const validator = join(repository, 'ops/scripts/validate.sh');
const scratch: string[] = [];

function digest(content: string) {
  return createHash('sha256').update(content).digest('hex');
}

function cleanEnvironment(extra: NodeJS.ProcessEnv = {}) {
  const environment = { ...process.env, ...extra };
  delete environment.CAUCE_COMPOSE_OVERRIDE_MANIFEST;
  delete environment.CAUCE_COMPOSE_OVERRIDE_MANIFEST_SHA256;
  delete environment.CAUCE_COMPOSE_OVERRIDES_DIR;
  delete environment.CAUCE_LOCAL_POSTGRES;
  return { ...environment, ...extra };
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'cauce-compose-files-'));
  scratch.push(directory);
  return directory;
}

function runResolver(target: string, environment: NodeJS.ProcessEnv) {
  return spawnSync(resolver, [target], { encoding: 'utf8', env: cleanEnvironment(environment) });
}

function manifestSelection(path: string, content: string): NodeJS.ProcessEnv {
  return {
    CAUCE_COMPOSE_OVERRIDE_MANIFEST: path,
    CAUCE_COMPOSE_OVERRIDE_MANIFEST_SHA256: `sha256:${digest(content)}`,
  };
}

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('authoritative Compose file set', () => {
  test('uses no overrides only when the configured directory contains no YAML', async () => {
    const directory = await fixture();
    let result = runResolver('prod', {
      CAUCE_COMPOSE_OVERRIDES_DIR: directory,
      CAUCE_LOCAL_POSTGRES: '0',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(join(repository, 'deploy/compose.yaml'));

    await writeFile(join(directory, 'forgotten.yaml'), 'services: {}\n');
    result = runResolver('prod', {
      CAUCE_COMPOSE_OVERRIDES_DIR: directory,
      CAUCE_LOCAL_POSTGRES: '0',
    });
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('CAUCE_COMPOSE_OVERRIDE_MANIFEST is unset');
  });

  test('emits active entries in manifest order and authenticates inactive entries', async () => {
    const directory = await fixture();
    const first = 'services:\n  alpha:\n    image: alpha@sha256:1\n';
    const second = 'services:\n  beta:\n    image: beta@sha256:2\n';
    const dormant = 'services:\n  old:\n    image: old@sha256:3\n';
    await writeFile(join(directory, 'first.yaml'), first);
    await writeFile(join(directory, 'second.yaml'), second);
    await writeFile(join(directory, 'dormant.yaml'), dormant);
    const manifest = join(directory, 'active.manifest');
    const manifestContent = [
      `active ${digest(second)} second.yaml`,
      `inactive ${digest(dormant)} dormant.yaml`,
      `active ${digest(first)} first.yaml`,
    ].join('\n') + '\n';
    await writeFile(manifest, manifestContent);

    const result = runResolver('overrides', manifestSelection(manifest, manifestContent));
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual([
      join(directory, 'second.yaml'),
      join(directory, 'first.yaml'),
    ]);

    await writeFile(manifest, `${manifestContent}# changed after selector publication\n`);
    const stale = runResolver('overrides', manifestSelection(manifest, manifestContent));
    expect(stale.status).toBe(3);
    expect(stale.stderr).toContain('selected SHA-256');

    const missingSha = runResolver('overrides', { CAUCE_COMPOSE_OVERRIDE_MANIFEST: manifest });
    expect(missingSha.status).toBe(3);
    expect(missingSha.stderr).toContain('must be an explicit sha256 digest');
  });

  test('fails closed when a declared file changes or an undeclared YAML appears', async () => {
    const directory = await fixture();
    const content = 'services: {}\n';
    const pathname = join(directory, 'only.yaml');
    const manifest = join(directory, 'active.manifest');
    await writeFile(pathname, content);
    const manifestContent = `active ${digest(content)} only.yaml\n`;
    await writeFile(manifest, manifestContent);
    await writeFile(pathname, `${content}# tampered\n`);

    let result = runResolver('overrides', manifestSelection(manifest, manifestContent));
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('SHA-256 mismatch');

    await writeFile(pathname, content);
    await writeFile(join(directory, 'unlisted.yaml'), content);
    result = runResolver('overrides', manifestSelection(manifest, manifestContent));
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('absent from manifest');
  });

  test('rejects symlinked override bytes even when their digest matches', async () => {
    const directory = await fixture();
    const content = 'services: {}\n';
    await writeFile(join(directory, 'target.txt'), content);
    await symlink('target.txt', join(directory, 'linked.yaml'));
    const manifest = join(directory, 'active.manifest');
    const manifestContent = `active ${digest(content)} linked.yaml\n`;
    await writeFile(manifest, manifestContent);
    const result = runResolver('overrides', manifestSelection(manifest, manifestContent));
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('symlink');
  });

  test('compose.sh treats the env file as data and forwards exactly the resolved set', async () => {
    const directory = await fixture();
    const fakeBin = join(directory, 'bin');
    const fakeDocker = join(fakeBin, 'docker');
    const marker = join(directory, 'must-not-exist');
    const poisonedBin = join(directory, 'poisoned-bin');
    const poisonedMarker = join(directory, 'poisoned-command-ran');
    await Promise.all([mkdir(fakeBin), mkdir(poisonedBin)]);
    await writeFile(
      fakeDocker,
      '#!/bin/sh\nif [ "$1" = compose ] && [ "$2" = version ]; then exit 0; fi\nprintf "%s\\n" "$@"\n',
    );
    await chmod(fakeDocker, 0o755);
    for (const name of ['docker', 'python3']) {
      const path = join(poisonedBin, name);
      await writeFile(path, `#!/bin/sh\n/usr/bin/touch ${JSON.stringify(poisonedMarker)}\nexit 0\n`);
      await chmod(path, 0o755);
    }

    // The production wrapper intentionally ignores ambient PATH.  Keep the
    // fixture hermetic by copying it with a test-only canonical path and its
    // real repository root baked into the temporary source.
    const composeUnderTest = join(directory, 'compose.sh');
    const composeSource = (await readFile(compose, 'utf8'))
      .replace(
        'system_path=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        `system_path=${fakeBin}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
      )
      .replace(
        'ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)',
        `ROOT=${JSON.stringify(join(repository, 'ops'))}`,
      );
    expect(composeSource).not.toBe(await readFile(compose, 'utf8'));
    await writeFile(composeUnderTest, composeSource);
    await chmod(composeUnderTest, 0o755);

    const active = 'services: {}\n';
    const inactive = 'services:\n  dormant: {}\n';
    await writeFile(join(directory, 'active.yaml'), active);
    await writeFile(join(directory, 'inactive.yaml'), inactive);
    const manifest = join(directory, 'active.manifest');
    const manifestContent = `active ${digest(active)} active.yaml\ninactive ${digest(inactive)} inactive.yaml\n`;
    await writeFile(manifest, manifestContent);
    const envFile = join(directory, 'prod.env');
    await writeFile(
      envFile,
      `CAUCE_LOCAL_POSTGRES=0\nCAUCE_COMPOSE_OVERRIDE_MANIFEST=${manifest}\n` +
      `CAUCE_COMPOSE_OVERRIDE_MANIFEST_SHA256=sha256:${digest(manifestContent)}\n` +
      `CAUCE_RUNTIME_IMAGE=registry.invalid/cauce/runtime@sha256:${'1'.repeat(64)}\n` +
      `CAUCE_CONSOLE_IMAGE=registry.invalid/cauce/console@sha256:${'2'.repeat(64)}\n` +
      `CAUCE_ROLLBACK_BASELINE_FILE=${manifest}\n` +
      `CAUCE_ROLLBACK_BASELINE_SHA256=sha256:${digest(manifestContent)}\n` +
      `UNRELATED=$(touch ${marker})\n`,
    );

    const environment = cleanEnvironment({
      PATH: poisonedBin,
      CAUCE_ENV_FILE: envFile,
    });
    const result = spawnSync(composeUnderTest, ['prod', 'config', '--quiet'], {
      encoding: 'utf8',
      env: environment,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(spawnSync('test', ['-e', poisonedMarker]).status).not.toBe(0);
    const argumentsPassed = result.stdout.trim().split('\n');
    expect(argumentsPassed).toContain(join(repository, 'deploy/compose.yaml'));
    expect(argumentsPassed).toContain(join(directory, 'active.yaml'));
    expect(argumentsPassed).not.toContain(join(directory, 'inactive.yaml'));
    const markerProbe = spawnSync('test', ['-e', marker]);
    expect(markerProbe.status).not.toBe(0);

    const poisoned = spawnSync(composeUnderTest, ['prod', 'config', '--quiet'], {
      encoding: 'utf8',
      env: {
        ...environment,
        CAUCE_COMPOSE_OVERRIDE_MANIFEST: join(directory, 'attacker.manifest'),
        CAUCE_COMPOSE_OVERRIDE_MANIFEST_SHA256: `sha256:${'0'.repeat(64)}`,
      },
    });
    expect(poisoned.status).toBe(2);
    expect(poisoned.stderr).toContain('production Compose selector preview is disabled outside deployment tooling');

    await chmod(envFile, 0o600);
    const unlockedMutation = spawnSync(composeUnderTest, ['prod', '--dry-run', 'down'], {
      encoding: 'utf8', env: environment,
    });
    expect(unlockedMutation.status).toBe(2);
    expect(unlockedMutation.stderr).toContain('production Compose mutation is disabled outside deployment tooling');
    expect(unlockedMutation.stdout).toBe('');

    for (const argumentsList of [
      ['prod', 'config', '--output', join(directory, 'rendered.yaml')],
      ['prod', 'config', '--lock-image-digests'],
      ['prod', 'config', '--future-file-option'],
    ]) {
      const rejected = spawnSync(composeUnderTest, argumentsList, {
        encoding: 'utf8', env: environment,
      });
      expect(rejected.status).toBe(2);
      expect(rejected.stderr).toContain('production Compose mutation is disabled outside deployment tooling');
      expect(rejected.stdout).toBe('');
    }
    expect(spawnSync('test', ['-e', join(directory, 'rendered.yaml')]).status).not.toBe(0);

  });

  test('validation supplies its own private media bind instead of inheriting operator state', async () => {
    const source = await readFile(validator, 'utf8');
    expect(source).toContain('validation_media_dir="$tmp_release_state/media"');
    expect(source).toContain('chmod 0700 "$validation_media_dir"');
    expect(source).toContain('export CAUCE_MEDIA_RUNTIME_DIR="$validation_media_dir"');
  });
});
