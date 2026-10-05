import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { issueAuthorityContinuity, authorityContinuityCommitment, encodeTerminalSubject } from './authority-continuity.js';
import { TerminalSessionAuthority, authorityProof } from './session-authority.js';
import { PasswordAuthProvider } from '../password-auth.js';
import { MemoryConsoleUserStore } from '../test-support/console-users.js';
import { DevOnlyAuthProvider, MtlsAuthProvider } from '../auth.js';

const key = randomBytes(32);
function payload() {
  return { version: 2 as const, sessionId: randomUUID(), requestId: randomUUID(),
    semanticDigest: randomBytes(32).toString('hex'), origin: { kind: 'human' as const,
      humanId: randomUUID(), loginSid: randomBytes(24).toString('base64url'),
      credentialStamp: randomBytes(32).toString('base64url'),
      actor: { tenantId: 'Steven', alias: 'kant' }, issuedAtSeconds: 100, expiresAtSeconds: 200 } };
}

describe('terminal authority row boundary', () => {
  it('rejects a missing, oversized, legacy or non-text proof before database work', () => {
    for (const value of [undefined, null, 1, '', 'r1.legacy', 'ac2.' + 'x'.repeat(4096)]) {
      expect(() => authorityProof(value)).toThrow();
    }
  });
  it('binds the signed original to exact row sid, request, subject and admission commitment', () => {
    const original = payload(); const proof = issueAuthorityContinuity(original, key);
    const authority = new TerminalSessionAuthority(DevOnlyAuthProvider.forTests(), key);
    const row = { id: original.sessionId, request_id: original.requestId,
      console_subject: encodeTerminalSubject(original.origin), request_sha256: authorityContinuityCommitment(original) };
    expect(authority.matchRow(authority.verify(proof), row)).toEqual(original);
    for (const changed of [{ id: randomUUID() }, { request_id: randomUUID() },
      { console_subject: 'Steven:kant' }, { request_sha256: randomBytes(32) }]) {
      expect(() => authority.matchRow(original, { ...row, ...changed })).toThrow();
    }
  });
  it('never invokes the machine verifier for a present duplicated or malformed human cookie', async () => {
    const machine = new MtlsAuthProvider({ resolve: async () => { throw new Error('mapper must not run'); } });
    const fallback = vi.spyOn(machine, 'verifiedTerminalMachine').mockRejectedValue(new Error('machine must not run'));
    const provider = new PasswordAuthProvider({ users: new MemoryConsoleUserStore(), signingKey: randomBytes(32), fallback: machine });
    const boundary = new TerminalSessionAuthority(provider, key);
    for (const cookie of ['__Host-cauce_session=a; __Host-cauce_session=b', '__Host-cauce_session=%zz', '__Host-cauce_session=']) {
      await expect(boundary.capture({ headers: { cookie } } as never)).rejects.toThrow();
    }
    expect(fallback).not.toHaveBeenCalled(); fallback.mockRestore();
  });
  it('requires concrete trusted authentication; development/name/body are not origins', async () => {
    const authority = new TerminalSessionAuthority(DevOnlyAuthProvider.forTests(), key);
    await expect(authority.capture({ body: { humanId: randomUUID() } } as never)).rejects.toThrow();
  });
});
