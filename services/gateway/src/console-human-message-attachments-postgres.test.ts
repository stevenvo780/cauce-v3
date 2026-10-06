import { createHash, randomBytes, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PublishResultSchema } from '@cauce/protocol';
import { startConsoleLedgerFixture, type Session } from '../../../tests/e2e/console-password-human-ledger.fixtures.js';
import { registerConsoleMessageAttachmentRoutes } from './routes/console/message-attachments.js';
import { FixedAuthProvider, testPrincipal } from './test-support/gateway-doubles.js';
import { maintainConsoleUser } from './console-user-maintenance.js';
import { hashPassword } from './password.js';

let fixture: Awaited<ReturnType<typeof startConsoleLedgerFixture>> | undefined;
const apps: FastifyInstance[] = [];
const bytes = Buffer.from([0, 1, 127, 128, 255]);
const attachment = { kind: 'document', name: 'voice.ogg', mime_type: 'audio/ogg', file_size: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'), content_base64: bytes.toString('base64') };
function current() { if (!fixture) throw new Error('Fixture unavailable'); return fixture; }
function appForHuman() {
  const context = current(); const app = Fastify(); apps.push(app);
  registerConsoleMessageAttachmentRoutes(app, { pool: context.pool, authProvider: context.provider }); return app;
}
async function publish(session: Session) {
  const context = current(); const command = context.command();
  const withMedia = { ...command, body: { ...command.body, attachments_v1: [attachment] } };
  const prepared = await context.prepare(session, withMedia);
  const response = await context.send('/v3/console/messages', prepared.body, session);
  expect(response.status).toBe(202); return PublishResultSchema.parse(response.body).message_id;
}
function download(app: FastifyInstance, id: string, session?: Session) {
  return app.inject({ method: 'GET', url: `/v3/console/messages/${id}/attachments/0`,
    ...(session ? { headers: { cookie: session.cookie } } : {}) });
}
beforeAll(async () => { fixture = await startConsoleLedgerFixture(); }, 120_000);
afterAll(async () => { try { await Promise.all(apps.splice(0).map((app) => app.close())); } finally { await fixture?.close(); } });
describe('password-authenticated human attachment ownership on PostgreSQL', () => {
  it('returns exact bytes to A and denies B sharing the same tenant and operator alias', async () => {
    const context = current(); const a = await context.login(0); const b = await context.login(1);
    const id = await publish(a); const app = appForHuman();
    expect(context.users[0]?.id).not.toBe(context.users[1]?.id);
    const owner = await download(app, id, a); expect(owner.statusCode).toBe(200); expect(owner.rawPayload).toEqual(bytes);
    expect(owner.headers['content-type']).toBe('audio/ogg'); expect(owner.headers['cache-control']).toBe('private, no-store');
    expect(owner.headers['content-security-policy']).toContain('sandbox');
    const other = await download(app, id, b); expect(other.statusCode).toBe(404);
    expect(other.body).not.toContain(attachment.content_base64);
  });
  it('denies a real foreign-tenant human and anonymous access', async () => {
    const context = current(); const a = await context.login(0); const id = await publish(a); const app = appForHuman();
    const password = randomBytes(24).toString('base64url'); const email = `foreign-${randomUUID()}@fixture.invalid`;
    await context.pool.query(`INSERT INTO agents(tenant_id,alias,harness_id,enabled,container_name,runtime_user,home_directory,state_directory) VALUES('Jhon',$1,'claude',true,$2,'dev','/home/dev','/home/dev/.cauce')`, [context.actor, `own-foreign-${randomUUID()}`]);
    await maintainConsoleUser(context.pool, { email, name: 'Foreign fixture', role: 'operator', tenant: 'Jhon',
      alias: context.actor, updateOnly: false, activate: false }, await hashPassword(password));
    const login = await context.send('/v3/auth/login', { email, password }); expect(login.status).toBe(200);
    if (!login.cookie) throw new Error('Missing foreign session cookie');
    expect((await download(app, id, { cookie: login.cookie, csrf: '' })).statusCode).toBe(404);
    expect((await download(app, id)).statusCode).toBe(401);
  });
  it.each(['permission', 'revoked', 'stamp', 'binding', 'room'] as const)('rejects stale %s without returning bytes', async (condition) => {
    const context = current(); const session = await context.login(0); const id = await publish(session); const app = appForHuman();
    const humanId = context.users[0]?.id; if (!humanId) throw new Error('Missing owner');
    try {
      if (condition === 'permission') await context.pool.query("UPDATE human_tenant_memberships SET permissions=ARRAY['route'] WHERE human_id=$1", [humanId]);
      if (condition === 'revoked') await context.pool.query('UPDATE human_tenant_memberships SET enabled=false,revoked_at=clock_timestamp() WHERE human_id=$1', [humanId]);
      if (condition === 'stamp') await context.pool.query('UPDATE console_users SET password_hash=$2 WHERE id=$1', [humanId, await hashPassword(randomUUID())]);
      if (condition === 'binding') await context.pool.query('UPDATE human_tenant_memberships SET actor_alias=$2 WHERE human_id=$1', [humanId, context.target]);
      if (condition === 'room') await context.pool.query('UPDATE memberships SET enabled=false WHERE tenant_id=$1 AND room_id=$2 AND alias=$3', [context.tenant, context.room, context.actor]);
      const response = await download(app, id, session);
      expect(response.statusCode).toBe(condition === 'stamp' ? 401 : condition === 'binding' ? 409 : condition === 'room' ? 404 : 403);
      expect(response.body).not.toContain(attachment.content_base64);
    } finally {
      await context.pool.query("UPDATE human_tenant_memberships SET enabled=true,revoked_at=NULL,permissions=ARRAY['route','read'],actor_alias=$2 WHERE human_id=$1", [humanId, context.actor]);
      if (condition === 'stamp') await context.pool.query('UPDATE console_users SET password_hash=$2 WHERE id=$1', [humanId, await hashPassword(context.users[0]?.password ?? '')]);
      await context.pool.query('UPDATE memberships SET enabled=true WHERE tenant_id=$1 AND room_id=$2 AND alias=$3', [context.tenant, context.room, context.actor]);
    }
  });
  it('preserves authorized static nonhuman downloads without admitting legacy roots to human sessions', async () => {
    const context = current(); const human = await context.login(0);
    const result = await context.repository.publish({ version: '3.0', idempotency_key: `legacy:${randomUUID()}`, request_id: randomUUID(), trace_id: randomUUID(),
      tenant_id: context.tenant, actor_alias: context.actor, room_id: context.room,
      recipients: [{ tenant_id: context.tenant, alias: context.target }], body: { text: 'Legacy fixture', attachments_v1: [attachment] },
      origin: { adapter: 'fixture', channel: 'fixture', conversation_id: 'fixture', relay: [], metadata: {} }, lane: 'interactive', priority: 1 });
    const staticApp = Fastify(); apps.push(staticApp);
    registerConsoleMessageAttachmentRoutes(staticApp, { pool: context.pool,
      authProvider: new FixedAuthProvider(testPrincipal({ tenant_id: context.tenant, alias: context.actor })) });
    expect((await download(staticApp, result.message_id)).rawPayload).toEqual(bytes);
    expect((await download(appForHuman(), result.message_id, human)).statusCode).toBe(404);
  });
});
