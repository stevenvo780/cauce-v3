import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildPublishReceipt, publishRequestHash, type PublishMessage } from '@cauce/protocol';
import type { PublishOptions } from '@cauce/store';
import type { GatewayRepository } from './app.js';
import { validatePrincipal, type Principal } from './auth.js';
import { consoleMessageAuthor } from './console-message-author.js';
import { buildTestGateway, fakePool, fakeRepository, FixedAuthProvider, ids } from './test-support/gateway-doubles.js';

const human: Principal = {
  tenant_id: 'Steven', alias: 'kant', session_id: 'session-one', channel: 'console',
  roles: ['operator'], permissions: ['route', 'read'], operator_id: 'person@example.test',
  operator_profile: { id: 'console:one', display_name: 'Steven' },
};
const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

const payload = {
  room_id: 'grp.steven', recipients: [{ tenant_id: 'Steven', alias: 'jarvis' }],
  body: { text: 'Ping' }, lane: 'interactive', priority: 10, idempotency_key: 'console:prepared',
};
const headers = { origin: 'http://localhost' };

async function gateway(actor = human, overrides: Partial<GatewayRepository> = {}) {
  const publish = vi.fn(async (command: PublishMessage, _options?: PublishOptions) => buildPublishReceipt(command, {
    message_id: ids.message, delivery_ids: [ids.delivery], duplicate: false,
    request_id: command.request_id, trace_id: command.trace_id,
  }));
  const app = await buildTestGateway({
    pool: fakePool({ ssl: true }), authProvider: new FixedAuthProvider(actor),
    repository: fakeRepository({ publish, ...overrides }),
  });
  apps.push(app);
  return { app, publish };
}

