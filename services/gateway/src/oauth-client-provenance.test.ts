import { describe, expect, it } from 'vitest';
import { DeliveryEnvelopeSchema, HUMAN_CLIENT_PROVENANCE_CAPABILITY } from '@cauce/protocol';
import { projectHumanClientProvenance } from '../../../packages/store/src/repository/deliveries/client-provenance.js';
import { lockOAuthAccess } from './oauth-grant-authority.js';
import { createHumanPublishAuthority } from './human-mcp-authority.js';
import { expectedLocalClient, fixtureDatabase, fixtureDelivery, fixtureGrantId, fixtureIdentity,
  fixtureIssuer, fixtureSnapshot, pinnedFixture, sharedChatGptClient, verifyFixtureStamp } from './oauth-client-provenance.fixtures.js';

describe('OAuth client provenance', () => {
  it('returns the client proven by the locked grant instead of discarding it', async () => {
    const f = fixtureDatabase();
    const result = await lockOAuthAccess(f.client, fixtureIdentity, fixtureIssuer,
      fixtureIdentity.audience, verifyFixtureStamp);
    expect(result).toEqual(expectedLocalClient());
  });

  it.each([sharedChatGptClient, 'cauce-dcr-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'])(
    'preserves verified client %s separately from the human and route alias', async (clientId) => {
      const f = fixtureDatabase(clientId);
      const authorize = createHumanPublishAuthority(fixtureIdentity, pinnedFixture,
        new AbortController().signal, { lock: async () => fixtureSnapshot,
          verifyCredentialStamp: verifyFixtureStamp });
      const result = await authorize(f.client);
      expect(result).toEqual({ ...pinnedFixture, clientProvenance: expectedLocalClient(clientId) });
    },
  );

  it('uses grant client identity despite a forged caller hint naming Dots', async () => {
    const f = fixtureDatabase();
    const identity = { ...fixtureIdentity, clientId: 'Dots', clientInstance: 'Dots' };
    const authorize = createHumanPublishAuthority(identity, pinnedFixture,
      new AbortController().signal, { lock: async () => fixtureSnapshot,
        verifyCredentialStamp: verifyFixtureStamp });
    const result = await authorize(f.client);
    expect(result).toMatchObject({ clientProvenance: expectedLocalClient() });
    expect(JSON.stringify(result)).not.toContain('"Dots"');
  });

  it('records unknown client for external OAuth without a verified client claim', async () => {
    const f = fixtureDatabase();
    const identity = { kind: 'oauth' as const, issuer: fixtureIdentity.issuer, subject: fixtureIdentity.subject,
      audience: fixtureIdentity.audience, expiresAt: fixtureIdentity.expiresAt, scopes: fixtureIdentity.scopes };
    const authorize = createHumanPublishAuthority(identity, pinnedFixture,
      new AbortController().signal, { lock: async () => fixtureSnapshot });
    const result = await authorize(f.client);
    expect(result).toEqual({ ...pinnedFixture, clientProvenance: { kind: 'unknown' } });
    expect(f.query.mock.calls.some(([sql]) => sql.includes('FROM cauce_oauth_grants'))).toBe(false);
  });

  it('supports the client wire projection without a grant identifier', () => {
    const humanClient = { root_message_id: fixtureDelivery.message_id,
      client: { kind: 'oauth_client', verification: 'local_grant', issuer: fixtureIssuer,
        client_id: sharedChatGptClient, instance: 'unknown' } };
    const result = DeliveryEnvelopeSchema.safeParse({ ...fixtureDelivery,
      human_client_provenance: humanClient });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(JSON.stringify(result.data)).not.toContain(fixtureGrantId);
    expect(result.data).toMatchObject({ human_client_provenance: humanClient });
  });

  it('supports explicit unknown provenance on a capable consumer', () => {
    expect(DeliveryEnvelopeSchema.safeParse({ ...fixtureDelivery, human_client_provenance: {
      root_message_id: fixtureDelivery.message_id, client: { kind: 'unknown' },
    } }).success).toBe(true);
  });

  it('supports a server-projected owner declaration naming Dots without asserting a unique instance', () => {
    expect(DeliveryEnvelopeSchema.safeParse({ ...fixtureDelivery, human_client_delegation: {
      root_message_id: fixtureDelivery.message_id, owner_human_id: pinnedFixture.humanId,
      owner_tenant_id: pinnedFixture.tenantId, label: 'Dots',
      basis: 'owner_declared_grant', instance: 'unknown',
    } }).success).toBe(true);
  });
});

describe('existing security and compatibility controls', () => {
  it('fails closed when durable lineage names a missing root rather than projecting unknown', async () => {
    const f = fixtureDatabase();
    f.query.mockImplementation(async sql => {
      const rows = sql.includes('FROM human_message_initiators') ? [{ messageId: fixtureDelivery.message_id,
        messageTenantId: 'Steven', humanId: pinnedFixture.humanId, tenantId: 'Steven',
        rootMessageId: fixtureDelivery.message_id, conversationId: 'missing-root' }] : [];
      return { rows, rowCount: rows.length };
    });
    await expect(projectHumanClientProvenance(f.client,
      [{ id: fixtureDelivery.delivery_id, message_id: fixtureDelivery.message_id }],
      [HUMAN_CLIENT_PROVENANCE_CAPABILITY], 'Steven')).rejects.toThrow('durable human message root is missing');
    expect(f.query.mock.calls.some(([sql]) => sql.includes('FROM human_message_client_provenance'))).toBe(false);
  });

  it('keeps the legacy delivery valid and the sender route unchanged', () => {
    expect(DeliveryEnvelopeSchema.parse(fixtureDelivery)).toMatchObject({
      actor_alias: 'kant', recipient_alias: 'zeus', tenant_id: 'Steven',
    });
  });

  it('keeps local authority closed when durable token proof disappears', async () => {
    const f = fixtureDatabase(sharedChatGptClient, false);
    const authorize = createHumanPublishAuthority(fixtureIdentity, pinnedFixture,
      new AbortController().signal, { lock: async () => fixtureSnapshot,
        verifyCredentialStamp: verifyFixtureStamp });
    await expect(authorize(f.client)).rejects.toThrow('invalid_grant');
  });

  it('keeps mismatched audience closed', async () => {
    const f = fixtureDatabase();
    await expect(lockOAuthAccess(f.client, fixtureIdentity, fixtureIssuer,
      `${fixtureIssuer}/other`, verifyFixtureStamp)).rejects.toThrow('invalid_grant');
  });
});
