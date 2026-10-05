import { createHmac, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AuthorityContinuityError, authorityContinuityCommitment, decodeTerminalSubject,
  encodeTerminalSubject, humanAuthorityOrigin, issueAuthorityContinuity,
  machineAuthorityOrigin, verifyAuthorityContinuity,
  type AuthorityContinuityPayload, type TerminalAuthorityOrigin,
} from './authority-continuity.js';
import { deriveAliasKey } from './tickets.js';

function origin(): TerminalAuthorityOrigin {
  return { kind: 'human', humanId: randomUUID(), loginSid: randomUUID(),
    actor: { tenantId: 'Steven', alias: 'kant' }, credentialStamp: randomBytes(32).toString('base64url'),
    issuedAtSeconds: 100, expiresAtSeconds: 200 };
}
function payload(): AuthorityContinuityPayload {
  return { version: 2, sessionId: randomUUID(), requestId: randomUUID(),
    semanticDigest: randomBytes(32).toString('hex'), origin: origin() };
}
function signRaw(value: unknown, master: Buffer, domain = 'cauce-v3/terminal-authority-continuity/v2'): string {
  const encoded = Buffer.from(JSON.stringify(value)).toString('base64url');
  const key = hkdfSync('sha256', master, Buffer.from(domain), Buffer.from('gateway-only/authority-continuity'), 32);
  const input = `ac2.${encoded}`;
  return `${input}.${createHmac('sha256', Buffer.from(key)).update(input, 'ascii').digest('base64url')}`;
}
function alternateEncoding(encoded: string): string {
  const decoded = Buffer.from(encoded, 'base64url');
  for (const char of 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_') {
    const candidate = encoded.slice(0, -1) + char;
    if (candidate !== encoded && Buffer.from(candidate, 'base64url').equals(decoded)) return candidate;
  }
  throw new Error('no alternate spelling');
}

