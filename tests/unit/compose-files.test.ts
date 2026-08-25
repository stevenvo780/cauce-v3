import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const resolver = join(repository, 'ops/scripts/compose-files.sh');
const compose = join(repository, 'ops/scripts/compose.sh');
const scratch: string[] = [];

function digest(content: string) {
  return createHash('sha256').update(content).digest('hex');
}

function cleanEnvironment(extra: NodeJS.ProcessEnv = {}) {
  const environment = { ...process.env, ...extra };
  delete environment.CAUCE_COMPOSE_OVERRIDE_MANIFEST;
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
    expect(result.status).toBe(0);
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
    await writeFile(
      manifest,
      [
        `active ${digest(second)} second.yaml`,
        `inactive ${digest(dormant)} dormant.yaml`,
        `active ${digest(first)} first.yaml`,
      ].join('\n') + '\n',
    );

    const result = runResolver('overrides', { CAUCE_COMPOSE_OVERRIDE_MANIFEST: manifest });
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual([
      join(directory, 'second.yaml'),
      join(directory, 'first.yaml'),
    ]);
  });

  test('fails closed when a declared file changes or an undeclared YAML appears', async () => {
    const directory = await fixture();
    const content = 'services: {}\n';
    const pathname = join(directory, 'only.yaml');
    const manifest = join(directory, 'active.manifest');
    await writeFile(pathname, content);
    await writeFile(manifest, `active ${digest(content)} only.yaml\n`);
    await writeFile(pathname, `${content}# tampered\n`);

    let result = runResolver('overrides', { CAUCE_COMPOSE_OVERRIDE_MANIFEST: manifest });
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('SHA-256 mismatch');

    await writeFile(pathname, content);
    await writeFile(join(directory, 'unlisted.yaml'), content);
    result = runResolver('overrides', { CAUCE_COMPOSE_OVERRIDE_MANIFEST: manifest });
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('absent from manifest');
  });

  test('rejects symlinked override bytes even when their digest matches', async () => {
    const directory = await fixture();
    const content = 'services: {}\n';
    await writeFile(join(directory, 'target.txt'), content);
    await symlink('target.txt', join(directory, 'linked.yaml'));
    const manifest = join(directory, 'active.manifest');
    await writeFile(manifest, `active ${digest(content)} linked.yaml\n`);
    const result = runResolver('overrides', { CAUCE_COMPOSE_OVERRIDE_MANIFEST: manifest });
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('symlink');
  });

  test('compose.sh treats the env file as data and forwards exactly the resolved set', async () => {
    const directory = await fixture();
    const fakeBin = join(directory, 'bin');
    const fakeDocker = join(fakeBin, 'docker');
    const marker = join(directory, 'must-not-exist');
    await mkdir(fakeBin);
    await writeFile(
      fakeDocker,
      '#!/bin/sh\nif [ "$1" = compose ] && [ "$2" = version ]; then exit 0; fi\nprintf "%s\\n" "$@"\n',
    );
    await chmod(fakeDocker, 0o755);

    const active = 'services: {}\n';
    const inactive = 'services:\n  dormant: {}\n';
    await writeFile(join(directory, 'active.yaml'), active);
    await writeFile(join(directory, 'inactive.yaml'), inactive);
    const manifest = join(directory, 'active.manifest');
    await writeFile(
      manifest,
      `active ${digest(active)} active.yaml\ninactive ${digest(inactive)} inactive.yaml\n`,
    );
    const envFile = join(directory, 'prod.env');
    await writeFile(
      envFile,
      `CAUCE_LOCAL_POSTGRES=0\nCAUCE_COMPOSE_OVERRIDE_MANIFEST=${manifest}\nUNRELATED=$(touch ${marker})\n`,
    );

    const environment = cleanEnvironment({
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      CAUCE_ENV_FILE: envFile,
    });
    const result = spawnSync(compose, ['prod', 'config', '--quiet'], {
      encoding: 'utf8',
      env: environment,
    });
    expect(result.status).toBe(0);
    const argumentsPassed = result.stdout.trim().split('\n');
    expect(argumentsPassed).toContain(join(repository, 'deploy/compose.yaml'));
    expect(argumentsPassed).toContain(join(directory, 'active.yaml'));
    expect(argumentsPassed).not.toContain(join(directory, 'inactive.yaml'));
    const markerProbe = spawnSync('test', ['-e', marker]);
    expect(markerProbe.status).not.toBe(0);
  });
});
