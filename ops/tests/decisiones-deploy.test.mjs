#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../deploy/decisiones/desplegar.sh', import.meta.url));
const revision = 'a'.repeat(40);
const mocks = {
  id: 'if [[ $# == 1 ]]; then printf "0\\n"; else printf "1000\\n"; fi',
  chown: 'printf "chown\\n" >> "$FAKE_LOG"',
  ss: 'exit 0',
  tar: 'cat >/dev/null',
  git: `case "$3" in
    rev-parse) printf '%s\\n' "$FAKE_REVISION" ;;
    cat-file|archive) exit 0 ;;
    show) printf 'services: {}\\n' ;;
    *) exit 97 ;;
  esac`,
  docker: `printf '%s\\n' "$*" >> "$FAKE_LOG"
  if [[ "$1" == compose && "$*" == *"exec -T decisiones node -e"* ]]; then
    printf '{"credencial_jev":true}\\n'
  fi`,
  openssl: 'if [[ "$1" == s_client ]]; then printf "fixture-certificate\\n"; else cat >/dev/null; printf "subject=CN=fixture\\n"; fi',
};

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'cauce-decisions-deploy-'));
  const bin = path.join(root, 'bin');
  const identities = path.join(root, 'identities');
  const decisionsSecret = path.join(root, 'database_url_decisiones');
  const gatewaySecret = path.join(root, 'database_url_gateway');
  const prod = path.join(root, 'production.conf');
  const environment = path.join(root, 'decisions.conf');
  const log = path.join(root, 'commands.log');
  const key = path.join(root, 'jev.key');
  await Promise.all([mkdir(bin), mkdir(identities)]);
  await Promise.all(Object.entries(mocks).map(([name, body]) =>
    writeFile(path.join(bin, name), `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`, { mode: 0o755 })));
  await Promise.all([decisionsSecret, gatewaySecret, key].map(file => writeFile(file, '')));
  await writeFile(path.join(identities, 'mtls_identities.json'), '{}');
  const production = [
    'CAUCE_PRIVATE_BIND_IP=127.0.0.1',
    `CAUCE_GATEWAY_TLS_CERT_PATH=${root}/gateway.crt`,
    `CAUCE_GATEWAY_TLS_KEY_PATH=${root}/gateway.key`,
    `CAUCE_GATEWAY_CLIENT_CA_PATH=${root}/gateway-ca.crt`,
    `CAUCE_GATEWAY_IDENTITY_DIR=${identities}`,
    `CAUCE_DECISIONES_DATABASE_URL_SECRET_PATH=${decisionsSecret}`,
    `CAUCE_DATABASE_URL_GATEWAY_SECRET_PATH=${gatewaySecret}`,
    `CAUCE_POSTGRES_CA_PATH=${root}/postgres-ca.crt`,
    'COMPOSE_PROJECT_NAME=cauce-fixture',
    '',
  ].join('\n');
  const original = [
    'CAUCE_DECISIONES_IMAGE=cauce-decisiones:previous',
    `CAUCE_DECISIONES_DATABASE_URL_SECRET_PATH=${gatewaySecret}`,
    'CAUCE_PRIVATE_BIND_IP=127.0.0.1',
    'CAUCE_DECISIONES_ALIASES=fixture',
    '',
  ].join('\n');
  await Promise.all([writeFile(prod, production), writeFile(environment, original, { mode: 0o600 })]);
  return { root, bin, decisionsSecret, gatewaySecret, prod, environment, log, key, production, original };
}

function apply(context, variables = {}) {
  return spawnSync('bash', [script, 'aplicar', revision], {
    encoding: 'utf8', timeout: 10_000,
    env: {
      ...process.env,
      PATH: `${context.bin}:${process.env.PATH}`,
      CAUCE_ENV_FILE: context.prod,
      CAUCE_DECISIONES_ENV_FILE: context.environment,
      CAUCE_DECISIONES_REVERT_FILE: path.join(context.root, 'decisions.revert'),
      CAUCE_DECISIONES_DEPLOY_DIR: path.join(context.root, 'deployments'),
      CAUCE_TYPESAFE_JEV_KEY_PATH: context.key,
      CAUCE_DECISIONES_SMOKE_PKI: path.join(context.root, 'missing-smoke-pki'),
      CAUCE_DECISIONES_GIT: context.root,
      CAUCE_DECISIONES_DATABASE_URL_SECRET_PATH: '',
      FAKE_REVISION: revision,
      FAKE_LOG: context.log,
      ...variables,
    },
  });
}

