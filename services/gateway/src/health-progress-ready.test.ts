import { schemaBarrierReply } from '../../../tests/helpers/schema-barrier.js';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { createPool, type DatabasePool } from '@cauce/store';
import { afterEach, describe, expect, it } from 'vitest';
import { dockerTestRequirement, startTestDatabase } from '../../../tests/helpers/postgres.js';
import {
  buildLoopbackHealthProbe, probeConsolePublishIntentPath,
  probeDeliveryAdmissionPath, probeProfileRuntimePath,
  probeTerminalBrowserOwnerPath, probeTerminalClaimPath, probeTerminalRelayInstancePath,
  probeWakePath, renderWakePumpMetrics,
} from './health.js';
import { WakePumpTelemetry } from './wake-pump-telemetry.js';

const postgresRequirement = dockerTestRequirement('PostgreSQL readiness and least-privilege contracts for schemas 015 and 031-035');
const answeringPool = {
  query: async () => ({ rows: [{ ssl: true }], rowCount: 1 }),
} as unknown as DatabasePool;
let dataListener: Server | undefined;

afterEach(async () => {
  const listener = dataListener;
  if (listener) await new Promise<void>((resolve) => listener.close(() => { resolve(); }));
  dataListener = undefined;
});

async function listeningDataApp(): Promise<{ server: Server }> {
  const server = createServer(() => undefined);
  dataListener = server;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server };
}

