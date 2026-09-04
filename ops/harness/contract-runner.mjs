#!/usr/bin/env node

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tenantAgents } from './fleet.mjs';
import { redactUrl, waitUntil, writeHarnessArtifacts } from './harness-utils.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const mockMode = args.includes('--mock');
const liveMode = args.includes('--live');
if (mockMode === liveMode) {
  console.error('choose exactly one of --mock or --live');
  process.exit(2);
}
const artifactFlag = args.indexOf('--artifact-dir');
const artifactDir = path.resolve(artifactFlag >= 0 ? args[artifactFlag + 1] : path.join(here, '..', 'artifacts'));

const tenants = tenantAgents;
const kinds = ['Hermes', 'OpenCode', 'ClaudeCode', 'Codex'];
const retryWaitMs = Number(process.env.CAUCE_RETRY_WAIT_MS || 120);
const presenceLeaseMs = Number(process.env.CAUCE_PRESENCE_LEASE_MS || 1200);
const httpTimeoutMs = Number(process.env.CAUCE_HTTP_TIMEOUT_MS || 5000);
const wsTimeoutMs = Number(process.env.CAUCE_WS_TIMEOUT_MS || 5000);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const unique = (prefix) => `${prefix}-${crypto.randomUUID()}`;

class SkipError extends Error {}

class WsClient {
  constructor(url) {
    this.url = url;
    this.messages = [];
    this.ws = null;
  }

  async connect() {
    this.ws = new WebSocket(this.url);
    this.ws.addEventListener('message', (event) => {
      try { this.messages.push(JSON.parse(String(event.data))); }
      catch { this.messages.push({ type: 'invalid_json', raw: String(event.data) }); }
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`WS open timeout: ${this.url}`)), wsTimeoutMs);
      this.ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      this.ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error(`WS open rejected: ${this.url}`)); }, { once: true });
    });
    return this.next((message) => message.type === 'connected');
  }

  send(value) { this.ws.send(JSON.stringify(value)); }

  async next(predicate = () => true, timeoutMs = wsTimeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const index = this.messages.findIndex(predicate);
      if (index >= 0) return this.messages.splice(index, 1)[0];
      await sleep(10);
    }
    throw new Error(`WS message timeout after ${timeoutMs}ms`);
  }

  async close() {
    if (!this.ws || this.ws.readyState === WebSocket.CLOSED) return;
    const closed = new Promise((resolve) => this.ws.addEventListener('close', resolve, { once: true }));
    this.ws.close();
    await Promise.race([closed, sleep(500)]);
  }
}

function wsUrl(base, tenant, agent, kind = 'OpenCode') {
  const url = new URL(base);
  url.searchParams.set('tenant', tenant);
  url.searchParams.set('agent', agent);
  url.searchParams.set('kind', kind);
  return url.toString();
}

async function api(context, method, pathname, body, expectedStatus) {
  const response = await fetch(new URL(pathname, context.baseUrl), {
    method,
    headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(httpTimeoutMs),
  });
  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await response.json() : await response.text();
  if (expectedStatus !== undefined) assert.equal(response.status, expectedStatus, `${method} ${pathname}: ${JSON.stringify(data)}`);
  return { status: response.status, data };
}

async function postMessage(context, { tenant, originAgent, recipientTenant = tenant, recipientAgent, recipients, payload, lane = 'normal', idempotencyKey = unique('idem') }) {
  return api(context, 'POST', '/v3/messages', {
    tenant,
    originAgent,
    recipients: recipients ?? [{ tenant: recipientTenant, agent: recipientAgent }],
    payload: payload ?? { nonce: unique('payload') },
    lane,
    idempotencyKey,
  });
}

async function connect(context, tenant, agent, kind = 'OpenCode') {
  const client = new WsClient(wsUrl(context.wsBaseUrl, tenant, agent, kind));
  const connected = await client.connect();
  assert.equal(connected.tenant, tenant);
  assert.equal(connected.agent, agent);
  assert.equal(connected.harnessKind, kind);
  return client;
}

