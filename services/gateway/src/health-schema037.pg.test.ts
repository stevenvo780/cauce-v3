import { randomUUID } from 'node:crypto';
import { createPool, type DatabasePool } from '@cauce/store';
import { describe, expect, it } from 'vitest';
import { startTestDatabase } from '../../../tests/helpers/postgres.js';
import { probeConsolePublishIntentPath } from './health.js';

const migration037 = '037_console_publish_intent_indexes.sql';
const migration037Sha256 =
  '0daeb89c224e940600562ab162fba03c4facd4cb0b80b65f20feedc02b33f281';

const indexDefinitions = {
  audit_events_console_publish_key_037_idx: `CREATE INDEX audit_events_console_publish_key_037_idx
    ON audit_events (tenant_id,actor_alias,(metadata->>'idempotency_key'),id)
    WHERE action IN (
      'console.publish.prepare','console.publish.confirm','console.publish.expire'
    )`,
  audit_events_console_publish_nonce_037_idx: `CREATE INDEX audit_events_console_publish_nonce_037_idx
    ON audit_events (
      tenant_id,actor_alias,(metadata->>'operator_scope_hash'),
      (metadata->>'intent_nonce_hash'),id DESC
    ) WHERE action='console.publish.prepare'`,
  audit_events_console_publish_rate_037_idx: `CREATE INDEX audit_events_console_publish_rate_037_idx
    ON audit_events (
      tenant_id,actor_alias,(metadata->>'operator_scope_hash'),created_at DESC,id DESC
    ) WHERE action='console.publish.prepare'`,
  audit_events_console_publish_head_037_idx: `CREATE INDEX audit_events_console_publish_head_037_idx
    ON audit_events (
      tenant_id,actor_alias,(metadata->>'operator_scope_hash'),
      (metadata->>'conversation_hash'),id DESC
    ) WHERE action='console.publish.head'`,
} as const;

type IndexName = keyof typeof indexDefinitions;

async function replaceIndex(
  pool: DatabasePool,
  name: IndexName,
  definition: string = indexDefinitions[name],
): Promise<void> {
  await pool.query(`DROP INDEX IF EXISTS ${name}`);
  await pool.query(definition);
}

