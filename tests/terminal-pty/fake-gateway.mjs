#!/usr/bin/env node
//
// Fake gateway: implements the four `/v3/terminal/relay/*` endpoints of the PTY contract
// with no database, no dispatcher and no bus, so the terminal-relay can be driven end to
// end from a test.
//
//   POST /v3/terminal/relay/agents                     agent registration
//   POST /v3/terminal/relay/sessions/:sid/consume      atomic single use: 200 then 409
//   GET  /v3/terminal/relay/sessions/:sid/authz        200 while live, 403 with a reason
//   POST /v3/terminal/relay/sessions/:sid/close        session teardown + audit row
//
// Every request needs `Authorization: Bearer <relay token>`. Two knobs exist to reproduce
// the nasty cases: `revoke_after_ms` flips authz to 403 revoked in flight (the relay must
// close the browser socket with 4403) and `down_after_ms` makes the gateway unreachable so
// the relay's fail-closed grace can be measured.
//
//   GATEWAY_PORT=0 RELAY_TOKEN=... MASTER_KEY_B64=... node tests/terminal-pty/fake-gateway.mjs

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import process from 'node:process';
import { setTimeout as setTimer, clearTimeout as clearTimer } from 'node:timers';
import { pathToFileURL } from 'node:url';

import { deriveAliasKey, verifyTicket } from './protocol.mjs';
import { createSelfSignedCert } from './certs.mjs';

const AGENTS_PATH = '/v3/terminal/relay/agents';
const SESSION_PATH = /^\/v3\/terminal\/relay\/sessions\/([^/]+)\/(consume|authz|close)$/;
const HARNESS_STATE_PATH = '/__harness/state';

function fingerprint(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}

/**
 * Starts the fake gateway and resolves once it is listening.
 * The returned handle exposes the levers a test needs: revoke(), setGrants(), goDown(),
 * the audit trail and the consume counters.
 */
