import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TerminalHumanFixture, type HumanRevocation } from './terminal-human-revocation.fixtures.js';

describe('terminal control revalidates the originating password account', () => {
  let fixture: TerminalHumanFixture;
  beforeEach(async () => { fixture = new TerminalHumanFixture(); await fixture.start(); }, 120_000);
  afterEach(async () => fixture.close(), 30_000);

  it('allows a consumed claim and denies it after explicit terminal revocation', async () => {
    const terminal = await fixture.issue();
    expect((await fixture.consume(terminal)).status).toBe(200);
    expect((await fixture.authorize(terminal)).status).toBe(200);
    expect((await fixture.revokeTerminal(terminal)).status).toBe(204);
    const denied = await fixture.authorize(terminal);
    expect(denied.status).toBe(403);
    expect(denied.body.reason).toBe('revoked');
  });

  it.each<HumanRevocation>(['disabled', 'reader', 'password'])(
    'denies renewal after account %s revocation without changing technical ACLs', async (kind) => {
      const terminal = await fixture.issue();
      expect((await fixture.consume(terminal)).status).toBe(200);
      expect((await fixture.authorize(terminal)).status).toBe(200);
      const expiryBefore = await fixture.claimExpiry(terminal);
      const authorityBefore = await fixture.technicalAuthorityHash();
      await fixture.revokeHuman(terminal, kind);
      const cookieRequest = await fixture.request('/v3/console/terminal/targets', {
        headers: { cookie: terminal.cookie },
      });
      expect(cookieRequest.status).toBe(kind === 'reader' ? 403 : 401);
      const relayRequest = await fixture.authorize(terminal);
      const expiryAfter = await fixture.claimExpiry(terminal);
      expect(await fixture.technicalAuthorityHash()).toBe(authorityBefore);
      console.info(JSON.stringify({ scenario: kind, cookieStatus: cookieRequest.status,
        relayStatus: relayRequest.status, claimRenewed: expiryAfter !== expiryBefore }));
      expect.soft(relayRequest.status).toBe(403);
      expect.soft(expiryAfter).toBe(expiryBefore);
    },
  );

  it('denies ticket consumption after the explicit grant is removed', async () => {
    const terminal = await fixture.issue();
    await fixture.removeGrants();
    expect((await fixture.consume(terminal)).status).toBe(403);
  });
});
