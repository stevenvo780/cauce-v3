import {
  TicketError, deriveAliasKey, issueTicket, parseAndVerify, ticketDigest,
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
    const parts = GOLDEN_TICKET.split('.');
    const forged = issueTicket({ ...GOLDEN_PAYLOAD, mode: 'harness' }, key).split('.');
    // Payload of the harness ticket with the signature of the shell ticket.
    expect(() => parseAndVerify(`v1.${forged[1]}.${parts[2]}`, key, GOLDEN_PAYLOAD.iat + 1))
      .toThrowError(expect.objectContaining({ reason: 'signature_invalid' }) as Error);
    expect(() => parseAndVerify('v2.a.b', key)).toThrowError(TicketError);
    expect(() => parseAndVerify('v1.a', key)).toThrowError(TicketError);
    expect(() => parseAndVerify(`v1.${parts[1]}.$$$`, key)).toThrowError(TicketError);
  });

  it('truncates the ticket digest to 16 hex characters and never echoes the ticket', () => {
    const digest = ticketDigest(GOLDEN_TICKET);
    expect(digest).toMatch(/^[0-9a-f]{16}$/);
    expect(GOLDEN_TICKET).not.toContain(digest);
  });
});
