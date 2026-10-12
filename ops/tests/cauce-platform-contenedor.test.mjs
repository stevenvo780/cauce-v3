#!/usr/bin/env node
// cauce:requiere docker-compose
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const wrapper = fileURLToPath(new URL('../cli/cauce-platform-contenedor', import.meta.url));
const cli = fileURLToPath(new URL('../cli/platform_admin.mjs', import.meta.url));
const image = '127.0.0.1:5000/cauce-v3-runtime@sha256:' + 'a'.repeat(64);

// Las URLs de fixture se construyen en tiempo de ejecución: ningún literal user:password@host en el repositorio.
function fixtureDatabaseUrl({ user, password, host, port, database, query }) {
  return `postgresql://${user}:${password}@${host}:${port}/${database}${query ? `?${query}` : ''}`;
}

test('renders the platform CLI as a hardened one-off service on the stack backend network', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'cauce-platform-container-'));
  try {
    const envFile = join(scratch, 'prod.env');
    await writeFile(join(scratch, 'database_url'), `${fixtureDatabaseUrl({ user: 'owner', password: 'fixture-never-printed', host: 'postgres', port: 5432, database: 'cauce' })}\n`);
    await writeFile(join(scratch, 'ca.crt'), 'ca\n');
    await writeFile(envFile, [
      'COMPOSE_PROJECT_NAME=cauce-v3-prod', 'COMPOSE_PROFILES=observability,telegram',
      `CAUCE_RUNTIME_IMAGE=${image}`, `CAUCE_DATABASE_URL_SECRET_PATH=${join(scratch, 'database_url')}`,
      `CAUCE_POSTGRES_CA_PATH=${join(scratch, 'ca.crt')}`, 'CAUCE_UNRELATED_SECRET=never-printed-either', '',
    ].join('\n'));
    const rendered = spawnSync(wrapper, ['--mostrar'], { encoding: 'utf8', env: {
      PATH: process.env.PATH, HOME: process.env.HOME, CAUCE_ENV_FILE: envFile,
      CAUCE_PLATFORM_ADMIN_ID: '78c81e05-0c18-427b-b02b-346d7e8c8508' } });
    assert.equal(rendered.status, 0, rendered.stderr);
    const out = rendered.stdout;
    assert.match(out, /^name: cauce-v3-prod-plataforma$/mu);
    assert.ok(out.includes(`image: ${image}\n`), 'uses the immutable runtime image of the env file');
    assert.match(out, /name: cauce-v3-prod_backend\n\s+external: true/u);
    assert.match(out, /read_only: true/u);
    assert.match(out, /user: 1000:1000/u);
    assert.match(out, /- ALL/u);
    assert.match(out, /PGSSLMODE: verify-full/u);
    assert.match(out, /DATABASE_URL_FILE: \/run\/secrets\/database_url/u);
    assert.match(out, /target: \/run\/secrets\/postgres_ca/u);
    assert.ok(out.includes(`source: ${cli}`), 'mounts the CLI next to the wrapper');
    assert.match(out, /target: \/app\/ops\/cli\/platform_admin\.mjs\n\s+read_only: true/u);
    assert.doesNotMatch(out, /never-printed|ports:|profiles:/u);

    const missing = spawnSync(wrapper, ['--mostrar'], { encoding: 'utf8',
      env: { PATH: process.env.PATH, CAUCE_ENV_FILE: join(scratch, 'missing.env') } });
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /no puedo leer/u);
    await writeFile(envFile, 'COMPOSE_PROJECT_NAME=Bad Name\n');
    const invalid = spawnSync(wrapper, ['--mostrar'], { encoding: 'utf8', env: { PATH: process.env.PATH, CAUCE_ENV_FILE: envFile } });
    assert.equal(invalid.status, 2);
    assert.match(invalid.stderr, /COMPOSE_PROJECT_NAME/u);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
