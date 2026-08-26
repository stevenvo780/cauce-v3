import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const releaseConsole = join(repository, 'ops/scripts/release-console.sh');
const makefile = join(repository, 'ops/Makefile');
const runbook = join(repository, 'ops/runbooks/consola-rama-fuera-de-main.md');
const scratch: string[] = [];

type Fixture = { root: string; env: NodeJS.ProcessEnv; mutationLog: string };

afterEach(async () => {
  await Promise.all(scratch.splice(0).map(async (path) => rm(path, { force: true, recursive: true })));
});

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'cauce-release-console-retired-'));
  scratch.push(root);
  const bin = join(root, 'bin');
  const mutationLog = join(root, 'mutations.log');
  await mkdir(bin);
  const guarded = [
    'docker', 'ssh', 'scp', 'rsync', 'mv', 'cp', 'sed', 'ln', 'install', 'tee', 'systemctl',
  ];
  await Promise.all(guarded.map(async (command) => {
    const executable = join(bin, command);
    await writeFile(
      executable,
      `#!/bin/sh\nprintf '%s\\n' '${command}' >> "$CAUCE_MUTATION_LOG"\nexit 97\n`,
    );
    await chmod(executable, 0o755);
  }));
  return {
    root,
    mutationLog,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      CAUCE_MUTATION_LOG: mutationLog,
    },
  };
}

async function mutations(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

describe('retired console-only release path', () => {
  test.each(['desplegar', 'deploy', 'revertir', 'rollback'])('%s fails before any external mutation', async (action) => {
    const value = await fixture();
    const result = spawnSync(releaseConsole, [action], { encoding: 'utf8', env: value.env });

    expect(result.status).toBe(64);
    expect(result.stderr).toContain('camino historico release-console esta retirado');
    expect(result.stderr).toContain('deploy-release.sh');
    expect(result.stderr).toContain('locked-exec');
    expect(result.stderr).toContain('rollback.sh console');
    expect(await mutations(value.mutationLog)).toBe('');
  });

  test.each(['release-console', 'release-console-rollback'])('%s Make tombstone cannot mutate', async (target) => {
    const value = await fixture();
    const result = spawnSync('make', ['-C', join(repository, 'ops'), target], {
      encoding: 'utf8',
      env: value.env,
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('camino historico release-console esta retirado');
    expect(await mutations(value.mutationLog)).toBe('');
  });

  test('read-only verification preserves a registry host and port exactly', async () => {
    const value = await fixture();
    const reference = `127.0.0.1:5000/cauce/console@sha256:${'a'.repeat(64)}`;
    const result = spawnSync(releaseConsole, ['verificar', reference], {
      encoding: 'utf8',
      env: value.env,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(reference);
    expect(result.stdout).toContain('comprobacion local read-only');

    const makeResult = spawnSync('make', ['-C', join(repository, 'ops'), 'release-console-verify'], {
      encoding: 'utf8',
      env: { ...value.env, CAUCE_CONSOLE_IMAGE: reference },
    });
    expect(makeResult.status).toBe(0);
    expect(makeResult.stdout).toContain(reference);
    expect(await mutations(value.mutationLog)).toBe('');
  });

  test('read-only verification reads only the unique selector and never exposes other env lines', async () => {
    const value = await fixture();
    const reference = `registry.example:5443/humanizar/cauce-console@sha256:${'b'.repeat(64)}`;
    const envFile = join(value.root, 'prod.env');
    await writeFile(envFile, `PRIVATE_VALUE=must-not-be-printed\nCAUCE_CONSOLE_IMAGE=${reference}\n`, { mode: 0o600 });
    const result = spawnSync(releaseConsole, ['verificar'], {
      encoding: 'utf8',
      env: { ...value.env, CAUCE_ENV_FILE: envFile },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(reference);
    expect(`${result.stdout}${result.stderr}`).not.toContain('must-not-be-printed');
    expect(await mutations(value.mutationLog)).toBe('');
  });

  test('read-only verification rejects mutable, duplicate and symlinked selectors', async () => {
    const value = await fixture();
    const mutable = spawnSync(releaseConsole, ['verificar', 'registry.example:5000/cauce/console:latest'], {
      encoding: 'utf8',
      env: value.env,
    });
    expect(mutable.status).toBe(2);

    const reference = `registry.example:5000/cauce/console@sha256:${'c'.repeat(64)}`;
    const duplicate = join(value.root, 'duplicate.env');
    await writeFile(duplicate, `CAUCE_CONSOLE_IMAGE=${reference}\nCAUCE_CONSOLE_IMAGE=${reference}\n`, { mode: 0o600 });
    const duplicateResult = spawnSync(releaseConsole, ['verificar'], {
      encoding: 'utf8',
      env: { ...value.env, CAUCE_ENV_FILE: duplicate },
    });
    expect(duplicateResult.status).toBe(2);

    const link = join(value.root, 'prod-link.env');
    await symlink(duplicate, link);
    const symlinkResult = spawnSync(releaseConsole, ['verificar'], {
      encoding: 'utf8',
      env: { ...value.env, CAUCE_ENV_FILE: link },
    });
    expect(symlinkResult.status).toBe(2);
    expect(await mutations(value.mutationLog)).toBe('');
  });

  test('source, Make routing and runbook keep one canonical deployment architecture', async () => {
    const [source, make, documentation] = await Promise.all([
      readFile(releaseConsole, 'utf8'),
      readFile(makefile, 'utf8'),
      readFile(runbook, 'utf8'),
    ]);

    expect(source).not.toMatch(/^\s*(?:docker\s+(?:build|tag|save|load|push)|ssh|scp|rsync)\b/mu);
    expect(source).not.toContain('CAUCE_CONSOLE_TAG%%:');
    expect(make).not.toContain('CAUCE_PROD_HOST');
    expect(make).not.toContain('CAUCE_CONSOLE_TAG');
    for (const required of [
      'release-build.sh',
      'deploy-release.sh',
      'pin-production-release.py locked-exec',
      'CAUCE_RUNTIME_IMAGE',
      'CAUCE_CONSOLE_IMAGE',
      'CAUCE_COMPOSE_OVERRIDE_MANIFEST',
      'CAUCE_COMPOSE_OVERRIDE_MANIFEST_SHA256',
      'CAUCE_ROLLBACK_BASELINE_FILE',
      'CAUCE_ROLLBACK_BASELINE_SHA256',
      'rollback.sh console',
    ]) {
      expect(documentation).toContain(required);
    }
  });
});
