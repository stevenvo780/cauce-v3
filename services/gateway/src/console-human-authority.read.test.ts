import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseClient } from '@cauce/store';
import { consoleHumanAccess } from './console-human-authority.js';
import { createConsoleCredentialStamp } from './console-credential-stamp.js';
import { AuthError } from './auth.js';
import { PasswordAuthProvider } from './password-auth.js';
import { MemoryConsoleUserStore } from './test-support/console-users.js';
import { replyError } from './routes/shared.js';

const humanId = 'cccccccc-3333-4333-8333-333333333333';
const key = Buffer.alloc(32, 1);
const credentials = { userId: humanId, passwordHash: 'public-fixture', passwordChangedAtUs: '1' };
const apps: FastifyInstance[] = [];
function fixture() {
  const provider = new PasswordAuthProvider({ users: new MemoryConsoleUserStore(), signingKey: key });
  const now = Date.now();
  const session = { humanId, loginSid: 'public-fixture-login', tenantId: 'Steven' as const, actorAlias: 'reader',
    issuedAtMs: now, expiresAtMs: now + 60_000, credentialStamp: createConsoleCredentialStamp(key, credentials) };
  const verified = vi.spyOn(provider, 'verifiedConsoleSession').mockResolvedValue(session);
  const account = { id: humanId, active: true, role: 'reader', tenant_id: 'Steven', alias: 'reader',
    password_changed_at: new Date(0), password_hash: credentials.passwordHash, password_changed_at_us: '1' };
  const membership = { tenant_id: 'Steven', actor_alias: 'reader', role: 'reader', permissions: ['read'], enabled: true,
    revision: '1', revoked_at: null as Date | null };
  const query = vi.fn(async (sql: string) => ({ rows: sql.includes('FROM console_users') ? [account]
    : sql.includes('FROM human_tenant_memberships') ? [membership] : [], rowCount: 1 }));
  const client = { query } as unknown as DatabaseClient;
  const app = Fastify(); apps.push(app);
  for (const mode of ['read', 'route', 'default', 'cancel'] as const) app.get(`/${mode}`, async (request, reply) => {
    let access;
    try {
      access = await consoleHumanAccess(provider, request, reply, mode === 'default' ? undefined : mode === 'cancel' ? 'read' : mode);
      if (!access) throw new AuthError();
      if (mode === 'cancel') request.raw.emit('aborted');
      return await access.options.humanAuthority(client);
    } catch (error) { replyError(reply, error); }
    finally { access?.close(); }
  });
  return { app, provider, account, membership, verified, session, query };
}
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(apps.splice(0).map((app) => app.close())); });
describe('read-only console human authority', () => {
  it('allows a durable reader but keeps default and explicit publishing forbidden', async () => {
    const { app } = fixture();
    expect((await app.inject('/read')).statusCode).toBe(200);
    expect((await app.inject('/route')).statusCode).toBe(403);
    expect((await app.inject('/default')).statusCode).toBe(403);
  });
  it('preserves operator publishing by default', async () => {
    const { app, account, membership } = fixture(); account.role = 'operator'; membership.role = 'operator'; membership.permissions = ['route', 'read'];
    expect((await app.inject('/default')).statusCode).toBe(200);
    expect((await app.inject('/route')).statusCode).toBe(200);
    expect((await app.inject('/read')).statusCode).toBe(200);
  });
  it.each(['account', 'membership', 'permission', 'revocation', 'stamp', 'password-generation', 'human-binding'] as const)('rejects stale or missing %s authority', async (condition) => {
    const { app, account, membership } = fixture();
    if (condition === 'account') account.active = false;
    if (condition === 'membership') membership.enabled = false;
    if (condition === 'permission') membership.permissions = [];
    if (condition === 'revocation') membership.revoked_at = new Date();
    if (condition === 'stamp') account.password_hash = 'changed-public-fixture';
    if (condition === 'password-generation') account.password_changed_at = new Date(Date.now() + 10_000);
    if (condition === 'human-binding') account.alias = 'other-alias';
    const response = await app.inject('/read'); expect(response.statusCode).toBe(condition === 'human-binding' ? 409 : 403);
    expect(response.body).not.toContain(account.password_hash);
  });
  it('requires a verified session and refuses a session without a credential stamp', async () => {
    const { app, verified, session } = fixture(); verified.mockResolvedValue(undefined);
    expect((await app.inject('/read')).statusCode).toBe(401);
    const { credentialStamp: _stamp, ...unstamped } = session; void _stamp;
    verified.mockResolvedValue(unstamped); expect((await app.inject('/read')).statusCode).toBe(403);
  });
  it('preserves cancellation before any durable authority query', async () => {
    const { app, query } = fixture();
    expect((await app.inject('/cancel')).statusCode).not.toBe(200);
    expect(query).not.toHaveBeenCalled();
  });
});
