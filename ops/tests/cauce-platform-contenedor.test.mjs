#!/usr/bin/env node
// cauce:requiere docker-compose
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const wrapper = fileURLToPath(new URL('../cli/cauce-platform-contenedor', import.meta.url));
const cliDirectory = fileURLToPath(new URL('../cli/', import.meta.url)).replace(/\/$/u, '');
const cli = join(cliDirectory, 'platform_admin.mjs');
const seed = join(cliDirectory, 'context_seed.mjs');
const importer = join(cliDirectory, 'company_import.mjs');
const image = '127.0.0.1:5000/cauce-v3-runtime@sha256:' + 'a'.repeat(64);

// Las URLs de fixture se construyen en tiempo de ejecución: ningún literal user:password@host en el repositorio.
function fixtureDatabaseUrl({ user, password, host, port, database, query }) {
  return `postgresql://${user}:${password}@${host}:${port}/${database}${query ? `?${query}` : ''}`;
}

async function writeEnvironment(scratch) {
  const envFile = join(scratch, 'prod.env');
  await writeFile(join(scratch, 'database_url'), `${fixtureDatabaseUrl({ user: 'owner', password: 'fixture-never-printed', host: 'postgres', port: 5432, database: 'cauce' })}\n`);
  await writeFile(join(scratch, 'ca.crt'), 'ca\n');
  await writeFile(envFile, [
    'COMPOSE_PROJECT_NAME=cauce-v3-prod', 'COMPOSE_PROFILES=observability,telegram',
    `CAUCE_RUNTIME_IMAGE=${image}`, `CAUCE_DATABASE_URL_SECRET_PATH=${join(scratch, 'database_url')}`,
    `CAUCE_POSTGRES_CA_PATH=${join(scratch, 'ca.crt')}`, 'CAUCE_UNRELATED_SECRET=never-printed-either', '',
  ].join('\n'));
  return envFile;
}

