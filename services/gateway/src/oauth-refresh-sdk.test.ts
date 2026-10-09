import { createRequire } from 'node:module';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { PostgresOAuthStore } from './oauth-authorization-store.js';
import { registerOAuthAuthorizationServer } from './oauth-authorization-server.js';
import { OAuthClients } from './oauth-client-metadata.js';
import { issuer, tokens, verify, database, authorized, seed, intercept, exchangeInput, context, revoked, shortGrace } from './oauth-postgres.fixtures.js';

interface SdkTokens { access_token: string; refresh_token: string; expires_in: number; scope: string }
type SdkRefresh = (origin: string, options: { clientInformation: { client_id: string }; refreshToken: string;
  resource: URL; fetchFn: typeof fetch; metadata?: { token_endpoint: string; token_endpoint_auth_methods_supported: string[] } }) => Promise<SdkTokens>;
const sdkRequire = createRequire(new URL('../../../packages/mcp-fleet-monitor/package.json', import.meta.url));
const sdk = sdkRequire('@modelcontextprotocol/sdk/client/auth.js') as { refreshAuthorization: SdkRefresh };
const refreshAuthorization: SdkRefresh = (origin, options) => sdk.refreshAuthorization(origin, {
  ...options, metadata: { token_endpoint: `${issuer}/oauth/token`, token_endpoint_auth_methods_supported: ['none'] },
});

async function endpoint(store: PostgresOAuthStore) {
  const app = Fastify();
  await registerOAuthAuthorizationServer(app, { store, tokens, clients: new OAuthClients(),
    session: async () => { throw new Error('interactive authorization is forbidden in this fixture'); },
    passwordAuth: { login: async () => { throw new Error('login is forbidden in this fixture'); }, verifyCredentialStamp: verify } });
  const fetchFn: typeof fetch = async (url, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => { headers[key] = value; });
    const target = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    const body = init?.body;
    if (typeof body !== 'string' && !(body instanceof URLSearchParams)) throw new Error('unexpected SDK token body');
    const response = await app.inject({ method: 'POST', url: new URL(target).pathname,
      headers, payload: typeof body === 'string' ? body : body.toString() });
    return new Response(response.body, { status: response.statusCode, headers: { 'content-type': 'application/json' } });
  };
  return { app, fetchFn };
}

