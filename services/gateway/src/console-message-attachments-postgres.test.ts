import { createHash } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPool, type DatabaseClient, type DatabasePool } from '@cauce/store';
import type { Tenant } from '@cauce/protocol';
import { startTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';
import { loadMessageDetail } from '../../../packages/store/src/repository/messages/message-detail.js';
import { FixedAuthProvider, testPrincipal } from './test-support/gateway-doubles.js';
import { registerConsoleMessageAttachmentRoutes } from './routes/console/message-attachments.js';

let database: TestDatabase | undefined;
const id = 'cccccccc-3333-4333-8333-333333333333';
const payload = Buffer.from([0, 1, 255, 128]);
const attachment = {
  kind: 'document', name: 'audio.ogg', mime_type: 'audio/ogg', file_size: payload.length,
  sha256: createHash('sha256').update(payload).digest('hex'), content_base64: payload.toString('base64'),
};
let pool: DatabasePool;
let client: DatabaseClient;
const apps: FastifyInstance[] = [];

describe('attachment authorization on isolated PostgreSQL temporary tables', () => {
  beforeAll(async () => { database = await startTestDatabase(); }, 180_000);
  afterAll(async () => {
    if (database === undefined) return;
    try { await database.pool.end(); } finally { await database.container.stop(); }
  });
  beforeEach(async () => {
    if (database === undefined) throw new Error('Attachment fixture database unavailable');
    pool = createPool(database.url, { max: 1, connectionTimeoutMillis: 3_000 });
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query(`
      CREATE TEMP TABLE messages (
        id uuid PRIMARY KEY, tenant_id text, room_id text, actor_alias text, body jsonb,
        version int DEFAULT 3, request_id text, trace_id text, auth_channel text, origin jsonb, lane text,
        priority int, created_at timestamptz DEFAULT now()
      ) ON COMMIT DROP;
      CREATE TEMP TABLE deliveries (
        id uuid PRIMARY KEY, message_id uuid, recipient_tenant text, recipient_alias text,
        status text, attempt int, terminal_at timestamptz, result jsonb, created_at timestamptz DEFAULT now()
      ) ON COMMIT DROP;
      CREATE TEMP TABLE memberships (
        tenant_id text, room_id text, alias text, role text, enabled boolean
      ) ON COMMIT DROP;
      CREATE TEMP TABLE role_policies (role text, allow_read boolean) ON COMMIT DROP;
      CREATE TEMP TABLE acl_edges (
        from_tenant text, to_tenant text, enabled boolean, allow_read boolean
      ) ON COMMIT DROP;
      CREATE TEMP TABLE audit_events (
        trace_id text, request_id text, message_id uuid, tenant_id text,
        actor_alias text, action text, decision text, metadata jsonb
      ) ON COMMIT DROP;
      INSERT INTO role_policies VALUES ('reader',true);
      INSERT INTO memberships VALUES
        ('Pablo','source','midas','reader',true),
        ('Pablo','source','socrates','reader',true),
        ('Steven','recipient','kant','reader',true);
      INSERT INTO acl_edges VALUES ('Steven','Pablo',true,true);
    `);
    await client.query('INSERT INTO messages(id,tenant_id,room_id,actor_alias,body) VALUES ($1,$2,$3,$4,$5)',
      [id, 'Pablo', 'source', 'midas', JSON.stringify({ text: 'hello', attachments_v1: [attachment] })]);
    await client.query(`INSERT INTO deliveries(id,message_id,recipient_tenant,recipient_alias)
      VALUES ('dddddddd-1111-4111-8111-111111111111',$1,'Steven','kant')`, [id]);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(apps.splice(0).map((app) => app.close()));
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  });

  async function download(tenant: Tenant, alias: string, index = '0') {
    const app = Fastify();
    apps.push(app);
    registerConsoleMessageAttachmentRoutes(app, {
      pool: client as unknown as DatabasePool,
      authProvider: new FixedAuthProvider(testPrincipal({ tenant_id: tenant, alias })),
    });
    return app.inject({ method: 'GET', url: `/v3/console/messages/${id}/attachments/${index}` });
  }

  it.each([['Pablo', 'midas'], ['Steven', 'kant']] as const)('returns authorized %s/%s bytes in one SQL statement', async (tenant, alias) => {
    const query = vi.spyOn(client, 'query');
    const response = await download(tenant, alias);
    expect(response.statusCode).toBe(200);
    expect(response.rawPayload).toEqual(payload);
    expect(createHash('sha256').update(response.rawPayload).digest('hex')).toBe(attachment.sha256);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('denies a source-room reader who is neither sender nor recipient', async () => {
    expect((await download('Pablo', 'socrates')).statusCode).toBe(404);
  });

  it.each([
    "UPDATE memberships SET enabled=false WHERE tenant_id='Steven'",
    "DELETE FROM memberships WHERE tenant_id='Steven'",
    "UPDATE role_policies SET allow_read=false",
    "DELETE FROM role_policies",
    "UPDATE acl_edges SET enabled=false",
    "UPDATE acl_edges SET allow_read=false",
    "DELETE FROM acl_edges",
    "UPDATE acl_edges SET from_tenant='Pablo',to_tenant='Steven'",
    "DELETE FROM deliveries",
  ])('returns 404 after authorization is revoked: %s', async (sql) => {
    expect((await download('Steven', 'kant')).statusCode).toBe(200);
    await client.query(sql);
    const response = await download('Steven', 'kant');
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'not_found', message: 'message not found or not visible' });
    expect(response.body).not.toContain(attachment.content_base64);
  });

  it('does not authorize a foreign room membership without a participant delivery and ACL', async () => {
    await client.query("UPDATE memberships SET room_id='source' WHERE tenant_id='Steven'");
    await client.query('DELETE FROM deliveries');
    expect((await download('Steven', 'kant')).statusCode).toBe(404);
  });

  it('allows a same-tenant recipient with membership in another room, without an ACL', async () => {
    await client.query("UPDATE memberships SET room_id='recipient' WHERE alias='socrates'");
    await client.query("UPDATE deliveries SET recipient_tenant='Pablo',recipient_alias='socrates'");
    await client.query('DELETE FROM acl_edges');
    expect((await download('Pablo', 'socrates')).statusCode).toBe(200);
  });

  it('denies a sender after membership disablement or loss of room access', async () => {
    await client.query("UPDATE memberships SET enabled=false WHERE alias='midas'");
    expect((await download('Pablo', 'midas')).statusCode).toBe(404);
    await client.query("UPDATE memberships SET enabled=true,room_id='other' WHERE alias='midas'");
    expect((await download('Pablo', 'midas')).statusCode).toBe(404);
  });

  it('retains unfiltered raw metadata indices and excludes base64 from detail', async () => {
    await client.query('UPDATE messages SET body=$1', [JSON.stringify({ attachments_v1: [null, attachment] })]);
    const detail = await loadMessageDetail(client, id, 'Pablo', 'midas');
    expect(Reflect.get(detail, 'client_origin')).toBeNull();
    const rendered = JSON.stringify(detail);
    expect(rendered).not.toContain('attachments_v1');
    expect(rendered).not.toContain('content_base64');
    expect(rendered).not.toContain(attachment.content_base64);
    const metadata: unknown = Reflect.get(detail, 'attachments');
    expect(metadata).toEqual([
      { name: null, mime_type: null, file_size: null, sha256: null },
      { name: attachment.name, mime_type: attachment.mime_type, file_size: attachment.file_size, sha256: attachment.sha256 },
    ]);
    expect((await download('Pablo', 'midas', '1')).statusCode).toBe(404);
  });
});