async function ack(client, message, expected = 'accepted') {
  client.send({ type: 'ack', messageId: message.messageId, deliveryId: message.deliveryId });
  const result = await client.next((frame) => frame.type === 'ack_result' && frame.deliveryId === message.deliveryId);
  assert.equal(result.status, expected);
  return result;
}

async function expectWsRejected(url) {
  const ws = new WebSocket(url);
  const outcome = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), 1500);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve('opened'); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); resolve('rejected'); }, { once: true });
    ws.addEventListener('close', () => { clearTimeout(timer); resolve('rejected'); }, { once: true });
  });
  if (ws.readyState === WebSocket.OPEN) ws.close();
  assert.equal(outcome, 'rejected');
}

let mockChild;
let mockLogs = [];
const mockPort = 19000 + Math.floor(Math.random() * 4000);

function launchMock() {
  mockChild = spawn(process.execPath, [path.join(here, 'mock-server.mjs')], {
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(mockPort),
      PRESENCE_LEASE_MS: String(presenceLeaseMs),
      ACK_TIMEOUT_MS: String(retryWaitMs),
      MAX_DELIVERY_ATTEMPTS: '3',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const collect = (chunk) => { mockLogs.push(String(chunk).trim()); mockLogs = mockLogs.slice(-20); };
  mockChild.stdout.on('data', collect);
  mockChild.stderr.on('data', collect);
}

async function stopMock(signal = 'SIGTERM') {
  if (!mockChild || mockChild.exitCode !== null) return;
  const exited = new Promise((resolve) => mockChild.once('exit', resolve));
  mockChild.kill(signal);
  await Promise.race([exited, sleep(1200)]);
}

async function main() {
  const context = {
    baseUrl: process.env.CAUCE_BASE_URL,
    wsBaseUrl: process.env.CAUCE_WS_URL,
    faultMode: process.env.CAUCE_FAULT_MODE || 'none',
    mockOwned: mockMode,
  };
  if (mockMode) {
    launchMock();
    context.baseUrl = `http://127.0.0.1:${mockPort}`;
    context.wsBaseUrl = `ws://127.0.0.1:${mockPort}/v3/ws`;
    context.faultMode = 'mock-control';
  }
  if (!context.baseUrl || !context.wsBaseUrl) throw new Error('CAUCE_BASE_URL and CAUCE_WS_URL are required in --live mode');
  await waitUntil(async () => (await api(context, 'GET', '/health/ready')).status === 200, 6000);

  const tests = [
    ['all agent and harness-kind doubles', async () => {
      const clients = [];
      let index = 0;
      for (const [tenant, agents] of Object.entries(tenants)) {
        for (const agent of agents) {
          const kind = kinds[index % kinds.length]; index += 1;
          clients.push(await connect(context, tenant, agent, kind));
          const presence = await api(context, 'GET', `/v3/presence/${agent}?tenant=${tenant}`, undefined, 200);
          assert.equal(presence.data.status, 'online');
          assert.equal(presence.data.harnessKind, kind);
        }
      }
      assert.equal(clients.length, Object.values(tenants).flat().length);
      assert.deepEqual(new Set(kinds), new Set(['Hermes', 'OpenCode', 'ClaudeCode', 'Codex']));
      await Promise.all(clients.map((client) => client.close()));
    }],

    ['round-trip and ACK', async () => {
      const recipient = await connect(context, 'steven', 'socrates', 'ClaudeCode');
      const sent = await postMessage(context, { tenant: 'steven', originAgent: 'jarvis', recipientAgent: 'socrates', payload: { text: unique('roundtrip') } });
      assert.equal(sent.status, 202);
      const message = await recipient.next((frame) => frame.type === 'message');
      assert.equal(message.messageId, sent.data.messageId);
      await ack(recipient, message);
      await recipient.close();
    }],

    ['double consumer rejected', async () => {
      const first = await connect(context, 'steven', 'kant');
      await expectWsRejected(wsUrl(context.wsBaseUrl, 'steven', 'kant', 'Codex'));
      await first.close();
    }],

    ['offline queue and reconnect', async () => {
      const sent = await postMessage(context, { tenant: 'steven', originAgent: 'jarvis', recipientAgent: 'socrates' });
      assert.equal(sent.status, 202);
      const first = await connect(context, 'steven', 'socrates');
      const initial = await first.next((frame) => frame.type === 'message' && frame.messageId === sent.data.messageId);
      await first.close();
      await sleep(40);
      const reconnected = await connect(context, 'steven', 'socrates');
      const replay = await reconnected.next((frame) => frame.type === 'message' && frame.messageId === sent.data.messageId);
      assert.ok(replay.attempt > initial.attempt);
      await ack(reconnected, replay);
      await reconnected.close();
    }],

    ['lost, duplicate and out-of-order ACK', async () => {
      const recipient = await connect(context, 'miguel', 'janus', 'Hermes');
      const firstSent = await postMessage(context, { tenant: 'miguel', originAgent: 'kratos', recipientAgent: 'janus' });
      const lost = await recipient.next((frame) => frame.type === 'message' && frame.messageId === firstSent.data.messageId);
      const retried = await recipient.next((frame) => frame.type === 'message' && frame.messageId === firstSent.data.messageId && frame.attempt > lost.attempt);
      await ack(recipient, retried, 'accepted');
      await ack(recipient, retried, 'duplicate');

      const secondSent = await postMessage(context, { tenant: 'miguel', originAgent: 'kratos', recipientAgent: 'janus' });
      const oldDelivery = await recipient.next((frame) => frame.type === 'message' && frame.messageId === secondSent.data.messageId);
      const currentDelivery = await recipient.next((frame) => frame.type === 'message' && frame.messageId === secondSent.data.messageId && frame.attempt > oldDelivery.attempt);
      await ack(recipient, oldDelivery, 'out_of_order');
      await ack(recipient, currentDelivery, 'accepted');
      await recipient.close();
    }],

    ['idempotency key suppresses duplicate delivery', async () => {
      const recipient = await connect(context, 'steven', 'socrates', 'Codex');
      const idempotencyKey = unique('stable');
      const request = { tenant: 'steven', originAgent: 'jarvis', recipientAgent: 'socrates', idempotencyKey };
      const first = await postMessage(context, request);
      const duplicate = await postMessage(context, request);
      assert.equal(first.status, 202);
      assert.equal(duplicate.status, 200);
      assert.equal(duplicate.data.duplicate, true);
      assert.equal(first.data.messageId, duplicate.data.messageId);
      const message = await recipient.next((frame) => frame.type === 'message' && frame.messageId === first.data.messageId);
      await ack(recipient, message);
      await assert.rejects(recipient.next((frame) => frame.type === 'message' && frame.messageId === first.data.messageId, retryWaitMs * 2));
      await recipient.close();
    }],

    ['presence lease expires', async () => {
      const client = await connect(context, 'isa', 'salva');
      const online = await api(context, 'GET', '/v3/presence/salva?tenant=isa', undefined, 200);
      assert.equal(online.data.status, 'online');
      await client.close();
      await waitUntil(async () => {
        const presence = await api(context, 'GET', '/v3/presence/salva?tenant=isa', undefined, 200);
        return presence.data.status === 'offline';
      }, presenceLeaseMs + 1200);
    }],

    ['async wake reaches reconnecting agent', async () => {
      const wake = await api(context, 'POST', '/v3/agents/hegel/wake', { tenant: 'jhon', reason: 'queued_work' }, 202);
      assert.equal(wake.data.status, 'pending');
      const client = await connect(context, 'jhon', 'hegel', 'ClaudeCode');
      const frame = await client.next((message) => message.type === 'wake' && message.wakeId === wake.data.wakeId);
      assert.equal(frame.reason, 'queued_work');
      await client.close();
    }],

    ['origin relay is preserved', async () => {
      const recipient = await connect(context, 'steven', 'kant');
      const sent = await postMessage(context, { tenant: 'steven', originAgent: 'argos', recipientAgent: 'kant' });
      const message = await recipient.next((frame) => frame.type === 'message' && frame.messageId === sent.data.messageId);
      assert.deepEqual(message.origin, { tenant: 'steven', agent: 'argos' });
      await ack(recipient, message);
      await recipient.close();
    }],

    ['ACL tenant-by-tenant matrix', async () => {
      const entries = Object.entries(tenants);
      let checked = 0;
      for (const [sourceTenant, sourceAgents] of entries) {
        for (const [destinationTenant, destinationAgents] of entries) {
          const result = await postMessage(context, {
            tenant: sourceTenant,
            originAgent: sourceAgents[0],
            recipientTenant: destinationTenant,
            recipientAgent: destinationAgents[0],
          });
          assert.equal(result.status, sourceTenant === destinationTenant ? 202 : 403, `${sourceTenant}->${destinationTenant}`);
          checked += 1;
        }
      }
      assert.equal(checked, entries.length ** 2);
    }],

    ['zero-recipient request returns no_route', async () => {
      const result = await postMessage(context, { tenant: 'steven', originAgent: 'jarvis', recipients: [] });
      assert.equal(result.status, 422);
      assert.equal(result.data.code, 'no_route');
      assert.equal(result.data.routeCount, 0);
    }],

    ['retry exhaustion moves delivery to DLQ', async () => {
      const recipient = await connect(context, 'miguel', 'janus');
      const sent = await postMessage(context, { tenant: 'miguel', originAgent: 'kratos', recipientAgent: 'janus' });
      const attempts = [];
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const frame = await recipient.next((message) => message.type === 'message' && message.messageId === sent.data.messageId);
        attempts.push(frame.attempt);
      }
      assert.deepEqual(attempts, [1, 2, 3]);
      const item = await waitUntil(async () => {
        const dlq = await api(context, 'GET', '/v3/dlq/miguel', undefined, 200);
        return dlq.data.items.find((entry) => entry.messageId === sent.data.messageId);
      }, wsTimeoutMs);
      assert.equal(item.reason, 'ack_timeout');
      assert.equal(item.attempts, 3);
      await recipient.close();
    }],

    ['lane scheduler prioritizes without starving bulk', async () => {
      if (context.faultMode !== 'mock-control') throw new SkipError('requires mock dispatch control endpoint');
      const recipient = await connect(context, 'steven', 'kant');
      await api(context, 'POST', '/__control/dispatch', { paused: true }, 200);
      const lanes = ['bulk', 'bulk', 'bulk', 'bulk', 'normal', 'normal', 'interactive', 'interactive', 'control'];
      for (const lane of lanes) await postMessage(context, { tenant: 'steven', originAgent: 'socrates', recipientAgent: 'kant', lane, payload: { lane } });
      await api(context, 'POST', '/__control/dispatch', { paused: false }, 200);
      const observed = [];
      for (let index = 0; index < lanes.length; index += 1) {
        const frame = await recipient.next((message) => message.type === 'message');
        observed.push(frame.lane);
        await ack(recipient, frame);
      }
      assert.equal(observed[0], 'control');
      assert.ok(observed.indexOf('interactive') < observed.indexOf('bulk'));
      assert.equal(observed.filter((lane) => lane === 'bulk').length, 4);
      await recipient.close();
    }],

    ['database kill/restart recovery', async () => {
      if (context.faultMode === 'mock-control') {
        await api(context, 'POST', '/__control/db', { up: false }, 200);
        const down = await api(context, 'GET', '/health/ready');
        assert.equal(down.status, 503);
        await api(context, 'POST', '/__control/db', { up: true }, 200);
        await waitUntil(async () => (await api(context, 'GET', '/health/ready')).status === 200, wsTimeoutMs);
        return;
      }
      if (context.faultMode !== 'compose') throw new SkipError('set CAUCE_FAULT_MODE=compose for a disposable stack');
      runComposeFault('postgres');
      await waitUntil(async () => (await api(context, 'GET', '/health/ready')).status === 200, 30000);
    }],

    ['gateway kill/restart recovery', async () => {
      if (context.mockOwned) {
        await stopMock('SIGKILL');
        launchMock();
        await waitUntil(async () => (await api(context, 'GET', '/health/ready')).status === 200, 6000);
      } else if (context.faultMode === 'compose') {
        runComposeFault('gateway');
        await waitUntil(async () => (await api(context, 'GET', '/health/ready')).status === 200, 30000);
      } else throw new SkipError('gateway process restart requires --mock or guarded compose mode');
      const recipient = await connect(context, 'steven', 'socrates');
      const sent = await postMessage(context, { tenant: 'steven', originAgent: 'jarvis', recipientAgent: 'socrates' });
      const message = await recipient.next((frame) => frame.type === 'message' && frame.messageId === sent.data.messageId);
      await ack(recipient, message);
      await recipient.close();
    }],
  ];

  const startedAt = new Date();
  const results = [];
  for (const [name, test] of tests) {
    const started = performance.now();
    try {
      await test();
      results.push({ name, status: 'passed', evidence: 'mocked', durationMs: Math.round(performance.now() - started) });
      console.log(`PASS ${name}`);
    } catch (error) {
      const status = error instanceof SkipError ? 'skipped' : 'failed';
      results.push({ name, status, evidence: status === 'skipped' ? 'skipped' : 'mocked', durationMs: Math.round(performance.now() - started), error: error.message, stack: status === 'failed' ? error.stack : undefined });
      console.log(`${status === 'failed' ? 'FAIL' : 'SKIP'} ${name}: ${error.message}`);
    }
  }

  const report = {
    schemaVersion: 1,
    suite: 'cauce-v3-contract-e2e',
    mode: mockMode ? 'mock' : 'live',
    target: { baseUrl: redactUrl(context.baseUrl), wsUrl: redactUrl(context.wsBaseUrl) },
    evidence: {
      gatewayFault: mockMode ? 'mock gateway child process was SIGKILLed and restarted' : context.faultMode,
      databaseFault: context.faultMode === 'mock-control' ? 'simulated dependency outage in contract double' : context.faultMode,
      agentCount: Object.values(tenants).flat().length,
      harnessKinds: kinds,
    },
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    summary: {
      tests: results.length,
      passed: results.filter((item) => item.status === 'passed').length,
      failed: results.filter((item) => item.status === 'failed').length,
      skipped: results.filter((item) => item.status === 'skipped').length,
      real: 0,
      mocked: results.filter((item) => item.evidence === 'mocked').length,
    },
    tests: results,
  };
  await writeHarnessArtifacts(artifactDir, report, {
    suiteName: 'cauce-v3-contract-e2e',
    className: 'cauce.contract',
    includeSkipped: true,
  });
  if (mockMode) await stopMock();
  // This suite has no optional cases: any skip is a broken contract-double gate.
  process.exitCode = report.summary.failed || report.summary.skipped ? 1 : 0;
}

function runComposeFault(service) {
  if (process.env.CAUCE_FAULT_CONFIRM !== 'ephemeral-only') throw new Error('CAUCE_FAULT_CONFIRM=ephemeral-only is required');
  const script = path.join(here, '..', 'scripts', 'fault-compose.sh');
  const result = spawnSync(script, [service], { env: process.env, encoding: 'utf8', timeout: 120000 });
  if (result.status !== 0) throw new Error(`compose fault failed for ${service}: ${result.stderr.trim()}`);
}

main().catch(async (error) => {
  console.error(error.stack || error.message);
  if (mockMode) await stopMock();
  process.exitCode = 1;
});
