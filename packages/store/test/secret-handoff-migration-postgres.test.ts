import { preparePostgresSuite } from './postgres-suite.js';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyMigrations, type DatabaseClient, type DatabasePool } from '../src/index.js';
import {
  resetTestDatabase, startTestDatabase, type TestDatabase,
} from '../../../tests/helpers/postgres.js';

const version = '039_secret_handoff.sql';
const upPath = new URL(`../migrations/${version}`, import.meta.url);
const downPath = new URL(`../migrations/down/${version}`, import.meta.url);
const publicKey = Buffer.alloc(32, 7);
const ephemeralPublic = Buffer.alloc(32, 9);
const nonce = Buffer.alloc(12, 3);
const sealed = Buffer.alloc(48, 5);

let database: TestDatabase;
let databaseStarted = false;
let pool: DatabasePool;
let up: string;
let down: string;

async function tableExists(name: string): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    'SELECT to_regclass($1) IS NOT NULL AS exists', [name],
  );
  return result.rows[0]?.exists === true;
}

async function ensureUp(): Promise<void> {
  if (!await tableExists('secret_handoffs')) await pool.query(up);
  await pool.query(
    `INSERT INTO schema_migrations(version) VALUES($1) ON CONFLICT DO NOTHING`, [version],
  );
  await pool.query(
    `INSERT INTO schema_migration_ledger(version,source_sha256,source_origin)
     VALUES($1,$2,'applied-atomically')
     ON CONFLICT(version) DO UPDATE SET
       source_sha256=EXCLUDED.source_sha256,
       source_origin=EXCLUDED.source_origin`,
    [version, createHash('sha256').update(up).digest('hex')],
  );
}

async function seedAgents(): Promise<void> {
  await pool.query(`
    INSERT INTO agents(
      tenant_id,alias,harness_id,display_name,enabled,
      container_name,runtime_user,home_directory,state_directory
    ) VALUES
      ('Steven','kant','claude','Kant',true,'ctrl-infra','dev','/home/dev','/home/dev/.cauce/kant'),
      ('Steven','argos','claude','Argos',true,'ctrl-infra','dev','/home/dev','/home/dev/.cauce/argos')
    ON CONFLICT(tenant_id,alias) DO UPDATE SET enabled=true
  `);
}

interface SealingKeyOverrides {
  readonly alias?: string;
  readonly keyId?: string;
  readonly algorithm?: string;
  readonly publicKey?: Buffer;
}

async function insertSealingKey(overrides: SealingKeyOverrides = {}): Promise<void> {
  await pool.query(
    `INSERT INTO agent_sealing_keys(tenant_id,alias,key_id,algorithm,public_key)
     VALUES('Steven',$1,$2,$3,$4)`,
    [
      overrides.alias ?? 'argos',
      overrides.keyId ?? 'k1',
      overrides.algorithm ?? 'x25519',
      overrides.publicKey ?? publicKey,
    ],
  );
}

interface HandoffOverrides {
  readonly id?: string;
  readonly toAlias?: string;
  readonly label?: string;
  readonly expiresAt?: string;
  readonly ephemeralPublic?: Buffer;
  readonly nonce?: Buffer;
}

function inHours(hours: number): string {
  return new Date(Date.now() + hours * 3_600_000).toISOString();
}

async function insertHandoff(
  overrides: HandoffOverrides = {}, database_: DatabasePool | DatabaseClient = pool,
): Promise<string> {
  const id = overrides.id ?? randomUUID();
  await database_.query(
    `INSERT INTO secret_handoffs(
       id,from_tenant,from_alias,to_tenant,to_alias,label,sealed,sealing_key_id,
       ephemeral_public,nonce,expires_at
     ) VALUES($1,'Steven','kant','Steven',$2,$3,$4,'k1',$5,$6,$7::timestamptz)`,
    [
      id,
      overrides.toAlias ?? 'argos',
      overrides.label ?? 'ANTHROPIC_API_KEY',
      sealed,
      overrides.ephemeralPublic ?? ephemeralPublic,
      overrides.nonce ?? nonce,
      overrides.expiresAt ?? inHours(1),
    ],
  );
  return id;
}

const CLAIM = `UPDATE secret_handoffs SET read_at=now()
                WHERE id=$1 AND read_at IS NULL AND revoked_at IS NULL AND expires_at > now()
            RETURNING id`;

preparePostgresSuite(import.meta.url, async () => {
  [up, down] = await Promise.all([readFile(upPath, 'utf8'), readFile(downPath, 'utf8')]);
  database = await startTestDatabase();
  databaseStarted = true;
  pool = database.pool;
}, 120_000);

beforeEach(async () => {
  await resetTestDatabase(pool);
  await ensureUp();
  await seedAgents();
});

afterEach(async () => {
  if (!databaseStarted) return;
  await ensureUp();
  await applyMigrations(pool);
});

afterAll(async () => {
  if (!databaseStarted) return;
  await pool.end();
  await database.container.stop();
});

