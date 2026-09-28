#!/usr/bin/env node
// Driver de rescate de la pila de pruebas (T040, US4/FR-006).
// Lo invoca `ops/cli/cauce pila-test`; no se usa directo salvo depuracion.
// Todo pasa por `ops/scripts/compose.sh test`, que solo resuelve
// `ops/compose.test.yaml` (ver `ops/scripts/compose-files.sh`). La red
// testnet es interna y el puerto publicado no llega al host, asi que el HTTP
// se ejecuta DENTRO del contenedor gateway (node con fetch global) y la BD
// se lee con psql DENTRO del contenedor postgres. Jamas produccion: el
// objetivo `test` va fijo y ningun argumento del operador lo puede cambiar.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const compose = path.resolve(here, '..', 'scripts', 'compose.sh');
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const GATEWAY_ORIGIN = 'http://127.0.0.1:8080';

function usage() {
  process.stdout.write(
    'uso: cauce pila-test <colas|rescatar|estado> [delivery-id]\n'
    + '  colas               entregas visibles del operador en la pila de pruebas\n'
    + '  rescatar <id>       replay de una entrega terminal (dead|failed) -> clon pending\n'
    + '  estado <id>         estado en BD: delivery, dead letter y auditoria del replay\n'
    + 'Solo ops/compose.test.yaml, via compose.sh test. Jamas produccion.\n',
  );
}

function runCompose(args, input) {
  const result = spawnSync(compose, ['test', ...args], {
    encoding: 'utf8',
    input,
    timeout: 60_000,
  });
  if (result.error) throw new Error(`compose.sh test ${args[0]}: ${result.error.message}`);
  return result;
}

function execGateway(script, extraEnv = {}) {
  const envArgs = Object.entries(extraEnv).flatMap(([name, value]) => ['-e', `${name}=${value}`]);
  return runCompose(['exec', '-T', ...envArgs, 'gateway', 'node', '--input-type=module'], script);
}

function requireDeliveryId(value) {
  if (typeof value !== 'string' || !UUID.test(value)) {
    process.stderr.write(`delivery-id invalido (se esperaba UUID): ${value ?? '(ausente)'}\n`);
    process.exit(2);
  }
  return value;
}

function cmdColas() {
  const script = [
    `const res = await fetch('${GATEWAY_ORIGIN}/v3/console/queues', {`,
    '  headers: { accept: \'application/json\', \'x-cauce-tenant\': \'Steven\', \'x-cauce-alias\': \'kant\' },',
    '});',
    'const body = await res.text();',
    'if (!res.ok) { console.error(`queues ${res.status}: ${body.slice(0, 300)}`); process.exit(1); }',
    'console.log(body);',
    '',
  ].join('\n');
  const result = execGateway(script);
  if (result.status !== 0) {
    process.stderr.write(`colas: la pila de pruebas no responde (${(result.stderr || '').trim().split('\n').pop() || `exit ${result.status}`})\n`);
    process.exit(1);
  }
  let page;
  try {
    page = JSON.parse(result.stdout);
  } catch {
    process.stderr.write(`colas: respuesta no JSON: ${result.stdout.slice(0, 200)}\n`);
    process.exit(1);
  }
  const items = Array.isArray(page.items) ? page.items : [];
  process.stdout.write(
    `colas observed_at=${page.observed_at ?? '?'} pending=${page.pending ?? '?'} retrying=${page.retrying ?? '?'} dead=${page.dead ?? '?'}\n`,
  );
  for (const item of items) {
    process.stdout.write(
      `${item.delivery_id} ${item.state} attempts=${item.attempts}/${item.max_attempts} `
      + `${item.tenant_id}/${item.recipient_alias} lane=${item.lane} msg=${item.message_id}\n`,
    );
  }
}