export async function startFakeGateway(options = {}) {
  const master = Buffer.from(options.master_key_b64 ?? 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=', 'base64');
  const token = options.relay_token ?? 'harness-relay-token';
  const operatorTenant = options.operator_tenant ?? 'Steven';
  const clockSkewSec = options.clock_skew_sec ?? 2;
  /** How long the shell may live once the ticket is consumed; the ticket TTL is a separate, shorter clock. */
  const sessionTtlSec = options.session_ttl_sec ?? 3600;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));

  // grants.json semantics: a map of "<tenant>:<alias>" the operator is allowed to reach.
  // Emptying it must close the door for everyone without restarting anything.
  let grants = new Set(options.grants ?? ['Steven:jarvis', 'Steven:kant', 'Steven:argos', 'Steven:socrates']);
  let revoked = false;
  let down = false;
  const downMode = options.down_mode ?? 'reset';
  const agents = new Map();
  const sessions = new Map();
  const audit = [];
  const timers = [];

  const record = (event, fields) => {
    audit.push({ at: new Date().toISOString(), event, ...fields });
  };

  const tls = options.plaintext === true
    ? null
    : { key: options.tls_key, cert: options.tls_cert };
  if (tls && (!tls.key || !tls.cert)) {
    const generated = createSelfSignedCert();
    tls.key = generated.key;
    tls.cert = generated.cert;
    tls.ca = generated.cert;
    tls.cert_path = generated.cert_path;
  }

  const server = tls
    ? createHttpsServer({ key: tls.key, cert: tls.cert }, handle)
    : createHttpServer(handle);

  function handle(request, response) {
    if (down) {
      if (downMode === 'reset') { request.socket.destroy(); return; }
      if (downMode === 'timeout') return; // never answers: the relay must time out and fail closed
      reply(response, 503, { error: 'gateway_unavailable' });
      return;
    }
    void route(request, response).catch((error) => {
      reply(response, 500, { error: 'internal_error', detail: error.message });
    });
  }

  async function route(request, response) {
    const url = new URL(request.url ?? '/', 'http://gateway.invalid');
    if (request.headers.authorization !== `Bearer ${token}`) {
      record('auth.rejected', { path: url.pathname });
      reply(response, 401, { error: 'unauthorized' });
      return;
    }

    if (url.pathname === HARNESS_STATE_PATH && request.method === 'GET') {
      reply(response, 200, {
        agents: [...agents.values()],
        sessions: [...sessions.values()].map((session) => ({ ...session, ticket_fp: session.ticket_fp })),
        grants: [...grants],
        revoked,
        audit,
      });
      return;
    }

    if (url.pathname === AGENTS_PATH && request.method === 'POST') {
      const body = await readJson(request);
      const key = `${String(body.tenant_id)}:${String(body.alias)}`;
      if (revoked || !grants.has(key)) {
        record('agent.rejected', { alias: body.alias, reason: 'not_granted' });
        reply(response, 403, { ok: false, error: 'not_granted' });
        return;
      }
      const agent = {
        tenant_id: body.tenant_id, alias: body.alias, container_id: body.container_id,
        generation: body.generation, image_id: body.image_id, runtime_user: body.runtime_user,
        runtime_uid: body.runtime_uid, modes: body.modes, agent_version: body.agent_version,
        registered_at: new Date().toISOString(),
      };
      agents.set(key, agent);
      record('agent.registered', { alias: body.alias, container_id: body.container_id, image_id: body.image_id });
      reply(response, 200, { ok: true, agent_id: `agent:${key}`, registered_at: agent.registered_at });
      return;
    }

    const match = SESSION_PATH.exec(url.pathname);
    if (!match) {
      reply(response, 404, { error: 'not_found' });
      return;
    }
    const [, sessionId, action] = match;
    if (action === 'consume' && request.method === 'POST') return consume(sessionId, request, response);
    if (action === 'authz' && request.method === 'GET') return authz(sessionId, response);
    if (action === 'close' && request.method === 'POST') return close(sessionId, request, response);
    reply(response, 405, { error: 'method_not_allowed' });
    return undefined;
  }

  async function consume(sessionId, request, response) {
    const body = await readJson(request);
    const ticket = typeof body.ticket === 'string' ? body.ticket : '';
    const claimed = peekTarget(ticket);
    if (!claimed) {
      record('terminal.session.consume.denied', { session_id: sessionId, reason: 'malformed' });
      reply(response, 401, { ok: false, error: 'ticket_invalid', reason: 'malformed' });
      return;
    }
    const aliasKey = deriveAliasKey(master, claimed.tenant, claimed.alias);
    const verdict = verifyTicket(aliasKey, ticket, { now: now(), clock_skew_sec: clockSkewSec, session_id: sessionId });
    if (!verdict.ok) {
      record('terminal.session.consume.denied', { session_id: sessionId, reason: verdict.reason });
      reply(response, 401, { ok: false, error: 'ticket_invalid', reason: verdict.reason });
      return;
    }
    const payload = verdict.payload;
    const key = `${payload.tgt.tenant}:${payload.tgt.alias}`;
    // No per-person identity yet: an unattributed operator ticket may only reach its own tenant.
    if (payload.op.startsWith('unattributed:') && payload.tgt.tenant !== operatorTenant) {
      record('terminal.session.consume.denied', { session_id: sessionId, reason: 'attribution_required' });
      reply(response, 403, { ok: false, error: 'attribution_required' });
      return;
    }
    if (revoked || !grants.has(key)) {
      record('terminal.session.consume.denied', { session_id: sessionId, reason: 'revoked' });
      reply(response, 403, { ok: false, error: 'revoked' });
      return;
    }
    if (sessions.has(sessionId)) {
      // Single use is the whole point: a replayed ticket must never open a second shell.
      record('terminal.session.consume.replayed', { session_id: sessionId });
      reply(response, 409, { ok: false, error: 'ticket_already_consumed' });
      return;
    }
    const session = {
      session_id: sessionId,
      tenant_id: payload.tgt.tenant,
      alias: payload.tgt.alias,
      container_id: payload.tgt.container,
      generation: payload.tgt.generation,
      image_id: payload.tgt.image,
      runtime_user: payload.tgt.user,
      runtime_uid: payload.tgt.uid,
      mode: payload.mode,
      subject: payload.sub,
      operation: payload.op,
      expires_at: payload.exp,
      consumed_at: now(),
      ticket_fp: fingerprint(ticket),
      // Geometry belongs to the session the operator asked for; the real gateway stores it at
      // request time and hands it back at consume so the relay can size the PTY on OPEN.
      cols: Number.isInteger(body.cols) ? body.cols : 80,
      rows: Number.isInteger(body.rows) ? body.rows : 24,
      revoked_at: null,
      closed_at: null,
    };
    sessions.set(sessionId, session);
    record('terminal.session.request', { session_id: sessionId, alias: session.alias, decision: 'allow', reason: body.reason ?? null });
    record('terminal.session.consume', {
      session_id: sessionId, alias: session.alias, container_id: session.container_id,
      image_id: session.image_id, generation: session.generation, mode: session.mode,
      subject: session.subject, ticket_fp: session.ticket_fp,
    });
    if (options.revoke_after_ms !== undefined) {
      const timer = setTimer(() => { session.revoked_at = now(); }, options.revoke_after_ms);
      timer.unref?.();
      timers.push(timer);
    }
    // FLAT body, field for field as services/gateway/src/terminal/plugin.ts answers it. It used
    // to be nested under `session` with `container_id` and no cols/rows/operator_id, which the
    // relay's `parseSessionGrant` rejects wholesale: the grant was dropped and every attach died
    // with 1011 instead of opening a shell. `session` is still echoed alongside so the harness's
    // own gateway tests keep asserting the container identity they were written against.
    reply(response, 200, {
      ok: true,
      tenant_id: session.tenant_id,
      alias: session.alias,
      mode: session.mode,
      cols: session.cols,
      rows: session.rows,
      operator_id: session.operation,
      container: session.container_id,
      runtime_user: session.runtime_user,
      expires_at: new Date(session.expires_at * 1000).toISOString(),
      session_expires_at: new Date((session.expires_at + sessionTtlSec) * 1000).toISOString(),
      session: {
        session_id: sessionId, tenant_id: session.tenant_id, alias: session.alias,
        container_id: session.container_id, generation: session.generation,
        image_id: session.image_id, runtime_user: session.runtime_user,
        runtime_uid: session.runtime_uid, mode: session.mode, expires_at: session.expires_at,
      },
    });
  }

  function authz(sessionId, response) {
    const session = sessions.get(sessionId);
    if (!session) {
      reply(response, 403, { ok: false, reason: 'unknown_session' });
      return;
    }
    if (session.closed_at !== null) {
      reply(response, 403, { ok: false, reason: 'closed' });
      return;
    }
    if (now() > session.expires_at + clockSkewSec) {
      reply(response, 403, { ok: false, reason: 'ttl_expired' });
      return;
    }
    if (revoked || session.revoked_at !== null || !grants.has(`${session.tenant_id}:${session.alias}`)) {
      reply(response, 403, { ok: false, reason: 'revoked' });
      return;
    }
    reply(response, 200, { ok: true, expires_at: session.expires_at });
  }

  async function close(sessionId, request, response) {
    const body = await readJson(request);
    const session = sessions.get(sessionId);
    if (!session) {
      reply(response, 404, { ok: false, error: 'unknown_session' });
      return;
    }
    session.closed_at = now();
    record('terminal.session.close', {
      session_id: sessionId, alias: session.alias, container_id: session.container_id,
      image_id: session.image_id, generation: session.generation,
      reason: body.reason ?? 'unspecified', exit_code: body.exit_code ?? null,
    });
    reply(response, 200, { ok: true });
  }

  await new Promise((resolve) => { server.listen(options.port ?? 0, options.host ?? '127.0.0.1', resolve); });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : Number(options.port);
  const scheme = tls ? 'https' : 'http';

  if (options.down_after_ms !== undefined) {
    const timer = setTimer(() => { down = true; }, options.down_after_ms);
    timer.unref?.();
    timers.push(timer);
  }

  return {
    url: `${scheme}://127.0.0.1:${port}`,
    port,
    token,
    ca: tls?.ca,
    ca_path: tls?.cert_path,
    audit,
    get agents() { return [...agents.values()]; },
    get sessions() { return [...sessions.values()]; },
    session: (sessionId) => sessions.get(sessionId),
    setGrants(next) { grants = new Set(next); },
    revokeAll() { revoked = true; },
    restore() { revoked = false; down = false; },
    goDown() { down = true; },
    auditOf: (event) => audit.filter((entry) => entry.event === event),
    async close() {
      for (const timer of timers) clearTimer(timer);
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function reply(response, status, body) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': payload.length });
  response.end(payload);
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed !== null && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Reads the (still unverified) target out of a ticket so we know which alias key to derive. */
function peekTarget(ticket) {
  const parts = String(ticket).split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  try {
    const json = Buffer.from(parts[1].replaceAll('-', '+').replaceAll('_', '/'), 'base64').toString('utf8');
    const payload = JSON.parse(json);
    const target = payload?.tgt;
    if (!target || typeof target.tenant !== 'string' || typeof target.alias !== 'string') return null;
    return { tenant: target.tenant, alias: target.alias };
  } catch {
    return null;
  }
}

async function main() {
  const environment = process.env;
  const options = {
    port: Number(environment.GATEWAY_PORT ?? 0),
    relay_token: environment.RELAY_TOKEN ?? 'harness-relay-token',
    master_key_b64: environment.MASTER_KEY_B64,
    operator_tenant: environment.OPERATOR_TENANT ?? 'Steven',
    plaintext: environment.GATEWAY_PLAINTEXT === '1',
  };
  if (environment.GATEWAY_CERT && environment.GATEWAY_KEY) {
    options.tls_cert = readFileSync(environment.GATEWAY_CERT);
    options.tls_key = readFileSync(environment.GATEWAY_KEY);
  }
  if (environment.GRANTS) options.grants = environment.GRANTS.split(',').filter(Boolean);
  if (environment.REVOKE_AFTER_MS) options.revoke_after_ms = Number(environment.REVOKE_AFTER_MS);
  if (environment.DOWN_AFTER_MS) options.down_after_ms = Number(environment.DOWN_AFTER_MS);
  if (environment.DOWN_MODE) options.down_mode = environment.DOWN_MODE;

  const gateway = await startFakeGateway(options);
  // One machine-readable line so a supervising test can learn the ephemeral port.
  process.stdout.write(`${JSON.stringify({ ready: true, url: gateway.url, port: gateway.port, ca_path: gateway.ca_path ?? null })}\n`);
  const stop = () => { void gateway.close().then(() => process.exit(0)); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
