#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const artifactFlag = args.indexOf('--artifact-dir');
const artifactDir = path.resolve(artifactFlag >= 0 ? args[artifactFlag + 1] : path.join(here, '..', 'artifacts', 'runtime-authentic'));
const mode = required('CAUCE_AUTHENTIC_MODE');
if (!['compose-authentic', 'runtime-authentic'].includes(mode)) throw new Error('CAUCE_AUTHENTIC_MODE is invalid');
const evidenceClass = mode;
const suiteMechanism = mode === 'compose-authentic' ? 'docker-compose-final-binaries' : 'docker-run-final-binaries';
const imageDigest = digest(required('CAUCE_IMAGE_DIGEST'));
// Two domains back this evidence. CAUCE_SOURCE_DIGEST is the `runtime` domain: the sources the five
// final services are built from. apps/console is deliberately NOT in it -- nothing under apps/console
// reaches the runtime image, so console edits used to invalidate this artifact for no causal reason
// and that pressure is what produced hand-edited evidence. CAUCE_HARNESS_DIGEST is the `harness`
// domain: this runner, the fake external world, the authentic Compose topology and the fault
// drivers, i.e. everything that decides what the run below reports. See ops/scripts/source-digest.py.
const sourceDigest = digest(required('CAUCE_SOURCE_DIGEST'));
const harnessDigest = digest(required('CAUCE_HARNESS_DIGEST'));
const gatewayHost = process.env.CAUCE_GATEWAY_HOST || '127.0.0.1';
const gatewayPort = positivePort(required('CAUCE_GATEWAY_PORT'));
const externalControlHost = process.env.CAUCE_EXTERNAL_CONTROL_HOST || '127.0.0.1';
const controlPort = positivePort(required('CAUCE_EXTERNAL_CONTROL_PORT'));
const unixControlHost = process.env.CAUCE_UNIX_CONTROL_HOST || '127.0.0.1';
const unixControlPort = positivePort(required('CAUCE_UNIX_CONTROL_PORT'));
const fixtureDir = required('CAUCE_FIXTURE_DIR_HOST');
const deployment = JSON.parse(await readFile(required('CAUCE_DEPLOYMENT_EVIDENCE_FILE'), 'utf8'));
const credentials = {
  ca: await readFile(path.join(fixtureDir, 'ca.crt')),
  cert: await readFile(path.join(fixtureDir, 'client.crt')),
  key: await readFile(path.join(fixtureDir, 'client.key')),
};
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function digest(value) {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) throw new Error('evidence digest is invalid');
  return value;
}

function positivePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('port is invalid');
  return port;
}

function request(options, body) {
  const requester = options.protocol === 'https:' ? https.request : http.request;
  return new Promise((resolve, reject) => {
    const handle = requester({ ...options, signal: AbortSignal.timeout(8_000) }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.once('error', reject);
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let decoded;
        try { decoded = text ? JSON.parse(text) : undefined; } catch { decoded = text; }
        resolve({ status: response.statusCode || 0, body: decoded });
      });
    });
    handle.once('error', reject);
    if (body !== undefined) handle.end(JSON.stringify(body));
    else handle.end();
  });
}

function gatewayRequest(method, pathname, body, withCertificate = true) {
  return request({
    protocol: 'https:',
    hostname: gatewayHost,
    port: gatewayPort,
    path: pathname,
    method,
    servername: 'gateway',
    ca: credentials.ca,
    ...(withCertificate ? { cert: credentials.cert, key: credentials.key } : {}),
    headers: {
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
  }, body);
}

async function gatewayReady() {
  const response = await gatewayRequest('GET', '/v3/status');
  return response.status === 200;
}

function controlState() {
  return request({ protocol: 'http:', hostname: externalControlHost, port: controlPort, path: '/state', method: 'GET' });
}

function enableTelegramUpdate() {
  return request({ protocol: 'http:', hostname: externalControlHost, port: controlPort, path: '/telegram/enable', method: 'POST' });
}

async function waitUntil(operation, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await operation();
      if (value) return value;
    } catch (error) { lastError = error; }
    await sleep(100);
  }
  throw lastError || new Error(`condition timed out after ${timeoutMs}ms`);
}

