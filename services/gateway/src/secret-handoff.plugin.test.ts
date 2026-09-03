import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  generateSealingKeyPair, openSealedSecret, sealSecret,
  type SealingKeyPair, type SecretHandoffBinding,
} from '@cauce/protocol';
import { createPool, type DatabasePool } from '@cauce/store';
import {
  dockerTestRequirement, resetTestDatabase, startTestDatabase, type TestDatabase,
} from '../../../tests/helpers/postgres.js';
import type { AuthProvider, Principal } from './auth.js';
import { registerSecretHandoffPlane } from './secret-handoff/routes.js';

const VALUE = 'sk-ant-valor-que-nunca-viaja-en-claro';
const LABEL = 'ANTHROPIC_API_KEY';
const requirement = dockerTestRequirement(
  'the gateway sealed credential hand-off plane against PostgreSQL',
);

interface AuditRow {
  readonly tenant_id: string;
  readonly actor_alias: string;
  readonly action: string;
  readonly decision: string;
  readonly metadata: Record<string, unknown>;
}

interface Injected {
  readonly statusCode: number;
  readonly body: string;
}

let database: TestDatabase | undefined;
let pool: DatabasePool;
let app: FastifyInstance;
let appStarted = false;
let actor: Principal;
let recipientKey: SealingKeyPair;

function principalOf(tenant: string, alias: string, overrides: Partial<Principal> = {}): Principal {
  return {
    tenant_id: tenant, alias, session_id: `session-${alias}`, channel: 'agent',
    roles: ['agent'], permissions: ['route', 'read'], ...overrides,
  };
}

async function closeApp(): Promise<void> {
  if (!appStarted) return;
  appStarted = false;
  await app.close();
}

