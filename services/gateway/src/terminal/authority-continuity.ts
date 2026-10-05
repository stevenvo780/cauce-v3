import { createHash, createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { AliasSchema, TenantSchema, isCanonicalUuidV4, isRfcUuid } from '@cauce/protocol';
import type { Principal } from '../auth.js';
import type { VerifiedConsoleSession } from '../password-auth.js';

export interface AuthorityActor { readonly tenantId: string; readonly alias: string }
interface OriginClock {
  readonly issuedAtSeconds: number; readonly expiresAtSeconds: number; readonly actor: AuthorityActor;
}
export interface HumanAuthorityOrigin extends OriginClock {
  readonly kind: 'human'; readonly humanId: string; readonly loginSid: string; readonly credentialStamp: string;
}
export interface MachineAuthorityOrigin extends OriginClock {
  readonly kind: 'machine'; readonly certificateSha256: string;
  readonly principalChannel: string; readonly principalSessionId: string;
}
export type TerminalAuthorityOrigin = HumanAuthorityOrigin | MachineAuthorityOrigin;
export interface VerifiedTerminalMachine {
  readonly authentication: 'mtls';
  readonly principal: Pick<Principal, 'tenant_id' | 'alias' | 'channel' | 'session_id'>;
  readonly certificateSha256: string; readonly issuedAtMs: number; readonly expiresAtMs: number;
}
export interface AuthorityContinuityPayload {
  readonly version: 2; readonly sessionId: string; readonly requestId: string;
  readonly semanticDigest: string; readonly origin: TerminalAuthorityOrigin;
}
export type TerminalSubjectIdentity =
  | { readonly kind: 'human'; readonly humanId: string; readonly actor: AuthorityActor }
  | { readonly kind: 'machine'; readonly certificateSha256: string;
    readonly principalChannel: string; readonly principalSessionId: string; readonly actor: AuthorityActor };

const DOMAIN = 'cauce-v3/terminal-authority-continuity/v2';
const KEY_INFO = 'gateway-only/authority-continuity';
const ADMISSION_DOMAIN = 'cauce-v3/terminal-admission-authority/v2';
export const TERMINAL_SUBJECT_MAX_BYTES = 2048;
export const AUTHORITY_CONTINUITY_MAX_BYTES = 4096;
const MAX_SECONDS = 8_640_000_000_000;
const HEX = /^[0-9a-f]{64}$/u;
const LOGIN_SID = /^[A-Za-z0-9_-]{16,128}$/u;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const VISIBLE_ASCII = /^[\u0021-\u007e]+$/u;

export class AuthorityContinuityError extends Error {
  constructor() { super('invalid terminal authority continuity'); this.name = 'AuthorityContinuityError'; }
}
function fail(): never { throw new AuthorityContinuityError(); }
function text(value: unknown, max: number, pattern: RegExp): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > max || !pattern.test(value)) fail();
  return value;
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || value !== value.toLowerCase() || !isRfcUuid(value)) fail();
  return value;
}
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail();
  const actual = Object.keys(value);
  if (actual.length !== keys.length || !keys.every((key) => Object.hasOwn(value, key))) fail();
  return value as Record<string, unknown>;
}
function actor(value: unknown): AuthorityActor {
  const row = exact(value, ['tenantId', 'alias']);
  const tenant = TenantSchema.safeParse(row.tenantId); const alias = AliasSchema.safeParse(row.alias);
  if (!tenant.success || !alias.success) fail();
  return Object.freeze({ tenantId: tenant.data, alias: alias.data });
}
function seconds(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > MAX_SECONDS) fail();
  return value;
}
function milliseconds(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_SECONDS * 1000) fail();
  return Math.floor(value / 1000);
}
function decoded(value: string): Buffer {
  if (!BASE64URL.test(value)) fail();
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value) fail();
  return bytes;
}
function stamp(value: unknown): string {
  const normalized = text(value, 43, BASE64URL);
  if (normalized.length !== 43 || decoded(normalized).length !== 32) fail();
  return normalized;
}
function normalizedOrigin(value: unknown): TerminalAuthorityOrigin {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail();
  const kind = (value as Record<string, unknown>).kind;
  const fields = ['kind', 'actor', 'issuedAtSeconds', 'expiresAtSeconds'];
  const row = exact(value, kind === 'human'
    ? [...fields, 'humanId', 'loginSid', 'credentialStamp']
    : [...fields, 'certificateSha256', 'principalChannel', 'principalSessionId']);
  const common = { actor: actor(row.actor), issuedAtSeconds: seconds(row.issuedAtSeconds),
    expiresAtSeconds: seconds(row.expiresAtSeconds) };
  if (common.expiresAtSeconds <= common.issuedAtSeconds) fail();
  if (kind === 'human') return Object.freeze({ kind, humanId: uuid(row.humanId),
    loginSid: text(row.loginSid, 128, LOGIN_SID), actor: common.actor,
    credentialStamp: stamp(row.credentialStamp), issuedAtSeconds: common.issuedAtSeconds,
    expiresAtSeconds: common.expiresAtSeconds });
  if (kind !== 'machine') fail();
  return Object.freeze({ kind, certificateSha256: text(row.certificateSha256, 64, HEX),
    principalChannel: text(row.principalChannel, 128, VISIBLE_ASCII),
    principalSessionId: text(row.principalSessionId, 256, VISIBLE_ASCII), actor: common.actor,
    issuedAtSeconds: common.issuedAtSeconds, expiresAtSeconds: common.expiresAtSeconds });
}
function normalizedPayload(value: unknown): AuthorityContinuityPayload {
  const row = exact(value, ['version', 'sessionId', 'requestId', 'semanticDigest', 'origin']);
  if (row.version !== 2 || !isCanonicalUuidV4(row.sessionId) || !isCanonicalUuidV4(row.requestId)) fail();
  return Object.freeze({ version: 2, sessionId: row.sessionId, requestId: row.requestId,
    semanticDigest: text(row.semanticDigest, 64, HEX), origin: normalizedOrigin(row.origin) });
}
function signingKey(master: Buffer): Buffer {
  if (master.length !== 32) fail();
  return Buffer.from(hkdfSync('sha256', master, Buffer.from(DOMAIN), Buffer.from(KEY_INFO), 32));
}
function parsed(bytes: Buffer): unknown {
  try { return JSON.parse(bytes.toString('utf8')) as unknown; } catch { return fail(); }
}

