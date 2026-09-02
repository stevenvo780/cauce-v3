// Reference implementation of the Cauce V3 PTY wire contract v1 (frozen).
//
// Three teams implement this contract separately: the gateway (TypeScript, mints
// tickets), the terminal-relay (TypeScript, multiplexes bytes) and the pty-agent
// (Python 3 stdlib, opens the PTY inside a container on another host). This module
// is the neutral third implementation the interop harness measures them against;
// it has no dependency on any of the three, only on Node built-ins.
//
// Framing relay <-> pty-agent (raw TLS socket, the agent dials the relay):
//   [tag:1][length:4 big-endian uint32][payload], length <= 65536
// DATA payloads (STDIN/STDOUT) are 36 ASCII bytes of session_id followed by raw bytes.
// Every other payload is either empty (PING/PONG) or UTF-8 JSON.

import { createHmac, hkdfSync, randomUUID, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';

export const WIRE_VERSION = 1;
export const MAX_FRAME_PAYLOAD = 65_536;
export const SESSION_ID_BYTES = 36;
export const FRAME_HEADER_BYTES = 5;
export const TICKET_HKDF_SALT = 'cauce-v3/pty-ticket/v1';
export const TICKET_PREFIX = 'v1';

export const TAG = {
  AGENT_HELLO: 0x01,
  HELLO_ACK: 0x02,
  OPEN: 0x10,
  OPEN_OK: 0x11,
  OPEN_ERR: 0x12,
  STDIN: 0x20,
  STDOUT: 0x21,
  RESIZE: 0x22,
  CLOSE: 0x30,
  CLOSED: 0x31,
  PING: 0x40,
  PONG: 0x41,
  READ: 0x50,
  READ_OK: 0x51,
  READ_ERR: 0x52,
  READ_DATA: 0x53,
  WRITE: 0x54,
  WRITE_DATA: 0x55,
  WRITE_OK: 0x56,
  WRITE_ERR: 0x57,
  WRITE_CANCEL: 0x58,
  WRITE_BATCH: 0x59,
  WRITE_BATCH_DATA: 0x5a,
  WRITE_BATCH_OK: 0x5b,
  WRITE_BATCH_ERR: 0x5c,
  WRITE_BATCH_CANCEL: 0x5d,
  READ_DONE: 0x5e,
};

export const TAG_NAME = Object.fromEntries(Object.entries(TAG).map(([name, tag]) => [tag, name]));

/** Payloads carrying opaque bytes prefixed by the session id. */
export const DATA_TAGS = new Set([TAG.STDIN, TAG.STDOUT]);
/** Payloads that must be empty on the wire. */
export const EMPTY_TAGS = new Set([TAG.PING, TAG.PONG]);
export const PREFIXED_TAGS = new Set([
  ...DATA_TAGS, TAG.READ_DATA, TAG.WRITE_DATA, TAG.WRITE_BATCH_DATA,
]);
/** Payloads carrying UTF-8 JSON. */
export const JSON_TAGS = new Set([
  TAG.AGENT_HELLO, TAG.HELLO_ACK, TAG.OPEN, TAG.OPEN_OK, TAG.OPEN_ERR,
  TAG.RESIZE, TAG.CLOSE, TAG.CLOSED,
  TAG.READ, TAG.READ_OK, TAG.READ_ERR, TAG.READ_DONE,
  TAG.WRITE, TAG.WRITE_OK, TAG.WRITE_ERR, TAG.WRITE_CANCEL,
  TAG.WRITE_BATCH, TAG.WRITE_BATCH_OK, TAG.WRITE_BATCH_ERR, TAG.WRITE_BATCH_CANCEL,
]);

/** WebSocket close codes browser <-> relay. */
export const CLOSE_CODE = {
  protocol_error: 4400,
  ticket_invalid: 4401,
  revoked: 4403,
  agent_offline: 4404,
  idle_timeout: 4408,
  session_conflict: 4409,
  output_flood: 4413,
  ttl_expired: 4423,
  internal_error: 1011,
};

/** Ticket payload key order is part of the contract: the JSON is signed verbatim. */
export const TICKET_PAYLOAD_KEYS = ['v', 'sid', 'op', 'sub', 'tgt', 'mode', 'iat', 'exp'];
export const TICKET_TARGET_KEYS = ['tenant', 'alias', 'container', 'generation', 'image', 'uid', 'user'];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;

export class FrameError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = 'FrameError';
    this.code = code;
  }
}

