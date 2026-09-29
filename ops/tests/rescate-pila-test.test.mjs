#!/usr/bin/env node
// T040 (US4/FR-006): rescate por CLI en la pila de pruebas.
// Ciclo: atascar a proposito -> ver atascada -> destrabar con ops/cli/cauce
// `pila-test` -> verificar el cambio de estado en BD -> cerrar el clon.
// Solo ops/compose.test.yaml, via ops/scripts/compose.sh test. Jamas
// produccion: la red testnet es interna, asi que el HTTP/WS se ejecuta
// DENTRO del contenedor gateway y la BD se lee DENTRO de postgres.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ops = path.resolve(here, '..');
const compose = path.join(ops, 'scripts', 'compose.sh');
const cli = path.join(ops, 'cli', 'cauce');
const SENDER = { tenant: 'Steven', alias: 'kant', room: 'grp.steven' };
const RECIPIENT = { tenant: 'Steven', alias: 'argos' };
const ATTEMPT_TIMEOUT_MS = 45_000;

function runCompose(args, { input = undefined, timeout = 60_000 } = {}) {
  const result = spawnSync(compose, ['test', ...args], { encoding: 'utf8', input, timeout });
  if (result.error) throw new Error(`compose.sh test ${args.join(' ')}: ${result.error.message}`);
  return result;
}

function runCli(args) {
  const result = spawnSync(cli, ['pila-test', ...args], { encoding: 'utf8', timeout: 60_000 });
  if (result.error) throw new Error(`cauce pila-test ${args.join(' ')}: ${result.error.message}`);
  return result;
}

function queryTestDb(sql) {
  const result = runCompose(
    ['exec', '-T', 'postgres', 'psql', '-U', 'cauce_test', '-d', 'cauce_test', '-At', '-c', sql],
  );
  assert.equal(result.status, 0, `psql en la pila de pruebas: ${result.stderr.trim().slice(0, 300)}`);
  return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
}