describe('authenticated console authorship', () => {
  it('exposes the durable human subject separately from the shared routing subject', async () => {
    const first = await gateway();
    const secondActor = { ...human, operator_profile: { id: 'console:two', display_name: 'Otra persona' } };
    const second = await gateway(secondActor);
    const firstAccess = await first.app.inject({ method: 'GET', url: '/v3/console/access', headers });
    const secondAccess = await second.app.inject({ method: 'GET', url: '/v3/console/access', headers });
    expect(firstAccess.statusCode).toBe(200);
    expect(firstAccess.json()).toMatchObject({ subject: 'Steven:kant', human_subject: consoleMessageAuthor(human)?.subject_id });
    expect(secondAccess.json()).toMatchObject({ subject: 'Steven:kant', human_subject: consoleMessageAuthor(secondActor)?.subject_id });
    expect(firstAccess.json<{ human_subject: string }>().human_subject)
      .not.toBe(secondAccess.json<{ human_subject: string }>().human_subject);
    expect(firstAccess.body).not.toContain(human.operator_id);
  });

  it('keeps the human subject after a reader downgrade without granting publish permission', async () => {
    const { app } = await gateway({ ...human, roles: [], permissions: ['read'] });
    const response = await app.inject({ method: 'GET', url: '/v3/console/access', headers });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ human_subject: consoleMessageAuthor(human)?.subject_id, roles: [], permissions: [] });
  });

  it('uses the existing server profile without exposing email or inferring an owner role', () => {
    const author = consoleMessageAuthor(validatePrincipal(human));
    expect(author).toMatchObject({ kind: 'human', display_name: 'Steven' });
    expect(author?.subject_id).toMatch(/^human:[a-f0-9]{64}$/u);
    expect(JSON.stringify(author)).not.toContain(human.operator_id);
    expect(consoleMessageAuthor({ ...human, session_id: 'new-session' })).toEqual(author);
    expect(consoleMessageAuthor({ ...human, operator_profile: { id: 'console:two', display_name: 'Steven' } })?.subject_id)
      .not.toBe(author?.subject_id);
    expect(consoleMessageAuthor({ ...human, tenant_id: 'Pablo' })?.subject_id).not.toBe(author?.subject_id);
  });

  it('uses an honest generic human identity when a verified profile label is absent', () => {
    const { operator_profile: _profile, ...actor } = human;
    void _profile;
    expect(consoleMessageAuthor(actor)?.display_name).toBeNull();
    const { operator_id: _operator, ...machine } = actor;
    void _operator;
    expect(consoleMessageAuthor(machine)).toBeUndefined();
    expect(consoleMessageAuthor({ ...human, roles: ['agent'] })).toBeUndefined();
  });

  it('passes self-authorship separately while preserving technical tenant, actor and receipt semantics', async () => {
    const { app, publish } = await gateway();
    const response = await app.inject({ method: 'POST', url: '/v3/console/messages', headers, payload });
    expect(response.statusCode).toBe(202);
    const published = publish.mock.calls[0];
    if (published === undefined) throw new Error('expected a publish call');
    const [command, options] = published;
    expect(command).toMatchObject({ tenant_id: 'Steven', actor_alias: 'kant', body: payload.body });
    expect(command.authenticated_context).toEqual({ session_id: 'session-one', channel: 'console' });
    expect(options).toMatchObject({ requirePreparedConsoleIntent: true, consoleAuthor: consoleMessageAuthor(human) });
    expect(options?.consoleIntentOperatorScope).toMatch(/^[a-f0-9]{64}$/u);
    expect(response.json()).toMatchObject({ request_hash: publishRequestHash(command), actor_alias: 'kant', tenant_id: 'Steven' });
  });

  it.each(['author', 'consoleAuthor', 'actor_alias', 'tenant_id', 'operator_profile'])('rejects the client authority field %s', async (key) => {
    const { app, publish } = await gateway();
    const response = await app.inject({ method: 'POST', url: '/v3/console/messages', headers, payload: { ...payload, [key]: 'forged' } });
    expect(response.statusCode).toBe(400);
    expect(publish).not.toHaveBeenCalled();
  });

  it('cannot derive a human author from message-body metadata or machine headers', async () => {
    const actor: Principal = { tenant_id: 'Steven', alias: 'kant', session_id: 'machine', channel: 'mtls', roles: ['agent'], permissions: ['route', 'read'] };
    const { app, publish } = await gateway(actor);
    const response = await app.inject({ method: 'POST', url: '/v3/console/messages', headers: { ...headers, 'x-cauce-operator': 'pretend-owner' },
      payload: { ...payload, body: { ...payload.body, author: consoleMessageAuthor(human), operator_id: 'forged' } } });
    expect(response.statusCode).toBe(202);
    expect(publish.mock.calls[0]?.[1]?.consoleAuthor).toBeUndefined();
  });

  it('does not stamp a machine publish endpoint as interactive human input', async () => {
    const { app, publish } = await gateway();
    const response = await app.inject({ method: 'POST', url: '/v3/messages', headers, payload });
    expect(response.statusCode).toBe(202);
    expect(publish.mock.calls[0]?.[1]?.consoleAuthor).toBeUndefined();
  });

  it('keeps the same message visibility before exposing any human snapshot', async () => {
    const row = { message_id: ids.message, tenant_id: 'Steven', actor_alias: 'kant', author: consoleMessageAuthor(human), deliveries: [] };
    const foreign = { ...row, message_id: ids.delivery, tenant_id: 'Pablo', actor_alias: 'midas' };
    const { app } = await gateway(human, { listMessages: vi.fn(async () => ({ items: [row, foreign] })) });
    const response = await app.inject({ method: 'GET', url: '/v3/console/messages', headers });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [row] });
    const hidden = await gateway(human, { getMessage: vi.fn(async () => foreign) });
    const detail = await hidden.app.inject({ method: 'GET', url: `/v3/console/messages/${ids.message}`, headers });
    expect(detail.statusCode).toBe(404);
    expect(detail.body).not.toContain('subject_id');
  });

});
