#!/usr/bin/env node
//
// Fake pty-agent: speaks the agent leg of the PTY wire contract v1 against a real
// terminal-relay, without kratos, without containers and without a real PTY.
//
// The production agent is Python 3 stdlib running inside the target container on kratos;
// this one runs anywhere, verifies tickets with the same rules, and emulates a trivial
// shell (echoes STDIN, answers `pong-<n>` to the line `ping`). It exists so the relay can
// be exercised end to end from a laptop or from CI.
//
//   RELAY_HOST=127.0.0.1 RELAY_PORT=8600 ALIAS_KEY_HEX=<64 hex> \
//   TENANT=Steven ALIAS=jarvis node tests/terminal-pty/fake-pty-agent.mjs
//
// Exit codes (kept identical to the real agent): 0 clean, 2 bad configuration,
// 3 HELLO rejected by the relay, 4 protocol error, 5 transport failure, 78 refuses to run
// as root. Never prints a ticket or a key: only names, lengths and truncated hashes.

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { connect } from 'node:tls';
import { pathToFileURL } from 'node:url';

import { GOVERNANCE_FEATURES, createGovernanceSandbox } from './governance-double.mjs';
import {
  FrameDecoder, GEOMETRY_CLAMP, MAX_FRAME_PAYLOAD, SESSION_ID_BYTES, TAG, TAG_NAME,
  decodeDataPayload, decodeJsonPayload, encodeDataFrame, encodeFrame, encodeJsonFrame,
  verifyTicket,
} from './protocol.mjs';

export { GOVERNANCE, GOVERNANCE_FEATURES, createGovernanceSandbox } from './governance-double.mjs';

export const EXIT = {
  ok: 0,
  bad_config: 2,
  hello_rejected: 3,
  protocol_error: 4,
  transport_error: 5,
  refuses_root: 78,
};

const AGENT_VERSION = 'fake-pty-agent/1.0.0';
const MAX_DATA_BYTES = MAX_FRAME_PAYLOAD - SESSION_ID_BYTES;
const REFUSAL_REASONS = ['governance_write_in_flight', 'pane_input_barrier', 'tmux_prefix'];

/** Tickets and keys never reach a log line; this is what goes instead. */
function fingerprint(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}

/**
 * Connects to the relay and serves the agent leg until the socket dies or `close()` is
 * called. Resolves once HELLO_ACK arrives so tests can await a registered agent.
 */
