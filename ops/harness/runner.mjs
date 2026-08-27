#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { topology } from './fleet.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
if (!args.includes('--live') || args.includes('--mock')) {
  console.error('runner.mjs targets the real V3 gateway; use --live (mock contract has contract-runner.mjs)');
  process.exit(2);
}
const artifactFlag = args.indexOf('--artifact-dir');
const artifactDir = path.resolve(artifactFlag >= 0 ? args[artifactFlag + 1] : path.join(here, '..', 'artifacts', 'real'));
const requireRestarts = args.includes('--require-restarts') || process.env.CAUCE_REQUIRE_RESTART_EVIDENCE === '1';
const baseUrl = required('CAUCE_BASE_URL');
const wsBaseUrl = required('CAUCE_WS_URL');
const faultMode = process.env.CAUCE_FAULT_MODE || 'none';
if (requireRestarts && faultMode !== 'compose') {
  console.error('restart evidence is required but CAUCE_FAULT_MODE=compose is not enabled');
  process.exit(2);
}
const httpTimeoutMs = Number(process.env.CAUCE_HTTP_TIMEOUT_MS || 8_000);
const wsTimeoutMs = Number(process.env.CAUCE_WS_TIMEOUT_MS || 8_000);
// A lost claim is first fenced, then deliberately held for the 30 s timeout backoff before its
// wake becomes eligible. The recovery probe must cover that safety interval instead of silently
// encoding the old immediate-retry behaviour.
const retryTimeoutMs = Number(process.env.CAUCE_RETRY_TIMEOUT_MS || 45_000);
const leaseWaitMs = Number(process.env.CAUCE_PRESENCE_LEASE_MS || 500);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const unique = (prefix) => `${prefix}-${crypto.randomUUID()}`;
const restartEvidence = [];
const liveSockets = new Set();
const socketShutdowns = new WeakMap();

function sourceDigest(domain) {
  const result = spawnSync('python3', [path.join(here, '..', 'scripts', 'source-digest.py'), '--domain', domain], {
    cwd: path.join(here, '..', '..'),
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    encoding: 'utf8',
  });
  const value = result.stdout.trim();
  if (result.status !== 0 || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`could not bind ${domain} source digest`);
  }
  return value;
}

function testcontainersBindings() {
  if (process.env.CAUCE_EVIDENCE_CLASS !== 'testcontainers') return {};
  const repositoryDigest = required('CAUCE_TESTCONTAINERS_DB_REPOSITORY_DIGEST');
  const imageId = required('CAUCE_TESTCONTAINERS_DB_IMAGE_ID');
  const containerConfigImage = required('CAUCE_TESTCONTAINERS_DB_CONFIG_IMAGE');
  const containerIdSha256 = required('CAUCE_TESTCONTAINERS_DB_CONTAINER_ID_SHA256');
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+@sha256:[a-f0-9]{64}$/u.test(repositoryDigest)
      || !/^sha256:[a-f0-9]{64}$/u.test(imageId)
      || !/^sha256:[a-f0-9]{64}$/u.test(containerIdSha256)) {
    throw new Error('Testcontainers image binding is malformed');
  }
  return {
    evidenceClass: 'testcontainers-source-execution',
    executionTarget: {
      application: 'source-tree',
      database: 'immutable-testcontainer-image',
      finalCauceImageExecuted: false,
    },
    sourceDigest: sourceDigest('runtime'),
    sourceDigestDomain: 'runtime',
    harnessDigest: sourceDigest('testcontainers'),
    harnessDigestDomain: 'testcontainers',
    databaseImage: {
      role: 'postgresql-test-dependency',
      repositoryDigest,
      imageId,
      containerConfigImage,
      containerIdSha256,
      verifiedAgainstRunningContainer: true,
    },
  };
}

function trackSocket(socket) {
  liveSockets.add(socket);
  socket.once('close', () => liveSockets.delete(socket));
  return socket;
}