class MtlsWsClient {
  constructor(instanceId = `authentic-${crypto.randomUUID()}`) {
    this.instanceId = instanceId;
    this.frames = [];
    this.socket = undefined;
    this.epoch = undefined;
  }

  async connect(expectRejected = false) {
    this.socket = new WebSocket(`wss://${gatewayHost}:${gatewayPort}/v3/ws`, {
      ca: credentials.ca,
      cert: credentials.cert,
      key: credentials.key,
      servername: 'gateway',
      rejectUnauthorized: true,
    });
    this.socket.on('message', (data) => {
      try { this.frames.push(JSON.parse(data.toString('utf8'))); } catch { this.frames.push({ type: 'invalid' }); }
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('mTLS WebSocket open timed out')), 8_000);
      this.socket.once('open', () => { clearTimeout(timer); resolve(); });
      this.socket.once('error', (error) => { clearTimeout(timer); reject(error); });
    });
    this.send({
      type: 'hello',
      version: '3.0',
      tenant_id: 'Steven',
      alias: 'jarvis',
      instance_id: this.instanceId,
      capabilities: ['runtime-authentic', 'acks.v3'],
    });
    const hello = await this.next((frame) => frame.type === 'hello_ack' || frame.type === 'takeover_rejected');
    assert.equal(hello.type, expectRejected ? 'takeover_rejected' : 'hello_ack');
    if (!expectRejected) this.epoch = hello.epoch;
    return hello;
  }

  send(value) {
    assert.equal(this.socket?.readyState, WebSocket.OPEN);
    this.socket.send(JSON.stringify(value));
  }

  // The fault-injection cases kill the gateway or PostgreSQL outright and then wait
  // for the system to reconverge. What they assert is that the effect survives, never
  // that it arrives quickly, so the budget has to cover a cold reconnect on a busy
  // release host -- 20s was tight enough there that either fault case failed at random.
  // Raising it cannot turn a real failure into a pass: no caller catches this timeout,
  // so a longer wait only removes premature aborts.
  async next(predicate, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const index = this.frames.findIndex(predicate);
      if (index >= 0) return this.frames.splice(index, 1)[0];
      await sleep(20);
    }
    throw new Error(`WebSocket frame timed out after ${timeoutMs}ms`);
  }

  delivery(predicate = () => true, timeoutMs = 30_000) {
    return this.next((frame) => frame.type === 'delivery' && predicate(frame), timeoutMs);
  }

  async ack(delivery, resultText) {
    const frame = {
      type: 'ack',
      version: '3.0',
      event_id: crypto.randomUUID(),
      delivery_id: delivery.delivery_id,
      attempt: delivery.attempt,
      claim_token: delivery.claim_token,
      status: 'done',
      instance_id: this.instanceId,
      epoch: this.epoch,
      retryable: false,
      result: { text: resultText },
    };
    this.send(frame);
    const first = await this.next((value) => value.type === 'ack_result' && value.delivery_id === delivery.delivery_id);
    this.send({ ...frame, event_id: crypto.randomUUID() });
    const duplicate = await this.next((value) => value.type === 'ack_result' && value.delivery_id === delivery.delivery_id);
    // The receipt is the only thing that distinguishes a genuine durability defect from
    // a claim this harness lost to timing, and a bare `false !== true` hides it.
    assert.equal(first.applied, true, `first ACK was not applied: receipt=${first.receipt}`);
    assert.equal(duplicate.applied, false, `replayed ACK was applied twice: receipt=${duplicate.receipt}`);
  }

  terminate() { this.socket?.terminate(); }

  async close() {
    if (!this.socket || this.socket.readyState === WebSocket.CLOSED) return;
    const closed = new Promise((resolve) => this.socket.once('close', resolve));
    this.socket.close(1000, 'authentic QA complete');
    await Promise.race([closed, sleep(1_000)]);
  }
}

async function publishWebhookMessage() {
  const response = await gatewayRequest('POST', '/v3/messages', {
    room_id: 'grp.steven',
    recipients: [{ tenant_id: 'Steven', alias: 'jarvis' }],
    body: { text: 'runtime authentic webhook effect' },
    idempotency_key: `authentic-${crypto.randomUUID()}`,
    lane: 'interactive',
    priority: 10,
  });
  assert.equal(response.status, 202, JSON.stringify(response.body));
  return response.body.message_id;
}