export function startFakeAgent(options) {
  const config = normalise(options);
  const events = [];
  const emit = (event, fields = {}) => {
    const entry = { at: new Date().toISOString(), event, alias: config.alias, ...fields };
    events.push(entry);
    if (config.log) process.stderr.write(`${JSON.stringify(entry)}\n`);
    if (config.on_event) config.on_event(entry);
  };

  const euid = config.simulate_euid ?? (typeof process.geteuid === 'function' ? process.geteuid() : 1000);
  if (euid === 0) {
    // Criterion: the PTY never runs as root. The agent refuses before touching the network.
    emit('refuses_root', { euid });
    const error = new Error('fake-pty-agent refuses to run as root (euid 0)');
    error.exit_code = EXIT.refuses_root;
    const rejected = Promise.reject(error);
    rejected.catch(() => undefined);
    return {
      failed: true, exit_code: EXIT.refuses_root, error, events, sessions: 0,
      ready: rejected, closed: Promise.resolve(EXIT.refuses_root),
      close: () => undefined, destroy: () => undefined,
    };
  }

  const decoder = new FrameDecoder();
  const sessions = new Map();
  let sandbox = null;
  let exitCode = EXIT.ok;
  let settledReady = false;
  let resolveReady;
  let rejectReady;
  let resolveClosed;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const closed = new Promise((resolve) => { resolveClosed = resolve; });
  ready.catch(() => undefined);

  const socket = connect({
    host: config.host,
    port: config.port,
    ...(config.cert ? { cert: config.cert } : {}),
    ...(config.key ? { key: config.key } : {}),
    ...(config.ca ? { ca: config.ca } : {}),
    servername: config.servername,
    rejectUnauthorized: config.reject_unauthorized,
  });
  socket.setNoDelay(true);

  const send = (frame) => {
    if (!socket.destroyed) socket.write(frame);
  };

  const fail = (code, reason, fields = {}) => {
    exitCode = code;
    emit('agent_abort', { reason, ...fields });
    if (!settledReady) { settledReady = true; rejectReady(new Error(reason)); }
    socket.destroy();
  };

  socket.on('secureConnect', () => {
    emit('connected', { host: config.host, port: config.port, authorized: socket.authorized });
    send(encodeJsonFrame(TAG.AGENT_HELLO, {
      v: 1,
      tenant_id: config.tenant,
      alias: config.alias,
      container_id: config.container_id,
      generation: config.generation,
      image_id: config.image_id,
      runtime_user: config.runtime_user,
      runtime_uid: config.runtime_uid,
      harness: 'fake-pty-agent',
      agent_version: AGENT_VERSION,
      modes: config.modes,
      ...(config.governance ? { features: GOVERNANCE_FEATURES } : {}),
    }));
  });

  socket.on('data', (chunk) => {
    let frames;
    try {
      frames = decoder.push(chunk);
    } catch (error) {
      fail(EXIT.protocol_error, error.code ?? 'frame_error');
      return;
    }
    for (const frame of frames) {
      try {
        handleFrame(frame);
      } catch (error) {
        fail(EXIT.protocol_error, error.code ?? 'handler_error', { detail: error.message });
        return;
      }
      if (socket.destroyed) return;
    }
  });

  socket.on('error', (error) => {
    if (exitCode === EXIT.ok) exitCode = EXIT.transport_error;
    emit('transport_error', { message: error.message });
    if (!settledReady) { settledReady = true; rejectReady(error); }
  });

  socket.on('close', () => {
    if (sandbox !== null) {
      sandbox.dispose();
      sandbox = null;
    }
    emit('disconnected', { sessions: sessions.size, exit_code: exitCode });
    if (!settledReady) { settledReady = true; rejectReady(new Error('closed before HELLO_ACK')); }
    resolveClosed(exitCode);
  });

  function handleFrame(frame) {
    switch (frame.tag) {
      case TAG.HELLO_ACK: return onHelloAck(frame);
      case TAG.PING: return onPing();
      case TAG.OPEN: return onOpen(frame);
      case TAG.STDIN: return onStdin(frame);
      case TAG.RESIZE: return onResize(frame);
      case TAG.CLOSE: return onClose(frame);
      case TAG.READ:
      case TAG.WRITE:
      case TAG.WRITE_CANCEL:
      case TAG.WRITE_BATCH:
      case TAG.WRITE_BATCH_CANCEL:
      case TAG.WRITE_DATA:
      case TAG.WRITE_BATCH_DATA:
        if (!config.governance) break;
        return onGovernance(frame);
      default:
        break;
    }
    // Anything else on this leg — including tags only the agent may send — is a
    // protocol error. Forward compatibility is bought with a version bump, not silence.
    fail(EXIT.protocol_error, 'unexpected_tag', { tag: TAG_NAME[frame.tag] ?? frame.tag });
    return undefined;
  }

  function governance() {
    if (sandbox === null) sandbox = createGovernanceSandbox({ harness: config.governance_harness });
    return sandbox;
  }

  function onGovernance(frame) {
    const store = governance();
    let outputs;
    if (frame.tag === TAG.WRITE_DATA || frame.tag === TAG.WRITE_BATCH_DATA) {
      const { session_id: requestId, data } = decodeDataPayload(frame.payload);
      outputs = frame.tag === TAG.WRITE_DATA
        ? store.writeData(requestId, data)
        : store.writeBatchData(requestId, data);
    } else {
      const body = decodeJsonPayload(frame.payload);
      if (frame.tag === TAG.READ) outputs = store.read(body);
      else if (frame.tag === TAG.WRITE) outputs = store.write(body);
      else if (frame.tag === TAG.WRITE_CANCEL) outputs = store.writeCancel(String(body.request_id));
      else if (frame.tag === TAG.WRITE_BATCH) outputs = store.writeBatch(body);
      else outputs = store.writeBatchCancel(String(body.request_id));
    }
    for (const output of outputs) {
      send(output.json === undefined
        ? encodeDataFrame(output.tag, output.request_id, output.data)
        : encodeJsonFrame(output.tag, output.json));
      emit('governance_reply', { tag: TAG_NAME[output.tag] ?? output.tag });
    }
    return undefined;
  }

  function onHelloAck(frame) {
    const body = decodeJsonPayload(frame.payload);
    if (body.ok !== true) {
      emit('hello_rejected', { reason: body.reason ?? 'unknown' });
      exitCode = EXIT.hello_rejected;
      if (!settledReady) { settledReady = true; rejectReady(new Error(`hello rejected: ${String(body.reason)}`)); }
      socket.end();
      return;
    }
    emit('hello_ack');
    if (!settledReady) { settledReady = true; resolveReady({ alias: config.alias }); }
  }

  function onPing() {
    send(encodeFrame(TAG.PONG));
    emit('pong');
  }

  function onOpen(frame) {
    const body = decodeJsonPayload(frame.payload);
    const sessionId = typeof body.session_id === 'string' ? body.session_id : '';
    const deny = (reason) => {
      emit('open_denied', { session_id: sessionId, reason });
      send(encodeJsonFrame(TAG.OPEN_ERR, { session_id: sessionId, reason }));
    };
    if (sessionId === '') return deny('missing_session_id');
    if (sessions.has(sessionId)) return deny('session_conflict');

    const verdict = verifyTicket(config.alias_key, body.ticket, {
      now: config.now(),
      clock_skew_sec: config.clock_skew_sec,
      session_id: sessionId,
      tenant: config.tenant,
      alias: config.alias,
      container_id: config.container_id,
      generation: config.generation,
      modes: config.modes,
    });
    emit('ticket_checked', { session_id: sessionId, ticket_fp: fingerprint(body.ticket), ok: verdict.ok, reason: verdict.ok ? null : verdict.reason });
    if (!verdict.ok) return deny(verdict.reason);
    if (typeof body.mode === 'string' && body.mode !== verdict.payload.mode) return deny('mode_mismatch');
    // The signed target may say uid 0; the agent still refuses to hand out a root shell.
    if (verdict.payload.tgt.uid === 0) return deny('refuses_root');

    const session = {
      id: sessionId,
      mode: verdict.payload.mode,
      cols: typeof body.cols === 'number' ? body.cols : 80,
      rows: typeof body.rows === 'number' ? body.rows : 24,
      line: '',
      pongs: 0,
      expires_at: verdict.payload.exp,
    };
    sessions.set(sessionId, session);
    send(encodeJsonFrame(TAG.OPEN_OK, { session_id: sessionId, pid: process.pid }));
    emit('open_ok', { session_id: sessionId, mode: session.mode, cols: session.cols, rows: session.rows });
    if (config.geometry !== null) {
      send(encodeJsonFrame(TAG.GEOMETRY, { session_id: sessionId, cols: config.geometry.cols, rows: config.geometry.rows }));
      emit('geometry', { session_id: sessionId, cols: config.geometry.cols, rows: config.geometry.rows });
    }
    if (config.banner) {
      write(session, `${config.runtime_user}@${config.container_id}:~$ `);
    }
    return undefined;
  }

  function onStdin(frame) {
    const { session_id: sessionId, data } = decodeDataPayload(frame.payload);
    const session = sessions.get(sessionId);
    if (!session) {
      emit('stdin_for_unknown_session', { session_id: sessionId, bytes: data.length });
      return;
    }
    if (session.mode === 'readonly') {
      emit('stdin_dropped_readonly', { session_id: sessionId, bytes: data.length });
      return;
    }
    if (config.refuse_input_while !== null) {
      send(encodeJsonFrame(TAG.INPUT_REFUSED, { session_id: sessionId, reason: config.refuse_input_while }));
      emit('input_refused', { session_id: sessionId, reason: config.refuse_input_while, bytes: data.length });
      return;
    }
    // A real PTY echoes what it receives; so do we, byte for byte.
    if (data.length > 0) write(session, data);
    for (const byte of data) {
      if (byte === 0x03) { // Ctrl-C
        session.line = '';
        write(session, '^C\r\n');
        continue;
      }
      if (byte === 0x0d || byte === 0x0a) {
        const line = session.line;
        session.line = '';
        runLine(session, line);
        continue;
      }
      if (byte === 0x7f) { // backspace
        session.line = session.line.slice(0, -1);
        continue;
      }
      session.line += String.fromCharCode(byte);
    }
  }

  function runLine(session, line) {
    const command = line.trim();
    if (command === '') {
      write(session, '\r\n');
      return;
    }
    if (command === 'ping') {
      session.pongs += 1;
      write(session, `\r\npong-${session.pongs}\r\n`);
      return;
    }
    if (command === 'size') {
      write(session, `\r\nsize:${session.cols}x${session.rows}\r\n`);
      return;
    }
    if (command === 'id -un') {
      write(session, `\r\n${config.runtime_user}\r\n`);
      return;
    }
    if (command === 'hostname') {
      write(session, `\r\n${config.container_id}\r\n`);
      return;
    }
    if (command === 'flood') {
      // Deliberate output storm so the relay's flood guard (4413) can be observed.
      write(session, '\r\n');
      let remaining = config.flood_bytes;
      while (remaining > 0) {
        const chunk = Math.min(remaining, MAX_DATA_BYTES);
        write(session, Buffer.alloc(chunk, 0x2e));
        remaining -= chunk;
      }
      emit('flooded', { session_id: session.id, bytes: config.flood_bytes });
      return;
    }
    if (command === 'exit') {
      write(session, '\r\n');
      closeSession(session, 0, 'shell_exit');
      return;
    }
    write(session, `\r\nfake-shell: ${command}: not found\r\n`);
  }

  function onResize(frame) {
    const body = decodeJsonPayload(frame.payload);
    const session = sessions.get(String(body.session_id));
    if (!session) return;
    if (typeof body.cols === 'number') session.cols = body.cols;
    if (typeof body.rows === 'number') session.rows = body.rows;
    emit('resized', { session_id: session.id, cols: session.cols, rows: session.rows });
  }

  function onClose(frame) {
    const body = decodeJsonPayload(frame.payload);
    const session = sessions.get(String(body.session_id));
    if (!session) {
      send(encodeJsonFrame(TAG.CLOSED, { session_id: String(body.session_id), exit_code: null, signal: null, reason: 'unknown_session' }));
      return;
    }
    closeSession(session, 0, typeof body.reason === 'string' ? body.reason : 'relay_close');
  }

  function closeSession(session, exitCodeOfShell, reason) {
    sessions.delete(session.id);
    send(encodeJsonFrame(TAG.CLOSED, { session_id: session.id, exit_code: exitCodeOfShell, signal: null, reason }));
    emit('closed', { session_id: session.id, exit_code: exitCodeOfShell, reason });
    if (config.oneshot && sessions.size === 0) socket.end();
  }

  function write(session, data) {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    for (let offset = 0; offset < bytes.length; offset += MAX_DATA_BYTES) {
      send(encodeDataFrame(TAG.STDOUT, session.id, bytes.subarray(offset, offset + MAX_DATA_BYTES)));
    }
  }

  return {
    failed: false,
    events,
    ready,
    closed,
    get sessions() { return sessions.size; },
    get exit_code() { return exitCode; },
    get governance() { return sandbox; },
    close() { socket.end(); },
    destroy() { socket.destroy(); },
  };
}

