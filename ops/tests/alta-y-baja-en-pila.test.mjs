#!/usr/bin/env node
// cauce:requiere docker
// T030: ida-y-vuelta de alta/baja de agente contra la pila de pruebas.
// Solo usa ops/compose.test.yaml (red interna testnet, BD cauce_test efímera).
// Verifica el invariante del runbook ops/runbooks/alta-y-baja-de-agente.md:
// con fila en agents y enabled=true el alias reclama lease; con enabled=false
// el lease se rechaza dentro de la transacción (0 filas, sin efectos).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ops = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE = path.join(ops, 'compose.test.yaml');
const TENANT = 'Steven';
const ROOM = 'grp.steven';
const ALIAS = `t030-${process.pid}-${Date.now().toString(36)}`;
const INSTANCE = 't030-pila';
const READY_TIMEOUT_MS = 90_000;
const MIGRATOR_TIMEOUT_MS = 300_000;

assert.match(ALIAS, /^[a-z0-9-]{1,63}$/u, 'alias de prueba con charset seguro para SQL');

function quote(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function compose(args, { timeoutMs = 60_000 } = {}) {
  const result = spawnSync('docker', ['compose', '-f', COMPOSE, ...args], {
    encoding: 'utf8',
    timeout: timeoutMs,
  });
  if (result.error) throw new Error(`docker compose ${args.join(' ')}: ${result.error.message}`);
  return result;
}

function checked(result, label) {
  assert.equal(result.status, 0, `${label} falló (exit ${result.status}):\n${result.stderr}`);
  return result.stdout;
}

async function sleep(ms) {
  await new Promise(resolve => { setTimeout(resolve, ms); });
}

function psql(script, label) {
  const result = compose(['exec', '-T', 'postgres', 'psql',
    '-U', 'cauce_test', '-d', 'cauce_test',
    '-v', 'ON_ERROR_STOP=1', '-At', '-F|', '-c', script]);
  return checked(result, label).split('\n').filter(line => line !== '');
}

async function ensureStack() {
  checked(compose(['up', '-d', 'postgres'], { timeoutMs: 120_000 }), 'compose up postgres');
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    const probe = compose(['exec', '-T', 'postgres', 'pg_isready',
      '-U', 'cauce_test', '-d', 'cauce_test']);
    if (probe.status === 0) break;
    assert.ok(Date.now() < deadline, `postgres de pruebas no levantó:\n${probe.stderr}`);
    await sleep(1000);
  }
  const tables = psql("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'agents';", 'sondear tabla agents');
  if (tables.length === 0) {
    checked(compose(['up', 'migrator'], { timeoutMs: MIGRATOR_TIMEOUT_MS }), 'compose up migrator');
    const retry = psql("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'agents';", 're-sondear tabla agents');
    assert.deepEqual(retry, ['agents'], 'el migrator de la pila debe crear agents');
  }
}

function claimSql(epoch) {
  return `WITH ins AS (
  INSERT INTO connection_leases (tenant_id, alias, instance_id, epoch, lease_until)
  SELECT ${quote(TENANT)}, ${quote(ALIAS)}, ${quote(INSTANCE)}, ${epoch}, now() + interval '1 hour'
  WHERE EXISTS (
    SELECT 1 FROM agents
    WHERE tenant_id = ${quote(TENANT)} AND alias = ${quote(ALIAS)} AND enabled IS TRUE
  )
  RETURNING 1
) SELECT count(*) FROM ins;`;
}

