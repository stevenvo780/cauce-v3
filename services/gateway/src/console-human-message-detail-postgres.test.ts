import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PublishResultSchema } from '@cauce/protocol';
import { consumeConsoleRoots, object, startConsoleLedgerFixture, type Session } from '../../../tests/e2e/console-password-human-ledger.fixtures.js';
import { buildTestGateway, FixedAuthProvider, testPrincipal } from './test-support/gateway-doubles.js';
import { hashPassword } from './password.js';

let fixture: Awaited<ReturnType<typeof startConsoleLedgerFixture>> | undefined;
const apps: FastifyInstance[] = [];
const bytes = Buffer.from([0, 1, 127, 128, 255]);
const attachment = { kind: 'document', name: 'owner.png', mime_type: 'image/png', file_size: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'), content_base64: bytes.toString('base64') };
function current() { if (!fixture) throw new Error('Fixture unavailable'); return fixture; }
async function gateway(machine = false) {
  const context = current();
  const app = await buildTestGateway({ pool: context.pool, repository: context.repository,
    authProvider: machine ? new FixedAuthProvider(testPrincipal({ tenant_id: context.tenant, alias: context.actor, roles: ['operator'] })) : context.provider });
  apps.push(app); return app;
}
async function publish(session: Session) {
  const context = current(); const command = context.command();
  const withMedia = { ...command, body: { text: 'Private owner fixture body', attachments_v1: [attachment] } };
  const prepared = await context.prepare(session, withMedia);
  const response = await context.send('/v3/console/messages', prepared.body, session);
  expect(response.status).toBe(202); const receipt = PublishResultSchema.parse(response.body);
  const confirmed = await context.send('/v3/console/publish-intents/confirm', { idempotency_key: receipt.idempotency_key,
    message_id: receipt.message_id, causal_hash: receipt.causal_hash }, session);
  expect(confirmed.status).toBe(200); return receipt.message_id;
}
async function publishLegacy() {
  const context = current();
  const receipt = await context.repository.publish({ version: '3.0', idempotency_key: `legacy:${randomUUID()}`,
    request_id: randomUUID(), trace_id: randomUUID(), tenant_id: context.tenant, actor_alias: context.actor,
    room_id: context.room, recipients: [{ tenant_id: context.tenant, alias: context.target }], body: { text: 'Visible legacy text' },
    origin: { adapter: 'fixture', channel: 'fixture', conversation_id: 'fixture', relay: [], metadata: {} }, lane: 'interactive', priority: 1 });
  return receipt.message_id;
}
function detail(app: FastifyInstance, id: string, session?: Session) {
  return app.inject({ method: 'GET', url: `/v3/console/messages/${id}`,
    ...(session ? { headers: { cookie: session.cookie } } : {}) });
}
beforeAll(async () => { fixture = await startConsoleLedgerFixture(); }, 120_000);
afterAll(async () => { try { await Promise.all(apps.splice(0).map((app) => app.close())); } finally { await fixture?.close(); } });
describe('durable human detail fallback on PostgreSQL', () => {
  it('keeps owner metadata and canonical reply but denies another human sharing tenant and alias', async () => {
    const context = current(); const a = await context.login(0); const b = await context.login(1); const id = await publish(a);
    await consumeConsoleRoots(context, [id]); const app = await gateway();
    const owner = await detail(app, id, a); expect(owner.statusCode).toBe(200);
    const body = object(owner.json()); expect(object(body.body).text).toBe('Private owner fixture body');
    expect(body.attachments).toEqual([expect.objectContaining({ name: attachment.name, mime_type: attachment.mime_type,
      file_size: attachment.file_size, sha256: attachment.sha256 })]);
    expect(body.deliveries).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'done', reply: `owned output ${String(context.users[0]?.id)}` })]));
    expect(owner.body).not.toContain('content_base64');
    const other = await detail(app, id, b); expect(other.statusCode).toBe(404);
    expect(other.body).not.toContain('Private owner fixture body'); expect(other.body).not.toContain(attachment.name);
  });
  it('preserves legacy text with no human ledger and refuses a forged UUID', async () => {
    const context = current(); const session = await context.login(0); const id = await publishLegacy(); const app = await gateway();
    expect((await context.pool.query('SELECT message_id FROM human_message_initiators WHERE message_id=$1', [id])).rowCount).toBe(0);
    const response = await detail(app, id, session); expect(response.statusCode).toBe(200);
    expect(object(object(response.json()).body).text).toBe('Visible legacy text');
    expect((await detail(app, randomUUID(), session)).statusCode).toBe(404);
    expect((await detail(app, id)).statusCode).toBe(401);
  });
  it('keeps legacy text readable with a durable reader role', async () => {
    const context = current(); const user = context.users[0]; if (!user) throw new Error('Missing owner');
    const id = await publishLegacy();
    try {
      await context.pool.query("UPDATE console_users SET role='reader' WHERE id=$1", [user.id]);
      await context.pool.query("UPDATE human_tenant_memberships SET role='reader',permissions=ARRAY['read'] WHERE human_id=$1", [user.id]);
      const session = await context.login(0); const response = await detail(await gateway(), id, session);
      expect(response.statusCode).toBe(200); expect(object(object(response.json()).body).text).toBe('Visible legacy text');
    } finally {
      await context.pool.query("UPDATE console_users SET role='operator' WHERE id=$1", [user.id]);
      await context.pool.query("UPDATE human_tenant_memberships SET role='operator',permissions=ARRAY['route','read'] WHERE human_id=$1", [user.id]);
    }
  });
  it.each(['permission', 'revoked', 'stamp', 'binding'] as const)('preserves %s authority rejection for the legacy fallback', async (condition) => {
    const context = current(); const user = context.users[0]; if (!user) throw new Error('Missing owner');
    const session = await context.login(0); const id = await publishLegacy(); const app = await gateway();
    try {
      if (condition === 'permission') await context.pool.query("UPDATE human_tenant_memberships SET permissions=ARRAY['route'] WHERE human_id=$1", [user.id]);
      if (condition === 'revoked') await context.pool.query('UPDATE human_tenant_memberships SET enabled=false,revoked_at=clock_timestamp() WHERE human_id=$1', [user.id]);
      if (condition === 'stamp') await context.pool.query('UPDATE console_users SET password_hash=$2 WHERE id=$1', [user.id, await hashPassword(randomUUID())]);
      if (condition === 'binding') await context.pool.query('UPDATE human_tenant_memberships SET actor_alias=$2 WHERE human_id=$1', [user.id, context.target]);
      const response = await detail(app, id, session);
      expect(response.statusCode).toBe(condition === 'stamp' ? 401 : condition === 'binding' ? 409 : 403);
      expect(response.body).not.toContain('Visible legacy text');
    } finally {
      await context.pool.query("UPDATE human_tenant_memberships SET enabled=true,revoked_at=NULL,permissions=ARRAY['route','read'],actor_alias=$2 WHERE human_id=$1", [user.id, context.actor]);
      if (condition === 'stamp') await context.pool.query('UPDATE console_users SET password_hash=$2 WHERE id=$1', [user.id, await hashPassword(user.password)]);
    }
  });
  it('preserves machine shared detail without changing human ledger ownership', async () => {
    const context = current(); const id = await publish(await context.login(0)); const response = await detail(await gateway(true), id);
    expect(response.statusCode).toBe(200); expect(object(object(response.json()).body).text).toBe('Private owner fixture body');
    expect((await context.pool.query('SELECT initiating_human_id FROM human_message_initiators WHERE message_id=$1', [id])).rows)
      .toEqual([{ initiating_human_id: context.users[0]?.id }]);
  });
});