function normalise(options) {
  const aliasKey = Buffer.isBuffer(options.alias_key) ? options.alias_key : Buffer.from(String(options.alias_key ?? ''), 'hex');
  if (aliasKey.length !== 32) {
    const error = new Error('alias key must be 32 bytes (64 hex chars)');
    error.exit_code = EXIT.bad_config;
    throw error;
  }
  const refusal = options.refuse_input_while ?? null;
  if (refusal !== null && !REFUSAL_REASONS.includes(refusal)) {
    const error = new Error(`refuse_input_while must be one of ${REFUSAL_REASONS.join(', ')}`);
    error.exit_code = EXIT.bad_config;
    throw error;
  }
  const geometry = checkedGeometry(options.geometry ?? null);
  return {
    host: options.host ?? '127.0.0.1',
    port: Number(options.port),
    cert: options.cert,
    key: options.key,
    ca: options.ca,
    servername: options.servername ?? 'localhost',
    reject_unauthorized: options.reject_unauthorized ?? true,
    tenant: options.tenant ?? 'Steven',
    alias: options.alias ?? 'jarvis',
    alias_key: aliasKey,
    container_id: options.container_id ?? 'claw',
    generation: options.generation ?? 'gen-1',
    image_id: options.image_id ?? 'sha256:deadbeef',
    runtime_user: options.runtime_user ?? 'claw',
    runtime_uid: options.runtime_uid ?? 1000,
    modes: options.modes ?? ['shell', 'readonly'],
    refuse_input_while: refusal,
    geometry,
    governance: options.governance ?? false,
    governance_harness: options.governance_harness ?? 'claude',
    banner: options.banner ?? false,
    oneshot: options.oneshot ?? false,
    flood_bytes: options.flood_bytes ?? 4 * 1024 * 1024,
    clock_skew_sec: options.clock_skew_sec ?? 2,
    simulate_euid: options.simulate_euid,
    now: options.now ?? (() => Math.floor(Date.now() / 1000)),
    log: options.log ?? false,
    on_event: options.on_event,
  };
}