describe('migration 039 sealed credential hand-off', () => {
  it('creates both tables and the pending partial index', async () => {
    expect(await tableExists('agent_sealing_keys')).toBe(true);
    expect(await tableExists('secret_handoffs')).toBe(true);
    const indexes = await pool.query<{ indexdef: string }>(
      `SELECT pg_get_indexdef(index_relation.oid) AS indexdef
         FROM pg_class index_relation
         JOIN pg_index index_value ON index_value.indexrelid=index_relation.oid
        WHERE index_value.indrelid='public.secret_handoffs'::regclass
          AND index_value.indpred IS NOT NULL
        ORDER BY index_relation.relname`,
    );
    expect(indexes.rows.map((row) => row.indexdef).join('\n')).toMatch(/read_at IS NULL/u);
    expect(indexes.rows.some((row) => row.indexdef.includes('UNIQUE'))).toBe(true);
  });

  /**
   * The pending page and the ceiling must never scan the debris they ignore: the partial index
   * carries `expires_at` so the page filters inside it, and the ceiling counts what was CREATED
   * for a recipient, which no partial index on liveness could serve.
   */
  it('indexes the expiry of a pending hand-off and the recipient creation window', async () => {
    const indexes = await pool.query<{ indexdef: string }>(
      `SELECT pg_get_indexdef(index_relation.oid) AS indexdef
         FROM pg_class index_relation
         JOIN pg_index index_value ON index_value.indexrelid=index_relation.oid
        WHERE index_value.indrelid='public.secret_handoffs'::regclass
        ORDER BY index_relation.relname`,
    );
    const definitions = indexes.rows.map((row) => row.indexdef);
    expect(definitions.some((definition) =>
      definition.includes('to_tenant, to_alias, created_at, expires_at)')
      && definition.includes('read_at IS NULL'))).toBe(true);
    expect(definitions.some((definition) =>
      definition.includes('to_tenant, to_alias, created_at)')
      && !definition.includes('WHERE'))).toBe(true);
  });

  it('accepts a hand-off inside the 24 hour ceiling and rejects one beyond it', async () => {
    await expect(insertHandoff({ expiresAt: inHours(23) })).resolves.toBeTypeOf('string');
    await expect(insertHandoff({ expiresAt: inHours(25) })).rejects.toMatchObject({
      constraint: 'secret_handoffs_lifetime',
    });
    await expect(insertHandoff({ expiresAt: inHours(-1) })).rejects.toMatchObject({
      constraint: 'secret_handoffs_lifetime',
    });
  });

  it('rejects an empty or oversized label', async () => {
    await expect(insertHandoff({ label: '' })).rejects.toMatchObject({
      constraint: 'secret_handoffs_label',
    });
    await expect(insertHandoff({ label: 'x'.repeat(121) })).rejects.toMatchObject({
      constraint: 'secret_handoffs_label',
    });
  });

  it('rejects sealed material of the wrong length', async () => {
    await expect(insertHandoff({ ephemeralPublic: Buffer.alloc(31, 9) })).rejects.toMatchObject({
      constraint: 'secret_handoffs_ephemeral_public',
    });
    await expect(insertHandoff({ nonce: Buffer.alloc(11, 3) })).rejects.toMatchObject({
      constraint: 'secret_handoffs_nonce',
    });
  });

  it('rejects a sealing key that is not x25519 or not 32 bytes', async () => {
    await expect(insertSealingKey({ algorithm: 'x25519-hybrid' })).rejects.toMatchObject({
      constraint: 'agent_sealing_keys_algorithm',
    });
    await expect(insertSealingKey({ publicKey: Buffer.alloc(31, 7) })).rejects.toMatchObject({
      constraint: 'agent_sealing_keys_public_key',
    });
    await expect(insertSealingKey()).resolves.toBeUndefined();
  });

  it('refuses to bind either table to an agent that does not exist', async () => {
    await expect(insertSealingKey({ alias: 'ghost' })).rejects.toMatchObject({ code: '23503' });
    await expect(insertHandoff({ toAlias: 'ghost' })).rejects.toMatchObject({ code: '23503' });
  });

  it('lets exactly one of two concurrent callers claim the same hand-off', async () => {
    const id = await insertHandoff();
    const first = await pool.connect();
    const second = await pool.connect();
    try {
      await first.query('BEGIN');
      await second.query('BEGIN');
      const winner = await first.query(CLAIM, [id]);
      const blocked = second.query(CLAIM, [id]);
      await first.query('COMMIT');
      const loser = await blocked;
      await second.query('COMMIT');
      expect(winner.rowCount).toBe(1);
      expect(loser.rowCount).toBe(0);
    } finally {
      first.release();
      second.release();
    }
    const claimedTwice = await pool.query(CLAIM, [id]);
    expect(claimedTwice.rowCount).toBe(0);
  });

  it('never claims a revoked or expired hand-off', async () => {
    const revoked = await insertHandoff();
    await pool.query(`UPDATE secret_handoffs SET revoked_at=now() WHERE id=$1`, [revoked]);
    expect((await pool.query(CLAIM, [revoked])).rowCount).toBe(0);
    const expired = await insertHandoff({ expiresAt: inHours(1) });
    // Back-dating both columns keeps the 24 hour ceiling satisfied, which is the only way the
    // constraint lets a row become expired: it forbids moving `expires_at` behind `created_at`.
    await pool.query(
      `UPDATE secret_handoffs
          SET created_at=created_at - interval '2 hours',
              expires_at=created_at - interval '1 hour'
        WHERE id=$1`,
      [expired],
    );
    expect((await pool.query(CLAIM, [expired])).rowCount).toBe(0);
  });

  it('rolls the schema back and re-applies the up unchanged', async () => {
    await insertSealingKey();
    await insertHandoff();
    await pool.query(down);
    expect(await tableExists('secret_handoffs')).toBe(false);
    expect(await tableExists('agent_sealing_keys')).toBe(false);
    await pool.query(up);
    await pool.query(up);
    expect(await tableExists('secret_handoffs')).toBe(true);
    expect(await tableExists('agent_sealing_keys')).toBe(true);
    await seedAgents();
    await expect(insertHandoff()).resolves.toBeTypeOf('string');
  });
});