async function shutdownSocket(socket, graceful = true) {
  const existing = socketShutdowns.get(socket);
  if (existing) return existing;
  const shutdown = (async () => {
    if (socket.readyState === WebSocket.CLOSED) return;
    let closedResolve;
    const closed = new Promise((resolve) => { closedResolve = resolve; });
    const onClose = () => closedResolve();
    const swallowShutdownError = () => undefined;
    socket.once('close', onClose);
    socket.on('error', swallowShutdownError);
    try {
      if (graceful && socket.readyState === WebSocket.OPEN) socket.close(1000, 'QA close');
      else socket.terminate();
      await Promise.race([closed, sleep(1_000)]);
      if (socket.readyState !== WebSocket.CLOSED) {
        socket.terminate();
        await Promise.race([closed, sleep(1_000)]);
      }
      if (socket.readyState !== WebSocket.CLOSED) {
        throw new Error('WebSocket did not reach CLOSED during QA cleanup');
      }
    } finally {
      socket.off('close', onClose);
      socket.off('error', swallowShutdownError);
    }
  })();
  socketShutdowns.set(socket, shutdown);
  try {
    await shutdown;
  } finally {
    socketShutdowns.delete(socket);
  }
}

const harnessKinds = ['hermes', 'opencode', 'claude', 'codex'];
const allIdentities = Object.entries(topology).flatMap(([tenant, value]) =>
  value.aliases.map((alias) => ({ tenant, alias, room: value.room })));

class WsClient {
  constructor(identity, kind = 'opencode', instanceId = unique(`qa-${identity.alias}`)) {
    this.identity = identity;
    this.kind = kind;
    this.instanceId = instanceId;
    this.messages = [];
    this.ws = undefined;
    this.epoch = undefined;
  }

  async connect(expectRejected = false) {
    this.messages = [];
    const socket = trackSocket(new WebSocket(wsBaseUrl, {
      headers: { 'x-cauce-tenant': this.identity.tenant, 'x-cauce-alias': this.identity.alias },
    }));
    this.ws = socket;
    socket.on('message', (data) => {
      try { this.messages.push(JSON.parse(data.toString('utf8'))); }
      catch { this.messages.push({ type: 'invalid_json' }); }
    });
    try {
      await new Promise((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          socket.off('open', onOpen);
          socket.off('error', onError);
        };
        const onOpen = () => { cleanup(); resolve(); };
        const onError = (error) => { cleanup(); reject(error); };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error('WebSocket open timeout'));
        }, wsTimeoutMs);
        socket.once('open', onOpen);
        socket.once('error', onError);
      });
      this.send({
        type: 'hello', version: '3.0', tenant_id: this.identity.tenant, alias: this.identity.alias,
        instance_id: this.instanceId,
        capabilities: [`harness.${this.kind}`, 'qa-double', 'acks.v3'],
      });
      const response = await this.next(
        (frame) => frame.type === 'hello_ack' || frame.type === 'takeover_rejected'
      );
      if (expectRejected) {
        assert.equal(response.type, 'takeover_rejected');
        return response;
      }
      assert.equal(response.type, 'hello_ack');
      assert.equal(response.version, '3.0');
      this.epoch = response.epoch;
      return response;
    } catch (error) {
      try {
        await shutdownSocket(socket, false);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], error.message, { cause: error });
      } finally {
        if (this.ws === socket) this.ws = undefined;
      }
      throw error;
    }
  }

  send(frame) {
    assert.equal(this.ws?.readyState, WebSocket.OPEN);
    this.ws.send(JSON.stringify(frame));
  }

  async next(predicate = () => true, timeoutMs = wsTimeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const index = this.messages.findIndex(predicate);
      if (index >= 0) return this.messages.splice(index, 1)[0];
      await sleep(10);
    }
    throw new Error(`WebSocket frame timeout after ${timeoutMs}ms`);
  }

  nextDelivery(messageId, timeoutMs = wsTimeoutMs) {
    return this.next((frame) => frame.type === 'delivery' && (!messageId || frame.message_id === messageId), timeoutMs);
  }

  async ack(delivery, status, detail = {}) {
    this.send({
      type: 'ack', version: '3.0', event_id: crypto.randomUUID(),
      delivery_id: delivery.delivery_id, attempt: delivery.attempt, claim_token: delivery.claim_token, status,
      instance_id: this.instanceId, epoch: this.epoch, retryable: detail.retryable ?? false,
      ...(detail.error ? { error: detail.error } : {}),
      ...(detail.result ? { result: detail.result } : {}),
    });
    return this.next((frame) => frame.type === 'ack_result' && frame.delivery_id === delivery.delivery_id);
  }

  heartbeat() {
    this.send({ type: 'heartbeat', instance_id: this.instanceId, epoch: this.epoch });
    return this.next((frame) => frame.type === 'heartbeat_ack');
  }

  async terminate() {
    const socket = this.ws;
    if (!socket) return;
    await shutdownSocket(socket, false);
    if (this.ws === socket) this.ws = undefined;
  }

  async close() {
    const socket = this.ws;
    if (!socket) return;
    await shutdownSocket(socket, true);
    if (this.ws === socket) this.ws = undefined;
  }
}

