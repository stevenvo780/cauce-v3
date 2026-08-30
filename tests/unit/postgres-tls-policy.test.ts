import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const postgresTls = join(repository, 'ops/scripts/check-postgres-tls.mjs');
const scratch: string[] = [];

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('PostgreSQL TLS policy used by backup and restore', () => {
  test('requires verify-full and a readable absolute non-symlink root CA', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cauce-postgres-tls-'));
    scratch.push(directory);
    const ca = join(directory, 'postgres-ca.crt');
    const caLink = join(directory, 'postgres-ca-link.crt');
    await writeFile(ca, 'root CA fixture\n', { mode: 0o600 });
    await symlink(ca, caLink);
    const baseEnvironment = {
      ...process.env,
      NODE_ENV: 'test',
      CAUCE_POSTGRES_TLS_POLICY: 'verify-full',
      PGSSLMODE: '',
      PGSSLROOTCERT: '',
    };
    const validQuery = new URLSearchParams({ sslmode: 'verify-full', sslrootcert: ca });
    const valid = spawnSync('node', [postgresTls], {
      encoding: 'utf8',
      env: { ...baseEnvironment, DATABASE_URL: `postgresql://user:hidden@localhost/db?${validQuery}` },
    });
    expect(valid.status, valid.stderr).toBe(0);

    const weakQuery = new URLSearchParams({ sslmode: 'require', sslrootcert: ca });
    const weak = spawnSync('node', [postgresTls], {
      encoding: 'utf8',
      env: { ...baseEnvironment, DATABASE_URL: `postgresql://user:hidden@localhost/db?${weakQuery}` },
    });
    expect(weak.status).toBe(2);
    expect(weak.stderr).toBe('PostgreSQL requires sslmode=verify-full\n');
    expect(weak.stderr).not.toContain('hidden');

    const linkedQuery = new URLSearchParams({ sslmode: 'verify-full', sslrootcert: caLink });
    const linked = spawnSync('node', [postgresTls], {
      encoding: 'utf8',
      env: { ...baseEnvironment, DATABASE_URL: `postgresql://user:hidden@localhost/db?${linkedQuery}` },
    });
    expect(linked.status).toBe(2);
    expect(linked.stderr).toBe('PostgreSQL root CA must be a regular non-symlink file\n');
    expect(linked.stderr).not.toContain(caLink);

    const duplicated = spawnSync('node', [postgresTls], {
      encoding: 'utf8',
      env: {
        ...baseEnvironment,
        DATABASE_URL: `postgresql://user:hidden@localhost/db?sslmode=verify-full&sslmode=require&sslrootcert=${encodeURIComponent(ca)}`,
      },
    });
    expect(duplicated.status).toBe(2);
    expect(duplicated.stderr).toBe('PostgreSQL TLS parameters must not be repeated\n');
    expect(duplicated.stderr).not.toContain('hidden');
  });

  // ── NEGATIVE CONTROL: el test de arriba demuestra que `sslmode=require` se rechaza en
  //    RUNTIME, pero ¿qué pasa si alguien borra la rama `if (mode !== 'verify-full')` del
  //    script y mantiene el `verify-full` en la URL del test? La invocación con `require`
  //    pasaría a exit 0 sin avisar. Aquí anclamos el control al CÓDIGO del script: la
  //    comparación debe seguir ahí y el mensaje exacto debe seguir siendo el que el assert
  //    original espera en `weak.stderr`.
  test('CONTROL NEGATIVO — el script ancla el rechazo de sslmode al literal «verify-full»', async () => {
    const codigo = await readFile(postgresTls, 'utf8');
    expect(codigo).toMatch(/['"]verify-full['"]/u);
    expect(codigo).toContain('PostgreSQL requires sslmode=verify-full');
  });
});