// Corre DENTRO del gateway (node --input-type=module por stdin). Sin
// dependencias salvo el `ws` de la propia imagen: el WebSocket global de
// undici no manda las cabeceras x-cauce-* y el handshake sale 4401.
function innerScript() {
  return [
    'import WebSocket from \'/app/services/gateway/node_modules/ws/wrapper.mjs\';',
    `const SENDER = ${JSON.stringify(SENDER)};`,
    `const RECIPIENT = ${JSON.stringify(RECIPIENT)};`,
    `const ATTEMPT_TIMEOUT_MS = ${ATTEMPT_TIMEOUT_MS};`,
    'const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));',
    'async function api(method, pathname, actor, body) {',
    '  const res = await fetch(`http://127.0.0.1:8080${pathname}`, {',
    '    method,',
    '    headers: {',
    '      accept: \'application/json\',',
    '      \'x-cauce-tenant\': actor.tenant,',
    '      \'x-cauce-alias\': actor.alias,',
    '      ...(body === undefined ? {} : { \'content-type\': \'application/json\' }),',
    '    },',
    '    body: body === undefined ? undefined : JSON.stringify(body),',
    '  });',
    '  const data = await res.json().catch(() => ({}));',
    '  return { status: res.status, data };',
    '}',
    'function connect(identity) {',
    '  return new Promise((resolve, reject) => {',
    '    const ws = new WebSocket(\'ws://127.0.0.1:8080/v3/ws\', {',
    '      headers: { \'x-cauce-tenant\': identity.tenant, \'x-cauce-alias\': identity.alias },',
    '    });',
    '    const frames = [];',
    '    let settled = false;',
    '    const fail = (error) => {',
    '      if (settled) return;',
    '      settled = true;',
    '      try { ws.terminate(); } catch { /* ya cerrado */ }',
    '      reject(error);',
    '    };',
    '    ws.on(\'message\', (data) => {',
    '      try { frames.push(JSON.parse(String(data))); } catch { fail(new Error(\'trama no JSON\')); }',
    '    });',
    '    ws.on(\'error\', fail);',
    '    const instanceId = `rescate-${crypto.randomUUID()}`;',
    '    ws.on(\'open\', () => {',
    '      ws.send(JSON.stringify({ type: \'hello\', version: \'3.0\', tenant_id: identity.tenant,',
    '        alias: identity.alias, instance_id: instanceId,',
    '        capabilities: [\'harness.codex\', \'qa-double\', \'acks.v3\'] }));',
    '    });',
    '    (async () => {',
    '      const ack = await nextFrame({ frames }, (f) => f.type === \'hello_ack\', 8000);',
    '      settled = true;',
    '      ws.off(\'error\', fail);',
    '      resolve({ ws, epoch: ack.epoch, frames, instanceId });',
    '    })().catch(fail);',
    '  });',
    '}',
    'async function nextFrame(client, predicate, timeoutMs = 8000) {',
    '  const deadline = Date.now() + timeoutMs;',
    '  while (Date.now() < deadline) {',
    '    const index = client.frames.findIndex(predicate);',
    '    if (index >= 0) return client.frames.splice(index, 1)[0];',
    '    await sleep(10);',
    '  }',
    '  throw new Error(\'timeout esperando trama WS\');',
    '}',
    'async function ack(client, identity, delivery, status, detail = {}) {',
    '  client.ws.send(JSON.stringify({ type: \'ack\', version: \'3.0\', event_id: crypto.randomUUID(),',
    '    delivery_id: delivery.delivery_id, attempt: delivery.attempt, claim_token: delivery.claim_token,',
    '    status, instance_id: client.instanceId, epoch: client.epoch, retryable: detail.retryable ?? false,',
    '    ...(detail.error ? { error: detail.error } : {}),',
    '    ...(detail.result ? { result: detail.result } : {}) }));',
    '  return nextFrame(client, (f) => f.type === \'ack_result\' && f.delivery_id === delivery.delivery_id);',
    '}',
    'const mode = process.env.CAUCE_RESCATE_MODE;',
    'if (mode === \'atascar\') {',
    '  const sent = await api(\'POST\', \'/v3/messages\', SENDER, { room_id: SENDER.room,',
    '    recipients: [{ tenant_id: RECIPIENT.tenant, alias: RECIPIENT.alias }],',
    '    body: { text: `rescate-${crypto.randomUUID()}` },',
    '    idempotency_key: `rescate-${crypto.randomUUID()}`, lane: \'interactive\', priority: 10 });',
    '  if (sent.status !== 202) { console.error(`publish ${sent.status}: ${JSON.stringify(sent.data).slice(0, 200)}`); process.exit(1); }',
    '  const client = await connect(RECIPIENT);',
    '  const statuses = [];',
    '  let deliveryId = null;',
    '  for (let attempt = 1; attempt <= 3; attempt += 1) {',
    '    const delivery = await nextFrame(client,',
    '      (f) => f.type === \'delivery\' && f.message_id === sent.data.message_id, ATTEMPT_TIMEOUT_MS);',
    '    deliveryId = delivery.delivery_id;',
    '    const result = await ack(client, RECIPIENT, delivery, \'failed\',',
    '      { retryable: true, error: `atasco-deliberado-${attempt}` });',
    '    statuses.push(result.status);',
    '  }',
    '  client.ws.terminate();',
    '  console.log(JSON.stringify({ message_id: sent.data.message_id, delivery_id: deliveryId, statuses }));',
    '} else if (mode === \'cerrar\') {',
    '  const messageId = process.env.CAUCE_RESCATE_MESSAGE_ID;',
    '  const client = await connect(RECIPIENT);',
    '  const delivery = await nextFrame(client,',
    '    (f) => f.type === \'delivery\' && f.message_id === messageId, ATTEMPT_TIMEOUT_MS);',
    '  const result = await ack(client, RECIPIENT, delivery, \'done\', { result: { answer: \'rescatada\' } });',
    '  client.ws.terminate();',
    '  console.log(JSON.stringify({ delivery_id: delivery.delivery_id, status: result.status }));',
    '} else { console.error(`modo desconocido: ${mode}`); process.exit(2); }',
    '',
  ].join('\n');
}

function runInner(mode, extraEnv = {}) {
  const envArgs = Object.entries({ CAUCE_RESCATE_MODE: mode, ...extraEnv })
    .flatMap(([name, value]) => ['-e', `${name}=${value}`]);
  const result = runCompose(
    ['exec', '-T', ...envArgs, 'gateway', 'node', '--input-type=module'],
    { input: innerScript(), timeout: 180_000 },
  );
  if (result.status !== 0) {
    throw new Error(`fase ${mode} en gateway: ${(result.stderr || result.stdout).trim().slice(0, 500)}`);
  }
  return JSON.parse(result.stdout.trim().split('\n').pop());
}