describe('gateway readiness stops lying about the listener the agents actually use', () => {
  it('rejects schema-037 when same-named indexes do not match the exact definitions', async () => {
    const query = vi.fn(async (sql: string, params: readonly unknown[] = []) => {
      const schema = schemaBarrierReply(sql, params);
      if (schema) return schema;
      if (sql.includes('AS migration_ledger_exact')) {
        return {
          rows: [{
            migration_ledger_exact: true,
            indexes_exact: false,
            journal_permissions: true,
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const client = { query, on: vi.fn(), off: vi.fn(), release: vi.fn() };
    const pool = { connect: vi.fn(async () => client) } as unknown as DatabasePool;

    await expect(probeConsolePublishIntentPath(pool))
      .rejects.toThrow(/schema-037 console publish intent/u);
    expect(query.mock.calls.map(([sql]) => sql).at(-1)).toBe('ROLLBACK');
  });

  it('reports ready while the data listener is up', async () => {
    const app = await buildLoopbackHealthProbe({
      pool: answeringPool,
      dataApp: await listeningDataApp(),
      ackProbe: async () => undefined,
    });
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ready' });
    await app.close();
  });

  it('reports not_ready when the data listener is closed even though SELECT 1 still works', async () => {
    const dataApp = await listeningDataApp();
    const app = await buildLoopbackHealthProbe({
      pool: answeringPool,
      dataApp,
      ackProbe: async () => undefined,
    });
    expect((await app.inject({ method: 'GET', url: '/health/ready' })).statusCode).toBe(200);

    const listener = dataListener;
    if (listener === undefined) throw new Error('test data listener is unavailable');
    await new Promise<void>((resolve) => listener.close(() => { resolve(); }));
    expect((await answeringPool.query('SELECT 1')).rowCount).toBe(1);

    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'not_ready', reason: 'data_listener_down' });
    await app.close();
  });

  it('reports not_ready when the ACK path is broken but SELECT 1 is not', async () => {
    const app = await buildLoopbackHealthProbe({
      pool: answeringPool,
      dataApp: await listeningDataApp(),
      ackProbe: async () => { throw new Error('canceling statement due to lock timeout'); },
    });
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'not_ready', reason: 'ack_path_unavailable' });
    await app.close();
  });

  it('reports not_ready when wake SQL is denied with no sessions and a clean empty cycle', async () => {
    const telemetry = new WakePumpTelemetry();
    telemetry.beginCycle();
    telemetry.finishCycle();
    const clientQuery = vi.fn(async (sql: string, params: readonly unknown[] = []) => {
      const schema = schemaBarrierReply(sql, params);
      if (schema) return schema;
      if (sql.includes('AS migration_applied')) {
        return {
          rows: [{
            migration_applied: true,
            connection_token_exact: true,
            claim_permissions: true,
          }],
          rowCount: 1,
        };
      }
      if (sql.includes('WITH requested')) throw new Error('permission denied for adapter_outbox');
      return { rows: [], rowCount: 0 };
    });
    const client = { query: clientQuery, on: vi.fn(), off: vi.fn(), release: vi.fn() };
    const pool = {
      query: async () => ({ rows: [{ ssl: true }], rowCount: 1 }),
      connect: vi.fn(async () => client),
    } as unknown as DatabasePool;
    const app = await buildLoopbackHealthProbe({
      pool,
      dataApp: await listeningDataApp(),
      ackProbe: async () => undefined,
      wakePumpTelemetry: telemetry,
      deliveryAdmissionProbe: async () => undefined,
      terminalClaimProbe: async () => undefined,
      terminalBrowserOwnerProbe: async () => undefined,
      terminalRelayInstanceProbe: async () => undefined,
      profileRuntimeProbe: async () => undefined,
      consolePublishIntentProbe: async () => undefined,
    });

    const response = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'not_ready', reason: 'wake_path_unavailable' });
    expect(clientQuery.mock.calls.some(([sql]) => sql.includes('WITH requested'))).toBe(true);
    await app.close();
  });

  it('reports not_ready when delivery admission is unavailable before other consumer probes', async () => {
    const telemetry = new WakePumpTelemetry();
    telemetry.beginCycle();
    telemetry.finishCycle();
    const app = await buildLoopbackHealthProbe({
      pool: answeringPool,
      dataApp: await listeningDataApp(),
      ackProbe: async () => undefined,
      wakePumpTelemetry: telemetry,
      deliveryAdmissionProbe: async () => { throw new Error('agents SELECT denied'); },
      wakeProbe: async () => undefined,
      terminalClaimProbe: async () => undefined,
      terminalBrowserOwnerProbe: async () => undefined,
      terminalRelayInstanceProbe: async () => undefined,
      profileRuntimeProbe: async () => undefined,
    });

    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: 'not_ready', reason: 'delivery_admission_path_unavailable',
    });
    await app.close();
  });

  it('reports not_ready for broken schema-032 CAS even with no terminal sessions and a clean wake cycle', async () => {
    const telemetry = new WakePumpTelemetry();
    telemetry.beginCycle();
    telemetry.finishCycle();
    const app = await buildLoopbackHealthProbe({
      pool: answeringPool,
      dataApp: await listeningDataApp(),
      ackProbe: async () => undefined,
      wakePumpTelemetry: telemetry,
      deliveryAdmissionProbe: async () => undefined,
      wakeProbe: async () => undefined,
      terminalClaimProbe: async () => { throw new Error('missing exact-fence constraint'); },
    });

    const response = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: 'not_ready', reason: 'terminal_claim_path_unavailable',
    });
    await app.close();
  });

  it('reports not_ready for a broken schema-033 owner fence after schema-032 passes', async () => {
    const telemetry = new WakePumpTelemetry();
    telemetry.beginCycle();
    telemetry.finishCycle();
    const app = await buildLoopbackHealthProbe({
      pool: answeringPool,
      dataApp: await listeningDataApp(),
      ackProbe: async () => undefined,
      wakePumpTelemetry: telemetry,
      deliveryAdmissionProbe: async () => undefined,
      wakeProbe: async () => undefined,
      terminalClaimProbe: async () => undefined,
      terminalBrowserOwnerProbe: async () => { throw new Error('request index is not unique'); },
    });

    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: 'not_ready', reason: 'terminal_browser_owner_path_unavailable',
    });
    await app.close();
  });

  it('reports not_ready for a broken schema-034 relay pin after earlier terminal probes pass', async () => {
    const telemetry = new WakePumpTelemetry();
    telemetry.beginCycle();
    telemetry.finishCycle();
    const app = await buildLoopbackHealthProbe({
      pool: answeringPool,
      dataApp: await listeningDataApp(),
      ackProbe: async () => undefined,
      wakePumpTelemetry: telemetry,
      deliveryAdmissionProbe: async () => undefined,
      wakeProbe: async () => undefined,
      terminalClaimProbe: async () => undefined,
      terminalBrowserOwnerProbe: async () => undefined,
      terminalRelayInstanceProbe: async () => { throw new Error('relay pin widened'); },
    });

    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: 'not_ready', reason: 'terminal_relay_instance_path_unavailable',
    });
    await app.close();
  });

  it('reports not_ready for a broken schema-035 profile adoption path after PTY probes pass', async () => {
    const telemetry = new WakePumpTelemetry();
    telemetry.beginCycle();
    telemetry.finishCycle();
    const app = await buildLoopbackHealthProbe({
      pool: answeringPool,
      dataApp: await listeningDataApp(),
      ackProbe: async () => undefined,
      wakePumpTelemetry: telemetry,
      deliveryAdmissionProbe: async () => undefined,
      wakeProbe: async () => undefined,
      terminalClaimProbe: async () => undefined,
      terminalBrowserOwnerProbe: async () => undefined,
      terminalRelayInstanceProbe: async () => undefined,
      profileRuntimeProbe: async () => { throw new Error('adoption trigger disabled'); },
    });

    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: 'not_ready', reason: 'profile_runtime_path_unavailable',
    });
    await app.close();
  });

  it('reports not_ready for a broken schema-037 journal after schema-035 passes', async () => {
    const telemetry = new WakePumpTelemetry();
    telemetry.beginCycle();
    telemetry.finishCycle();
    const app = await buildLoopbackHealthProbe({
      pool: answeringPool,
      dataApp: await listeningDataApp(),
      ackProbe: async () => undefined,
      wakePumpTelemetry: telemetry,
      deliveryAdmissionProbe: async () => undefined,
      wakeProbe: async () => undefined,
      terminalClaimProbe: async () => undefined,
      terminalBrowserOwnerProbe: async () => undefined,
      terminalRelayInstanceProbe: async () => undefined,
      profileRuntimeProbe: async () => undefined,
      consolePublishIntentProbe: async () => { throw new Error('head predicate changed'); },
    });

    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: 'not_ready', reason: 'console_publish_intent_path_unavailable',
    });
    await app.close();
  });

  it('reports not_ready when Postgres is down, before it ever probes the ACK path', async () => {
    let ackProbes = 0;
    const app = await buildLoopbackHealthProbe({
      pool: { query: async () => { throw new Error('no connection'); } } as unknown as DatabasePool,
      dataApp: await listeningDataApp(),
      ackProbe: async () => { ackProbes += 1; },
    });
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'not_ready', reason: 'postgres_unavailable' });
    expect(ackProbes).toBe(0);
    await app.close();
  });

  it('is actually wired in main.ts, not just available', async () => {
    const main = await readFile(new URL('./main.ts', import.meta.url), 'utf8');
    expect(main).toMatch(/buildLoopbackHealthProbe\(\{[\s\S]*?dataApp: app[\s\S]*?\}\)/u);
    expect(main).toMatch(/wakePumpTelemetry[\s\S]*?health\.listen\(\{ host: '0\.0\.0\.0'/u);
  });

  it('exports bounded identity-free wake progress on the internal listener', async () => {
    const telemetry = new WakePumpTelemetry();
    telemetry.beginCycle();
    telemetry.markClaimed();
    telemetry.recordOutcome('sent');
    telemetry.finishCycle();
    const app = await buildLoopbackHealthProbe({
      pool: answeringPool,
      ackProbe: async () => undefined,
      wakePumpTelemetry: telemetry,
      deliveryAdmissionProbe: async () => undefined,
      wakeProbe: async () => undefined,
      terminalClaimProbe: async () => undefined,
      terminalBrowserOwnerProbe: async () => undefined,
      terminalRelayInstanceProbe: async () => undefined,
      profileRuntimeProbe: async () => undefined,
    });

    const response = await app.inject({ method: 'GET', url: '/metrics' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.body).toContain('cauce_gateway_wake_pump_cycles_total 1');
    expect(response.body).toContain('cauce_gateway_wake_pump_claimed_total 1');
    expect(response.body).toContain('cauce_gateway_wake_pump_last_success_timestamp_seconds');
    expect(response.body).toContain('cauce_gateway_wake_pump_consecutive_failures 0');
    expect(response.body).toContain('cauce_gateway_wake_pump_outcomes_total{result="sent"} 1');
    expect(response.body).not.toMatch(/tenant_id|tenant=|alias=|event_id|claim_token|recipient_alias/u);
    await app.close();
  });

  it('fails closed if a telemetry implementation invents a label or negative counter', () => {
    expect(() => renderWakePumpMetrics({
      snapshot: () => ({
        state: 'idle', lastProgressAtMs: null, lastSuccessAtMs: null, consecutiveFailures: 0,
        counters: {
          cycles: -1, claimed: 0, sent: 0, retry: 0, dead: 0,
          fenced: 0, error: 0, cancelled: 0,
        },
      }),
    })).toThrow(/invalid cycles counter/u);
  });

  it('does not report ready for a pump that never started or keeps failing while still making progress', async () => {
    const telemetry = new WakePumpTelemetry();
    const app = await buildLoopbackHealthProbe({
      pool: answeringPool,
      dataApp: await listeningDataApp(),
      ackProbe: async () => undefined,
      wakePumpTelemetry: telemetry,
      deliveryAdmissionProbe: async () => undefined,
      wakeProbe: async () => undefined,
      terminalClaimProbe: async () => undefined,
      terminalBrowserOwnerProbe: async () => undefined,
      terminalRelayInstanceProbe: async () => undefined,
      profileRuntimeProbe: async () => undefined,
      consolePublishIntentProbe: async () => undefined,
      wakePumpMaxStaleMs: 1_000,
    });
    expect((await app.inject({ method: 'GET', url: '/health/ready' })).json())
      .toEqual({ status: 'not_ready', reason: 'wake_pump_not_started' });

    telemetry.beginCycle();
    telemetry.recordOutcome('error');
    telemetry.finishCycle();
    expect((await app.inject({ method: 'GET', url: '/health/ready' })).json())
      .toEqual({ status: 'not_ready', reason: 'wake_pump_degraded' });

    telemetry.beginCycle();
    telemetry.finishCycle();
    expect((await app.inject({ method: 'GET', url: '/health/ready' })).json())
      .toEqual({ status: 'ready' });
    await app.close();
  });

  it('proves exact 015/031/032/033/034/035 contracts on PostgreSQL 16 and rejects false structural greens', async ({ skip }) => {
    if (!process.env.CAUCE_TEST_DATABASE_URL) await postgresRequirement.skipIfUnavailable(skip);
    const database = await startTestDatabase();
    const role = `wake_probe_${randomUUID().replaceAll('-', '')}`;
    const password = randomUUID();
    let restrictedPool: DatabasePool | undefined;
    let roleCreated = false;
    try {
      const emptySessions = await database.pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM connection_leases',
      );
      expect(emptySessions.rows[0]?.count).toBe('0');
      const before = await database.pool.query<{ outbox: string; dead: string }>(
        `SELECT
           (SELECT count(*)::text FROM adapter_outbox) AS outbox,
           (SELECT count(*)::text FROM outbox_dead_letters) AS dead`,
      );
      const telemetry = new WakePumpTelemetry();
      telemetry.beginCycle();
      telemetry.finishCycle();
      const app = await buildLoopbackHealthProbe({
        pool: database.pool,
        ackProbe: async () => undefined,
        wakePumpTelemetry: telemetry,
      });
      const ready = await app.inject({ method: 'GET', url: '/health/ready' });
      expect(ready.statusCode).toBe(200);
      expect(ready.json()).toEqual({ status: 'ready' });
      await app.close();
      const after = await database.pool.query<{ outbox: string; dead: string }>(
        `SELECT
           (SELECT count(*)::text FROM adapter_outbox) AS outbox,
           (SELECT count(*)::text FROM outbox_dead_letters) AS dead`,
      );
      expect(after.rows).toEqual(before.rows);

      // This role can connect and parse every SELECT in the probe, but cannot take the row locks,
      // update the wake lease, or insert the exhausted claim in its DLQ. SELECT 1 remains green.
      await database.pool.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
      roleCreated = true;
      await database.pool.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
      await database.pool.query(
        `GRANT SELECT ON schema_migrations,connection_leases,adapter_outbox,outbox_dead_letters,
                         terminal_sessions
           TO ${role}`,
      );
      await database.pool.query(`GRANT UPDATE ON terminal_sessions TO ${role}`);
      const restrictedUrl = new URL(database.url);
      restrictedUrl.username = role;
      restrictedUrl.password = password;
      restrictedPool = createPool(restrictedUrl.href, { max: 1 });
      expect((await restrictedPool.query('SELECT 1')).rowCount).toBe(1);
      await expect(probeDeliveryAdmissionPath(restrictedPool))
        .rejects.toThrow(/schema-015 delivery admission/u);
      await expect(probeWakePath(restrictedPool)).rejects.toThrow(/schema-031 claim contract/u);
      await expect(probeTerminalClaimPath(restrictedPool))
        .rejects.toThrow(/schema-032 claim contract/u);
      await expect(probeTerminalBrowserOwnerPath(restrictedPool))
        .rejects.toThrow(/schema-033 browser owner/u);
      await expect(probeTerminalRelayInstancePath(restrictedPool))
        .rejects.toThrow(/schema-034 relay instance/u);
      await expect(probeProfileRuntimePath(restrictedPool))
        .rejects.toThrow(/schema-035 profile runtime/u);

      await database.pool.query(`GRANT UPDATE ON connection_leases,adapter_outbox TO ${role}`);
      await database.pool.query(`GRANT INSERT ON outbox_dead_letters TO ${role}`);
      await database.pool.query(
        `GRANT SELECT ON agents,memberships,role_policies,tenants,rooms,acl_edges,
                         delivery_lane_fairness,deliveries,messages TO ${role}`,
      );
      await database.pool.query(`GRANT INSERT,UPDATE ON delivery_lane_fairness TO ${role}`);
      await database.pool.query(`GRANT UPDATE ON deliveries TO ${role}`);
      await expect(probeDeliveryAdmissionPath(restrictedPool)).resolves.toBeUndefined();
      for (const routeTable of ['memberships', 'role_policies', 'tenants', 'rooms', 'acl_edges']) {
        await database.pool.query(`REVOKE SELECT ON ${routeTable} FROM ${role}`);
        await expect(probeDeliveryAdmissionPath(restrictedPool))
          .rejects.toThrow(/schema-015 delivery admission/u);
        await database.pool.query(`GRANT SELECT ON ${routeTable} TO ${role}`);
      }
      await expect(probeDeliveryAdmissionPath(restrictedPool)).resolves.toBeUndefined();
      await expect(probeWakePath(restrictedPool)).resolves.toBeUndefined();
      const restrictedApp = await buildLoopbackHealthProbe({
        pool: restrictedPool,
        ackProbe: async () => undefined,
        wakePumpTelemetry: telemetry,
      });
      const denied = await restrictedApp.inject({ method: 'GET', url: '/health/ready' });
      expect(denied.statusCode).toBe(503);
      expect(denied.json()).toEqual({
        status: 'not_ready', reason: 'terminal_claim_path_unavailable',
      });
      await restrictedApp.close();

      // Table UPDATE is not enough: every successful claim transaction writes durable audit.
      // A role with a green SELECT 1 and all claim columns but no audit INSERT must stay unready.
      await database.pool.query(`GRANT INSERT ON audit_events TO ${role}`);
      await database.pool.query(`GRANT USAGE ON SEQUENCE audit_events_id_seq TO ${role}`);
      await expect(probeTerminalClaimPath(restrictedPool)).resolves.toBeUndefined();
      await expect(probeTerminalBrowserOwnerPath(restrictedPool))
        .rejects.toThrow(/schema-033 browser owner/u);
      await database.pool.query(`GRANT INSERT ON terminal_sessions TO ${role}`);
      await expect(probeTerminalBrowserOwnerPath(restrictedPool)).resolves.toBeUndefined();
      await expect(probeTerminalRelayInstancePath(restrictedPool)).resolves.toBeUndefined();
      await expect(probeProfileRuntimePath(restrictedPool))
        .rejects.toThrow(/schema-035 profile runtime/u);
      await database.pool.query(
        `GRANT SELECT,INSERT,UPDATE ON agent_profile_runtime_expectations TO ${role}`,
      );
      await database.pool.query(
        `GRANT SELECT,INSERT ON agent_profile_runtime_adoptions TO ${role}`,
      );
      await database.pool.query(`GRANT SELECT,UPDATE ON agent_profiles TO ${role}`);
      await database.pool.query(`GRANT SELECT ON deliveries TO ${role}`);
      await expect(probeProfileRuntimePath(restrictedPool)).resolves.toBeUndefined();

      await database.pool.query(
        `ALTER TABLE agent_profile_runtime_adoptions
           DISABLE TRIGGER agent_profile_runtime_adoptions_expectation_guard`,
      );
      await expect(probeProfileRuntimePath(database.pool))
        .rejects.toThrow(/schema-035 profile runtime/u);
      await database.pool.query(
        `ALTER TABLE agent_profile_runtime_adoptions
           ENABLE TRIGGER agent_profile_runtime_adoptions_expectation_guard`,
      );
      await expect(probeProfileRuntimePath(database.pool)).resolves.toBeUndefined();

      await database.pool.query(
        `CREATE OR REPLACE FUNCTION cauce_profile_runtime_documents_valid(candidate jsonb)
         RETURNS boolean LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
         AS $$ BEGIN RETURN true; END $$`,
      );
      await expect(probeProfileRuntimePath(database.pool))
        .rejects.toThrow(/schema-035 profile runtime/u);

      await database.pool.query(
        `ALTER TABLE terminal_sessions DROP CONSTRAINT terminal_sessions_relay_instance_shape,
           ADD CONSTRAINT terminal_sessions_relay_instance_shape CHECK (
             (
               relay_instance_id IS NULL AND relay_boot_id IS NULL
               AND (closed_at IS NOT NULL OR revoked_at IS NOT NULL)
             ) OR (
               relay_instance_id IS NOT NULL AND relay_instance_id ~ '^[0-9a-f]{64}$'
               AND (
                 (relay_claim_epoch=0 AND relay_boot_id IS NULL)
                 OR (
                   relay_claim_epoch>0 AND relay_boot_id IS NOT NULL
                   AND relay_boot_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
                 )
               )
             ) OR relay_instance_id='not-a-real-instance'
           )`,
      );
      await expect(probeTerminalRelayInstancePath(database.pool))
        .rejects.toThrow(/schema-034 relay instance/u);

      await database.pool.query(
        `DROP INDEX terminal_sessions_request_id_idx;
         CREATE INDEX terminal_sessions_request_id_idx ON terminal_sessions(request_id)`,
      );
      await expect(probeTerminalBrowserOwnerPath(database.pool))
        .rejects.toThrow(/schema-033 browser owner/u);
      await database.pool.query(
        `DROP INDEX terminal_sessions_request_id_idx;
         CREATE UNIQUE INDEX terminal_sessions_request_id_idx ON terminal_sessions(request_id)`,
      );
      await expect(probeTerminalBrowserOwnerPath(database.pool)).resolves.toBeUndefined();

      // Preserve every expected fragment but add an invalid owner generation: exact comparison
      // must reject the widened CHECK rather than accepting it by substring.
      await database.pool.query(
        `ALTER TABLE terminal_sessions DROP CONSTRAINT terminal_sessions_browser_owner_shape,
           ADD CONSTRAINT terminal_sessions_browser_owner_shape CHECK (
             (
               octet_length(request_sha256)=32
               AND octet_length(browser_owner_sha256)=32
               AND browser_owner_generation>0
             ) OR browser_owner_generation=-1
           )`,
      );
      await expect(probeTerminalBrowserOwnerPath(database.pool))
        .rejects.toThrow(/schema-033 browser owner/u);

      // The old substring probe accepted this widened constraint because every expected fragment
      // was still present. Exact structural comparison must reject the extra invalid state.
      await database.pool.query(
        `ALTER TABLE terminal_sessions DROP CONSTRAINT terminal_sessions_relay_claim_shape,
           ADD CONSTRAINT terminal_sessions_relay_claim_shape CHECK (
             (
               relay_claim_sha256 IS NULL AND relay_claim_epoch=0
               AND relay_claimed_at IS NULL AND relay_claim_expires_at IS NULL
             ) OR (
               consumed_at IS NOT NULL AND relay_claim_sha256 IS NOT NULL
               AND octet_length(relay_claim_sha256)=32 AND relay_claim_epoch>0
               AND relay_claimed_at IS NOT NULL AND relay_claim_expires_at IS NOT NULL
               AND relay_claim_expires_at>relay_claimed_at
             ) OR relay_claim_epoch=-1
           )`,
      );
      await expect(probeTerminalClaimPath(database.pool))
        .rejects.toThrow(/schema-032 claim contract/u);
    } finally {
      await restrictedPool?.end();
      if (roleCreated) {
        await database.pool.query(`DROP OWNED BY ${role}`);
        await database.pool.query(`DROP ROLE ${role}`);
      }
      await database.pool.end();
      await database.container.stop();
    }
  }, 120_000);

  it('keeps the old behaviour when no data app is supplied', async () => {
    const app = await buildLoopbackHealthProbe({ pool: answeringPool, ackProbe: async () => undefined });
    expect((await app.inject({ method: 'GET', url: '/health/ready' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/health/live' })).json()).toEqual({ status: 'live' });
    await app.close();
  });
});