export function humanAuthorityOrigin(session: Readonly<VerifiedConsoleSession>): HumanAuthorityOrigin {
  const result = normalizedOrigin({ kind: 'human', humanId: session.humanId, loginSid: session.loginSid,
    actor: { tenantId: session.tenantId, alias: session.actorAlias }, credentialStamp: session.credentialStamp,
    issuedAtSeconds: milliseconds(session.issuedAtMs), expiresAtSeconds: milliseconds(session.expiresAtMs) });
  if (result.kind !== 'human') fail();
  return result;
}
export function machineAuthorityOrigin(verified: Readonly<VerifiedTerminalMachine>): MachineAuthorityOrigin {
  const input = exact(verified, ['authentication', 'principal', 'certificateSha256', 'issuedAtMs', 'expiresAtMs']);
  if (input.authentication !== 'mtls') fail();
  const result = normalizedOrigin({ kind: 'machine', certificateSha256: verified.certificateSha256,
    principalChannel: verified.principal.channel, principalSessionId: verified.principal.session_id,
    actor: { tenantId: verified.principal.tenant_id, alias: verified.principal.alias },
    issuedAtSeconds: milliseconds(verified.issuedAtMs), expiresAtSeconds: milliseconds(verified.expiresAtMs) });
  if (result.kind !== 'machine') fail();
  return result;
}
export function encodeTerminalSubject(origin: TerminalAuthorityOrigin): string {
  const row = normalizedOrigin(origin);
  const tuple = row.kind === 'human' ? [row.humanId, row.actor.tenantId, row.actor.alias]
    : [row.certificateSha256, row.principalChannel, row.principalSessionId, row.actor.tenantId, row.actor.alias];
  const subject = `${row.kind === 'human' ? 'h2' : 'm2'}.${Buffer.from(JSON.stringify(tuple)).toString('base64url')}`;
  if (subject.length > TERMINAL_SUBJECT_MAX_BYTES) fail();
  return subject;
}
export function decodeTerminalSubject(subject: string): TerminalSubjectIdentity {
  if (typeof subject !== 'string' || subject.length > TERMINAL_SUBJECT_MAX_BYTES) fail();
  const [version, encoded, extra] = subject.split('.');
  if ((version !== 'h2' && version !== 'm2') || !encoded || extra !== undefined) fail();
  const tuple: unknown = parsed(decoded(encoded));
  if (!Array.isArray(tuple) || tuple.length !== (version === 'h2' ? 3 : 5)
    || Buffer.from(JSON.stringify(tuple)).toString('base64url') !== encoded) fail();
  if (version === 'h2') return Object.freeze({ kind: 'human', humanId: uuid(tuple[0]),
    actor: actor({ tenantId: tuple[1] as unknown, alias: tuple[2] as unknown }) });
  return Object.freeze({ kind: 'machine', certificateSha256: text(tuple[0], 64, HEX),
    principalChannel: text(tuple[1], 128, VISIBLE_ASCII), principalSessionId: text(tuple[2], 256, VISIBLE_ASCII),
    actor: actor({ tenantId: tuple[3] as unknown, alias: tuple[4] as unknown }) });
}
export function authorityContinuityCommitment(payload: AuthorityContinuityPayload): Buffer {
  return createHash('sha256').update(`${ADMISSION_DOMAIN}\0${JSON.stringify(normalizedPayload(payload))}`, 'utf8').digest();
}
export function issueAuthorityContinuity(payload: AuthorityContinuityPayload, master: Buffer): string {
  const encoded = Buffer.from(JSON.stringify(normalizedPayload(payload))).toString('base64url');
  const input = `ac2.${encoded}`;
  const token = `${input}.${createHmac('sha256', signingKey(master)).update(input, 'ascii').digest('base64url')}`;
  if (token.length > AUTHORITY_CONTINUITY_MAX_BYTES) fail();
  return token;
}

// Signature proves origin continuity only; callers still lock and revalidate live authority and expiry.
export function verifyAuthorityContinuity(token: string, master: Buffer): AuthorityContinuityPayload {
  if (typeof token !== 'string' || token.length > AUTHORITY_CONTINUITY_MAX_BYTES) fail();
  const [version, encoded, signature, extra] = token.split('.');
  if (version !== 'ac2' || !encoded || !signature || extra !== undefined) fail();
  const bytes = decoded(encoded); const supplied = decoded(signature);
  const expected = createHmac('sha256', signingKey(master)).update(`ac2.${encoded}`, 'ascii').digest();
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) fail();
  const payload = normalizedPayload(parsed(bytes));
  if (JSON.stringify(payload) !== bytes.toString('utf8')) fail();
  return payload;
}
