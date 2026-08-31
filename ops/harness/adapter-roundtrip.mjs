import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.join(here, '..', '..');
const fixture = path.join(here, 'adapter-roundtrip-fixture.mjs');
const inheritedEnvironment = ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TEMP'];
const diagnosticKeys = ['event', 'alias', 'reason', 'error_code', 'phase'];
const roundTripAliases = { opencode: 'qa-opencode', reviewer: 'qa-reviewer' };

function safeEnvironment() {
  return Object.fromEntries(inheritedEnvironment.flatMap((key) => (
    process.env[key] === undefined ? [] : [[key, process.env[key]]]
  )));
}

function sanitizeText(value) {
  return String(value)
    .replace(/\b(?:https?|wss?):\/\/\S+/giu, '[url]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/giu, '[id]')
    .replace(/\b[a-f0-9]{32,}\b/giu, '[opaque]')
    .replace(/\b(?:authorization|cookie|password|secret|token)\b\s*[:=]\s*\S+/giu, '[redacted]')
    .slice(0, 240);
}

function sanitizedLine(line) {
  try {
    const parsed = JSON.parse(line);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return sanitizeText(line);
    const selected = Object.fromEntries(diagnosticKeys.flatMap((key) => (
      typeof parsed[key] === 'string' || typeof parsed[key] === 'number'
        ? [[key, sanitizeText(parsed[key])]]
        : []
    )));
    return Object.keys(selected).length === 0 ? '[structured adapter event]' : JSON.stringify(selected);
  } catch {
    return sanitizeText(line);
  }
}

function diagnosticCapture() {
  const lines = [];
  let pending = '';
  const append = (chunk) => {
    pending += chunk.toString('utf8');
    if (pending.length > 64 * 1024) pending = pending.slice(-64 * 1024);
    const parts = pending.split(/\r?\n/u);
    pending = parts.pop() ?? '';
    for (const line of parts) {
      if (line.trim().length > 0 && lines.length < 40) lines.push(sanitizedLine(line));
    }
  };
  const snapshot = () => [
    ...lines,
    ...(pending.trim().length === 0 || lines.length >= 40 ? [] : [sanitizedLine(pending)]),
  ];
  return { append, snapshot };
}

function startAdapter({ alias, entrypoint, root, wsBaseUrl }) {
  const capture = diagnosticCapture();
  const stateDirectory = path.join(root, alias, 'state');
  const homeDirectory = path.join(root, alias, 'home');
  const child = spawn(process.execPath, [entrypoint], {
    cwd: repositoryRoot,
    detached: process.platform !== 'win32',
    env: {
      ...safeEnvironment(),
      HOME: homeDirectory,
      CAUCE_TENANT: 'Steven',
      CAUCE_ROOM: 'grp.steven',
      CAUCE_ALIAS: alias,
      CAUCE_INSTANCE_ID: `qa-${alias}-${crypto.randomUUID()}`,
      CAUCE_STATE_DIR: stateDirectory,
      CAUCE_RELAY_URL: wsBaseUrl,
      CAUCE_ENVIRONMENT: 'test',
      CAUCE_DEV_AUTH: '1',
      CAUCE_HARNESS_COMMAND: fixture,
      CAUCE_HEARTBEAT_MS: '100',
      CAUCE_DEFAULT_TIMEOUT_MS: '15000',
      CAUCE_SEMBRAR_PERFIL: '0',
      CAUCE_SEMBRAR_CONTEXTO: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', capture.append);
  child.stderr.on('data', capture.append);
  let spawnError;
  child.once('error', (error) => { spawnError = sanitizeText(error.message); });
  const closed = new Promise((resolve) => child.once('close', resolve));
  return {
    alias, child, closed,
    failure() {
      if (spawnError !== undefined) return spawnError;
      if (child.exitCode === null && child.signalCode === null) return undefined;
      return `exited code=${String(child.exitCode)} signal=${String(child.signalCode)}`;
    },
    diagnostics() {
      return { alias, exitCode: child.exitCode, signal: child.signalCode, events: capture.snapshot() };
    },
  };
}

function processExists(target) {
  try {
    process.kill(target, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

function signalProcess(target, signal) {
  try {
    process.kill(target, signal);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

async function waitForProcessExit(target, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(target)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !processExists(target);
}

async function promiseSettled(promise, timeoutMs) {
  return Promise.race([
    promise.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

async function stopAdapter(adapter) {
  const { child, closed } = adapter;
  if (child.pid === undefined) {
    if (!await promiseSettled(closed, 2_000)) throw new Error('adapter without a process id did not close');
    return;
  }
  const target = process.platform === 'win32' ? child.pid : -child.pid;
  if (processExists(target) && signalProcess(target, 'SIGTERM')
      && !await waitForProcessExit(target, 2_000)) {
    signalProcess(target, 'SIGKILL');
    if (!await waitForProcessExit(target, 2_000)) {
      throw new Error('adapter process group remained alive after SIGKILL');
    }
  }
  if (!await promiseSettled(closed, 2_000)) {
    throw new Error('adapter parent did not close after its process group exited');
  }
}

function assertRunning(adapters) {
  for (const adapter of adapters) {
    const failure = adapter.failure();
    if (failure !== undefined) {
      throw new Error(`adapter ${adapter.alias} ${failure}; diagnostics=${JSON.stringify(adapter.diagnostics())}`);
    }
  }
}

async function api(baseUrl, method, pathname, body, expectedStatus = 200) {
  const response = await fetch(new URL(pathname, baseUrl), {
    method,
    headers: {
      accept: 'application/json',
      'x-cauce-tenant': 'Steven',
      'x-cauce-alias': 'kant',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(8_000),
  });
  const data = response.status === 204 ? undefined : await response.json();
  assert.equal(response.status, expectedStatus, `${method} ${pathname} returned ${String(response.status)}`);
  return data;
}

async function waitFor(operation, adapters, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    assertRunning(adapters);
    try {
      const value = await operation();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  assertRunning(adapters);
  throw lastError ?? new Error(`adapter round-trip timed out after ${String(timeoutMs)}ms`);
}

function finalReply(relay) {
  return relay?.payload?.result?.output?.reply;
}

export async function runAdapterRoundTrip({ baseUrl, wsBaseUrl, timeoutMs = 30_000 }) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const marker = `CAUCE_ADAPTER_ROUNDTRIP_V1:${nonce}`;
  const expectedReply = `CAUCE_ADAPTER_ROUNDTRIP_FINAL:${nonce}`;
  const root = await mkdtemp(path.join(os.tmpdir(), 'cauce-adapter-roundtrip-'));
  const entrypoints = {
    opencode: path.join(repositoryRoot, 'packages', 'adapter-sdk', 'dist', 'src', 'bin', 'opencode.js'),
    reviewer: path.join(repositoryRoot, 'packages', 'adapter-sdk', 'dist', 'src', 'bin', 'fake.js'),
  };
  const adapters = [];
  let outcome;
  let executionError;
  try {
    await Promise.all([
      access(entrypoints.opencode, fsConstants.R_OK),
      access(entrypoints.reviewer, fsConstants.R_OK),
      access(fixture, fsConstants.X_OK),
    ]);
    await Promise.all(Object.values(roundTripAliases).map(async (alias) => {
      await mkdir(path.join(root, alias, 'home'), { recursive: true, mode: 0o700 });
      await mkdir(path.join(root, alias, 'state'), { recursive: true, mode: 0o700 });
    }));
    adapters.push(
      startAdapter({ alias: roundTripAliases.opencode, entrypoint: entrypoints.opencode, root, wsBaseUrl }),
      startAdapter({ alias: roundTripAliases.reviewer, entrypoint: entrypoints.reviewer, root, wsBaseUrl }),
    );
    await waitFor(async () => {
      const status = await api(baseUrl, 'GET', '/v3/status');
      return Object.values(roundTripAliases).every((alias) => status.presence.some((row) => (
        row.tenant_id === 'Steven' && row.alias === alias && row.online === true
      )));
    }, adapters, timeoutMs);

    const published = await api(baseUrl, 'POST', '/v3/messages', {
      room_id: 'grp.steven',
      recipients: [{ tenant_id: 'Steven', alias: roundTripAliases.opencode }],
      body: { text: marker },
      idempotency_key: `qa-adapter-roundtrip-${nonce}`,
      lane: 'interactive',
      priority: 10,
    }, 202);

    const relay = await waitFor(async () => {
      const page = await api(baseUrl, 'GET', '/v3/console/origin-relays');
      const matching = page.items.filter((item) => JSON.stringify(item.payload).includes(nonce));
      assert.ok(matching.length <= 1, 'round-trip produced more than one nonce-correlated origin relay');
      return matching.length === 1 && finalReply(matching[0]) === expectedReply ? matching[0] : undefined;
    }, adapters, timeoutMs);
    assert.equal(relay.adapter, 'dev-auth');
    assert.equal(relay.origin.channel, 'dev');
    assert.equal(relay.trace_id, published.trace_id);
    assert.notEqual(relay.request_id, published.request_id);
    assert.notEqual(relay.message_id, published.message_id);
    assert.notEqual(relay.delivery_id, published.delivery_ids[0]);
    assert.deepEqual(relay.payload.correlation, {
      request_id: relay.request_id,
      message_id: relay.message_id,
      delivery_id: relay.delivery_id,
      trace_id: relay.trace_id,
      root_message_id: published.message_id,
    });
    assert.equal(relay.payload.outcome, 'done');
    assert.equal(finalReply(relay), expectedReply);
    const chain = await api(baseUrl, 'GET', `/v3/console/chains/${encodeURIComponent(published.trace_id)}`);
    assert.equal(chain.trace_id, published.trace_id);
    assert.equal(chain.edges.length, 1);
    const [review] = chain.edges;
    assert.equal(review.source.alias, roundTripAliases.opencode);
    assert.equal(review.source.status, 'done');
    assert.equal(review.target.alias, roundTripAliases.reviewer);
    assert.equal(review.target.status, 'done');
    assert.equal(review.state, 'materialized');
    assert.equal(review.open, false);
    assert.equal(review.response.decision, 'allow');
    assert.equal(review.response.outcome, 'done');
    assert.equal(chain.counters.open_branches, 0);
    assert.equal(chain.counters.rejected_branches, 0);
    outcome = { evidenceClass: 'adapter-process-roundtrip', adapters: ['opencode', 'fake'], originRelays: 1 };
  } catch (error) {
    const diagnostics = adapters.map((adapter) => adapter.diagnostics());
    const reason = error instanceof Error ? sanitizeText(error.message) : sanitizeText(error);
    executionError = new Error(`adapter process round-trip failed; reason=${reason}; diagnostics=${JSON.stringify(diagnostics)}`, { cause: error });
  }
  const cleanup = await Promise.allSettled(adapters.map(stopAdapter));
  const cleanupErrors = cleanup
    .filter((result) => result.status === 'rejected')
    .map((result) => result.reason);
  try {
    await rm(root, { recursive: true, force: true });
  } catch (error) {
    cleanupErrors.push(new Error('adapter temporary directory cleanup failed', { cause: error }));
  }
  if (executionError !== undefined && cleanupErrors.length > 0) {
    throw new AggregateError([executionError, ...cleanupErrors], executionError.message, { cause: executionError });
  }
  if (executionError !== undefined) throw executionError;
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'adapter process cleanup failed');
  assert.ok(outcome !== undefined, 'adapter process round-trip produced no outcome');
  return outcome;
}