function runFault(service) {
  const script = process.env.CAUCE_FAULT_DRIVER === 'docker-run'
    ? path.join(here, '..', 'scripts', 'fault-runtime.sh')
    : path.join(here, '..', 'scripts', 'fault-compose.sh');
  const result = spawnSync(script, [service], { env: process.env, encoding: 'utf8', timeout: 120_000 });
  if (result.status !== 0) throw new Error(`fault ${service} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

async function shadowIngress(payload) {
  return request({
    protocol: 'http:',
    hostname: unixControlHost,
    port: unixControlPort,
    path: '/router/ingress/v3',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  }, payload);
}

const testCases = [
  ['five final services share the inspected runtime image', 'final-image-digest-inspection', async () => {
    assert.ok(deployment && Array.isArray(deployment.services));
    const expected = ['dispatcher', 'gateway', 'relay-worker', 'shadow-router', 'telegram-bridge'];
    assert.deepEqual(deployment.services.map((item) => item.name).sort(), expected);
    assert.ok(deployment.services.every((item) => item.imageDigest === imageDigest));
  }],
  ['gateway data plane requires verified mTLS and isolates health', 'gateway-health-mtls', async () => {
    await assert.rejects(gatewayRequest('GET', '/v3/status', undefined, false));
    const ready = await gatewayRequest('GET', '/v3/status');
    assert.equal(ready.status, 200);
    const publicHealth = await gatewayRequest('GET', '/health/ready');
    assert.equal(publicHealth.status, 404);
  }],
  ['duplicate gateway owner is fenced', 'gateway-epoch-fencing', async () => {
    const first = new MtlsWsClient('fencing-first');
    const second = new MtlsWsClient('fencing-second');
    try {
      await first.connect();
      const rejected = await second.connect(true);
      assert.equal(rejected.active_instance_id, first.instanceId);
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  }],
  ['gateway process kill preserves Telegram delivery and one human reply', 'gateway-process-kill', async () => {
    assert.equal((await enableTelegramUpdate()).status, 200);
    await waitUntil(async () => (await controlState()).body.updatesEnabled === true);
    runFault('gateway');
    await waitUntil(gatewayReady, 45_000);
    const client = new MtlsWsClient('telegram-after-gateway-kill');
    try {
      await client.connect();
      const delivery = await client.delivery((frame) => frame.origin?.adapter === 'telegram', 45_000);
      await client.ack(delivery, 'one durable human reply');
    } finally {
      await client.close();
    }
    await waitUntil(async () => (await controlState()).body.telegramSends === 1, 30_000);
    runFault('telegram-bridge');
    await sleep(3_000);
    assert.equal((await controlState()).body.telegramSends, 1);
  }],
  ['PostgreSQL container kill preserves webhook effect over verified HTTPS', 'postgres-container-kill', async () => {
    const messageId = await publishWebhookMessage();
    runFault('postgres');
    await waitUntil(gatewayReady, 60_000);
    const client = new MtlsWsClient('webhook-after-postgres-kill');
    try {
      await client.connect();
      const delivery = await client.delivery((frame) => frame.message_id === messageId, 45_000);
      await client.ack(delivery, 'webhook durable result');
    } finally {
      await client.close();
    }
    runFault('relay-worker');
    const state = await waitUntil(async () => {
      const current = (await controlState()).body;
      return current.webhooks === 1 ? current : undefined;
    }, 30_000);
    assert.equal(state.webhookTls, true);
    assert.equal(state.webhookIdsUnique, true);
  }],
  ['real V2 Unix target receives one side-effect-free shadow preview', 'v2-unix-socket-shadow', async () => {
    const envelope = {
      direction: 'v3-to-v2',
      source_event_id: `source-${crypto.randomUUID()}`,
      tenant_id: 'Steven',
      correlation: {
        request_id: crypto.randomUUID(),
        trace_id: crypto.randomUUID(),
        conversation_key: `conversation-${crypto.randomUUID()}`,
      },
      payload: { text: 'must remain a preview' },
      expects_human_reply: true,
    };
    const first = await shadowIngress(envelope);
    const duplicate = await shadowIngress(envelope);
    assert.equal(first.status, 202);
    assert.ok([200, 202].includes(duplicate.status));
    const events = await waitUntil(async () => {
      const state = await request({ protocol: 'http:', hostname: unixControlHost, port: unixControlPort, path: '/state', method: 'GET' });
      return state.body.events.length === 1 ? state.body.events : undefined;
    }, 30_000);
    assert.equal(events[0].path, '/shadow/preview');
    assert.equal(events[0].allowHumanReply, false);
    assert.equal(events[0].allowHarness, false);
    assert.match(events[0].socketPath, /\/v2\/ingress\.sock$/);
  }],
];

async function main() {
  const suiteStarted = new Date();
  const results = [];
  for (const [name, mechanism, execute] of testCases) {
    const startedAt = new Date();
    const started = performance.now();
    try {
      await execute();
      results.push(result(name, mechanism, 'passed', startedAt, performance.now() - started));
      console.log(`PASS ${name}`);
    } catch (error) {
      results.push(result(name, mechanism, 'failed', startedAt, performance.now() - started, error));
      console.error(`FAIL ${name}: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }
  const report = {
    schemaVersion: 4,
    suite: 'cauce-v3-final-binaries-e2e',
    mode,
    evidenceClass,
    mechanism: suiteMechanism,
    imageDigest,
    sourceDigest,
    sourceDigestDomain: 'runtime',
    harnessDigest,
    timestamps: { startedAt: suiteStarted.toISOString(), finishedAt: new Date().toISOString() },
    deployment,
    summary: {
      tests: results.length,
      passed: results.filter((item) => item.status === 'passed').length,
      failed: results.filter((item) => item.status === 'failed').length,
      skipped: results.filter((item) => item.status === 'skipped').length,
      criticalSkipped: results.filter((item) => item.critical && item.status === 'skipped').length,
      real: results.filter((item) => item.status === 'passed' && item.evidenceClass !== 'protocol-double').length,
      authentic: results.filter((item) => item.status === 'passed' && item.evidenceClass !== 'protocol-double').length,
      protocolDouble: results.filter((item) => item.evidenceClass === 'protocol-double').length,
    },
    tests: results,
  };
  await writeArtifacts(report);
  process.exitCode = report.summary.failed === 0 && report.summary.criticalSkipped === 0 ? 0 : 1;
}