describe.sequential('MCP SDK refresh against durable OAuth authority', () => {
  it('recovers a committed response loss after a store restart, then converges parallel SDK refreshes', async () => {
    const pool = await database(); const f = await authorized(pool);
    let e = await endpoint(f.store);
    const options = { clientInformation: { client_id: f.request.clientId }, resource: new URL(tokens.resource) };
    let lost: SdkTokens | undefined;
    try {
      await expect(refreshAuthorization(issuer, { ...options, refreshToken: f.issued.refreshToken,
        fetchFn: async (...args) => { const response = await e.fetchFn(...args); lost = await response.json() as SdkTokens; throw new TypeError('simulated response loss after commit'); },
      })).rejects.toThrow('simulated response loss');
      await e.app.close();
      const restarted = new PostgresOAuthStore(pool, issuer, verify, { refreshSuccessor: (hash, id) => tokens.refreshSuccessor(hash, id) });
      e = await endpoint(restarted);
      const recovered = await refreshAuthorization(issuer, { ...options, refreshToken: f.issued.refreshToken, fetchFn: e.fetchFn });
      expect(recovered.refresh_token).toBe(lost?.refresh_token);
      const identity = tokens.verify(recovered.access_token);
      expect(identity).toBeDefined();
      if (!identity) throw new Error('SDK received an invalid access token');
      expect(await restarted.validate(identity)).toBe(true);
      const raced = await Promise.all([1, 2].map(() => refreshAuthorization(issuer, {
        ...options, refreshToken: recovered.refresh_token, fetchFn: e.fetchFn,
      })));
      expect(raced[0]?.refresh_token).toBe(raced[1]?.refresh_token);
      expect(await revoked(pool, f.issued.identity.grantId)).toBe(false);
      expect((await pool.query('SELECT 1 FROM cauce_oauth_refresh_tokens WHERE grant_id=$1 AND consumed_at IS NULL', [identity.grantId])).rowCount).toBe(1);
      await expect(refreshAuthorization(issuer, { ...options, refreshToken: f.issued.refreshToken, fetchFn: e.fetchFn })).rejects.toThrow();
      expect(await revoked(pool, identity.grantId)).toBe(false);
    } finally { await e.app.close(); }
  });

  it.each(['revoked grant', 'disabled account', 'changed password', 'revoked membership', 'revoked binding', 'changed tenant'] as const)(
    'refuses recovery after a %s without issuing more access tokens', async change => {
      const pool = await database(); const f = await authorized(pool); const e = await endpoint(f.store);
      const options = { clientInformation: { client_id: f.request.clientId }, resource: new URL(tokens.resource),
        refreshToken: f.issued.refreshToken, fetchFn: e.fetchFn };
      try {
        await refreshAuthorization(issuer, options);
        if (change === 'revoked grant') await f.store.revoke(f.issued.identity.grantId, f.session, context());
        if (change === 'disabled account') await pool.query('UPDATE console_users SET active=false WHERE id=$1', [f.userId]);
        if (change === 'changed password') await pool.query('UPDATE console_users SET password_hash=$2 WHERE id=$1', [f.userId, '$scrypt$' + 'fixture-rotation'.repeat(5)]);
        if (change === 'revoked membership') await pool.query('UPDATE human_tenant_memberships SET enabled=false,revoked_at=clock_timestamp() WHERE human_id=$1', [f.userId]);
        if (change === 'revoked binding') await pool.query('UPDATE human_external_identities SET enabled=false,revoked_at=clock_timestamp() WHERE id=$1', [f.bindingId]);
        if (change === 'changed tenant') {
          await pool.query('INSERT INTO agents(tenant_id,alias) VALUES ($1,$2)', ['Isa', f.alias]);
          await pool.query(`INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,role,permissions)
            VALUES ($1,'Isa',$2,'operator',ARRAY['read','route'])`, [f.userId, f.alias]);
          await pool.query('UPDATE console_users SET tenant_id=$2 WHERE id=$1', [f.userId, 'Isa']);
        }
        await expect(refreshAuthorization(issuer, options)).rejects.toThrow();
        expect((await pool.query('SELECT 1 FROM cauce_oauth_tokens WHERE grant_id=$1', [f.issued.identity.grantId])).rowCount).toBe(2);
      } finally { await e.app.close(); }
    },
  );

  it('rejects foreign client and resource retries while leaving the original grant usable', async () => {
    const pool = await database(); const f = await authorized(pool); const e = await endpoint(f.store);
    const options = { clientInformation: { client_id: f.request.clientId }, resource: new URL(tokens.resource),
      refreshToken: f.issued.refreshToken, fetchFn: e.fetchFn };
    try {
      await refreshAuthorization(issuer, options);
      await expect(refreshAuthorization(issuer, { ...options, clientInformation: { client_id: 'https://foreign.example/client' } })).rejects.toThrow();
      await expect(refreshAuthorization(issuer, { ...options, resource: new URL('https://foreign.example/mcp') })).rejects.toThrow();
      expect(await revoked(pool, f.issued.identity.grantId)).toBe(false);
      await expect(refreshAuthorization(issuer, options)).resolves.toHaveProperty('refresh_token');
    } finally { await e.app.close(); }
  });

  it('cannot recover a refresh response after the original grant expires', async () => {
    const pool = await database(); const f = await seed(pool);
    const expiring = intercept(pool, async sql => sql.replace("date_trunc('second',at)+make_interval(secs=>$14)", "at+make_interval(secs=>$14*0)+interval '2 seconds'"));
    const store = new PostgresOAuthStore(expiring, issuer, verify, { refreshSuccessor: (hash, id) => tokens.refreshSuccessor(hash, id) });
    const approved = await store.consent(f.request.idHash, f.request.browserHash, f.session, ['cauce.read'], context());
    if (!approved.code) throw new Error('fixture consent did not issue a code');
    const issued = await store.exchange(exchangeInput(f, approved.code), value => tokens.issue(value), context());
    const e = await endpoint(store);
    const options = { clientInformation: { client_id: f.request.clientId }, resource: new URL(tokens.resource), refreshToken: issued.refreshToken, fetchFn: e.fetchFn };
    try {
      await refreshAuthorization(issuer, options);
      await pool.query('SELECT pg_sleep(2.1)');
      await expect(refreshAuthorization(issuer, options)).rejects.toThrow();
    } finally { await e.app.close(); }
  });
  it('revokes the family on SDK replay after the recovery window', async () => {
    const pool = await database(); const f = await authorized(pool);
    const store = new PostgresOAuthStore(shortGrace(pool), issuer, verify, { refreshSuccessor: (hash, id) => tokens.refreshSuccessor(hash, id) });
    const e = await endpoint(store);
    const options = { clientInformation: { client_id: f.request.clientId }, resource: new URL(tokens.resource), refreshToken: f.issued.refreshToken, fetchFn: e.fetchFn };
    try {
      const next = await refreshAuthorization(issuer, options);
      await pool.query('SELECT pg_sleep(0.3)');
      await expect(refreshAuthorization(issuer, options)).rejects.toThrow();
      expect(await revoked(pool, f.issued.identity.grantId)).toBe(true);
      await expect(refreshAuthorization(issuer, { ...options, refreshToken: next.refresh_token })).rejects.toThrow();
    } finally { await e.app.close(); }
  });
});
