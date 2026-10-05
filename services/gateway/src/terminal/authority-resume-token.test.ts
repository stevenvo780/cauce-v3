import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AUTHORITY_RESUME_MAX_BYTES, TicketError, deriveAliasKey, emitAuthorityResumeToken,
  issueResumeToken, verifyAuthorityResumeToken, verifyResumeTokenSignature,
} from './tickets.js';
import {
  AUTHORITY_CONTINUITY_MAX_BYTES, issueAuthorityContinuity, verifyAuthorityContinuity,
  type AuthorityContinuityPayload,
} from './authority-continuity.js';

const master = randomBytes(32);
const sessionId = '11111111-2222-4333-8444-555555555555';
const operator = 'operator:fixture';
const issuedAt = 1_750_000_000;
const expiresAt = issuedAt + 120;
const admission: AuthorityContinuityPayload = { version: 2, sessionId, requestId: randomUUID(),
  semanticDigest: randomBytes(32).toString('hex'), origin: { kind: 'human', humanId: randomUUID(),
    loginSid: randomBytes(24).toString('base64url'), credentialStamp: randomBytes(32).toString('base64url'),
    actor: { tenantId: 'Steven', alias: 'kant' }, issuedAtSeconds: issuedAt, expiresAtSeconds: expiresAt } };
const proof = issueAuthorityContinuity(admission, master);

function wrap(legacy: string, authority: string): string {
  return `r2.${Buffer.from(JSON.stringify([legacy, authority])).toString('base64url')}`;
}
function tuple(token: string): [string, string] {
  const encoded = token.split('.')[1];
  if (encoded === undefined) throw new Error('resume fixture envelope missing');
  const parsed: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== 'string' || typeof parsed[1] !== 'string') {
    throw new Error('resume fixture tuple missing');
  }
  return [parsed[0], parsed[1]];
}
function token(): string {
  return emitAuthorityResumeToken(sessionId, operator, expiresAt, master, issuedAt, proof);
}
function replaceSignature(credential: string): string {
  const [version, payload, signature] = credential.split('.');
  if (!version || !payload || !signature) throw new Error('credential fixture malformed');
  const bytes = Buffer.from(signature, 'base64url');
  bytes[0] = (bytes[0] ?? 0) ^ 1;
  return `${version}.${payload}.${bytes.toString('base64url')}`;
}