test('apply replaces the inherited gateway secret and keeps a private backup', async () => {
  const context = await fixture();
  try {
    const result = apply(context);
    assert.equal(result.status, 0, result.stderr);
    const environment = await readFile(context.environment, 'utf8');
    assert.ok(environment.includes(`CAUCE_DECISIONES_DATABASE_URL_SECRET_PATH=${context.decisionsSecret}\n`));
    assert.ok(environment.includes(`CAUCE_DECISIONES_IMAGE=cauce-decisiones:${revision.slice(0, 12)}\n`));
    assert.ok(environment.includes('CAUCE_DECISIONES_ALIASES=fixture\n'));
    assert.ok(environment.includes('CAUCE_DECISIONES_BACKEND_NETWORK=cauce-fixture_backend\n'));
    const backups = (await readdir(context.root)).filter(name => name.startsWith('decisions.conf.pre-v4-'));
    assert.equal(backups.length, 1);
    assert.equal(await readFile(path.join(context.root, backups[0]), 'utf8'), context.original);
    assert.match(await readFile(context.log, 'utf8'), / up -d --wait --wait-timeout 120/u);
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test('apply recognizes the configured gateway secret even with a custom filename', async () => {
  const context = await fixture();
  try {
    const gatewaySecret = path.join(context.root, 'gateway-login');
    await writeFile(context.prod, context.production.replaceAll(context.gatewaySecret, gatewaySecret));
    await writeFile(context.environment, context.original.replace(context.gatewaySecret, gatewaySecret));
    const result = apply(context);
    assert.equal(result.status, 0, result.stderr);
    assert.ok((await readFile(context.environment, 'utf8'))
      .includes(`CAUCE_DECISIONES_DATABASE_URL_SECRET_PATH=${context.decisionsSecret}\n`));
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test('apply keeps a dedicated configured secret and fills an absent variable', async () => {
  const context = await fixture();
  try {
    const dedicated = path.join(context.root, 'dedicated-decisions-login');
    await writeFile(dedicated, '');
    await writeFile(context.environment, context.original.replace(context.gatewaySecret, dedicated));
    const result = apply(context);
    assert.equal(result.status, 0, result.stderr);
    assert.ok((await readFile(context.environment, 'utf8'))
      .includes(`CAUCE_DECISIONES_DATABASE_URL_SECRET_PATH=${dedicated}\n`));
    await writeFile(context.environment, 'CAUCE_DECISIONES_IMAGE=cauce-decisiones:previous\n');
    const completed = apply(context);
    assert.equal(completed.status, 0, completed.stderr);
    assert.ok((await readFile(context.environment, 'utf8'))
      .includes(`CAUCE_DECISIONES_DATABASE_URL_SECRET_PATH=${context.decisionsSecret}\n`));
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test('a missing dedicated secret stops before changing the image, key or environment', async () => {
  const context = await fixture();
  try {
    await rm(context.decisionsSecret);
    const result = apply(context);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /no existe el secreto de cauce_decisiones/u);
    assert.equal(await readFile(context.environment, 'utf8'), context.original);
    assert.ok(!(await readdir(context.root)).includes('commands.log'));
    assert.ok(!(await readdir(context.root)).some(name => name.startsWith('decisions.conf.pre-v4-')));
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test('a generated gateway secret is rejected before any deployment mutation', async () => {
  const context = await fixture();
  try {
    const result = apply(context, { CAUCE_DECISIONES_DATABASE_URL_SECRET_PATH: context.gatewaySecret });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /el secreto de decisiones no puede ser el del gateway/u);
    assert.equal(await readFile(context.environment, 'utf8'), context.original);
    assert.ok(!(await readdir(context.root)).includes('commands.log'));
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});
