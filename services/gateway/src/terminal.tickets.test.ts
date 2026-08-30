import {
  TicketError, deriveAliasKey, issueResumeToken, issueTicket, parseAndVerify, parseResumeToken, ticketDigest,
  type TicketPayload
} from './terminal/tickets.js';

/**
 * Golden vectors of the frozen PTY ticket contract. terminal-relay (TypeScript) and the
 * pty-agent (Python) reproduce these exact bytes; if a change here is ever needed, all three
 * implementations and tests/terminal-pty must move together.
 */

// Generated fixture with no authority anywhere: 32 bytes 0x00..0x1f.
const MASTER = Buffer.from('AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=', 'base64');

const GOLDEN_ALIAS_KEY_HEX = '33ab99cc766ee43031f9c22b8db78aeae5b04bc0ebedddfe8539330af7233efa';

const GOLDEN_PAYLOAD: TicketPayload = {
  v: 1,
  sid: '11111111-2222-3333-4444-555555555555',
  op: 'unattributed:console-basic-auth',
  sub: 'Steven:kant',
  tgt: {
    tenant: 'Steven',
    alias: 'jarvis',
    container: 'claw',
    generation: 'gen-1',
    image: 'sha256:deadbeef',
    uid: 1000,
    user: 'claw'
  },
  mode: 'shell',
  iat: 1_750_000_000,
  exp: 1_750_000_030
};

const GOLDEN_TICKET = 'v1.eyJ2IjoxLCJzaWQiOiIxMTExMTExMS0yMjIyLTMzMzMtNDQ0NC01NTU1NTU1NTU1NTUiLCJvcCI6InVuYXR0' +
  'cmlidXRlZDpjb25zb2xlLWJhc2ljLWF1dGgiLCJzdWIiOiJTdGV2ZW46a2FudCIsInRndCI6eyJ0ZW5hbnQiOiJTdGV2ZW4iLCJhbGlhcyI6' +
  'ImphcnZpcyIsImNvbnRhaW5lciI6ImNsYXciLCJnZW5lcmF0aW9uIjoiZ2VuLTEiLCJpbWFnZSI6InNoYTI1NjpkZWFkYmVlZiIsInVpZCI6' +
  'MTAwMCwidXNlciI6ImNsYXcifSwibW9kZSI6InNoZWxsIiwiaWF0IjoxNzUwMDAwMDAwLCJleHAiOjE3NTAwMDAwMzB9.' +
  '034UhsCFtCkD-mxdU51meZwH44SLyjrD1PT26ikM3iY';

function nonCanonicalEncodingOfSameBytes(encoded: string): string {
  const expected = Buffer.from(encoded, 'base64url');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  for (const finalCharacter of alphabet) {
    const candidate = `${encoded.slice(0, -1)}${finalCharacter}`;
    if (candidate !== encoded && Buffer.from(candidate, 'base64url').equals(expected)) return candidate;
  }
  throw new Error('fixture has no alternate non-canonical base64url spelling');
}

describe('PTY ticket golden vectors', () => {
  it('derives the per-alias key with HKDF-SHA256 exactly as the relay and the agent do', () => {
    expect(deriveAliasKey(MASTER, 'Steven', 'jarvis').toString('hex')).toBe(GOLDEN_ALIAS_KEY_HEX);
  });

  it('emits the golden ticket byte for byte', () => {
    const key = deriveAliasKey(MASTER, 'Steven', 'jarvis');
    expect(issueTicket(GOLDEN_PAYLOAD, key)).toBe(GOLDEN_TICKET);
  });

  it('keeps the payload key order even when the caller assembles the object in another order', () => {
    const key = deriveAliasKey(MASTER, 'Steven', 'jarvis');
    const shuffled = {
      exp: GOLDEN_PAYLOAD.exp,
      iat: GOLDEN_PAYLOAD.iat,
      mode: GOLDEN_PAYLOAD.mode,
      tgt: {
        user: GOLDEN_PAYLOAD.tgt.user, uid: GOLDEN_PAYLOAD.tgt.uid, image: GOLDEN_PAYLOAD.tgt.image,
        generation: GOLDEN_PAYLOAD.tgt.generation, container: GOLDEN_PAYLOAD.tgt.container,
        alias: GOLDEN_PAYLOAD.tgt.alias, tenant: GOLDEN_PAYLOAD.tgt.tenant
      },
      sub: GOLDEN_PAYLOAD.sub, op: GOLDEN_PAYLOAD.op, sid: GOLDEN_PAYLOAD.sid, v: 1 as const
    };
    expect(issueTicket(shuffled, key)).toBe(GOLDEN_TICKET);
  });

  it('round-trips the payload while the ticket is inside its window', () => {
    const key = deriveAliasKey(MASTER, 'Steven', 'jarvis');
    expect(parseAndVerify(GOLDEN_TICKET, key, GOLDEN_PAYLOAD.iat + 1)).toEqual(GOLDEN_PAYLOAD);
  });

  it('rejects an expired ticket', () => {
    const key = deriveAliasKey(MASTER, 'Steven', 'jarvis');
    expect(() => parseAndVerify(GOLDEN_TICKET, key, GOLDEN_PAYLOAD.exp))
      .toThrowError(expect.objectContaining({ reason: 'expired' }) as Error);
    expect(() => parseAndVerify(GOLDEN_TICKET, key, GOLDEN_PAYLOAD.exp + 3_600))
      .toThrowError(expect.objectContaining({ reason: 'expired' }) as Error);
  });

  it('rejects a ticket minted for another alias: a stolen ticket is useless elsewhere', () => {
    const otherAlias = deriveAliasKey(MASTER, 'Steven', 'argos');
    const otherTenant = deriveAliasKey(MASTER, 'Miguel', 'jarvis');
    expect(otherAlias.equals(deriveAliasKey(MASTER, 'Steven', 'jarvis'))).toBe(false);
    for (const key of [otherAlias, otherTenant]) {
      let failure: TicketError | undefined;
      try {
        parseAndVerify(GOLDEN_TICKET, key, GOLDEN_PAYLOAD.iat + 1);
      } catch (error) {
        failure = error as TicketError;
      }
      expect(failure?.reason).toBe('signature_invalid');
    }
  });

  it('rejects tampered payloads and malformed shapes', () => {
    const key = deriveAliasKey(MASTER, 'Steven', 'jarvis');
    const [, payload, signature] = GOLDEN_TICKET.split('.');
    const [, forgedPayload] = issueTicket({ ...GOLDEN_PAYLOAD, mode: 'harness' }, key).split('.');
    if (payload === undefined || signature === undefined || forgedPayload === undefined) {
      throw new Error('ticket fixture is malformed');
    }
    // Payload of the harness ticket with the signature of the shell ticket.
    expect(() => parseAndVerify(`v1.${forgedPayload}.${signature}`, key, GOLDEN_PAYLOAD.iat + 1))
      .toThrowError(expect.objectContaining({ reason: 'signature_invalid' }) as Error);
    expect(() => parseAndVerify('v2.a.b', key)).toThrowError(TicketError);
    expect(() => parseAndVerify('v1.a', key)).toThrowError(TicketError);
    expect(() => parseAndVerify(`v1.${payload}.$$$`, key)).toThrowError(TicketError);
  });

  it('rejects a non-canonical signature spelling even when it decodes to the authentic HMAC', () => {
    const key = deriveAliasKey(MASTER, 'Steven', 'jarvis');
    const [version, payload, signature] = GOLDEN_TICKET.split('.') as [string, string, string];
    const alternate = nonCanonicalEncodingOfSameBytes(signature);
    expect(Buffer.from(alternate, 'base64url')).toEqual(Buffer.from(signature, 'base64url'));
    expect(() => parseAndVerify(`${version}.${payload}.${alternate}`, key, GOLDEN_PAYLOAD.iat + 1))
      .toThrowError(expect.objectContaining({ reason: 'signature_invalid' }) as Error);
  });

  it('truncates the ticket digest to 16 hex characters and never echoes the ticket', () => {
    const digest = ticketDigest(GOLDEN_TICKET);
    expect(digest).toMatch(/^[0-9a-f]{16}$/);
    expect(GOLDEN_TICKET).not.toContain(digest);
  });
});

