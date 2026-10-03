import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { humanAccounts, loginAs, publishAs } from './gateway-human-accounts-fixtures.js';

const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

describe('own human profile persistence', () => {
  it('persists only the authenticated name and retains historical authors and intent scope', async () => {
    const test = await humanAccounts();
    apps.push(test.app);
    const session = await loginAs(test.app, test.first);
    await publishAs(test.app, session.headers);
    const response = await test.app.inject({ method: 'PATCH', url: '/v3/auth/profile', headers: session.headers, payload: { name: '  Alba nueva 🌱  ' } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ name: 'Alba nueva 🌱' });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(await test.users.findById(test.first.id)).toEqual({ ...test.first, display_name: 'Alba nueva 🌱' });
    expect(await test.users.findById(test.other.id)).toEqual(test.other);
    const state = await test.app.inject({ method: 'GET', url: '/v3/auth/session', headers: session.headers });
    expect(state.json()).toEqual({ ...session.state, name: 'Alba nueva 🌱' });
    await publishAs(test.app, session.headers);
    const authors = test.publish.mock.calls.map(([, options]) => options?.consoleAuthor);
    expect(authors.map((author) => author?.display_name)).toEqual(['Alba', 'Alba nueva 🌱']);
    expect(authors[0]?.subject_id).toBe(authors[1]?.subject_id);
    expect(test.prepare.mock.calls[0]?.[1]).toBe(test.prepare.mock.calls[1]?.[1]);
  });

  it('lets readers edit their own name without granting operational permissions', async () => {
    const test = await humanAccounts({ role: 'reader' });
    apps.push(test.app);
    const session = await loginAs(test.app, test.other);
    const response = await test.app.inject({ method: 'PATCH', url: '/v3/auth/profile', headers: session.headers, payload: { name: 'Lector' } });
    expect(response.statusCode).toBe(200);
    const state = await test.app.inject({ method: 'GET', url: '/v3/auth/session', headers: session.headers });
    expect(state.json()).toEqual({ ...session.state, name: 'Lector' });
    expect(await test.users.findById(test.other.id)).toEqual({ ...test.other, display_name: 'Lector' });
  });

  it('validates Unicode length and rejects protected-field input without changing any account', async () => {
    const test = await humanAccounts();
    apps.push(test.app);
    const session = await loginAs(test.app, test.first);
    for (const payload of [{ name: ' ' }, { name: '🌱'.repeat(121) }, { name: 1 }, {}, { name: 'A', id: test.other.id }, { name: 'A', role: 'operator' }]) {
      const response = await test.app.inject({ method: 'PATCH', url: '/v3/auth/profile', headers: session.headers, payload });
      expect(response.statusCode).toBe(400);
      expect(await test.users.findById(test.first.id)).toEqual(test.first);
      expect(await test.users.findById(test.other.id)).toEqual(test.other);
    }
    const response = await test.app.inject({ method: 'PATCH', url: '/v3/auth/profile', headers: session.headers, payload: { name: '🌱'.repeat(120) } });
    expect(response.statusCode).toBe(200);
  });

  it('requires the human session, its CSRF token and the existing same-origin guard', async () => {
    const test = await humanAccounts();
    apps.push(test.app);
    const session = await loginAs(test.app, test.first);
    for (const [headers, status] of [
      [{ origin: 'http://localhost' }, 401],
      [{ cookie: session.cookie, origin: 'http://localhost' }, 403],
      [{ ...session.headers, origin: 'https://other.example.test' }, 403],
      [{ cookie: session.cookie, 'x-csrf-token': session.state.csrf_token }, 403],
    ] as const) {
      const response = await test.app.inject({ method: 'PATCH', url: '/v3/auth/profile', headers, payload: { name: 'New' } });
      expect(response.statusCode).toBe(status);
      expect(await test.users.findById(test.first.id)).toEqual(test.first);
    }
  });
});
