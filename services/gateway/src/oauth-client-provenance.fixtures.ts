import { vi } from 'vitest';
import type { DatabaseClient, HumanIdentitySnapshot } from '@cauce/store';
import type { OAuthAccessIdentity } from './oauth-authorization-types.js';

export const fixtureIssuer = 'https://cauce.example';
export const fixtureHumanId = '11111111-1111-4111-8111-111111111111';
export const fixtureGrantId = '22222222-2222-4222-8222-222222222222';
export const fixtureTokenId = '44444444-4444-4444-8444-444444444444';
export const sharedChatGptClient = 'https://chatgpt.com/oauth/client.json';
const bindingId = '33333333-3333-4333-8333-333333333333';
const credentialStamp = 's'.repeat(43);
export const verifyFixtureStamp = (value: string): boolean => value === credentialStamp;

export const fixtureIdentity: OAuthAccessIdentity = {
  kind: 'oauth', authorizationServer: 'local', issuer: fixtureIssuer,
  subject: fixtureHumanId, audience: `${fixtureIssuer}/mcp`, expiresAt: 2_524_608_000,
  grantId: fixtureGrantId, tokenId: fixtureTokenId, scopes: ['cauce.read', 'cauce.publish'],
};

export const fixtureSnapshot: HumanIdentitySnapshot = {
  provider: 'oauth', namespace: fixtureIssuer, subject: fixtureHumanId,
  humanId: fixtureHumanId, bindingId, bindingRevision: '2',
  account: { active: true, role: 'operator', defaultTenant: 'Steven', displayName: 'Fixture' },
  membership: { tenantId: 'Steven', actorAlias: 'kant', role: 'operator',
    permissions: ['read', 'route'], enabled: true, revision: '3' },
};

export const pinnedFixture = { humanId: fixtureHumanId, tenantId: 'Steven' as const, actorAlias: 'kant' };

export function fixtureDatabase(clientId = sharedChatGptClient, tokenPresent = true) {
  const query = vi.fn(async (sql: string) => {
    let rows: Record<string, unknown>[] = [];
    if (sql.includes('SELECT human_id')) rows = [{ human_id: fixtureHumanId }];
    else if (sql.includes('FROM console_users')) rows = [{ id: fixtureHumanId, active: true,
      role: 'operator', tenant_id: 'Steven', display_name: 'Fixture', alias: 'kant',
      password_hash: 'synthetic-fixture', password_changed_at_us: '0', password_changed_at: new Date(0) }];
    else if (sql.includes('FROM human_external_identities')) rows = [{ id: bindingId,
      human_id: fixtureHumanId, revision: '2', enabled: true, revoked_at: null }];
    else if (sql.includes('FROM human_tenant_memberships')) rows = [{ tenant_id: 'Steven',
      actor_alias: 'kant', role: 'operator', permissions: ['read', 'route'], enabled: true,
      revision: '3', revoked_at: null }];
    else if (sql.includes('SELECT credential_stamp')) rows = [{ credential_stamp: credentialStamp }];
    else if (sql.includes('AS valid')) rows = [{ valid: true }];
    else if (sql.includes('FROM cauce_oauth_grants')) rows = [{ id: fixtureGrantId,
      human_id: fixtureHumanId, client_id: clientId, redirect_uri: 'https://client.example/callback',
      scopes: [...fixtureIdentity.scopes], expires_at: new Date(fixtureIdentity.expiresAt * 1000),
      credential_stamp: credentialStamp, binding_id: bindingId, binding_revision: '2',
      membership_revision: '3', tenant_id: 'Steven', actor_alias: 'kant' }];
    else if (sql.includes('FROM cauce_oauth_tokens') && tokenPresent) {
      rows = [{ expires_at: new Date(fixtureIdentity.expiresAt * 1000) }];
    }
    return { rows, rowCount: rows.length };
  });
  return { client: { query } as unknown as DatabaseClient, query };
}

export function expectedLocalClient(clientId = sharedChatGptClient) {
  return { kind: 'oauth_client', verification: 'local_grant', issuer: fixtureIssuer,
    clientId, grantId: fixtureGrantId, instance: 'unknown' } as const;
}

export const fixtureDelivery = {
  type: 'delivery', version: '3.0', event_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  delivery_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  message_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  request_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', trace_id: 'synthetic-client-provenance',
  epoch: 1, attempt: 1, claim_token: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  ack_deadline_at: '2050-01-01T00:00:00.000Z', tenant_id: 'Steven', room_id: 'grp.steven',
  actor_alias: 'kant', recipient_alias: 'zeus', body: { text: 'synthetic fixture only' },
};
