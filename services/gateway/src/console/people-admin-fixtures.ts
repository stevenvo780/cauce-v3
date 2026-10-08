import { randomUUID } from 'node:crypto';
import type { DatabasePool } from '@cauce/store';
import { PostgresConsoleUserStore } from '../console-users.js';
import { createConsoleCredentialStamp, verifyConsoleCredentialStamp } from '../console-credential-stamp.js';
import { PostgresOAuthStore } from '../oauth-authorization-store.js';
import type { OAuthAccessIdentity } from '../oauth-authorization-types.js';
import type { PeopleAdminPerson } from './people-admin-schema.js';

export async function seedPeopleOAuth(pool: DatabasePool, person: PeopleAdminPerson) {
  const key = Buffer.alloc(32, 19); const issuer = 'https://people.example.test'; const grantId = randomUUID(); const bindingId = randomUUID(); const tokenId = randomUUID();
  const user = await new PostgresConsoleUserStore(pool).findById(person.id);
  if (!user?.password_changed_at_us) throw new Error('fixture user absent');
  const stamp = createConsoleCredentialStamp(key, { userId: user.id, passwordHash: user.password_hash, passwordChangedAtUs: user.password_changed_at_us });
  await pool.query("INSERT INTO human_external_identities(id,human_id,provider,namespace,subject) VALUES($1,$2::uuid,'oauth',$3,$2::text)", [bindingId, person.id, issuer]);
  await pool.query(`INSERT INTO cauce_oauth_grants(id,human_id,issuer,resource,client_id,redirect_uri,scopes,binding_id,binding_revision,membership_revision,
    tenant_id,actor_alias,credential_stamp,expires_at) VALUES($1,$2,$3,$4,'fixture-client','https://client.example.test/callback',ARRAY['cauce.read'],$5,1,1,$6,$7,$8,clock_timestamp()+interval '1 hour')`,
  [grantId, person.id, issuer, `${issuer}/mcp`, bindingId, person.tenant_id, person.alias, stamp]);
  const expiresAt = Math.floor(Date.now() / 1000) + 60;
  await pool.query('INSERT INTO cauce_oauth_tokens(id,grant_id,expires_at) VALUES($1,$2,$3)', [tokenId, grantId, new Date(expiresAt * 1000)]);
  await pool.query("INSERT INTO cauce_oauth_refresh_tokens(token_hash,grant_id,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 hour')", ['f'.repeat(64), grantId]);
  await pool.query("INSERT INTO human_oauth_client_delegations(local_oauth_grant_id,human_id,tenant_id,declared_by_human_id,label) VALUES($1,$2,$3,$2,'Fixture')", [grantId, person.id, person.tenant_id]);
  const store = new PostgresOAuthStore(pool, issuer, (value, current) => verifyConsoleCredentialStamp(key, value, current));
  const identity: OAuthAccessIdentity = { authorizationServer: 'local', kind: 'oauth', issuer, audience: `${issuer}/mcp`, subject: person.id,
    grantId, tokenId, expiresAt, scopes: ['cauce.read'] };
  return { store, identity, refresh: { tokenHash: 'f'.repeat(64), clientId: 'fixture-client', resource: `${issuer}/mcp`, scopes: undefined } };
}