export class TicketError extends Error {
  constructor(reason, message) {
    super(message ?? reason);
    this.name = 'TicketError';
    this.reason = reason;
  }
}

export function b64urlEncode(bytes) {
  return Buffer.from(bytes).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function b64urlDecode(text) {
  if (typeof text !== 'string' || text.length === 0 || !B64URL_RE.test(text)) {
    throw new TicketError('bad_b64', 'base64url segment is empty, padded or out of alphabet');
  }
  const padded = text.replaceAll('-', '+').replaceAll('_', '/');
  return Buffer.from(padded, 'base64');
}

/**
 * k_alias = HKDF-SHA256(IKM=master32, salt='cauce-v3/pty-ticket/v1', info='pty:<tenant>:<alias>', L=32)
 */
export function deriveAliasKey(master, tenant, alias) {
  const ikm = Buffer.isBuffer(master) ? master : Buffer.from(master, 'base64');
  if (ikm.length !== 32) throw new TicketError('bad_master_key', `master key must be 32 bytes, got ${ikm.length}`);
  const info = Buffer.from(`pty:${tenant}:${alias}`, 'utf8');
  return Buffer.from(hkdfSync('sha256', ikm, Buffer.from(TICKET_HKDF_SALT, 'utf8'), info, 32));
}

/** Serialises a ticket payload in the frozen key order; unknown keys are a loud failure. */
export function canonicalTicketPayload(payload) {
  const unknown = Object.keys(payload).filter((key) => !TICKET_PAYLOAD_KEYS.includes(key));
  if (unknown.length > 0) throw new TicketError('unknown_payload_key', `unknown ticket keys: ${unknown.join(',')}`);
  const parts = [];
  for (const key of TICKET_PAYLOAD_KEYS) {
    if (!(key in payload)) continue;
    const value = key === 'tgt' ? canonicalTarget(payload.tgt) : JSON.stringify(payload[key]);
    parts.push(`${JSON.stringify(key)}:${value}`);
  }
  return `{${parts.join(',')}}`;
}

function canonicalTarget(target) {
  const unknown = Object.keys(target).filter((key) => !TICKET_TARGET_KEYS.includes(key));
  if (unknown.length > 0) throw new TicketError('unknown_target_key', `unknown target keys: ${unknown.join(',')}`);
  const parts = [];
  for (const key of TICKET_TARGET_KEYS) {
    if (!(key in target)) continue;
    parts.push(`${JSON.stringify(key)}:${JSON.stringify(target[key])}`);
  }
  return `{${parts.join(',')}}`;
}

/** ticket = v1.<b64url(payload_json)>.<b64url(hmac_sha256(k_alias, ascii('v1.'+b64url_payload)))> */
export function mintTicket(aliasKey, payload) {
  const payloadJson = canonicalTicketPayload(payload);
  const signingInput = `${TICKET_PREFIX}.${b64urlEncode(Buffer.from(payloadJson, 'utf8'))}`;
  const mac = createHmac('sha256', aliasKey).update(Buffer.from(signingInput, 'ascii')).digest();
  return `${signingInput}.${b64urlEncode(mac)}`;
}

export function ticketPayload(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    v: 1,
    sid: overrides.sid ?? randomUUID(),
    op: overrides.op ?? 'unattributed:console-basic-auth',
    sub: overrides.sub ?? 'Steven:kant',
    tgt: {
      tenant: overrides.tenant ?? 'Steven',
      alias: overrides.alias ?? 'kant',
      container: overrides.container ?? 'claw-kant',
      generation: overrides.generation ?? 'a'.repeat(32),
      image: overrides.image ?? 'sha256:beef',
      uid: overrides.uid ?? 1000,
      user: overrides.user ?? 'claw',
    },
    mode: overrides.mode ?? 'shell',
    iat: overrides.iat ?? now - 1,
    exp: overrides.exp ?? now + 30,
  };
}