let stackReady = false;
try {
  await ensureStack();
  stackReady = true;

  assert.deepEqual(
    psql(`SELECT count(*) FROM agents WHERE tenant_id = ${quote(TENANT)} AND alias = ${quote(ALIAS)};`, 'alias limpio'),
    ['0'],
  );

  // Alta (runbook §2 paso 1): agents + memberships en una transacción.
  const alta = psql(`BEGIN;
INSERT INTO agents (tenant_id, alias, harness_id, enabled, container_name, runtime_user, home_directory, state_directory)
VALUES (${quote(TENANT)}, ${quote(ALIAS)}, 'codex', true, 'ctrl-infra', 'dev', '/home/dev', ${quote(`/home/dev/.local/state/cauce-v3/${ALIAS}`)});
INSERT INTO memberships (tenant_id, alias, room_id, role, enabled)
VALUES (${quote(TENANT)}, ${quote(ALIAS)}, ${quote(ROOM)}, 'operator', true);
COMMIT;`, 'alta en transacción');
  assert.deepEqual(alta, ['BEGIN', 'INSERT 0 1', 'INSERT 0 1', 'COMMIT']);

  // Reclamo con habilitado: 1 fila y lease activo (runbook §2 paso 7.3).
  const reclamo = psql(`BEGIN;
${claimSql(1)}
SELECT alias, lease_until > now() AS lease_activo FROM connection_leases
WHERE tenant_id = ${quote(TENANT)} AND alias = ${quote(ALIAS)};
COMMIT;`, 'reclamo de lease habilitado');
  assert.equal(reclamo[0], 'BEGIN');
  assert.equal(reclamo[1], '1', 'el alias habilitado debe reclamar el lease');
  assert.equal(reclamo[2], `${ALIAS}|t`, 'el lease reclamado debe estar activo');
  assert.equal(reclamo[3], 'COMMIT');

  // Baja (runbook §3 paso 2): deshabilitar en BD.
  assert.deepEqual(
    psql(`UPDATE agents SET enabled = false WHERE tenant_id = ${quote(TENANT)} AND alias = ${quote(ALIAS)};`, 'baja en BD'),
    ['UPDATE 1'],
  );

  // Rechazo con enabled=false: 0 filas y ROLLBACK sin efectos.
  const rechazo = psql(`BEGIN;
${claimSql(2)}
SELECT count(*) FROM connection_leases WHERE tenant_id = ${quote(TENANT)} AND alias = ${quote(ALIAS)};
ROLLBACK;`, 'rechazo de lease deshabilitado');
  assert.equal(rechazo[1], '0', 'el alias deshabilitado no debe reclamar lease');
  assert.equal(rechazo[2], '1', 'el rechazo en transacción no debe crear filas');
  assert.equal(rechazo[3], 'ROLLBACK');

  // Sin renovación el lease expira: lease_activo = false (runbook §3 paso 6.2).
  const expira = psql(`UPDATE connection_leases SET lease_until = now() - interval '1 second'
WHERE tenant_id = ${quote(TENANT)} AND alias = ${quote(ALIAS)};
SELECT alias, lease_until > now() AS lease_activo FROM connection_leases WHERE alias = ${quote(ALIAS)};`, 'expiración sin renovación');
  assert.equal(expira[0], 'UPDATE 1');
  assert.equal(expira[1], `${ALIAS}|f`, 'tras la baja no debe quedar lease activo');

  process.stdout.write(`alta/baja en pila ok: alias ${ALIAS} reclamó habilitado y rechazó deshabilitado en transacción\n`);
} finally {
  if (stackReady) {
    const cleanup = compose(['exec', '-T', 'postgres', 'psql',
      '-U', 'cauce_test', '-d', 'cauce_test', '-At', '-c',
      `DELETE FROM connection_leases WHERE tenant_id = ${quote(TENANT)} AND alias = ${quote(ALIAS)};
DELETE FROM memberships WHERE tenant_id = ${quote(TENANT)} AND alias = ${quote(ALIAS)};
DELETE FROM agents WHERE tenant_id = ${quote(TENANT)} AND alias = ${quote(ALIAS)};`]);
    if (cleanup.status !== 0) process.stderr.write(`aviso: limpieza de ${ALIAS} falló:\n${cleanup.stderr}`);
  }
  // La pila queda levantada a propósito: es compartida con otras suites.
}