async function executeWithClientCleanup(execute) {
  let executionError;
  try {
    await execute();
  } catch (error) {
    executionError = error;
  }
  const cleanup = await Promise.allSettled(
    [...liveSockets].map(async (socket) => shutdownSocket(socket, true))
  );
  const cleanupErrors = cleanup
    .filter((result) => result.status === 'rejected')
    .map((result) => result.reason);
  if (executionError && cleanupErrors.length > 0) {
    throw new AggregateError([executionError, ...cleanupErrors], executionError.message, {
      cause: executionError
    });
  }
  if (executionError) throw executionError;
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'QA WebSocket cleanup failed');
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function identity(tenant, alias = topology[tenant].aliases[0]) {
  return { tenant, alias, room: topology[tenant].room };
}

async function api(actor, method, pathname, body, expectedStatus) {
  const consoleMutation = pathname.startsWith('/v3/console/') && !['GET', 'HEAD', 'OPTIONS'].includes(method);
  const response = await globalThis.fetch(new URL(pathname, baseUrl), {
    method,
    headers: {
      accept: 'application/json',
      'x-cauce-tenant': actor.tenant,
      'x-cauce-alias': actor.alias,
      ...(consoleMutation ? { origin: new URL(baseUrl).origin } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: globalThis.AbortSignal.timeout(httpTimeoutMs),
  });
  const contentType = response.headers.get('content-type') || '';
  const data = response.status === 204 ? undefined
    : contentType.includes('application/json') ? await response.json() : await response.text();
  if (expectedStatus !== undefined) assert.equal(response.status, expectedStatus, `${method} ${pathname}: ${JSON.stringify(data)}`);
  return { status: response.status, data };
}

function publish(actor, recipient, options = {}) {
  return api(actor, 'POST', '/v3/messages', {
    room_id: actor.room,
    recipients: options.recipients ?? [{ tenant_id: recipient.tenant, alias: recipient.alias }],
    body: options.body ?? { text: unique('qa-message') },
    idempotency_key: options.idempotencyKey ?? unique('qa-idem'),
    lane: options.lane ?? 'interactive',
    priority: options.priority ?? 10,
  });
}

async function waitUntil(operation, timeoutMs = wsTimeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await operation();
      if (value) return value;
    } catch (error) { lastError = error; }
    await sleep(30);
  }
  throw lastError || new Error(`condition timeout after ${timeoutMs}ms`);
}

async function heartbeatWhile(client, operation) {
  let active = true;
  let heartbeatError;
  const heartbeat = (async () => {
    while (active) {
      await sleep(Math.min(1_000, Math.max(250, leaseWaitMs)));
      if (!active) return;
      try {
        await client.heartbeat();
      } catch (error) {
        heartbeatError = error;
        return;
      }
    }
  })();
  let result;
  let operationError;
  try {
    result = await operation();
  } catch (error) {
    operationError = error;
  } finally {
    active = false;
    await heartbeat;
  }
  if (operationError && heartbeatError) {
    throw new AggregateError([operationError, heartbeatError], operationError.message, {
      cause: operationError
    });
  }
  if (operationError) throw operationError;
  if (heartbeatError) throw heartbeatError;
  return result;
}