test('renders the platform CLI as a hardened one-off service on the stack backend network', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'cauce-platform-container-'));
  try {
    const envFile = await writeEnvironment(scratch);
    const rendered = spawnSync(wrapper, ['--mostrar'], { encoding: 'utf8', env: {
      PATH: process.env.PATH, HOME: process.env.HOME, CAUCE_ENV_FILE: envFile,
      CAUCE_PLATFORM_ADMIN_ID: '00000000-0000-4000-8000-000000000001' } });
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
    assert.match(out, /- node\n\s+- ops\/cli\/platform_admin\.mjs\n/u);
    assert.ok(out.includes(`source: ${seed}`), 'mounts the seed, which imports platform_admin.mjs');
    assert.match(out, /target: \/app\/ops\/cli\/context_seed\.mjs\n\s+read_only: true/u);
    assert.ok(out.includes(`source: ${importer}`), 'mounts the company import that platform_admin.mjs loads');
    assert.match(out, /target: \/app\/ops\/cli\/company_import\.mjs\n\s+read_only: true/u);
    assert.doesNotMatch(out, /never-printed|ports:|profiles:|\/run\/cauce\/(nativos|inventario|perfiles|clave)/u);

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

test('renders contexto with the seed script and the natives directory bound read-only', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'cauce-platform-container-'));
  try {
    const envFile = await writeEnvironment(scratch);
    const natives = join(scratch, 'natives');
    await mkdir(natives);
    const rendered = spawnSync(wrapper, ['--mostrar', 'contexto', 'sembrar', '--nativos', natives, '--simular'],
      { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, CAUCE_ENV_FILE: envFile } });
    assert.equal(rendered.status, 0, rendered.stderr);
    const out = rendered.stdout;
    assert.match(out, /- node\n\s+- ops\/cli\/context_seed\.mjs\n/u);
    assert.ok(out.includes(`source: ${cli}`) && out.includes(`source: ${seed}`), 'mounts both scripts');
    assert.ok(out.includes(`source: ${await realpath(natives)}\n        target: /run/cauce/nativos\n        read_only: true\n`),
      'binds the natives directory read-only');
    assert.doesNotMatch(out, /never-printed|ports:|profiles:/u);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('runs contexto in the seed script and hands it the mount point instead of the host directory', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'cauce-platform-container-'));
  try {
    const envFile = await writeEnvironment(scratch);
    const natives = join(scratch, 'natives');
    await mkdir(natives);
    const bin = join(scratch, 'bin');
    const log = join(scratch, 'docker.log');
    await mkdir(bin);
    await writeFile(join(bin, 'docker'), [
      '#!/bin/sh',
      'printf \'entrada=%s nativos=%s\\n\' "$CAUCE_PLATAFORMA_ENTRADA" "${CAUCE_PLATAFORMA_NATIVOS:-}" >>"$CAUCE_FAKE_DOCKER_LOG"',
      'printf \'%s\\n\' "$*" >>"$CAUCE_FAKE_DOCKER_LOG"', '',
    ].join('\n'));
    await chmod(join(bin, 'docker'), 0o755);
    const run = async (args, extra = {}) => {
      await writeFile(log, '');
      const result = spawnSync(wrapper, args, { encoding: 'utf8', env: { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME,
        CAUCE_ENV_FILE: envFile, CAUCE_FAKE_DOCKER_LOG: log, ...extra } });
      return { ...result, calls: (await readFile(log, 'utf8')).trim().split('\n') };
    };
    const compose = `compose --env-file ${envFile} -p cauce-v3-prod-plataforma -f ${cliDirectory}/cauce-platform.compose.yaml`;

    const seeded = await run(['contexto', 'sembrar', '--nativos', natives, '--simular'], { CAUCE_PLATAFORMA_NATIVOS: '/inherited' });
    assert.equal(seeded.status, 0, seeded.stderr);
    assert.deepEqual(seeded.calls.slice(2), [
      `entrada=context_seed.mjs nativos=${await realpath(natives)}`,
      `${compose} -f ${cliDirectory}/cauce-platform.nativos.compose.yaml run --rm --no-deps cauce-platform `
        + 'contexto sembrar --nativos /run/cauce/nativos --simular',
    ]);
    assert.equal(seeded.calls[1], 'network inspect cauce-v3-prod_backend');

    const admin = await run(['admin', 'semilla', '--email', 'a@b.test']);
    assert.equal(admin.status, 0, admin.stderr);
    assert.deepEqual(admin.calls.slice(2), ['entrada=platform_admin.mjs nativos=',
      `${compose} run --rm --no-deps cauce-platform admin semilla --email a@b.test`]);

    const bare = await run(['contexto', 'sembrar', '--nativos']);
    assert.equal(bare.status, 0, bare.stderr);
    assert.match(bare.calls.at(-1), /cauce-platform contexto sembrar --nativos$/u, 'a missing value reaches the seed, which rejects it');

    for (const [args, message] of [
      [['contexto', 'sembrar', '--nativos', natives, '--nativos', natives], /--nativos no se puede repetir/u],
      [['contexto', 'sembrar', '--nativos', join(scratch, 'missing')], /--nativos no es un directorio legible/u],
      [['contexto', 'sembrar', '--nativos', envFile], /--nativos no es un directorio legible/u],
      [['contexto', 'sembrar', '--nativos', `${natives}\n`], /--nativos contiene caracteres inválidos/u],
    ]) {
      const refused = await run(args);
      assert.equal(refused.status, 2, args.join(' '));
      assert.match(refused.stderr, message);
      assert.deepEqual(refused.calls, [''], 'refused before docker runs');
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('empresa importar binds its inventory, profiles and password files read-only and passes the mount points', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'cauce-platform-container-'));
  try {
    const envFile = await writeEnvironment(scratch);
    const inputs = {};
    for (const name of ['inventario.json', 'perfiles.json', 'clave']) {
      inputs[name] = join(scratch, name);
      await writeFile(inputs[name], '{}\n', { mode: 0o600 });
    }
    const args = ['empresa', 'importar', '--inventario', inputs['inventario.json'], '--perfiles', inputs['perfiles.json'],
      '--clave-archivo', inputs.clave, '--email', 'a@b.test', '--nombre', 'Dueño', '--dry-run'];
    const rendered = spawnSync(wrapper, ['--mostrar', ...args],
      { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, CAUCE_ENV_FILE: envFile } });
    assert.equal(rendered.status, 0, rendered.stderr);
    for (const [name, target] of [['inventario.json', '/run/cauce/inventario.json'], ['perfiles.json', '/run/cauce/perfiles.json'],
      ['clave', '/run/cauce/clave']]) {
      assert.ok(rendered.stdout.includes(`source: ${await realpath(inputs[name])}\n        target: ${target}\n        read_only: true\n`),
        `binds ${name} read-only`);
    }
    assert.doesNotMatch(rendered.stdout, /never-printed|ports:/u);

    const bin = join(scratch, 'bin');
    const log = join(scratch, 'docker.log');
    await mkdir(bin);
    await writeFile(join(bin, 'docker'), '#!/bin/sh\nprintf \'%s\\n\' "$*" >>"$CAUCE_FAKE_DOCKER_LOG"\n');
    await chmod(join(bin, 'docker'), 0o755);
    const run = async extra => {
      await writeFile(log, '');
      const result = spawnSync(wrapper, extra, { encoding: 'utf8', env: { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME,
        CAUCE_ENV_FILE: envFile, CAUCE_FAKE_DOCKER_LOG: log, CAUCE_PLATAFORMA_INVENTARIO: '/inherited' } });
      return { ...result, calls: (await readFile(log, 'utf8')).trim().split('\n') };
    };
    const imported = await run(args);
    assert.equal(imported.status, 0, imported.stderr);
    const compose = `compose --env-file ${envFile} -p cauce-v3-prod-plataforma -f ${cliDirectory}/cauce-platform.compose.yaml`;
    assert.deepEqual(imported.calls, ['network inspect cauce-v3-prod_backend',
      `${compose} -f ${cliDirectory}/cauce-platform.inventario.compose.yaml -f ${cliDirectory}/cauce-platform.perfiles.compose.yaml `
        + `-f ${cliDirectory}/cauce-platform.clave.compose.yaml run --rm --no-deps cauce-platform empresa importar `
        + '--inventario /run/cauce/inventario.json --perfiles /run/cauce/perfiles.json --clave-archivo /run/cauce/clave '
        + '--email a@b.test --nombre Dueño --dry-run']);
    const elsewhere = await run(['admin', 'semilla', '--email', 'a@b.test', '--inventario', inputs['inventario.json']]);
    assert.match(elsewhere.calls.at(-1), new RegExp(`--inventario ${inputs['inventario.json']}$`, 'u'), 'only empresa importar binds files');

    for (const [extra, message] of [
      [['--inventario', inputs['inventario.json'], '--inventario', inputs['inventario.json']], /--inventario no se puede repetir/u],
      [['--perfiles', join(scratch, 'missing.json')], /--perfiles no es un archivo legible/u],
      [['--clave-archivo', bin], /--clave-archivo no es un archivo legible/u],
      [['--inventario', `${inputs['inventario.json']}\n`], /--inventario contiene caracteres inválidos/u],
    ]) {
      const refused = await run(['empresa', 'importar', ...extra, '--dry-run']);
      assert.equal(refused.status, 2, extra.join(' '));
      assert.match(refused.stderr, message);
      assert.deepEqual(refused.calls, [''], 'refused before docker runs');
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