describe('gateway schema-037 readiness on PostgreSQL 16', () => {
  it('rejects absent ledger, absent index, definition drift, predicate drift and missing authority', async () => {
    const database = await startTestDatabase();
    const role = `publish_health_${randomUUID().replaceAll('-', '')}`;
    const password = randomUUID();
    let restrictedPool: DatabasePool | undefined;
    let roleCreated = false;
    let ledgerRow: {
      source_sha256: string;
      source_origin: string;
      recorded_at: Date;
    } | undefined;

    try {
      const ledger = await database.pool.query<{
        source_sha256: string;
        source_origin: string;
        recorded_at: Date;
      }>(
        `SELECT source_sha256,source_origin,recorded_at
           FROM schema_migration_ledger WHERE version=$1`,
        [migration037],
      );
      ledgerRow = ledger.rows[0];
      expect(ledgerRow?.source_sha256).toBe(migration037Sha256);
      expect(ledgerRow?.source_origin).toBe('applied-atomically');

      await expect(probeConsolePublishIntentPath(database.pool)).resolves.toBeUndefined();

      await database.pool.query(
        'DELETE FROM schema_migration_ledger WHERE version=$1',
        [migration037],
      );
      await expect(probeConsolePublishIntentPath(database.pool))
        .rejects.toThrow(/schema-037 console publish intent/u);
      await database.pool.query(
        `INSERT INTO schema_migration_ledger(
           version,source_sha256,source_origin,recorded_at
         ) VALUES ($1,$2,$3,$4)`,
        [migration037, ledgerRow!.source_sha256, ledgerRow!.source_origin, ledgerRow!.recorded_at],
      );
      await expect(probeConsolePublishIntentPath(database.pool)).resolves.toBeUndefined();

      await database.pool.query('DROP INDEX audit_events_console_publish_head_037_idx');
      await expect(probeConsolePublishIntentPath(database.pool))
        .rejects.toThrow(/schema-037 console publish intent/u);
      await database.pool.query(indexDefinitions.audit_events_console_publish_head_037_idx);

      // The right name and columns are insufficient when DESC/NULL ordering drifts.
      await replaceIndex(
        database.pool,
        'audit_events_console_publish_rate_037_idx',
        `CREATE INDEX audit_events_console_publish_rate_037_idx
           ON audit_events (
             tenant_id,actor_alias,(metadata->>'operator_scope_hash'),created_at,id DESC
           ) WHERE action='console.publish.prepare'`,
      );
      await expect(probeConsolePublishIntentPath(database.pool))
        .rejects.toThrow(/schema-037 console publish intent/u);
      await replaceIndex(database.pool, 'audit_events_console_publish_rate_037_idx');

      // Preserve the name and complete key while widening the partial predicate.
      await replaceIndex(
        database.pool,
        'audit_events_console_publish_key_037_idx',
        `CREATE INDEX audit_events_console_publish_key_037_idx
           ON audit_events (tenant_id,actor_alias,(metadata->>'idempotency_key'),id)
           WHERE action IN ('console.publish.prepare','console.publish.confirm')`,
      );
      await expect(probeConsolePublishIntentPath(database.pool))
        .rejects.toThrow(/schema-037 console publish intent/u);
      await replaceIndex(database.pool, 'audit_events_console_publish_key_037_idx');

      // Preserve name, arity, ordering and predicate while changing one JSON expression.
      await replaceIndex(
        database.pool,
        'audit_events_console_publish_nonce_037_idx',
        `CREATE INDEX audit_events_console_publish_nonce_037_idx
           ON audit_events (
             tenant_id,actor_alias,(metadata->>'operator_scope_hash'),
             (metadata->>'conversation_hash'),id DESC
           ) WHERE action='console.publish.prepare'`,
      );
      await expect(probeConsolePublishIntentPath(database.pool))
        .rejects.toThrow(/schema-037 console publish intent/u);
      await replaceIndex(database.pool, 'audit_events_console_publish_nonce_037_idx');
      await expect(probeConsolePublishIntentPath(database.pool)).resolves.toBeUndefined();

      await database.pool.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
      roleCreated = true;
      await database.pool.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
      await database.pool.query(
        `GRANT SELECT ON schema_migrations,schema_migration_ledger,audit_events TO ${role}`,
      );
      const restrictedUrl = new URL(database.url);
      restrictedUrl.username = role;
      restrictedUrl.password = password;
      restrictedPool = createPool(restrictedUrl.href, { max: 1 });
      const restrictedResult = await restrictedPool.query('SELECT 1');
      expect(restrictedResult).toMatchObject({ rowCount: 1 });
      expect(restrictedResult.rows).toBeDefined();
      await expect(probeConsolePublishIntentPath(restrictedPool))
        .rejects.toThrow(/schema-037 console publish intent/u);

      await database.pool.query(`GRANT INSERT ON audit_events TO ${role}`);
      await expect(probeConsolePublishIntentPath(restrictedPool))
        .rejects.toThrow(/schema-037 console publish intent/u);
      await database.pool.query(`GRANT USAGE ON SEQUENCE audit_events_id_seq TO ${role}`);
      await expect(probeConsolePublishIntentPath(restrictedPool)).resolves.toBeUndefined();
    } finally {
      try {
        try {
          await restrictedPool?.end();
        } finally {
          if (roleCreated) {
            await database.pool.query(`DROP OWNED BY ${role}`);
            await database.pool.query(`DROP ROLE ${role}`);
          }
          for (const [name, definition] of Object.entries(indexDefinitions)) {
            await replaceIndex(database.pool, name as IndexName, definition);
          }
          if (ledgerRow !== undefined) {
            await database.pool.query(
              `INSERT INTO schema_migration_ledger(
                 version,source_sha256,source_origin,recorded_at
               ) VALUES ($1,$2,$3,$4)
               ON CONFLICT (version) DO UPDATE SET
                 source_sha256=EXCLUDED.source_sha256,
                 source_origin=EXCLUDED.source_origin,
                 recorded_at=EXCLUDED.recorded_at`,
              [migration037, ledgerRow.source_sha256, ledgerRow.source_origin, ledgerRow.recorded_at],
            );
          }
        }
      } finally {
        try {
          await database.pool.end();
        } finally {
          await database.container.stop();
        }
      }
    }
  }, 120_000);
});
