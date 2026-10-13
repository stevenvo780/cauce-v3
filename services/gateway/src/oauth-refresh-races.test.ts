import { createHmac, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { waitForBlocked } from '../../../tests/integration/human-identity-resolver-postgres.fixtures.js';
import { PostgresOAuthStore } from './oauth-authorization-store.js';
import { secretHash } from './oauth-authorization-types.js';
import { OAuthTokens } from './oauth-tokens.js';
import { authorized, context, database, exchangeInput, intercept, issuer, revoked, seed, tokens, verify } from './oauth-postgres.fixtures.js';

function barrier() {
  let release: () => void = () => undefined;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
const options = { refreshSuccessor: (hash: string, id: string) => tokens.refreshSuccessor(hash, id) };
const input = (token: string, clientId: string) => ({ tokenHash: secretHash(token), clientId, resource: tokens.resource, scopes: undefined });
const issue = (value: Parameters<typeof tokens.issue>[0]) => tokens.issue(value);

describe.sequential('OAuth refresh recovery lock boundaries', () => {
  it.each(['recovery first', 'successor first'] as const)('serializes parent recovery against successor consumption: %s', async order => {
    const pool = await database(); const f = await authorized(pool);
    const next = await f.store.refresh(input(f.issued.refreshToken, f.request.clientId), issue, context());
    const held = barrier(); const release = barrier(); const entered = barrier();
    const observer = await pool.connect(); let waitingPid = 0;
    const holding = new PostgresOAuthStore(intercept(pool, undefined, async sql => {
      if (order === 'recovery first' ? sql.includes('SELECT token_hash FROM') : sql.startsWith('UPDATE cauce_oauth_refresh_tokens')) {
        held.release(); await release.promise;
      }
    }), issuer, verify, options);
    const waiting = new PostgresOAuthStore(intercept(pool, async (sql, client) => {
      if (order === 'recovery first' ? sql.includes('FOR UPDATE') && sql.includes('FROM cauce_oauth_refresh_tokens WHERE') : sql.includes('SELECT token_hash FROM')) {
        waitingPid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid ?? 0;
        entered.release();
      }
    }), issuer, verify, options);
    const first = holding.refresh(input(order === 'recovery first' ? f.issued.refreshToken : next.refreshToken, f.request.clientId), issue, context());
    try {
      await held.promise;
      const second = waiting.refresh(input(order === 'recovery first' ? next.refreshToken : f.issued.refreshToken, f.request.clientId), issue, context());
      const settled = Promise.allSettled([first, second]);
      await entered.promise; await waitForBlocked(observer, waitingPid); release.release();
      const results = await settled;
      expect(results[0].status).toBe('fulfilled');
      expect(results[1].status).toBe(order === 'recovery first' ? 'fulfilled' : 'rejected');
      const successor = results[order === 'recovery first' ? 1 : 0];
      if (successor.status !== 'fulfilled') throw new Error('missing successor rotation');
      expect(await f.store.validate(successor.value.identity)).toBe(true);
      expect(await revoked(pool, f.issued.identity.grantId)).toBe(false);
      expect((await pool.query('SELECT 1 FROM cauce_oauth_refresh_tokens WHERE grant_id=$1 AND consumed_at IS NULL', [f.issued.identity.grantId])).rowCount).toBe(1);
      expect((await pool.query('SELECT 1 FROM cauce_oauth_tokens WHERE grant_id=$1', [f.issued.identity.grantId])).rowCount).toBe(order === 'recovery first' ? 4 : 3);
    } finally { release.release(); await first.catch(() => undefined); observer.release(); }
  });

  it('rejects recovery when the grace expires while waiting for the successor lock', async () => {
    const pool = await database(); const f = await authorized(pool);
    const store = new PostgresOAuthStore(intercept(pool, async sql => sql.replaceAll("interval '60 seconds'", "interval '1 second'")), issuer, verify, options);
    const next = await store.refresh(input(f.issued.refreshToken, f.request.clientId), issue, context());
    const holder = await pool.connect(); const observer = await pool.connect(); const entered = barrier(); let waitingPid = 0;
    const waiting = new PostgresOAuthStore(intercept(pool, async (sql, client) => {
      if (sql.includes('SELECT token_hash FROM')) {
        waitingPid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid ?? 0;
        entered.release();
      }
      return sql.replaceAll("interval '60 seconds'", "interval '1 second'");
    }), issuer, verify, options);
    await holder.query('BEGIN');
    await holder.query('SELECT token_hash FROM cauce_oauth_refresh_tokens WHERE token_hash=$1 FOR UPDATE', [secretHash(next.refreshToken)]);
    const recovery = waiting.refresh(input(f.issued.refreshToken, f.request.clientId), issue, context());
    const rejected = expect(recovery).rejects.toThrow('invalid_grant');
    try {
      await entered.promise; await waitForBlocked(observer, waitingPid); await observer.query('SELECT pg_sleep(1.1)');
      await holder.query('COMMIT'); await rejected;
      expect((await pool.query('SELECT 1 FROM cauce_oauth_tokens WHERE grant_id=$1', [f.issued.identity.grantId])).rowCount).toBe(2);
      expect(await revoked(pool, f.issued.identity.grantId)).toBe(false);
      expect(await f.store.validate(next.identity)).toBe(true);
    } finally { await holder.query('ROLLBACK'); holder.release(); observer.release(); }
  });

  it('upgrades an eight-hour grant with a random successor without extending its expiry', async () => {
    const pool = await database(); const f = await seed(pool);
    const legacy = new PostgresOAuthStore(pool, issuer, verify, { grantTtlSeconds: 28_800 });
    const approved = await legacy.consent(f.request.idHash, f.request.browserHash, f.session, ['cauce.read'], context());
    if (!approved.code) throw new Error('missing legacy consent');
    const original = await legacy.exchange(exchangeInput(f, approved.code), issue, context());
    const random = await legacy.refresh(input(original.refreshToken, f.request.clientId), issue, context());
    const upgraded = new PostgresOAuthStore(pool, issuer, verify, options);
    await expect(upgraded.refresh(input(original.refreshToken, f.request.clientId), issue, context())).rejects.toThrow('invalid_grant');
    expect(await revoked(pool, original.identity.grantId)).toBe(false);
    const next = await upgraded.refresh(input(random.refreshToken, f.request.clientId), issue, context());
    const recovered = await upgraded.refresh(input(random.refreshToken, f.request.clientId), issue, context());
    expect(recovered.refreshToken).toBe(next.refreshToken);
    expect((await pool.query<{ seconds: number; bounded: boolean }>(`SELECT ceil(extract(epoch FROM g.expires_at-g.created_at))::int AS seconds,
      bool_and(r.expires_at=g.expires_at) AS bounded FROM cauce_oauth_grants g JOIN cauce_oauth_refresh_tokens r ON r.grant_id=g.id
      WHERE g.id=$1 GROUP BY g.id`, [original.identity.grantId])).rows[0]).toEqual({ seconds: 28_800, bounded: true });
  });

  it('rejects recovery of a pre-HKDF response but rotates its live successor without changing grant expiry', async () => {
    const pool = await database(); const f = await authorized(pool);
    const signingKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
    const signer = new OAuthTokens({ issuer, resource: tokens.resource, signingKey, kid: 'hkdf-fixture' });
    const signAccess = (value: Parameters<typeof signer.issue>[0]) => signer.issue(value);
    const expiresAt = (await pool.query<{ expires_at: string }>('SELECT expires_at::text AS expires_at FROM cauce_oauth_grants WHERE id=$1',
      [f.issued.identity.grantId])).rows[0]?.expires_at;
    const legacySuccessor = (hash: string, id: string) => createHmac('sha256', signingKey.export({ format: 'der', type: 'pkcs8' }))
      .update(JSON.stringify(['cauce-oauth-refresh-v1', issuer, tokens.resource, id, hash])).digest('base64url');
    const legacy = new PostgresOAuthStore(pool, issuer, verify, { refreshSuccessor: legacySuccessor });
    const original = await legacy.refresh(input(f.issued.refreshToken, f.request.clientId), signAccess, context());
    expect(original.refreshToken).toBe(legacySuccessor(secretHash(f.issued.refreshToken), f.issued.identity.grantId));
    const upgraded = new PostgresOAuthStore(pool, issuer, verify, { refreshSuccessor: (hash, id) => signer.refreshSuccessor(hash, id) });
    await expect(upgraded.refresh(input(f.issued.refreshToken, f.request.clientId), signAccess, context())).rejects.toThrow('invalid_grant');
    expect(await revoked(pool, original.identity.grantId)).toBe(false);
    expect((await pool.query('SELECT 1 FROM cauce_oauth_tokens WHERE grant_id=$1', [original.identity.grantId])).rowCount).toBe(2);
    const next = await upgraded.refresh(input(original.refreshToken, f.request.clientId), signAccess, context());
    expect(next.refreshToken).toBe(signer.refreshSuccessor(secretHash(original.refreshToken), original.identity.grantId));
    const recovered = await upgraded.refresh(input(original.refreshToken, f.request.clientId), signAccess, context());
    expect(recovered.refreshToken).toBe(next.refreshToken);
    expect(next.refreshToken).not.toBe(legacySuccessor(secretHash(original.refreshToken), original.identity.grantId));
    expect(await upgraded.validate(next.identity)).toBe(true);
    expect((await pool.query<{ expires_at: string; bounded: boolean }>(`SELECT g.expires_at::text AS expires_at,bool_and(r.expires_at=g.expires_at) AS bounded
      FROM cauce_oauth_grants g JOIN cauce_oauth_refresh_tokens r ON r.grant_id=g.id WHERE g.id=$1 GROUP BY g.id`,
    [original.identity.grantId])).rows[0]).toEqual({ expires_at: expiresAt, bounded: true });
  });

  it('keeps an in-flight recovery unusable after nonblocking grant revocation', async () => {
    const pool = await database(); const f = await authorized(pool);
    await f.store.refresh(input(f.issued.refreshToken, f.request.clientId), issue, context());
    const held = barrier(); const release = barrier();
    const recovering = new PostgresOAuthStore(intercept(pool, undefined, async sql => {
      if (sql.includes('SELECT token_hash FROM')) { held.release(); await release.promise; }
    }), issuer, verify, options);
    const recovery = recovering.refresh(input(f.issued.refreshToken, f.request.clientId), issue, context());
    try {
      await held.promise;
      await f.store.revoke(f.issued.identity.grantId, f.session, context());
      release.release();
      const result = await recovery;
      expect(await revoked(pool, result.identity.grantId)).toBe(true);
      expect(await f.store.validate(result.identity)).toBe(false);
      await expect(f.store.refresh(input(result.refreshToken, f.request.clientId), issue, context())).rejects.toThrow('invalid_grant');
    } finally { release.release(); await recovery.catch(() => undefined); }
  });
});