function instant(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

/**
 * Back-dates every hand-off so it is already expired. Both columns move together because the
 * database CHECK forbids `expires_at` behind `created_at`, which is the only way a row can be made
 * to look expired at all.
 */
async function expireAll(expiredAgo: string): Promise<void> {
  await pool.query(
    `UPDATE secret_handoffs
        SET created_at=now() - $1::interval - interval '1 hour',
            expires_at=now() - $1::interval`,
    [expiredAgo],
  );
}

async function seedAgents(): Promise<void> {
  await pool.query(`
    INSERT INTO agents(
      tenant_id,alias,harness_id,display_name,enabled,
      container_name,runtime_user,home_directory,state_directory
    ) VALUES
      ('Steven','kant','claude','Kant',true,'ctrl-infra','dev','/home/dev','/home/dev/.cauce/kant'),
      ('Steven','argos','claude','Argos',true,'ctrl-infra','dev','/home/dev','/home/dev/.cauce/argos'),
      ('Steven','jarvis','claude','Jarvis',true,'claw','claw','/home/claw','/home/claw/.cauce/jarvis'),
      ('Miguel','janus','claude','Janus',true,'claw-miguel','claw','/home/claw','/home/claw/.cauce/janus'),
      ('Pablo','dedalo','claude','Dedalo',true,'ws-pablo-dev','dev','/home/dev','/home/dev/.cauce/dedalo')
    ON CONFLICT(tenant_id,alias) DO UPDATE SET enabled=true
  `);
}

async function auditRows(): Promise<AuditRow[]> {
  const result = await pool.query<AuditRow>(
    `SELECT tenant_id,actor_alias,action,decision,metadata FROM audit_events
      WHERE action LIKE 'secret.%' ORDER BY id`,
  );
  return result.rows;
}

async function publishRecipientKey(keyId = 'k1', pair = recipientKey): Promise<number> {
  actor = principalOf('Steven', 'argos');
  const response = await app.inject({
    method: 'POST', url: '/v3/sealing-keys',
    payload: {
      key_id: keyId, algorithm: 'x25519', public_key: pair.publicKey.toString('base64'),
    },
  });
  return response.statusCode;
}

async function publishKey(payload: Record<string, unknown>): Promise<number> {
  return (await app.inject({ method: 'POST', url: '/v3/sealing-keys', payload })).statusCode;
}

/** The destructive step is a POST: a GET must never be able to consume a hand-off. */
async function claim(id: string): Promise<Injected> {
  return app.inject({ method: 'POST', url: `/v3/secrets/${id}/claim` });
}

async function advertisedKey(tenant: string, alias: string): Promise<Injected> {
  return app.inject({ method: 'GET', url: `/v3/sealing-keys/${tenant}/${alias}` });
}

async function revoke(id: string): Promise<Injected> {
  return app.inject({ method: 'DELETE', url: `/v3/secrets/${id}` });
}

async function planeOn(target: DatabasePool): Promise<FastifyInstance> {
  const isolated = Fastify({ logger: false });
  await isolated.register(registerSecretHandoffPlane, {
    pool: target,
    authProvider: {
      name: 'test-agent', mode: 'test',
      authenticateHttp: async () => actor,
      authenticateHello: async () => actor,
    } satisfies AuthProvider,
  });
  await isolated.ready();
  return isolated;
}

interface Page {
  readonly handoffs: { readonly id: string }[];
  readonly next_cursor: string | null;
}

async function pending(cursor?: string): Promise<Page> {
  const url = cursor === undefined
    ? '/v3/secrets'
    : `/v3/secrets?cursor=${encodeURIComponent(cursor)}`;
  return JSON.parse((await app.inject({ method: 'GET', url })).body) as Page;
}

interface HandoffOptions {
  readonly id?: string;
  readonly toTenant?: string;
  readonly toAlias?: string;
  readonly keyId?: string;
  readonly expiresAt?: string;
  readonly value?: string;
  readonly publicKey?: Buffer;
}

function sealedBody(options: HandoffOptions = {}): Record<string, unknown> {
  const id = options.id ?? randomUUID();
  const binding: SecretHandoffBinding = {
    id,
    fromTenant: 'Steven',
    fromAlias: 'kant',
    toTenant: options.toTenant ?? 'Steven',
    toAlias: options.toAlias ?? 'argos',
  };
  const sealed = sealSecret({
    recipientPublicKey: options.publicKey ?? recipientKey.publicKey,
    keyId: options.keyId ?? 'k1',
    binding,
    plaintext: Buffer.from(options.value ?? VALUE, 'utf8'),
  });
  return {
    id,
    to_tenant: binding.toTenant,
    to_alias: binding.toAlias,
    label: LABEL,
    sealing_key_id: options.keyId ?? 'k1',
    ephemeral_public: sealed.ephemeralPublic.toString('base64'),
    nonce: sealed.nonce.toString('base64'),
    sealed: sealed.sealed.toString('base64'),
    expires_at: options.expiresAt ?? instant(3_600_000),
  };
}

async function grant(options: HandoffOptions = {}): Promise<{
  status: number; body: Record<string, unknown>; request: Record<string, unknown>;
}> {
  const request = sealedBody(options);
  const response = await app.inject({ method: 'POST', url: '/v3/secrets', payload: request });
  return {
    status: response.statusCode,
    body: response.body === '' ? {} : (JSON.parse(response.body) as Record<string, unknown>),
    request,
  };
}

function opened(payload: Record<string, string>, id: string): string {
  const field = (name: string): Buffer => Buffer.from(payload[name] ?? '', 'base64');
  return openSealedSecret({
    privateKey: recipientKey.privateKey,
    ephemeralPublic: field('ephemeral_public'),
    nonce: field('nonce'),
    sealed: field('sealed'),
    keyId: 'k1',
    binding: {
      id, fromTenant: 'Steven', fromAlias: 'kant', toTenant: 'Steven', toAlias: 'argos',
    },
  }).toString('utf8');
}

beforeEach(async (context) => {
  if (database === undefined && !process.env.CAUCE_TEST_DATABASE_URL) {
    await requirement.skipIfUnavailable(context.skip);
  }
  database ??= await startTestDatabase();
  pool = database.pool;
  await resetTestDatabase(pool);
  await seedAgents();
  recipientKey = generateSealingKeyPair();
  actor = principalOf('Steven', 'kant');
  const authProvider: AuthProvider = {
    name: 'test-agent', mode: 'test',
    authenticateHttp: async () => actor,
    authenticateHello: async () => actor,
  };
  await closeApp();
  app = Fastify({ logger: false });
  await app.register(registerSecretHandoffPlane, { pool, authProvider });
  await app.ready();
  appStarted = true;
}, 180_000);

afterAll(async () => {
  await closeApp();
  if (database === undefined) return;
  await pool.end();
  await database.container.stop();
});

describe('sealed credential hand-off plane', () => {
  it('publishes only the caller own sealing key and refuses a rebind', async () => {
    expect(await publishRecipientKey()).toBe(201);
    expect(await publishRecipientKey()).toBe(201);
    expect(await publishRecipientKey('k1', generateSealingKeyPair())).toBe(409);

    actor = principalOf('Steven', 'kant');
    const impersonation = await app.inject({
      method: 'POST', url: '/v3/sealing-keys',
      payload: {
        tenant_id: 'Steven', alias: 'argos', key_id: 'k2', algorithm: 'x25519',
        public_key: recipientKey.publicKey.toString('base64'),
      },
    });
    expect(impersonation.statusCode).toBe(400);
    const keys = await pool.query<{ alias: string }>(`SELECT alias FROM agent_sealing_keys`);
    expect(keys.rows).toEqual([{ alias: 'argos' }]);
  });

  it('audits every publication and never re-enables a disabled key', async () => {
    expect(await publishRecipientKey()).toBe(201);
    const published = (await auditRows()).filter((row) => row.action === 'secret.key_published');
    expect(published).toHaveLength(1);
    expect(published[0]?.actor_alias).toBe('argos');
    expect(published[0]?.metadata).toMatchObject({ key_id: 'k1' });
    expect(String(published[0]?.metadata.key_fingerprint)).toMatch(/^[0-9a-f]{16}$/u);
    expect(JSON.stringify(published[0]?.metadata))
      .not.toContain(recipientKey.publicKey.toString('base64'));

    await pool.query(`UPDATE agent_sealing_keys SET enabled=false`);
    expect(await publishRecipientKey()).toBe(201);
    const state = await pool.query<{ enabled: boolean }>(`SELECT enabled FROM agent_sealing_keys`);
    expect(state.rows).toEqual([{ enabled: false }]);

    actor = principalOf('Steven', 'kant');
    expect((await grant()).status).toBe(409);
  });

  it('publishes a sealing key only with the permission the recipient half of the plane needs', async () => {
    const material = recipientKey.publicKey.toString('base64');
    actor = principalOf('Steven', 'argos', { permissions: ['route'] });
    expect(await publishKey({ key_id: 'k1', algorithm: 'x25519', public_key: material })).toBe(403);
    expect((await pool.query(`SELECT 1 FROM agent_sealing_keys`)).rowCount).toBe(0);
  });

  it('audits a publication only when the advertised identity changes', async () => {
    expect(await publishRecipientKey()).toBe(201);
    const key = { key_id: 'k1', algorithm: 'x25519' };
    const bytes = recipientKey.publicKey.toString('base64');
    for (let touch = 0; touch < 20; touch += 1) {
      const moved = { ...key, public_key: bytes, not_after: instant(3_600_000 + touch) };
      expect(await publishKey(moved)).toBe(201);
    }
    const published = (await auditRows()).filter((r) => r.action === 'secret.key_published');
    expect(published).toHaveLength(1);
  });

  it('bounds how many sealing keys one alias may create inside the window', async () => {
    for (let index = 0; index < 8; index += 1) {
      expect(await publishRecipientKey(`k${String(index)}`, generateSealingKeyPair())).toBe(201);
    }
    expect(await publishRecipientKey('k8', generateSealingKeyPair())).toBe(429);
    const rows = await auditRows();
    expect(rows.filter((row) => row.action === 'secret.key_published')).toHaveLength(8);
    expect(rows.filter((row) => row.metadata.reason === 'sealing_key_ceiling')).toHaveLength(1);
  });

  it('refuses a sender without routing authority or without the route permission', async () => {
    await publishRecipientKey();
    actor = principalOf('Steven', 'kant', { permissions: ['read'] });
    expect((await grant()).status).toBe(403);

    actor = principalOf('Miguel', 'janus');
    const crossTenant = await app.inject({
      method: 'POST', url: '/v3/secrets',
      payload: { ...sealedBody({ toTenant: 'Pablo', toAlias: 'dedalo' }) },
    });
    expect(crossTenant.statusCode).toBe(403);

    const rows = await auditRows();
    expect(rows.map((row) => row.action)).toEqual(['secret.key_published', 'secret.denied']);
    expect(rows[1]?.decision).toBe('deny');
    const stored = await pool.query(`SELECT 1 FROM secret_handoffs`);
    expect(stored.rowCount).toBe(0);
  });

  it('hands a sealed secret over exactly once and never in clear', async () => {
    await publishRecipientKey();
    actor = principalOf('Steven', 'kant');
    const granted = await grant();
    expect(granted.status).toBe(201);
    const id = granted.body.id as string;

    actor = principalOf('Steven', 'argos');
    const listed = await app.inject({ method: 'GET', url: '/v3/secrets' });
    expect(listed.statusCode).toBe(200);
    expect(JSON.parse(listed.body)).toMatchObject({
      handoffs: [{ id, from_tenant: 'Steven', from_alias: 'kant', label: LABEL }],
    });

    const first = await claim(id);
    expect(first.statusCode).toBe(200);
    const payload = JSON.parse(first.body) as Record<string, string>;
    expect(payload.sealed).toBe(granted.request.sealed);
    expect(opened(payload, id)).toBe(VALUE);

    expect((await claim(id)).statusCode).toBe(410);
    const emptied = await app.inject({ method: 'GET', url: '/v3/secrets' });
    expect(JSON.parse(emptied.body)).toEqual({ handoffs: [], next_cursor: null });

    const rows = await auditRows();
    expect(rows.map((row) => `${row.action}:${row.decision}`)).toEqual([
      'secret.key_published:allow', 'secret.granted:allow',
      'secret.read:allow', 'secret.denied:deny',
    ]);
    expect(rows[1]?.metadata).toMatchObject({
      label: LABEL, recipient_tenant: 'Steven', recipient_alias: 'argos', sealing_key_id: 'k1',
    });
    expect(String(rows[1]?.metadata.sealed_sha256)).toMatch(/^[0-9a-f]{16}$/u);
  });

  it('cannot be consumed by a GET nor by a console principal', async () => {
    await publishRecipientKey();
    actor = principalOf('Steven', 'kant');
    const id = (await grant()).body.id as string;

    actor = principalOf('Steven', 'argos');
    const prefetched = await app.inject({ method: 'GET', url: `/v3/secrets/${id}` });
    expect(prefetched.statusCode).toBe(404);
    expect(prefetched.body).not.toContain(VALUE);

    actor = principalOf('Steven', 'argos', { channel: 'console' });
    expect((await claim(id)).statusCode).toBe(403);

    actor = principalOf('Steven', 'argos');
    const claimed = await claim(id);
    expect(claimed.statusCode).toBe(200);
    expect(opened(JSON.parse(claimed.body) as Record<string, string>, id)).toBe(VALUE);
  });

  it('gives a sender the recipient current public key and completes the round trip', async () => {
    await publishRecipientKey();
    actor = principalOf('Steven', 'kant');
    const advertised = await advertisedKey('Steven', 'argos');
    expect(advertised.statusCode).toBe(200);
    const key = JSON.parse(advertised.body) as Record<string, string | null>;
    expect(key).toMatchObject({
      tenant_id: 'Steven', alias: 'argos', key_id: 'k1', algorithm: 'x25519', not_after: null,
    });
    expect(Buffer.from(String(key.public_key), 'base64')).toEqual(recipientKey.publicKey);

    const granted = await grant({
      publicKey: Buffer.from(String(key.public_key), 'base64'), keyId: String(key.key_id),
    });
    expect(granted.status).toBe(201);
    const id = granted.body.id as string;

    actor = principalOf('Steven', 'argos');
    const claimed = await claim(id);
    expect(claimed.statusCode).toBe(200);
    expect(opened(JSON.parse(claimed.body) as Record<string, string>, id)).toBe(VALUE);
  });

  it('refuses to advertise a key to a caller with no authority over the alias', async () => {
    await publishRecipientKey();
    actor = principalOf('Miguel', 'janus');
    expect((await advertisedKey('Pablo', 'dedalo')).statusCode).toBe(403);

    actor = principalOf('Steven', 'kant', { permissions: ['read'] });
    expect((await advertisedKey('Steven', 'argos')).statusCode).toBe(403);

    actor = principalOf('Steven', 'kant');
    expect((await advertisedKey('Steven', 'jarvis')).statusCode).toBe(404);
  });

  it('answers 404, never 403, to anybody who is not the recipient', async () => {
    await publishRecipientKey();
    actor = principalOf('Steven', 'kant');
    const id = (await grant()).body.id as string;

    actor = principalOf('Steven', 'jarvis');
    expect((await claim(id)).statusCode).toBe(404);
    expect((await revoke(id)).statusCode).toBe(404);
    expect(JSON.parse((await app.inject({ method: 'GET', url: '/v3/secrets' })).body))
      .toEqual({ handoffs: [], next_cursor: null });

    actor = principalOf('Steven', 'argos');
    expect((await claim(id)).statusCode).toBe(200);
  });

  it('reports an expired or revoked hand-off as gone', async () => {
    await publishRecipientKey();
    actor = principalOf('Steven', 'kant');
    const expired = (await grant()).body.id as string;
    // Expired but inside the retention grace: past the grace the sweep takes the row and the
    // honest recipient is told 404, which is the same answer a stranger gets and the right one.
    await pool.query(
      `UPDATE secret_handoffs
          SET created_at=now() - interval '1 hour', expires_at=now() - interval '1 minute'
        WHERE id=$1`,
      [expired],
    );
    const revoked = (await grant()).body.id as string;
    expect((await revoke(revoked)).statusCode).toBe(204);
    expect((await revoke(revoked)).statusCode).toBe(404);

    actor = principalOf('Steven', 'argos');
    expect((await claim(expired)).statusCode).toBe(410);
    expect((await claim(revoked)).statusCode).toBe(410);
    expect((await auditRows()).some((row) => row.action === 'secret.revoked')).toBe(true);
  });

  it('lets an operator of the edge revoke, and nobody else', async () => {
    await publishRecipientKey();
    actor = principalOf('Steven', 'kant');
    const id = (await grant()).body.id as string;

    actor = principalOf('Steven', 'kant', { permissions: ['read'] });
    expect((await revoke(id)).statusCode).toBe(403);

    actor = principalOf('Miguel', 'janus', {
      roles: ['operator'], permissions: ['route', 'read', 'control'],
    });
    expect((await revoke(id)).statusCode).toBe(404);

    actor = principalOf('Steven', 'jarvis', {
      roles: ['operator'], permissions: ['route', 'read', 'control'],
    });
    expect((await revoke(id)).statusCode).toBe(204);
    const revoked = await pool.query(`SELECT 1 FROM secret_handoffs WHERE revoked_at IS NOT NULL`);
    expect(revoked.rowCount).toBe(1);
  });

  it('stops offering a sealing key once not_after has passed', async () => {
    await publishRecipientKey();
    await pool.query(
      `UPDATE agent_sealing_keys SET not_after=now() - interval '1 minute'
        WHERE tenant_id='Steven' AND alias='argos'`,
    );
    actor = principalOf('Steven', 'kant');
    expect((await grant()).status).toBe(409);
    expect((await advertisedKey('Steven', 'argos')).statusCode).toBe(404);
  });

  it('rejects a request naming an identity or carrying a clear value', async () => {
    await publishRecipientKey();
    actor = principalOf('Steven', 'kant');
    for (const extra of [
      { from_tenant: 'Miguel' }, { from_alias: 'janus' }, { value: VALUE },
      { plaintext: VALUE }, { secret: VALUE },
    ]) {
      const response = await app.inject({
        method: 'POST', url: '/v3/secrets', payload: { ...sealedBody(), ...extra },
      });
      expect(response.statusCode).toBe(400);
    }
    const superseded = await grant({ keyId: 'k9' });
    expect(superseded.status).toBe(409);
    expect((await pool.query(`SELECT 1 FROM secret_handoffs`)).rowCount).toBe(0);
  });

  it('answers a colliding hand-off id with 409 and no schema detail', async () => {
    await publishRecipientKey();
    actor = principalOf('Steven', 'kant');
    const id = randomUUID();
    expect((await grant({ id })).status).toBe(201);
    const collision = await grant({ id });
    expect(collision.status).toBe(409);
    expect(JSON.stringify(collision.body)).not.toMatch(/duplicate key|pkey|constraint|relation/u);
    expect((await pool.query(`SELECT 1 FROM secret_handoffs`)).rowCount).toBe(1);
  });

  it('rolls the claim back when its audit row cannot be written', async () => {
    await publishRecipientKey();
    actor = principalOf('Steven', 'kant');
    const id = (await grant()).body.id as string;

    actor = principalOf('Steven', 'argos');
    await pool.query(
      `ALTER TABLE audit_events ADD CONSTRAINT audit_blocks_read CHECK (action <> 'secret.read')`,
    );
    const failed = await claim(id);
    expect(failed.statusCode).toBe(500);
    expect(failed.body).not.toMatch(/constraint|audit_events/u);
    const untouched = await pool.query<{ read_at: Date | null }>(
      `SELECT read_at FROM secret_handoffs WHERE id=$1`, [id],
    );
    expect(untouched.rows[0]?.read_at).toBeNull();

    await pool.query(`ALTER TABLE audit_events DROP CONSTRAINT audit_blocks_read`);
    expect((await claim(id)).statusCode).toBe(200);
  });

  it('rolls the grant back when its audit row cannot be written', async () => {
    await publishRecipientKey();
    actor = principalOf('Steven', 'kant');
    await pool.query(
      `ALTER TABLE audit_events ADD CONSTRAINT audit_blocks_grant
         CHECK (action <> 'secret.granted')`,
    );
    expect((await grant()).status).toBe(500);
    expect((await pool.query(`SELECT 1 FROM secret_handoffs`)).rowCount).toBe(0);

    await pool.query(`ALTER TABLE audit_events DROP CONSTRAINT audit_blocks_grant`);
    expect((await grant()).status).toBe(201);
  });

  it('lets exactly one of two simultaneous claims through', async () => {
    await publishRecipientKey();
    actor = principalOf('Steven', 'kant');
    const id = (await grant()).body.id as string;

    actor = principalOf('Steven', 'argos');
    const [first, second] = await Promise.all([claim(id), claim(id)]);
    expect([first.statusCode, second.statusCode].sort((left, right) => left - right))
      .toEqual([200, 410]);
    expect((await auditRows()).filter((row) => row.action === 'secret.read')).toHaveLength(1);
  });

  it('prunes what settled longer ago than the grace, and only that', async () => {
    await publishRecipientKey();
    actor = principalOf('Steven', 'kant');
    const stale = (await grant()).body.id as string;
    const justRead = (await grant()).body.id as string;
    const fresh = (await grant()).body.id as string;
    await pool.query(`UPDATE secret_handoffs SET read_at=now() - $1::interval WHERE id=$2`,
      ['2 hours', stale]);
    await pool.query(`UPDATE secret_handoffs SET read_at=now() - $1::interval WHERE id=$2`,
      ['1 minute', justRead]);
    expect((await grant()).status).toBe(201);
    const surviving = await pool.query<{ id: string }>(`SELECT id FROM secret_handoffs`);
    const ids = surviving.rows.map((row) => row.id);
    expect(ids).not.toContain(stale);
    expect(ids).toContain(justRead);
    expect(ids).toContain(fresh);
  });

  it('keeps the clear value and the ciphertext out of every response and every audit row', async () => {
    await publishRecipientKey();
    actor = principalOf('Steven', 'kant');
    const granted = await grant();
    const id = granted.body.id as string;
    actor = principalOf('Steven', 'argos');
    const read = await claim(id);

    expect(granted.body).not.toHaveProperty('sealed');
    expect(JSON.stringify(granted.body)).not.toContain(VALUE);
    expect(read.body).not.toContain(VALUE);
    const ciphertext = granted.request.sealed as string;
    const audit = JSON.stringify(await auditRows());
    expect(audit).not.toContain(VALUE);
    expect(audit).not.toContain(ciphertext);
    expect(audit).not.toContain(granted.request.nonce as string);
    expect(audit).not.toContain(granted.request.ephemeral_public as string);
  });
  it('refuses a flood past the recipient ceiling and bounds the audit it writes', async () => {
    await publishRecipientKey();
    actor = principalOf('Steven', 'kant');
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 60; attempt += 1) statuses.push((await grant()).status);
    expect(statuses.filter((status) => status === 201)).toHaveLength(32);
    expect(statuses.filter((status) => status === 429)).toHaveLength(28);

    const refused = await grant();
    expect(refused.status).toBe(429);
    expect(refused.body).toMatchObject({ error: 'too_many_handoffs' });
    expect(JSON.stringify(refused.body)).not.toMatch(/select|insert|constraint|relation/iu);
    expect((await pool.query(`SELECT 1 FROM secret_handoffs`)).rowCount).toBe(32);
    const denied = (await auditRows())
      .filter((row) => row.metadata.reason === 'recipient_handoff_ceiling');
    expect(denied.map((row) => row.metadata.denials_in_window)).toEqual([1, 2, 4, 8, 16]);
    expect(String(denied[0]?.metadata.handoff_id_sha256)).toMatch(/^[0-9a-f]{16}$/u);

    const jarvisKey = generateSealingKeyPair();
    actor = principalOf('Steven', 'jarvis');
    const published = await app.inject({
      method: 'POST', url: '/v3/sealing-keys',
      payload: {
        key_id: 'j1', algorithm: 'x25519', public_key: jarvisKey.publicKey.toString('base64'),
      },
    });
    expect(published.statusCode).toBe(201);
    actor = principalOf('Steven', 'kant');
    expect((await grant({
      toAlias: 'jarvis', keyId: 'j1', publicKey: jarvisKey.publicKey,
    })).status).toBe(201);
  });

  it('collapses a denial flood onto the sender ladder however the body varies the name', async () => {
    await publishRecipientKey();
    actor = principalOf('Steven', 'kant');
    for (let attempt = 0; attempt < 60; attempt += 1) {
      expect((await grant({ toAlias: `ghost-${String(attempt)}` })).status).toBe(403);
    }
    const cycled = (await auditRows()).filter((row) => row.action === 'secret.denied');
    expect(cycled.map((row) => row.metadata.denials_in_window)).toEqual([1, 2, 4, 8, 16, 32]);
    expect(cycled.every((row) => row.metadata.reason === 'target_not_routable')).toBe(true);

    for (let attempt = 0; attempt < 33; attempt += 1) await grant();
    const last = (await auditRows()).filter((row) => row.action === 'secret.denied').pop();
    expect(last?.metadata.reason).toBe('recipient_handoff_ceiling');
    expect(last?.metadata.denials_in_window).toBe(61);
  });

  it('validates the sealed envelope before it asks who the recipient is', async () => {
    actor = principalOf('Steven', 'kant');
    const refused = await grant({ toAlias: 'ghost', expiresAt: instant(1_000) });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toContain('30 seconds');
    expect(await auditRows()).toEqual([]);
  });

  it('counts what was created, so a short expiry does not walk past the ceiling', async () => {
    await publishRecipientKey();
    actor = principalOf('Steven', 'kant');
    for (let attempt = 0; attempt < 32; attempt += 1) expect((await grant()).status).toBe(201);
    await expireAll('1 second');

    actor = principalOf('Steven', 'argos');
    expect((await pending()).handoffs).toHaveLength(0);
    actor = principalOf('Steven', 'kant');
    expect((await grant()).status).toBe(429);
    expect((await pool.query(`SELECT 1 FROM secret_handoffs`)).rowCount).toBe(32);
  });

  it('sweeps the expired debris before the ceiling refuses', async () => {
    await publishRecipientKey();
    actor = principalOf('Steven', 'kant');
    for (let attempt = 0; attempt < 32; attempt += 1) expect((await grant()).status).toBe(201);
    await expireAll('30 minutes');

    expect((await grant()).status).toBe(201);
    expect((await pool.query(`SELECT 1 FROM secret_handoffs`)).rowCount).toBe(1);
  });

  it('refuses a hand-off that expires too soon for the recipient to claim it', async () => {
    await publishRecipientKey();
    actor = principalOf('Steven', 'kant');
    const tooShort = await grant({ expiresAt: instant(300) });
    expect(tooShort.status).toBe(400);
    expect(JSON.stringify(tooShort.body)).toContain('30 seconds');
    expect((await pool.query(`SELECT 1 FROM secret_handoffs`)).rowCount).toBe(0);
    expect((await grant({ expiresAt: instant(60_000) })).status).toBe(201);
  });

  it('serves the pending list one bounded page at a time', async () => {
    await publishRecipientKey();
    actor = principalOf('Steven', 'kant');
    for (let attempt = 0; attempt < 32; attempt += 1) expect((await grant()).status).toBe(201);

    actor = principalOf('Steven', 'argos');
    const first = await pending();
    expect(first.handoffs).toHaveLength(20);
    expect(typeof first.next_cursor).toBe('string');
    const second = await pending(first.next_cursor ?? '');
    expect(second.handoffs).toHaveLength(12);
    expect(second.next_cursor).toBeNull();
    const seen = new Set([...first.handoffs, ...second.handoffs].map((row) => row.id));
    expect(seen.size).toBe(32);

    const forged = await app.inject({ method: 'GET', url: '/v3/secrets?cursor=not-a-cursor' });
    expect(forged.statusCode).toBe(400);
    expect(forged.body).not.toMatch(/select|column|syntax|timestamptz/iu);
  });

  it('offers no cursor when the last page is exactly full', async () => {
    await publishRecipientKey();
    actor = principalOf('Steven', 'kant');
    for (let attempt = 0; attempt < 20; attempt += 1) expect((await grant()).status).toBe(201);

    actor = principalOf('Steven', 'argos');
    const only = await pending();
    expect(only.handoffs).toHaveLength(20);
    expect(only.next_cursor).toBeNull();
  });

  it('answers an infrastructure failure with an opaque 500, never the address of the database', async () => {
    const dead = createPool('postgresql://cauce@127.0.0.1:59999/cauce_test', {
      connectionTimeoutMillis: 1_000,
    });
    const stub = { query: () => { throw new TypeError('pool.query is not a function'); } };
    const downstream = await planeOn(dead);
    const broken = await planeOn(stub as unknown as DatabasePool);
    try {
      actor = principalOf('Steven', 'argos');
      for (const plane of [downstream, broken]) {
        for (const probe of [
          { method: 'GET' as const, url: '/v3/secrets' },
          { method: 'POST' as const, url: `/v3/secrets/${randomUUID()}/claim` },
          { method: 'GET' as const, url: '/v3/sealing-keys/Steven/argos' },
          { method: 'DELETE' as const, url: `/v3/secrets/${randomUUID()}` },
        ]) {
          const response = await plane.inject(probe);
          expect(response.statusCode).toBe(500);
          expect(JSON.parse(response.body)).toEqual({
            error: 'internal_error', message: 'request could not be completed',
          });
        }
      }
    } finally {
      await downstream.close();
      await broken.close();
      await dead.end();
    }
  });

  it('cannot revoke a hand-off that was already read', async () => {
    await publishRecipientKey();
    actor = principalOf('Steven', 'kant');
    const id = (await grant()).body.id as string;

    actor = principalOf('Steven', 'argos');
    expect((await claim(id)).statusCode).toBe(200);

    actor = principalOf('Steven', 'kant');
    expect((await revoke(id)).statusCode).toBe(410);
    actor = principalOf('Steven', 'jarvis', {
      roles: ['operator'], permissions: ['route', 'read', 'control'],
    });
    expect((await revoke(id)).statusCode).toBe(410);

    const state = await pool.query<{ revoked_at: Date | null }>(
      `SELECT revoked_at FROM secret_handoffs WHERE id=$1`, [id],
    );
    expect(state.rows[0]?.revoked_at).toBeNull();
    expect((await auditRows()).some((row) => row.action === 'secret.revoked')).toBe(false);
  });

  it('never lets disabled key material address the alias again under a new key_id', async () => {
    expect(await publishRecipientKey('k1')).toBe(201);
    await pool.query(`UPDATE agent_sealing_keys SET enabled=false`);
    expect(await publishRecipientKey('k2')).toBe(409);
    expect((await pool.query(`SELECT 1 FROM agent_sealing_keys`)).rowCount).toBe(1);

    actor = principalOf('Steven', 'kant');
    expect((await advertisedKey('Steven', 'argos')).statusCode).toBe(404);
    expect(await publishRecipientKey('k2', generateSealingKeyPair())).toBe(201);
    expect((await advertisedKey('Steven', 'argos')).statusCode).toBe(200);
  });

  it('correlates the claim denial with the hand-off it refused', async () => {
    await publishRecipientKey();
    actor = principalOf('Steven', 'kant');
    const id = (await grant()).body.id as string;

    actor = principalOf('Steven', 'argos');
    expect((await claim(id)).statusCode).toBe(200);
    expect((await claim(id)).statusCode).toBe(410);

    const rows = await auditRows();
    const digest = (action: string): unknown =>
      rows.find((row) => row.action === action)?.metadata.handoff_id_sha256;
    expect(String(digest('secret.granted'))).toMatch(/^[0-9a-f]{16}$/u);
    expect(digest('secret.read')).toBe(digest('secret.granted'));
    expect(digest('secret.denied')).toBe(digest('secret.granted'));
    expect(JSON.stringify(rows)).not.toContain(id);
  });
});