describe('PTY resume credential', () => {
  const sid = '11111111-2222-3333-4444-555555555555';
  const operator = 'operator:steven';
  const issuedAt = 1_750_000_000;
  const expiresAt = issuedAt + 120;

  it('round-trips a signed sid/operator/expiry binding with a fresh nonce', () => {
    const first = issueResumeToken(sid, operator, expiresAt, MASTER, issuedAt);
    const second = issueResumeToken(sid, operator, expiresAt, MASTER, issuedAt);
    expect(first).not.toBe(second);
    expect(parseResumeToken(first, MASTER, issuedAt + 1)).toMatchObject({
      v: 1, sid, op: operator, iat: issuedAt, exp: expiresAt,
    });
    expect(parseResumeToken(first, MASTER, issuedAt + 1).nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it('expires exactly at exp and rejects a signature made under another master', () => {
    const token = issueResumeToken(sid, operator, expiresAt, MASTER, issuedAt);
    expect(() => parseResumeToken(token, MASTER, expiresAt))
      .toThrowError(expect.objectContaining({ reason: 'expired' }) as Error);
    const otherMaster = Buffer.alloc(32, 0xff);
    expect(() => parseResumeToken(token, otherMaster, issuedAt + 1))
      .toThrowError(expect.objectContaining({ reason: 'signature_invalid' }) as Error);
  });

  it('rejects any payload/signature tampering and malformed versions', () => {
    const token = issueResumeToken(sid, operator, expiresAt, MASTER, issuedAt);
    const [version, payload, signature] = token.split('.') as [string, string, string];
    const tamperedPayload = `${payload.slice(0, -1)}${payload.endsWith('A') ? 'B' : 'A'}`;
    const tamperedSignature = `${signature.slice(0, -1)}${signature.endsWith('A') ? 'B' : 'A'}`;
    expect(() => parseResumeToken(`${version}.${tamperedPayload}.${signature}`, MASTER, issuedAt + 1))
      .toThrowError(expect.objectContaining({ reason: 'signature_invalid' }) as Error);
    expect(() => parseResumeToken(`${version}.${payload}.${tamperedSignature}`, MASTER, issuedAt + 1))
      .toThrowError(expect.objectContaining({ reason: 'signature_invalid' }) as Error);
    expect(() => parseResumeToken(`r2.${payload}.${signature}`, MASTER, issuedAt + 1)).toThrowError(TicketError);
  });

  it('rejects a non-canonical signature spelling that decodes to the same bytes', () => {
    const token = issueResumeToken(sid, operator, expiresAt, MASTER, issuedAt);
    const [version, payload, signature] = token.split('.') as [string, string, string];
    const alternate = nonCanonicalEncodingOfSameBytes(signature);
    expect(Buffer.from(alternate, 'base64url')).toEqual(Buffer.from(signature, 'base64url'));
    expect(() => parseResumeToken(`${version}.${payload}.${alternate}`, MASTER, issuedAt + 1))
      .toThrowError(expect.objectContaining({ reason: 'signature_invalid' }) as Error);
  });
});
