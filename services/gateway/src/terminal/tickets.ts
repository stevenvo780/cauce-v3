import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { isTerminalMode, type TerminalMode } from './types.js';

/**
 * PTY attach ticket. Frozen wire contract shared by three implementations: this gateway,
 * terminal-relay (TypeScript) and the pty-agent (Python). Golden vectors live in
 * terminal.tickets.test.ts and in tests/terminal-pty; do not change salt, info, key order
 * or the base64url alphabet without regenerating every implementation.
 *
 *   k_alias = HKDF-SHA256(ikm=master, salt='cauce-v3/pty-ticket/v1', info='pty:<tenant>:<alias>', L=32)
 *   ticket  = 'v1.' + b64url(payload) + '.' + b64url(HMAC-SHA256(k_alias, ascii('v1.' + b64url(payload))))
 *
 * Per-alias derivation is what makes a ticket useless against another agent: the pty-agent
 * inside the container only ever holds its own k_alias.
 */

export const TICKET_VERSION = 'v1';
export const TICKET_HKDF_SALT = 'cauce-v3/pty-ticket/v1';
export const RESUME_TOKEN_VERSION = 'r1';
export const RESUME_HKDF_SALT = 'cauce-v3/pty-resume/v1';

interface TicketTarget {
  readonly tenant: string;
  readonly alias: string;
  readonly container: string;
  readonly generation: string;
  readonly image: string;
  readonly uid: number;
  readonly user: string;
}

export interface TicketPayload {
  readonly v: 1;
  readonly sid: string;
  readonly op: string;
  readonly sub: string;
  readonly tgt: TicketTarget;
  readonly mode: TerminalMode;
  readonly iat: number;
  readonly exp: number;
}

type TicketFailure = 'malformed' | 'signature_invalid';

export class TicketError extends Error {
  constructor(readonly reason: TicketFailure, message: string) {
    super(message);
    this.name = 'TicketError';
  }
}

function base64url(value: Buffer): string {
  return value.toString('base64').replace(/=+$/, '').replaceAll('+', '-').replaceAll('/', '_');
}

function fromBase64url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new TicketError('malformed', 'ticket segment is not base64url');
  const decoded = Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/'), 'base64');
  if (base64url(decoded) !== value) {
    throw new TicketError('malformed', 'ticket segment is not canonical base64url');
  }
  return decoded;
}

function signatureFromBase64url(value: string, message: string): Buffer {
  try {
    return fromBase64url(value);
  } catch {
    // A non-canonical spelling that decodes to the same HMAC is still a different credential.
    // Classify every signature-segment failure uniformly so callers do not gain a parser oracle.
    throw new TicketError('signature_invalid', message);
  }
}

/** Per-alias key. The master secret never leaves the gateway process. */
export function deriveAliasKey(master: Buffer, tenantId: string, alias: string): Buffer {
  if (master.byteLength !== 32) throw new Error('terminal ticket master key must be 32 bytes');
  return Buffer.from(hkdfSync(
    'sha256',
    master,
    Buffer.from(TICKET_HKDF_SALT, 'utf8'),
    Buffer.from(`pty:${tenantId}:${alias}`, 'utf8'),
    32
  ));
}

/**
 * Canonical serialization. The key order below IS the contract: rebuilding the literal here
 * means a caller cannot break interoperability by assembling the payload in another order.
 */
function canonicalPayload(payload: TicketPayload): string {
  return JSON.stringify({
    v: 1,
    sid: payload.sid,
    op: payload.op,
    sub: payload.sub,
    tgt: {
      tenant: payload.tgt.tenant,
      alias: payload.tgt.alias,
      container: payload.tgt.container,
      generation: payload.tgt.generation,
      image: payload.tgt.image,
      uid: payload.tgt.uid,
      user: payload.tgt.user
    },
    mode: payload.mode,
    iat: payload.iat,
    exp: payload.exp
  });
}

export function issueTicket(payload: TicketPayload, key: Buffer): string {
  const encoded = base64url(Buffer.from(canonicalPayload(payload), 'utf8'));
  const signingInput = `${TICKET_VERSION}.${encoded}`;
  const signature = createHmac('sha256', key).update(Buffer.from(signingInput, 'ascii')).digest();
  return `${signingInput}.${base64url(signature)}`;
}

function decodePayload(value: Buffer): TicketPayload {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value.toString('utf8'));
  } catch {
    throw new TicketError('malformed', 'ticket payload is not JSON');
  }
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new TicketError('malformed', 'ticket payload is not an object');
  }
  const record = decoded as Record<string, unknown>;
  const target = record.tgt;
  if (record.v !== 1 || typeof record.sid !== 'string' || typeof record.op !== 'string' ||
      typeof record.sub !== 'string' || !isTerminalMode(record.mode) ||
      typeof record.iat !== 'number' || typeof record.exp !== 'number' ||
      target === null || typeof target !== 'object' || Array.isArray(target)) {
    throw new TicketError('malformed', 'ticket payload claims are invalid');
  }
  const tgt = target as Record<string, unknown>;
  if (typeof tgt.tenant !== 'string' || typeof tgt.alias !== 'string' || typeof tgt.container !== 'string' ||
      typeof tgt.generation !== 'string' || typeof tgt.image !== 'string' ||
      typeof tgt.uid !== 'number' || typeof tgt.user !== 'string') {
    throw new TicketError('malformed', 'ticket target claims are invalid');
  }
  return {
    v: 1,
    sid: record.sid,
    op: record.op,
    sub: record.sub,
    tgt: {
      tenant: tgt.tenant, alias: tgt.alias, container: tgt.container, generation: tgt.generation,
      image: tgt.image, uid: tgt.uid, user: tgt.user
    },
    mode: record.mode,
    iat: record.iat,
    exp: record.exp
  };
}

