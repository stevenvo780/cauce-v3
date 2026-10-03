import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { expect, vi } from 'vitest';
import { buildPublishReceipt, type ConsolePublishIntentCommand, type PublishMessage } from '@cauce/protocol';
import type { PublishOptions } from '@cauce/store';
import type { AuthProvider } from '../../services/gateway/src/auth.js';
import type { ConsoleUser } from '../../services/gateway/src/console-users.js';
import { hashPassword } from '../../services/gateway/src/password.js';
import { PasswordAuthProvider, type ConsolePasswordAuthState } from '../../services/gateway/src/password-auth.js';
import { MemoryConsoleUserStore } from '../../services/gateway/src/test-support/console-users.js';
import { buildTestGateway, fakePool, fakeRepository } from '../../services/gateway/src/test-support/gateway-doubles.js';

const PASSWORD = 'synthetic-account-contract-password';
export const message = {
  room_id: 'grp.steven', recipients: [{ tenant_id: 'Steven', alias: 'jarvis' }],
  body: { text: 'Synthetic human message' }, lane: 'interactive', priority: 10,
};

export async function humanAccounts(second: Partial<ConsoleUser> = {}, fallback?: AuthProvider) {
  const first: ConsoleUser = {
    id: '11111111-1111-4111-8111-111111111111', email: 'alba@example.test', display_name: 'Alba',
    role: 'operator', tenant_id: 'Steven', alias: 'kant', active: true, password_changed_at: 0,
    password_hash: await hashPassword(PASSWORD, { cost: 1_024, blockSize: 8, parallelism: 1 }),
  };
  const other: ConsoleUser = {
    ...first, id: '22222222-2222-4222-8222-222222222222', email: 'bruno@example.test', display_name: 'Bruno', ...second,
  };
  const users = new MemoryConsoleUserStore([first, other]);
  const provider = new PasswordAuthProvider({
    users, signingKey: Buffer.alloc(32, 19), ...(fallback === undefined ? {} : { fallback }),
  });
  const prepare = vi.fn(async (_input: ConsolePublishIntentCommand, _scope: string) => ({
    version: 1 as const, state: 'prepared' as const, idempotency_key: `console:${randomUUID()}`, receipt: null,
  }));
  const publish = vi.fn(async (input: PublishMessage, _options?: PublishOptions) => buildPublishReceipt(input, {
    message_id: randomUUID(), delivery_ids: [randomUUID()], duplicate: false,
    request_id: input.request_id, trace_id: input.trace_id,
  }));
  const repository = fakeRepository({ prepareConsolePublishIntent: prepare, publish, verifyPublishReceipt: vi.fn(async () => true) });
  const app = await buildTestGateway({ pool: fakePool({ ssl: true }), authProvider: provider, repository });
  return { app, users, first, other, prepare, publish, repository };
}

export async function loginAs(app: FastifyInstance, user: ConsoleUser) {
  const login = await app.inject({
    method: 'POST', url: '/v3/auth/login', headers: { origin: 'http://localhost' },
    payload: { email: user.email, password: PASSWORD },
  });
  expect(login.statusCode).toBe(200);
  const raw = login.headers['set-cookie'];
  const cookie = (Array.isArray(raw) ? raw[0] : raw)?.split(';')[0];
  if (cookie === undefined) throw new Error('expected a session cookie');
  const state = login.json<ConsolePasswordAuthState>();
  if (state.csrf_token === undefined) throw new Error('expected a session CSRF token');
  return { cookie, state, headers: { cookie, origin: 'http://localhost', 'x-csrf-token': state.csrf_token } };
}

export async function publishAs(app: FastifyInstance, headers: Record<string, string>) {
  const prepared = await app.inject({
    method: 'POST', url: '/v3/console/publish-intents', headers,
    payload: { ...message, intent_nonce: randomUUID() },
  });
  expect(prepared.statusCode).toBe(200);
  const { idempotency_key } = prepared.json<{ idempotency_key: string }>();
  const published = await app.inject({
    method: 'POST', url: '/v3/console/messages', headers, payload: { ...message, idempotency_key },
  });
  expect(published.statusCode).toBe(202);
  const receipt = published.json<{ message_id: string; causal_hash: string }>();
  const confirmed = await app.inject({
    method: 'POST', url: '/v3/console/publish-intents/confirm', headers,
    payload: { idempotency_key, message_id: receipt.message_id, causal_hash: receipt.causal_hash },
  });
  expect(confirmed.statusCode).toBe(200);
  expect(confirmed.json()).toMatchObject({ confirmed: true, idempotency_key, message_id: receipt.message_id });
}