function waitReady(deadlineMs = 180_000) {
  const started = Date.now();
  const probe = 'const r = await fetch(\'http://127.0.0.1:8080/health/ready\');'
    + ' console.log(r.status === 200 ? await r.text() : `http_${r.status}`);';
  for (;;) {
    const result = runCompose(['exec', '-T', 'gateway', 'node', '--input-type=module'], { input: probe });
    if (result.status === 0 && result.stdout.includes('"status":"ready"')) return;
    if (Date.now() - started > deadlineMs) {
      throw new Error(`la pila de pruebas no llega a ready: ${(result.stderr || result.stdout).trim().slice(0, 300)}`);
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
  }
}

const up = runCompose(['up', '-d', 'gateway', 'dispatcher'], { timeout: 240_000 });
assert.equal(up.status, 0, `compose up de la pila de pruebas: ${up.stderr.trim().slice(0, 300)}`);
waitReady();

// 1) Atasco deliberado: 3 ACK failed/retryable -> dead (mismo camino que el
// arnes e2e `retry backoff exhausts into DLQ`, sin atajos en BD).
const atasco = runInner('atascar');
assert.deepEqual(atasco.statuses, ['retry', 'retry', 'dead']);
assert.match(atasco.delivery_id, /^[0-9a-f-]{36}$/);
process.stdout.write(`atascada: delivery=${atasco.delivery_id} estados=${atasco.statuses.join(',')}\n`);

// 2) Visible como atascada por el CLI antes del rescate.
const antes = runCli(['estado', atasco.delivery_id]);
assert.equal(antes.status, 0, antes.stderr.trim().slice(0, 300));
assert.match(antes.stdout, /status=dead/);
assert.match(antes.stdout, /dead_letter_resolved_at=NULL/);
const colas = runCli(['colas']);
assert.equal(colas.status, 0, colas.stderr.trim().slice(0, 300));
assert.ok(colas.stdout.includes(`${atasco.delivery_id} dead`), `colas no muestra la atascada:\n${colas.stdout}`);

// 3) Destrabe por CLI: replay -> clon pending + auditoria.
const rescate = runCli(['rescatar', atasco.delivery_id]);
assert.equal(rescate.status, 0, rescate.stderr.trim().slice(0, 300));
const clon = /delivery_id=([0-9a-f-]{36})/.exec(rescate.stdout)?.[1];
assert.ok(clon && clon !== atasco.delivery_id, `recibo sin clon: ${rescate.stdout}`);
assert.match(rescate.stdout, /state=pending/);
process.stdout.write(`rescatada: original=${atasco.delivery_id} clon=${clon}\n`);

// 4) Verificacion en BD: clon pending, dead letter resuelta, auditoria allow.
assert.deepEqual(queryTestDb(`SELECT status FROM deliveries WHERE id='${clon}'::uuid`), ['pending']);
assert.deepEqual(
  queryTestDb(`SELECT resolved_at IS NOT NULL FROM dead_letters WHERE delivery_id='${atasco.delivery_id}'::uuid`),
  ['t'],
);
assert.deepEqual(
  queryTestDb(`SELECT count(*) FROM audit_events WHERE action='delivery.replay' AND decision='allow'`
    + ` AND delivery_id='${clon}'::uuid AND metadata->>'replayed_from_delivery_id'='${atasco.delivery_id}'`),
  ['1'],
);
const clonMessage = queryTestDb(`SELECT message_id FROM deliveries WHERE id='${clon}'::uuid`);
assert.equal(clonMessage.length, 1);

// 5) La cola vuelve a fluir: el clon se reclama y se cierra done.
const cierre = runInner('cerrar', { CAUCE_RESCATE_MESSAGE_ID: clonMessage[0] });
assert.equal(cierre.delivery_id, clon);
assert.equal(cierre.status, 'done');
const despues = runCli(['estado', clon]);
assert.equal(despues.status, 0, despues.stderr.trim().slice(0, 300));
assert.match(despues.stdout, /status=done/);

process.stdout.write(`rescate por CLI ok: atascada=${atasco.delivery_id} clon=${clon} clon_final=done auditoria=delivery.replay/allow\n`);