describe('terminal authority continuity primitives', () => {
  it('derives human origin only from the verified DTO and rejects missing legacy stamp', () => {
    const humanId = randomUUID(); const loginSid = randomUUID();
    const credentialStamp = randomBytes(32).toString('base64url');
    expect(humanAuthorityOrigin({ humanId, loginSid, credentialStamp,
      tenantId: 'Steven', actorAlias: 'kant', issuedAtMs: 100_000, expiresAtMs: 200_000,
    })).toEqual({ kind: 'human', humanId, loginSid, credentialStamp,
      actor: { tenantId: 'Steven', alias: 'kant' }, issuedAtSeconds: 100, expiresAtSeconds: 200 });
    expect(() => humanAuthorityOrigin({ humanId, loginSid, tenantId: 'Steven', actorAlias: 'kant',
      issuedAtMs: 100_000, expiresAtMs: 200_000 })).toThrow(AuthorityContinuityError);
  });

  it('round-trips a bounded human WHO subject without embedding login credentials', () => {
    const human = origin();
    if (human.kind !== 'human') throw new Error('expected human');
    const subject = encodeTerminalSubject(human);
    expect(subject).toBe(`h2.${Buffer.from(JSON.stringify([human.humanId, 'Steven', 'kant'])).toString('base64url')}`);
    expect(decodeTerminalSubject(subject)).toEqual({ kind: 'human', humanId: human.humanId,
      actor: { tenantId: 'Steven', alias: 'kant' } });
    expect(subject).not.toContain(human.loginSid);
    expect(subject).not.toContain(human.credentialStamp);
    const other = { ...human, humanId: randomUUID() };
    expect(encodeTerminalSubject(other)).not.toBe(subject);
    expect(encodeTerminalSubject({ ...human, actor: { tenantId: 'Miguel', alias: 'kant' } })).not.toBe(subject);
  });

  it('requires explicit mTLS origin and keeps it disjoint from human identity', () => {
    const certificateSha256 = randomBytes(32).toString('hex');
    const principal = { tenant_id: 'Steven', alias: 'kant', channel: 'adapter', session_id: 'mtls:agent' };
    const machine = machineAuthorityOrigin({ authentication: 'mtls', principal,
      certificateSha256, issuedAtMs: 100_000, expiresAtMs: 200_000 });
    const subject = encodeTerminalSubject(machine);
    expect(decodeTerminalSubject(subject)).toEqual({ kind: 'machine', certificateSha256,
      principalChannel: 'adapter', principalSessionId: 'mtls:agent', actor: { tenantId: 'Steven', alias: 'kant' } });
    expect(subject).not.toBe(encodeTerminalSubject(origin()));
    expect(() => machineAuthorityOrigin({ authentication: 'password', principal,
      certificateSha256, issuedAtMs: 100_000, expiresAtMs: 200_000 } as unknown as Parameters<typeof machineAuthorityOrigin>[0]))
      .toThrow(AuthorityContinuityError);
    expect(() => decodeTerminalSubject(subject.replace(/^m2/u, 'h2'))).toThrow(AuthorityContinuityError);
  });

  it('rejects legacy, ambiguous, padded and non-canonical subjects', () => {
    const subject = encodeTerminalSubject(origin());
    for (const value of ['Steven:kant', 'h1.a', subject + '=', subject + '.x', 'h2.@@', 'h2.' + 'a'.repeat(2049)]) {
      expect(() => decodeTerminalSubject(value)).toThrow(AuthorityContinuityError);
    }
    const encoded = subject.split('.')[1];
    if (!encoded) throw new Error('invalid fixture');
    expect(() => decodeTerminalSubject(`h2.${alternateEncoding(encoded)}`)).toThrow(AuthorityContinuityError);
    const unknown = `h2.${Buffer.from(JSON.stringify([randomUUID(), 'Steven:kant', 'kant'])).toString('base64url')}`;
    expect(() => decodeTerminalSubject(unknown)).toThrow(AuthorityContinuityError);
  });

  it('signs deterministically, recovers exact origin and binds every immutable admission field', () => {
    const master = randomBytes(32); const data = payload();
    const token = issueAuthorityContinuity(data, master);
    expect(token).toBe(signRaw(data, master));
    expect(verifyAuthorityContinuity(token, master)).toEqual(data);
    const commitment = authorityContinuityCommitment(data);
    expect(commitment).toHaveLength(32);
    const human = data.origin;
    if (human.kind !== 'human') throw new Error('expected human');
    for (const changed of [
      { ...data, sessionId: randomUUID() }, { ...data, requestId: randomUUID() },
      { ...data, semanticDigest: randomBytes(32).toString('hex') },
      { ...data, origin: { ...human, humanId: randomUUID() } },
      { ...data, origin: { ...human, loginSid: randomUUID() } },
      { ...data, origin: { ...human, credentialStamp: randomBytes(32).toString('base64url') } },
      { ...data, origin: { ...human, actor: { tenantId: 'Miguel', alias: 'kant' } } },
      { ...data, origin: { ...human, expiresAtSeconds: 201 } },
    ]) expect(authorityContinuityCommitment(changed).equals(commitment)).toBe(false);
  });

  it('rejects another master, alias keys, wrong HKDF domain and signature tampering', () => {
    const master = randomBytes(32); const data = payload(); const token = issueAuthorityContinuity(data, master);
    expect(() => verifyAuthorityContinuity(token, randomBytes(32))).toThrow(AuthorityContinuityError);
    expect(() => verifyAuthorityContinuity(token, deriveAliasKey(master, 'Steven', 'kant'))).toThrow(AuthorityContinuityError);
    expect(() => verifyAuthorityContinuity(signRaw(data, master, 'cauce-v3/pty-ticket/v1'), master)).toThrow(AuthorityContinuityError);
    const [version, encoded, signature] = token.split('.');
    if (!version || !encoded || !signature) throw new Error('invalid fixture');
    const changed = Buffer.from(JSON.stringify({ ...data, sessionId: randomUUID() })).toString('base64url');
    expect(() => verifyAuthorityContinuity(`${version}.${changed}.${signature}`, master)).toThrow(AuthorityContinuityError);
    expect(() => verifyAuthorityContinuity(`${version}.${encoded}.${alternateEncoding(signature)}`, master)).toThrow(AuthorityContinuityError);
  });

  it('rejects signed extra fields, malformed origins and invalid temporal or identity bounds', () => {
    const master = randomBytes(32); const data = payload();
    for (const invalid of [
      { ...data, version: 1 }, { ...data, passwordHash: 'must-not-travel' },
      { ...data, origin: { ...data.origin, kind: 'password' } },
      { ...data, origin: { ...data.origin, credentialStamp: undefined } },
      { ...data, origin: { ...data.origin, expiresAtSeconds: 100 } },
      { ...data, origin: { ...data.origin, issuedAtSeconds: 1.5 } },
      { ...data, origin: { ...data.origin, loginSid: 'x'.repeat(129) } },
      { ...data, origin: { ...data.origin, actor: { tenantId: 'Steven', alias: 'kant', humanId: randomUUID() } } },
      { ...data, semanticDigest: 'x'.repeat(64) }, { ...data, sessionId: 'not-a-uuid' },
    ]) expect(() => verifyAuthorityContinuity(signRaw(invalid, master), master)).toThrow(AuthorityContinuityError);
    expect(() => issueAuthorityContinuity(data, randomBytes(31))).toThrow(AuthorityContinuityError);
    const reordered = { origin: data.origin, version: data.version, sessionId: data.sessionId,
      requestId: data.requestId, semanticDigest: data.semanticDigest };
    expect(() => verifyAuthorityContinuity(signRaw(reordered, master), master)).toThrow(AuthorityContinuityError);
  });

  it('accepts canonical maximum fields within its declared budget and refuses oversized wire tokens', () => {
    const data = payload(); const master = randomBytes(32); const human = data.origin;
    if (human.kind !== 'human') throw new Error('expected human');
    const maximal = { ...data, origin: { ...human, loginSid: 'x'.repeat(128),
      actor: { tenantId: 'S'.repeat(64), alias: 'k'.repeat(64) } } };
    const token = issueAuthorityContinuity(maximal, master);
    expect(verifyAuthorityContinuity(token, master)).toEqual(maximal);
    expect(token.length).toBeLessThanOrEqual(4096);
    const machine = machineAuthorityOrigin({ authentication: 'mtls', certificateSha256: randomBytes(32).toString('hex'),
      principal: { tenant_id: 'S'.repeat(64), alias: 'k'.repeat(64), channel: '"'.repeat(128), session_id: '"'.repeat(256) },
      issuedAtMs: 100_000, expiresAtMs: 200_000 });
    const machineToken = issueAuthorityContinuity({ ...data, origin: machine }, master);
    expect(verifyAuthorityContinuity(machineToken, master).origin).toEqual(machine);
    expect(machineToken.length).toBeLessThanOrEqual(4096);
    expect(decodeTerminalSubject(encodeTerminalSubject(machine)).actor).toEqual(machine.actor);
    expect(() => machineAuthorityOrigin({ authentication: 'mtls', certificateSha256: randomBytes(32).toString('hex'),
      principal: { tenant_id: 'Steven', alias: 'kant', channel: 'adapter', session_id: 's'.repeat(257) },
      issuedAtMs: 100_000, expiresAtMs: 200_000 })).toThrow(AuthorityContinuityError);
    for (const invalid of ['r1.a.b', 'v1.a.b', 'ac2.a', token + '.x', 'ac2.' + 'x'.repeat(4097) + '.x']) {
      expect(() => verifyAuthorityContinuity(invalid, master)).toThrow(AuthorityContinuityError);
    }
    const encoded = token.split('.')[1];
    if (!encoded) throw new Error('invalid fixture');
    const signature = token.split('.')[2];
    if (!signature) throw new Error('invalid fixture');
    const padded = `ac2.${encoded}=.${signature}`;
    expect(() => verifyAuthorityContinuity(padded, master)).toThrow(AuthorityContinuityError);
  });
});