/**
 * Verifies a ticket exactly as the Python pty-agent must: signature first, then the
 * window, then the target bindings. Returns {ok, reason, payload} instead of throwing so
 * both legs can answer OPEN_ERR with the same reason string.
 */
export function verifyTicket(aliasKey, ticket, options = {}) {
  const skew = options.clock_skew_sec ?? 0;
  let payload;
  let signingInput;
  let mac;
  try {
    if (typeof ticket !== 'string') throw new TicketError('malformed', 'ticket is not a string');
    const parts = ticket.split('.');
    if (parts.length !== 3) throw new TicketError('malformed', 'ticket must have three dot-separated parts');
    const [prefix, payloadSegment, macSegment] = parts;
    if (prefix !== TICKET_PREFIX) throw new TicketError('unsupported_version', `unexpected prefix ${prefix}`);
    signingInput = `${prefix}.${payloadSegment}`;
    mac = b64urlDecode(macSegment);
    const payloadBytes = b64urlDecode(payloadSegment);
    try {
      payload = JSON.parse(payloadBytes.toString('utf8'));
    } catch {
      throw new TicketError('bad_json', 'ticket payload is not JSON');
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new TicketError('bad_json', 'ticket payload is not an object');
    }
    if (payload.v !== WIRE_VERSION) throw new TicketError('unsupported_version', `payload v=${String(payload.v)}`);
  } catch (error) {
    if (error instanceof TicketError) return { ok: false, reason: error.reason };
    throw error;
  }

  const expected = createHmac('sha256', aliasKey).update(Buffer.from(signingInput, 'ascii')).digest();
  if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) {
    return { ok: false, reason: 'bad_signature' };
  }

  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || typeof payload.iat !== 'number') {
    return { ok: false, reason: 'malformed', payload };
  }
  if (now > payload.exp + skew) return { ok: false, reason: 'ticket_expired', payload };
  if (now + skew < payload.iat) return { ok: false, reason: 'ticket_not_yet_valid', payload };

  const target = payload.tgt ?? {};
  if (options.session_id !== undefined && payload.sid !== options.session_id) {
    return { ok: false, reason: 'sid_mismatch', payload };
  }
  if (options.tenant !== undefined && target.tenant !== options.tenant) {
    return { ok: false, reason: 'tenant_mismatch', payload };
  }
  if (options.alias !== undefined && target.alias !== options.alias) {
    return { ok: false, reason: 'alias_mismatch', payload };
  }
  if (options.container_id !== undefined && target.container !== options.container_id) {
    return { ok: false, reason: 'container_mismatch', payload };
  }
  if (options.generation !== undefined && target.generation !== options.generation) {
    return { ok: false, reason: 'generation_mismatch', payload };
  }
  if (options.modes !== undefined && !options.modes.includes(payload.mode)) {
    return { ok: false, reason: 'mode_not_allowed', payload };
  }
  return { ok: true, payload };
}

/** A ticket that only failed on its window closes the socket as ttl_expired, not ticket_invalid. */
export function closeCodeForTicketReason(reason) {
  return reason === 'ticket_expired' ? CLOSE_CODE.ttl_expired : CLOSE_CODE.ticket_invalid;
}