const tests = [
  ['15 aliases and four harness kinds over real WS', async () => {
    const clients = await Promise.all(allIdentities.map(async (entry, index) => {
      const client = new WsClient(entry, harnessKinds[index % harnessKinds.length]);
      await client.connect();
      return client;
    }));
    const status = await api(identity('Steven', 'kant'), 'GET', '/v3/status', undefined, 200);
    for (const entry of allIdentities) {
      assert.ok(status.data.presence.some((row) => row.tenant_id === entry.tenant && row.alias === entry.alias && row.online === true));
    }
    assert.equal(new Set(clients.map((client) => client.kind)).size, 4);
    await Promise.all(clients.map((client) => client.close()));
    await waitUntil(async () => {
      const after = await api(identity('Steven', 'kant'), 'GET', '/v3/status');
      return allIdentities.every((entry) => after.data.presence.some(
        (row) => row.tenant_id === entry.tenant && row.alias === entry.alias && row.online === false));
    });
  }, { doubles: true, evidenceClass: 'protocol-double' }],

  ['double consumer rejected and fencing retained', async () => {
    const actor = identity('Steven', 'kant');
    const first = new WsClient(actor, 'opencode', unique('first'));
    const second = new WsClient(actor, 'codex', unique('second'));
    await first.connect();
    const rejected = await second.connect(true);
    assert.equal(rejected.active_instance_id, first.instanceId);
    await first.heartbeat();
    await Promise.all([first.close(), second.close()]);
  }],

  ['presence derives from heartbeat lease', async () => {
    const actor = identity('Pablo', 'midas');
    const client = new WsClient(actor);
    await client.connect();
    await client.heartbeat();
    const online = await api(identity('Steven', 'kant'), 'GET', '/v3/status', undefined, 200);
    assert.ok(online.data.presence.some((row) => row.alias === actor.alias && row.online === true));
    await client.close();
    await waitUntil(async () => {
      const status = await api(identity('Steven', 'kant'), 'GET', '/v3/status', undefined, 200);
      return status.data.presence.some((row) => row.alias === actor.alias && row.online === false);
    }, leaseWaitMs + wsTimeoutMs);
  }],

  ['offline durable queue delivers on connect', async () => {
    const sender = identity('Steven', 'jarvis');
    const recipient = identity('Isa', 'salva');
    const sent = await publish(sender, recipient);
    assert.equal(sent.status, 202);
    const client = new WsClient(recipient);
    await client.connect();
    const delivery = await client.nextDelivery(sent.data.message_id);
    assert.equal(delivery.attempt, 1);
    assert.equal((await client.ack(delivery, 'done')).status, 'done');
    await client.close();
  }],

  ['asynchronous wake and push delivery', async () => {
    const sender = identity('Steven', 'argos');
    const recipient = identity('Jhon', 'hegel');
    const client = new WsClient(recipient, 'claude');
    await client.connect();
    const sent = await publish(sender, recipient);
    await client.next((frame) => frame.type === 'wake');
    const delivery = await client.nextDelivery(sent.data.message_id);
    await client.ack(delivery, 'done');
    await client.close();
  }],

  ['ACK accepted-started-done rejects duplicate and out-of-order', async () => {
    const sender = identity('Miguel', 'kratos');
    const recipient = identity('Miguel', 'janus');
    const client = new WsClient(recipient, 'hermes');
    await client.connect();
    const sent = await publish(sender, recipient);
    const delivery = await client.nextDelivery(sent.data.message_id);
    const accepted = await client.ack(delivery, 'accepted');
    assert.equal(accepted.type, 'ack_result');
    assert.equal(accepted.delivery_id, delivery.delivery_id);
    assert.equal(accepted.status, 'accepted');
    assert.equal(accepted.applied, true);
    assert.equal((await client.ack(delivery, 'started')).applied, true);
    assert.equal((await client.ack(delivery, 'accepted')).applied, false);
    assert.equal((await client.ack(delivery, 'done', { result: { answer: 'ok' } })).applied, true);
    assert.equal((await client.ack(delivery, 'failed')).applied, false);
    await client.close();
  }],

  ['lost ACK redelivers after reconnect', async () => {
    const sender = identity('Pablo', 'dedalo');
    const recipient = identity('Pablo', 'seneca');
    const first = new WsClient(recipient, 'codex', unique('lost-a'));
    await first.connect();
    const sent = await publish(sender, recipient);
    const lost = await first.nextDelivery(sent.data.message_id);
    await first.terminate();
    const second = new WsClient(recipient, 'codex', unique('lost-b'));
    await waitUntil(async () => {
      try { await second.connect(); return true; }
      catch { await second.close(); return false; }
    }, retryTimeoutMs);
    const retried = await heartbeatWhile(
      second,
      async () => second.nextDelivery(sent.data.message_id, retryTimeoutMs)
    );
    assert.equal(retried.delivery_id, lost.delivery_id);
    assert.ok(retried.attempt > lost.attempt);
    await second.ack(retried, 'done');
    await second.close();
  }],

  ['idempotency suppresses duplicate and rejects mutation', async () => {
    const sender = identity('Steven', 'socrates');
    const recipient = identity('Pablo', 'vulcano');
    const idempotencyKey = unique('stable');
    const body = { text: unique('same-body') };
    const first = await publish(sender, recipient, { idempotencyKey, body });
    const duplicate = await publish(sender, recipient, { idempotencyKey, body });
    assert.equal(first.status, 202);
    assert.equal(duplicate.status, 202);
    assert.equal(duplicate.data.duplicate, true);
    assert.equal(duplicate.data.message_id, first.data.message_id);
    const changed = await publish(sender, recipient, { idempotencyKey, body: { text: 'mutated' } });
    assert.equal(changed.status, 409);
  }],

  ['origin relay uses authenticated context correlation', async () => {
    const sender = identity('Steven', 'kant');
    const recipient = identity('Isa', 'salva');
    const client = new WsClient(recipient);
    await client.connect();
    const sent = await publish(sender, recipient);
    const delivery = await client.nextDelivery(sent.data.message_id);
    await client.ack(delivery, 'done', { result: { text: 'relay-result' } });
    const relays = await api(sender, 'GET', '/v3/console/origin-relays', undefined, 200);
    const relay = relays.data.items.find((item) => item.delivery_id === delivery.delivery_id);
    assert.equal(relay.adapter, 'dev-auth');
    assert.equal(relay.origin.channel, 'dev');
    assert.deepEqual(relay.payload.correlation, {
      request_id: delivery.request_id, message_id: delivery.message_id,
      delivery_id: delivery.delivery_id, trace_id: delivery.trace_id,
    });
    await client.close();
  }],

  ['zero recipient is no_route and identity fields are rejected', async () => {
    const sender = identity('Steven', 'jarvis');
    const recipient = identity('Steven', 'argos');
    const zero = await publish(sender, recipient, { recipients: [] });
    assert.equal(zero.status, 422);
    assert.equal(zero.data.error, 'no_route');
    const forged = await api(sender, 'POST', '/v3/messages', {
      tenant_id: 'Isa', actor_alias: 'salva', room_id: sender.room,
      recipients: [{ tenant_id: recipient.tenant, alias: recipient.alias }],
      body: { text: 'forged' }, idempotency_key: unique('forged'), lane: 'interactive', priority: 0,
    });
    assert.equal(forged.status, 400);
  }],

  ['complete Steven/Isa/Jhon/Pablo/Miguel ACL matrix', async () => {
    let checked = 0;
    for (const [sourceTenant, source] of Object.entries(topology)) {
      for (const [destinationTenant, destination] of Object.entries(topology)) {
        const result = await publish(identity(sourceTenant, source.aliases[0]), identity(destinationTenant, destination.aliases[0]));
        const allowed = sourceTenant === destinationTenant || sourceTenant === 'Steven' || destinationTenant === 'Steven';
        assert.equal(result.status, allowed ? 202 : 403, `${sourceTenant}->${destinationTenant}`);
        checked += 1;
      }
    }
    assert.equal(checked, 25);
  }],

  ['retry backoff exhausts into DLQ', async () => {
    const sender = identity('Pablo', 'dedalo');
    const recipient = identity('Pablo', 'midas');
    const client = new WsClient(recipient);
    await client.connect();
    const sent = await publish(sender, recipient);
    const attempts = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const delivery = await client.nextDelivery(sent.data.message_id, retryTimeoutMs);
      attempts.push(delivery.attempt);
      const result = await client.ack(delivery, 'failed', { retryable: true, error: `planned-${attempt}` });
      assert.equal(result.status, attempt < 3 ? 'retry' : 'dead');
    }
    assert.deepEqual(attempts, [1, 2, 3]);
    const queues = await api(sender, 'GET', '/v3/console/queues', undefined, 200);
    assert.ok(queues.data.items.some((item) => item.message_id === sent.data.message_id && item.state === 'dead'));
    await client.close();
  }],

  ['lane priority and bounded fairness on real dispatcher', async () => {
    const actor = identity('Steven', 'kant');
    const creates = [];
    for (let index = 0; index < 6; index += 1) creates.push(api(actor, 'POST', '/v3/console/jobs', { lane: 'interactive', priority: index, kind: 'qa.fairness', payload: { index } }, 202));
    for (let index = 0; index < 2; index += 1) creates.push(api(actor, 'POST', '/v3/console/jobs', { lane: 'batch', priority: index, kind: 'qa.fairness', payload: { index } }, 202));
    const created = await Promise.all(creates);
    const ids = new Set(created.map((item) => item.data.job_id));
    const jobs = await waitUntil(async () => {
      const page = await api(actor, 'GET', '/v3/console/jobs', undefined, 200);
      const selected = page.data.items.filter((item) => ids.has(item.job_id));
      return selected.length === 8 && selected.every((item) => item.status === 'done') ? selected : undefined;
    }, retryTimeoutMs);
    const order = jobs.slice().sort((left, right) => new Date(left.claimed_at).getTime() - new Date(right.claimed_at).getTime());
    assert.ok(order.findIndex((job) => job.lane === 'batch') <= 3, 'batch lane was starved past configured burst');
    const interactivePriorities = order.filter((job) => job.lane === 'interactive').map((job) => job.priority);
    assert.deepEqual(interactivePriorities.slice().sort((left, right) => right - left), [5, 4, 3, 2, 1, 0]);
    const lastWaitingBatch = order.findLastIndex((job) => job.lane === 'batch');
    let streak = 0;
    let maximumStreak = 0;
    for (const job of order.slice(0, lastWaitingBatch + 1)) {
      streak = job.lane === 'interactive' ? streak + 1 : 0;
      maximumStreak = Math.max(maximumStreak, streak);
    }
    assert.ok(maximumStreak <= 3, 'batch lane exceeded configured interactive burst');
  }],

  ['console facades reflect real core state', async () => {
    const actor = identity('Steven', 'kant');
    for (const endpoint of ['topology', 'messages', 'queues', 'jobs', 'adapters', 'audit']) {
      const result = await api(actor, 'GET', `/v3/console/${endpoint}`, undefined, 200);
      assert.ok(result.data && typeof result.data === 'object');
    }
  }],
];

