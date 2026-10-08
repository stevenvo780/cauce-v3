import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { PasswordAuthProvider, signConsoleSession } from '../password-auth.js';
import { MemoryConsoleUserStore } from '../test-support/console-users.js';
import type { ConsoleUser } from '../console-users.js';
import { providerAuthActor } from './provider-auth.routes.js';

function fixture() {
  let time = 1_700_000_000_000;
  const key = Buffer.alloc(32, 7);
  const user: ConsoleUser = { id: '11111111-2222-4333-8444-555555555555', email: 'fixture@example.test', display_name: 'Fixture',
    role: 'operator', tenant_id: 'Steven', alias: 'kant', active: true, password_hash: '$scrypt$fixture', password_changed_at: 0 };
  const users = new MemoryConsoleUserStore([user]);
  const provider = new PasswordAuthProvider({ users, signingKey: key, now: () => time });
  const token = signConsoleSession(key, { iss: 'cauce-v3-gateway', aud: 'cauce-v3-console', sub: user.id,
    sid: 'a'.repeat(32), csrf: 'b'.repeat(32), iat: time / 1000, exp: time / 1000 + 60 });
  const request = { url: '/v3/console/provider-auth/ws', headers: { cookie: `${provider.cookieName}=${token}` } } as FastifyRequest;
  return { provider, users, user, request, advance: () => { time += 61_000; } };
}
describe('provider socket uses fresh password authority', () => {
  it.each(['password', 'role', 'active', 'expiry'] as const)('rejects cached authority after %s changes', async kind => {
    const f = fixture();
    await providerAuthActor(f.request, f.provider);
    if (kind === 'password') f.users.put({ ...f.user, password_changed_at: 1_700_000_005_000 });
    if (kind === 'role') f.users.put({ ...f.user, role: 'reader' });
    if (kind === 'active') f.users.put({ ...f.user, active: false });
    if (kind === 'expiry') f.advance();
    await expect(providerAuthActor(f.request, f.provider, true)).rejects.toThrow();
  });
});