describe('canonical r2 resume envelope without changing legacy credential crypto', () => {
  it('round trips the signed r1 claims and exact ac2 proof through a canonical tuple', () => {
    const issued = token(); const [legacy, authority] = tuple(issued);
    expect(issued.startsWith('r2.')).toBe(true);
    expect(issued === wrap(legacy, authority)).toBe(true);
    expect(authority === proof).toBe(true);
    expect(issued.length).toBeLessThanOrEqual(AUTHORITY_RESUME_MAX_BYTES);
    const claims = verifyAuthorityResumeToken(issued, master, proof);
    expect(claims).toMatchObject({ v: 1, sid: sessionId, op: operator, iat: issuedAt, exp: expiresAt });
    expect(claims).toEqual(verifyResumeTokenSignature(legacy, master));
    expect(verifyAuthorityContinuity(authority, master)).toEqual(admission);
  });

  it('rejects an external r1, v1 or r1 signature disguised as an r2 envelope', () => {
    const [legacy] = tuple(token());
    const [, payload, signature] = legacy.split('.');
    for (const invalid of [legacy, `v1.${payload ?? ''}.${signature ?? ''}`, `r2.${payload ?? ''}.${signature ?? ''}`]) {
      expect(() => verifyAuthorityResumeToken(invalid, master, proof)).toThrow(TicketError);
    }
  });

  it('requires the exact caller proof, including same-length mismatches', () => {
    const issued = token(); const wrong = replaceSignature(proof);
    expect(wrong.length === proof.length).toBe(true);
    expect(() => verifyAuthorityResumeToken(issued, master, wrong)).toThrow('proof does not match');
    const different = issueAuthorityContinuity({ ...admission, requestId: randomUUID() }, master);
    expect(() => verifyAuthorityResumeToken(issued, master, different)).toThrow('proof does not match');
  });

  it('rejects noncanonical JSON bytes, tuple shapes, escaped spelling and non-base64url', () => {
    const values = tuple(token()); const canonical = JSON.stringify(values);
    const escaped = canonical.replace('r1.', 'r\\u0031.');
    expect(JSON.parse(escaped) as unknown).toEqual(values);
    for (const bytes of [` ${canonical}`, `${canonical}\n`, escaped, JSON.stringify({ values }),
      JSON.stringify([...values, 'extra']), JSON.stringify([values[0]]), JSON.stringify([null, values[1]])]) {
      const invalid = `r2.${Buffer.from(bytes).toString('base64url')}`;
      expect(() => verifyAuthorityResumeToken(invalid, master, proof)).toThrow(TicketError);
    }
    for (const invalid of [`${token()}=`, 'r2.$$$', 'r2.', `${token()}.extra`]) {
      expect(() => verifyAuthorityResumeToken(invalid, master, proof)).toThrow(TicketError);
    }
  });

  it('rejects noncanonical base64url unused bits encoding the same envelope bytes', () => {
    const [legacy] = tuple(token());
    let alternate: string | undefined;
    for (const payload of ['YQ', 'YWE', 'YWFh']) {
      const authority = `ac2.${payload}.${Buffer.alloc(32).toString('base64url')}`;
      const issued = wrap(legacy, authority); const encoded = issued.slice(3);
      for (const character of 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_') {
        const candidate = `${encoded.slice(0, -1)}${character}`;
        if (candidate !== encoded && Buffer.from(candidate, 'base64url').equals(Buffer.from(encoded, 'base64url'))) {
          alternate = `r2.${candidate}`; break;
        }
      }
      if (alternate !== undefined) {
        const invalid = alternate;
        expect(() => verifyAuthorityResumeToken(invalid, master, authority)).toThrow(TicketError);
        break;
      }
    }
    expect(alternate !== undefined).toBe(true);
  });

  it('enforces proof4096, resume8192 and legacy1024 bounds on both emit and verify', () => {
    const boundary = `ac2.${'a'.repeat(4048)}.${Buffer.alloc(32).toString('base64url')}`;
    expect(boundary.length).toBe(AUTHORITY_CONTINUITY_MAX_BYTES);
    const issued = emitAuthorityResumeToken(sessionId, operator, expiresAt, master, issuedAt, boundary);
    expect(verifyAuthorityResumeToken(issued, master, boundary).sid).toBe(sessionId);
    const oversizedProof = boundary.replace('ac2.', 'ac2.a');
    expect(oversizedProof.length).toBe(AUTHORITY_CONTINUITY_MAX_BYTES + 1);
    expect(() => emitAuthorityResumeToken(sessionId, operator, expiresAt, master, issuedAt, oversizedProof)).toThrow(TicketError);
    expect(() => verifyAuthorityResumeToken(wrap(tuple(token())[0], oversizedProof), master, proof)).toThrow(TicketError);
    expect(() => verifyAuthorityResumeToken(`r2.${'a'.repeat(AUTHORITY_RESUME_MAX_BYTES - 2)}`, master, proof)).toThrow(TicketError);
    expect(() => verifyAuthorityResumeToken(wrap(`r1.${'a'.repeat(1022)}`, proof), master, proof)).toThrow(TicketError);
    expect(() => emitAuthorityResumeToken(sessionId, 'a'.repeat(1500), expiresAt, master, issuedAt, proof)).toThrow(TicketError);
  });

  it('rejects truncation of envelope, proof and inner resume signature', () => {
    const issued = token(); const [legacy, authority] = tuple(issued);
    for (const invalid of [issued.slice(0, -1), wrap(legacy.slice(0, -1), authority), wrap(legacy, authority.slice(0, -1))]) {
      expect(() => verifyAuthorityResumeToken(invalid, master, proof)).toThrow(TicketError);
    }
    for (const invalid of ['', 'ac2.a', 'ac2.YQ.AA', 'ac2.YQ.$$$']) {
      expect(() => emitAuthorityResumeToken(sessionId, operator, expiresAt, master, issuedAt, invalid)).toThrow(TicketError);
    }
  });

  it('still rejects forged r1 signatures, other masters and per-alias PTY keys', () => {
    const issued = token(); const [legacy] = tuple(issued);
    expect(() => verifyAuthorityResumeToken(wrap(replaceSignature(legacy), proof), master, proof))
      .toThrowError(expect.objectContaining({ reason: 'signature_invalid' }) as Error);
    for (const wrong of [randomBytes(32), deriveAliasKey(master, 'Steven', 'argos')]) {
      expect(() => verifyAuthorityResumeToken(issued, wrong, proof))
        .toThrowError(expect.objectContaining({ reason: 'signature_invalid' }) as Error);
    }
  });

  it('requires a separate ac2 cryptographic layer even after envelope and r1 verification', () => {
    const forgedProof = replaceSignature(proof);
    const issued = emitAuthorityResumeToken(sessionId, operator, expiresAt, master, issuedAt, forgedProof);
    expect(verifyAuthorityResumeToken(issued, master, forgedProof).sid).toBe(sessionId);
    expect(() => verifyAuthorityContinuity(forgedProof, master)).toThrow();
    const claims = verifyAuthorityResumeToken(token(), master, proof);
    expect(claims.exp).toBe(expiresAt);
    expect(claims.exp * 1000 < Date.now()).toBe(true);
  });

  it('preserves the legacy r1 golden bytes and keeps r1 issuance independent', () => {
    const fixtureMaster = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
    const golden = 'r1.eyJ2IjoxLCJzaWQiOiIxMTExMTExMS0yMjIyLTQzMzMtODQ0NC01NTU1NTU1NTU1NTUiLCJvcCI6Im9wZXJhdG9yOmZpeHR1cmUiLCJpYXQiOjE3NTAwMDAwMDAsImV4cCI6MTc1MDAwMDEyMCwibm9uY2UiOiJBQUFBQUFBQUFBQUFBQUFBQUFBQUFBIn0.Z1Cj3hSycnR7MiUygWo_8vf20s7JuoI69hhDKBRREUY';
    expect(verifyResumeTokenSignature(golden, fixtureMaster)).toEqual({ v: 1, sid: sessionId, op: operator,
      iat: issuedAt, exp: expiresAt, nonce: 'AAAAAAAAAAAAAAAAAAAAAA' });
    const authority = issueAuthorityContinuity(admission, fixtureMaster);
    expect(verifyAuthorityResumeToken(wrap(golden, authority), fixtureMaster, authority)).toEqual(verifyResumeTokenSignature(golden, fixtureMaster));
    const legacy = issueResumeToken(sessionId, operator, expiresAt, fixtureMaster, issuedAt);
    expect(legacy.startsWith('r1.')).toBe(true);
    expect(() => verifyAuthorityResumeToken(legacy, fixtureMaster, authority)).toThrow(TicketError);
  });
});