if (faultMode === 'compose') tests.push(
  ['gateway restart preserves queued PostgreSQL delivery', async () => {
    const sender = identity('Steven', 'jarvis');
    const recipient = identity('Pablo', 'seneca');
    const sent = await publish(sender, recipient);
    runComposeFault('gateway');
    await waitUntil(async () => (await api(sender, 'GET', '/health/ready')).status === 200, 30_000);
    const client = new WsClient(recipient);
    await client.connect();
    const delivery = await client.nextDelivery(sent.data.message_id);
    await client.ack(delivery, 'done');
    await client.close();
  }, { critical: requireRestarts, evidenceClass: 'authentic-restart' }],

  ['database restart preserves queued delivery', async () => {
    const sender = identity('Steven', 'argos');
    const recipient = identity('Miguel', 'janus');
    const sent = await publish(sender, recipient);
    runComposeFault('postgres');
    await waitUntil(async () => (await api(sender, 'GET', '/health/ready')).status === 200, 45_000);
    const client = new WsClient(recipient);
    await client.connect();
    const delivery = await client.nextDelivery(sent.data.message_id);
    await client.ack(delivery, 'done');
    await client.close();
  }, { critical: requireRestarts, evidenceClass: 'authentic-restart' }],
);

function runComposeFault(service) {
  if (process.env.CAUCE_FAULT_CONFIRM !== 'ephemeral-only') throw new Error('CAUCE_FAULT_CONFIRM=ephemeral-only is required');
  const script = path.join(here, '..', 'scripts', 'fault-compose.sh');
  const startedAt = new Date();
  const result = spawnSync(script, [service], { env: process.env, encoding: 'utf8', timeout: 120_000 });
  if (result.status !== 0) throw new Error(`compose fault failed for ${service}: ${result.stderr.trim()}`);
  const evidence = {
    service,
    mechanism: 'docker-compose-process-kill-and-start',
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    exitCode: result.status,
    output: result.stdout.trim(),
  };
  restartEvidence.push(evidence);
  console.log(`EVIDENCE ${service} restart: ${evidence.output}`);
}