/** Verifies the immutable credential and decodes its claims without consulting a process clock. */
export function verifyTicketSignature(ticket: string, key: Buffer): TicketPayload {
  const parts = ticket.split('.');
  if (parts.length !== 3 || parts[0] !== TICKET_VERSION) {
    throw new TicketError('malformed', 'ticket is not a v1 ticket');
  }
  const [, encodedPayload, encodedSignature] = parts as [string, string, string];
  const signature = signatureFromBase64url(
    encodedSignature,
    'ticket signature does not verify for this alias key'
  );
  const expected = createHmac('sha256', key)
    .update(Buffer.from(`${TICKET_VERSION}.${encodedPayload}`, 'ascii')).digest();
  if (signature.byteLength !== expected.byteLength || !timingSafeEqual(signature, expected)) {
    throw new TicketError('signature_invalid', 'ticket signature does not verify for this alias key');
  }
  return decodePayload(fromBase64url(encodedPayload));
}

/** Full digest of the emitted ticket; only this is stored, never the ticket. */
export function ticketSha256(ticket: string): Buffer {
  return createHash('sha256').update(ticket, 'utf8').digest();
}

/** Truncated digest for logs and audit metadata. */
export function ticketDigest(ticket: string): string {
  return ticketSha256(ticket).toString('hex').slice(0, 16);
}

/**
 * Memory-only credential used after the one-shot OPEN ticket has been consumed.
 *
 * It is deliberately a different wire format and HKDF domain from the agent ticket: the
 * pty-agent must never see it, and possessing it cannot mint or open a new PTY.  The gateway
 * re-checks the live database authorization on every resume; the token only proves continuity
 * of this exact browser session while its original TTL is still alive.
 */
interface ResumeTokenPayload {
  readonly v: 1;
  readonly sid: string;
  readonly op: string;
  readonly iat: number;
  readonly exp: number;
  /** 128 random bits prevent two otherwise identical sessions producing the same credential. */
  readonly nonce: string;
}

function resumeKey(master: Buffer): Buffer {
  if (master.byteLength !== 32) throw new Error('terminal ticket master key must be 32 bytes');
  return Buffer.from(hkdfSync(
    'sha256', master, Buffer.from(RESUME_HKDF_SALT, 'utf8'), Buffer.from('resume-token', 'utf8'), 32
  ));
}

function canonicalResumePayload(payload: ResumeTokenPayload): string {
  return JSON.stringify({
    v: 1,
    sid: payload.sid,
    op: payload.op,
    iat: payload.iat,
    exp: payload.exp,
    nonce: payload.nonce
  });
}

export function issueResumeToken(
  sessionId: string,
  operatorId: string,
  expiresAtSeconds: number,
  master: Buffer,
  nowSeconds: number = Math.floor(Date.now() / 1_000)
): string {
  const payload: ResumeTokenPayload = {
    v: 1,
    sid: sessionId,
    op: operatorId,
    iat: nowSeconds,
    exp: expiresAtSeconds,
    nonce: randomBytes(16).toString('base64url')
  };
  const encoded = base64url(Buffer.from(canonicalResumePayload(payload), 'utf8'));
  const input = `${RESUME_TOKEN_VERSION}.${encoded}`;
  const signature = createHmac('sha256', resumeKey(master)).update(Buffer.from(input, 'ascii')).digest();
  return `${input}.${base64url(signature)}`;
}

/** Verifies a resume credential without assigning authority to the local wall clock. */
export function verifyResumeTokenSignature(token: string, master: Buffer): ResumeTokenPayload {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== RESUME_TOKEN_VERSION) {
    throw new TicketError('malformed', 'resume token is not an r1 token');
  }
  const [, encodedPayload, encodedSignature] = parts as [string, string, string];
  const signature = signatureFromBase64url(encodedSignature, 'resume token signature is invalid');
  const input = `${RESUME_TOKEN_VERSION}.${encodedPayload}`;
  const expected = createHmac('sha256', resumeKey(master)).update(Buffer.from(input, 'ascii')).digest();
  if (signature.byteLength !== expected.byteLength || !timingSafeEqual(signature, expected)) {
    throw new TicketError('signature_invalid', 'resume token signature is invalid');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(fromBase64url(encodedPayload).toString('utf8'));
  } catch {
    throw new TicketError('malformed', 'resume token payload is not JSON');
  }
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new TicketError('malformed', 'resume token payload is not an object');
  }
  const record = decoded as Record<string, unknown>;
  if (record.v !== 1 || typeof record.sid !== 'string' || typeof record.op !== 'string' ||
      typeof record.iat !== 'number' || !Number.isSafeInteger(record.iat) ||
      typeof record.exp !== 'number' || !Number.isSafeInteger(record.exp) ||
      typeof record.nonce !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(record.nonce)) {
    throw new TicketError('malformed', 'resume token claims are invalid');
  }
  return {
    v: 1,
    sid: record.sid,
    op: record.op,
    iat: record.iat,
    exp: record.exp,
    nonce: record.nonce
  };
}