function cmdRescatar(rawId) {
  const deliveryId = requireDeliveryId(rawId);
  const script = [
    'const id = process.env.CAUCE_RESCATE_DELIVERY_ID;',
    `const res = await fetch('${GATEWAY_ORIGIN}/v3/console/deliveries/' + id + '/replay', {`,
    '  method: \'POST\',',
    '  headers: {',
    '    accept: \'application/json\',',
    '    \'x-cauce-tenant\': \'Steven\',',
    '    \'x-cauce-alias\': \'kant\',',
    `    origin: '${GATEWAY_ORIGIN}',`,
    '  },',
    '});',
    'const body = await res.text();',
    'if (!res.ok) { console.error(`replay ${res.status}: ${body.slice(0, 300)}`); process.exit(1); }',
    'console.log(body);',
    '',
  ].join('\n');
  const result = execGateway(script, { CAUCE_RESCATE_DELIVERY_ID: deliveryId });
  if (result.status !== 0) {
    process.stderr.write(`rescatar: ${((result.stderr || '').trim().split('\n').pop()) || `exit ${result.status}`}\n`);
    process.exit(1);
  }
  let receipt;
  try {
    receipt = JSON.parse(result.stdout);
  } catch {
    process.stderr.write(`rescatar: recibo no JSON: ${result.stdout.slice(0, 200)}\n`);
    process.exit(1);
  }
  if (receipt.replayed !== true || receipt.state !== 'pending'
    || typeof receipt.delivery_id !== 'string' || receipt.delivery_id === deliveryId
    || receipt.replayed_from_delivery_id !== deliveryId) {
    process.stderr.write(`rescatar: recibo inexacto: ${result.stdout.slice(0, 300)}\n`);
    process.exit(1);
  }
  process.stdout.write(
    `replayed=true delivery_id=${receipt.delivery_id} state=pending replayed_from_delivery_id=${deliveryId}\n`,
  );
}

function cmdEstado(rawId) {
  const deliveryId = requireDeliveryId(rawId);
  const sql = [
    `SELECT 'status='||d.status||' attempt='||d.attempt||'/'||d.max_attempts`
    + `||' recipient='||d.recipient_tenant||'/'||d.recipient_alias||' message_id='||d.message_id::text`
    + ` FROM deliveries d WHERE d.id='${deliveryId}'::uuid`,
    `SELECT 'dead_letter_resolved_at='||coalesce(dl.resolved_at::text,'NULL')`
    + `||' dead_letter_reason='||coalesce(dl.reason,'NULL')`
    + ` FROM dead_letters dl WHERE dl.delivery_id='${deliveryId}'::uuid`
    + ` ORDER BY dl.created_at DESC LIMIT 1`,
    `SELECT 'replay_clone='||a.delivery_id::text||' clone_status='||d.status`
    + ` FROM audit_events a JOIN deliveries d ON d.id=a.delivery_id`
    + ` WHERE a.action='delivery.replay' AND a.decision='allow'`
    + ` AND a.metadata->>'replayed_from_delivery_id'='${deliveryId}'`
    + ` ORDER BY a.created_at DESC LIMIT 1`,
  ].join('; ');
  const result = runCompose(
    ['exec', '-T', 'postgres', 'psql', '-U', 'cauce_test', '-d', 'cauce_test', '-At', '-c', sql],
  );
  if (result.status !== 0) {
    process.stderr.write(`estado: psql en la pila de pruebas fallo: ${(result.stderr || '').trim().split('\n').pop() || `exit ${result.status}`}\n`);
    process.exit(1);
  }
  const lines = result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0 || !lines[0].startsWith('status=')) {
    process.stderr.write(`estado: entrega inexistente en la pila de pruebas: ${deliveryId}\n`);
    process.exit(1);
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

const [subcommand, argument] = process.argv.slice(2);
if (subcommand === 'colas' && argument === undefined) cmdColas();
else if (subcommand === 'rescatar') cmdRescatar(argument);
else if (subcommand === 'estado') cmdEstado(argument);
else {
  if (subcommand !== undefined && subcommand !== '--help' && subcommand !== '-h') {
    process.stderr.write(`pila-test: no entiendo '${subcommand}'\n`);
  }
  usage();
  process.exit(subcommand === undefined || subcommand === '--help' || subcommand === '-h' ? 0 : 2);
}