export function encodeFrame(tag, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (!Number.isInteger(tag) || tag < 0 || tag > 0xff) throw new FrameError('bad_tag', `tag ${String(tag)} is not a byte`);
  if (body.length > MAX_FRAME_PAYLOAD) throw new FrameError('frame_too_large', `payload ${body.length} > ${MAX_FRAME_PAYLOAD}`);
  const frame = Buffer.allocUnsafe(FRAME_HEADER_BYTES + body.length);
  frame[0] = tag;
  frame.writeUInt32BE(body.length, 1);
  body.copy(frame, FRAME_HEADER_BYTES);
  return frame;
}

export function encodeJsonFrame(tag, value) {
  return encodeFrame(tag, Buffer.from(JSON.stringify(value), 'utf8'));
}

export function encodeDataFrame(tag, sessionId, data) {
  assertSessionId(sessionId);
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  return encodeFrame(tag, Buffer.concat([Buffer.from(sessionId, 'ascii'), bytes]));
}

export function decodeJsonPayload(payload) {
  try {
    const value = JSON.parse(payload.toString('utf8'));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new FrameError('bad_json_frame', 'json payload is not an object');
    }
    return value;
  } catch (error) {
    if (error instanceof FrameError) throw error;
    throw new FrameError('bad_json_frame', 'payload is not valid JSON');
  }
}

export function decodeDataPayload(payload) {
  if (payload.length < SESSION_ID_BYTES) throw new FrameError('bad_data_frame', `data payload shorter than ${SESSION_ID_BYTES} bytes`);
  const sessionId = payload.subarray(0, SESSION_ID_BYTES).toString('ascii');
  if (!UUID_RE.test(sessionId)) throw new FrameError('bad_session_id', 'data payload does not start with a lowercase uuid');
  return { session_id: sessionId, data: payload.subarray(SESSION_ID_BYTES) };
}

export function assertSessionId(sessionId) {
  if (typeof sessionId !== 'string' || !UUID_RE.test(sessionId)) {
    throw new FrameError('bad_session_id', 'session id must be a lowercase uuid with dashes');
  }
  return sessionId;
}

export function isKnownTag(tag) {
  return Object.prototype.hasOwnProperty.call(TAG_NAME, tag);
}

/**
 * Incremental frame decoder. TLS hands us arbitrary chunk boundaries, so every leg has to
 * survive a frame split byte by byte and several frames arriving in a single read.
 */
export class FrameDecoder {
  constructor(options = {}) {
    this.maxPayload = options.max_payload ?? MAX_FRAME_PAYLOAD;
    this.buffer = Buffer.alloc(0);
  }

  get pending() {
    return this.buffer.length;
  }

  push(chunk) {
    this.buffer = this.buffer.length === 0
      ? Buffer.from(chunk)
      : Buffer.concat([this.buffer, Buffer.from(chunk)]);
    const frames = [];
    for (;;) {
      if (this.buffer.length < FRAME_HEADER_BYTES) break;
      const tag = this.buffer[0];
      const length = this.buffer.readUInt32BE(1);
      if (length > this.maxPayload) {
        throw new FrameError('frame_too_large', `announced ${length} > ${this.maxPayload}`);
      }
      if (this.buffer.length < FRAME_HEADER_BYTES + length) break;
      const payload = Buffer.from(this.buffer.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + length));
      this.buffer = Buffer.from(this.buffer.subarray(FRAME_HEADER_BYTES + length));
      frames.push({ tag, payload, known: isKnownTag(tag) });
    }
    return frames;
  }
}

/** Decodes a complete buffer in one shot; throws if it does not hold exactly one frame. */
export function decodeSingleFrame(bytes) {
  const decoder = new FrameDecoder();
  const frames = decoder.push(bytes);
  if (frames.length !== 1) throw new FrameError('not_one_frame', `expected one frame, decoded ${frames.length}`);
  if (decoder.pending !== 0) throw new FrameError('trailing_bytes', `${decoder.pending} trailing bytes`);
  return frames[0];
}