async function main() {
  await waitUntil(async () => (await api(identity('Steven', 'kant'), 'GET', '/health/ready')).status === 200, 15_000);
  const startedAt = new Date();
  const results = [];
  for (const [name, execute, metadata = {}] of tests) {
    const started = performance.now();
    try {
      await executeWithClientCleanup(execute);
      results.push({ name, status: 'passed', evidence: 'real', durationMs: Math.round(performance.now() - started), ...metadata });
      console.log(`PASS ${name}`);
    } catch (error) {
      results.push({
        name, status: 'failed', evidence: 'real',
        durationMs: Math.round(performance.now() - started), error: error.message,
        stack: error.stack, ...metadata,
      });
      console.log(`FAIL ${name}: ${error.message}`);
    }
  }
  const report = {
    schemaVersion: 2,
    suite: 'cauce-v3-real-e2e',
    mode: 'real',
    ...testcontainersBindings(),
    target: { baseUrl: redactUrl(baseUrl), wsUrl: redactUrl(wsBaseUrl) },
    evidence: {
      transport: 'real Fastify HTTP/WebSocket gateway',
      persistence: 'real PostgreSQL',
      harnessExecution: 'four advertised harness kinds are protocol doubles; adapter executable tests are unit/contract',
      faultMode,
      aliases: allIdentities.length,
      harnessKinds,
      restartRequirement: requireRestarts ? 'required' : 'not-in-this-profile',
      restarts: restartEvidence,
    },
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    summary: {
      tests: results.length,
      passed: results.filter((item) => item.status === 'passed').length,
      failed: results.filter((item) => item.status === 'failed').length,
      skipped: 0,
      criticalSkipped: 0,
      real: results.filter((item) => item.evidence === 'real' && item.evidenceClass !== 'protocol-double').length,
      mocked: results.filter((item) => item.evidence === 'mocked').length,
    },
    tests: results,
  };
  await writeArtifacts(report);
  process.exitCode = report.summary.failed || report.summary.criticalSkipped ? 1 : 0;
}