function result(name, mechanism, status, startedAt, duration, error) {
  return {
    name,
    status,
    critical: true,
    evidenceClass,
    mechanism,
    imageDigest,
    sourceDigest,
    timestamps: { startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString() },
    durationMs: Math.max(0, Math.round(duration)),
    ...(error === undefined ? {} : { error: String(error instanceof Error ? error.message : error).slice(0, 2000) }),
  };
}

function xmlEscape(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

async function writeArtifacts(report) {
  await mkdir(artifactDir, { recursive: true });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  const cases = report.tests.map((test) => {
    const failure = test.status === 'failed' ? `<failure message="${xmlEscape(test.error)}"/>` : '';
    return `  <testcase classname="cauce.${report.evidenceClass}" name="${xmlEscape(test.name)}" time="${(test.durationMs / 1000).toFixed(3)}">${failure}</testcase>`;
  }).join('\n');
  const junit = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuite name="cauce-v3-final-binaries-e2e" tests="${report.summary.tests}" failures="${report.summary.failed}" skipped="${report.summary.skipped}" timestamp="${report.timestamps.startedAt}">`,
    '  <properties>',
    `    <property name="evidenceClass" value="${report.evidenceClass}"/>`,
    `    <property name="imageDigest" value="${report.imageDigest}"/>`,
    `    <property name="sourceDigest" value="${report.sourceDigest}"/>`,
    '  </properties>',
    cases,
    '</testsuite>',
    '',
  ].join('\n');
  await writeFile(path.join(artifactDir, 'report.json'), json, { mode: 0o644 });
  await writeFile(path.join(artifactDir, 'junit.xml'), junit, { mode: 0o644 });
  const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
  await writeFile(path.join(artifactDir, 'SHA256SUMS'), `${sha(json)}  report.json\n${sha(junit)}  junit.xml\n`, { mode: 0o644 });
}

await main();