function checkedGeometry(value) {
  if (value === null) return null;
  const within = (side, low, high) => Number.isInteger(side) && side >= low && side <= high;
  const cols = value.cols;
  const rows = value.rows;
  if (!within(cols, GEOMETRY_CLAMP.min_cols, GEOMETRY_CLAMP.max_cols)
    || !within(rows, GEOMETRY_CLAMP.min_rows, GEOMETRY_CLAMP.max_rows)) {
    const error = new Error(
      `geometry must be whole cols in [${GEOMETRY_CLAMP.min_cols}, ${GEOMETRY_CLAMP.max_cols}] `
      + `and rows in [${GEOMETRY_CLAMP.min_rows}, ${GEOMETRY_CLAMP.max_rows}], got ${JSON.stringify(value)}`,
    );
    error.exit_code = EXIT.bad_config;
    throw error;
  }
  return { cols, rows };
}

function geometryOf(value) {
  const [cols, rows] = String(value).split('x');
  return { cols: Number(cols), rows: Number(rows) };
}

export function fromEnvironment() {
  const environment = process.env;
  const port = Number(environment.RELAY_PORT);
  if (!Number.isInteger(port) || port <= 0) {
    process.stderr.write('RELAY_PORT is required\n');
    process.exit(EXIT.bad_config);
  }
  const readIfSet = (name) => (environment[name] ? readFileSync(environment[name]) : undefined);
  const options = {
    host: environment.RELAY_HOST ?? '127.0.0.1',
    port,
    cert: readIfSet('AGENT_CERT'),
    key: readIfSet('AGENT_KEY'),
    ca: readIfSet('AGENT_CA'),
    servername: environment.RELAY_SERVERNAME ?? 'localhost',
    reject_unauthorized: environment.AGENT_TLS_INSECURE !== '1',
    tenant: environment.TENANT ?? 'Steven',
    alias: environment.ALIAS ?? 'jarvis',
    alias_key: environment.ALIAS_KEY_HEX ?? '',
    container_id: environment.CONTAINER_ID ?? 'claw',
    generation: environment.GENERATION ?? 'gen-1',
    image_id: environment.IMAGE_ID ?? 'sha256:deadbeef',
    runtime_user: environment.RUNTIME_USER ?? 'claw',
    runtime_uid: Number(environment.RUNTIME_UID ?? 1000),
    modes: (environment.AGENT_MODES ?? 'shell,readonly').split(',').filter(Boolean),
    refuse_input_while: environment.AGENT_REFUSE_INPUT ?? null,
    geometry: environment.AGENT_GEOMETRY === undefined ? null : geometryOf(environment.AGENT_GEOMETRY),
    governance: environment.AGENT_GOVERNANCE === '1',
    governance_harness: environment.AGENT_GOVERNANCE_HARNESS ?? 'claude',
    banner: environment.AGENT_BANNER === '1',
    oneshot: environment.AGENT_ONESHOT === '1',
    flood_bytes: Number(environment.AGENT_FLOOD_BYTES ?? 4 * 1024 * 1024),
    log: environment.AGENT_QUIET !== '1',
  };
  if (environment.AGENT_SIMULATE_EUID !== undefined) options.simulate_euid = Number(environment.AGENT_SIMULATE_EUID);
  return options;
}

async function main() {
  let agent;
  try {
    agent = startFakeAgent(fromEnvironment());
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(error.exit_code ?? EXIT.bad_config);
  }
  if (agent.failed) {
    process.stderr.write('refusing to run as root (euid 0)\n');
    process.exit(agent.exit_code);
  }
  process.on('SIGINT', () => agent.close());
  process.on('SIGTERM', () => agent.close());
  const code = await agent.closed;
  process.exit(code);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