function redactUrl(value) {
  const url = new URL(value);
  url.username = '';
  url.password = '';
  for (const key of [...url.searchParams.keys()]) if (/token|key|secret|auth/i.test(key)) url.searchParams.set(key, 'REDACTED');
  return url.toString();
}

function xmlEscape(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

async function writeArtifacts(report) {
  await mkdir(artifactDir, { recursive: true });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  const totalSeconds = report.tests.reduce((sum, item) => sum + item.durationMs, 0) / 1_000;
  const cases = report.tests.map((test) => {
    const detail = test.status === 'failed'
      ? `<failure message="${xmlEscape(test.error)}">${xmlEscape(test.stack || test.error)}</failure>`
      : '';
    return `  <testcase classname="cauce.real" name="${xmlEscape(test.name)}" time="${(test.durationMs / 1_000).toFixed(3)}">${detail}</testcase>`;
  }).join('\n');
  const junit = `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="cauce-v3-real-e2e" tests="${report.summary.tests}" failures="${report.summary.failed}" skipped="${report.summary.skipped}" time="${totalSeconds.toFixed(3)}" timestamp="${report.startedAt}">\n${cases}\n</testsuite>\n`;
  const reportPath = path.join(artifactDir, 'report.json');
  const junitPath = path.join(artifactDir, 'junit.xml');
  await writeFile(reportPath, json, { mode: 0o644 });
  await writeFile(junitPath, junit, { mode: 0o644 });
  const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
  await writeFile(path.join(artifactDir, 'SHA256SUMS'), `${digest(json)}  report.json\n${digest(junit)}  junit.xml\n`, { mode: 0o644 });
}

executeWithClientCleanup(main).catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
