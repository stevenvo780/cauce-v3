import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createPool, type DatabasePool } from '@cauce/store';
import { afterEach, describe, expect, it } from 'vitest';
import { dockerTestRequirement, startTestDatabase } from '../../../tests/helpers/postgres.js';
import {
  buildLoopbackHealthProbe,
  probeDeliveryAdmissionPath, probeProfileRuntimePath,
  probeTerminalBrowserOwnerPath, probeTerminalClaimPath, probeTerminalRelayInstancePath,
  probeWakePath,
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
      companyIsolationProbe: async () => undefined,
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
      await database.adminPool.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
      roleCreated = true;
      await database.adminPool.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
      await database.adminPool.query(
        `GRANT SELECT ON schema_migrations,connection_leases,adapter_outbox,outbox_dead_letters,
                         terminal_sessions
           TO ${role}`,
      );
      await database.adminPool.query(`GRANT UPDATE ON terminal_sessions TO ${role}`);
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

      await database.adminPool.query(`GRANT UPDATE ON connection_leases,adapter_outbox TO ${role}`);
      await database.adminPool.query(`GRANT INSERT ON outbox_dead_letters TO ${role}`);
      await database.adminPool.query(
        `GRANT SELECT ON agents,memberships,role_policies,tenants,rooms,acl_edges,
                         delivery_lane_fairness,deliveries,messages TO ${role}`,
      );
      await database.adminPool.query(`GRANT INSERT,UPDATE ON delivery_lane_fairness TO ${role}`);
      await database.adminPool.query(`GRANT UPDATE ON deliveries TO ${role}`);
      await expect(probeDeliveryAdmissionPath(restrictedPool)).resolves.toBeUndefined();
      for (const routeTable of ['memberships', 'role_policies', 'tenants', 'rooms', 'acl_edges']) {
        await database.adminPool.query(`REVOKE SELECT ON ${routeTable} FROM ${role}`);
        await expect(probeDeliveryAdmissionPath(restrictedPool))
          .rejects.toThrow(/schema-015 delivery admission/u);
        await database.adminPool.query(`GRANT SELECT ON ${routeTable} TO ${role}`);
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
      await database.adminPool.query(`GRANT INSERT ON audit_events TO ${role}`);
      await database.adminPool.query(`GRANT USAGE ON SEQUENCE audit_events_id_seq TO ${role}`);
      await expect(probeTerminalClaimPath(restrictedPool)).resolves.toBeUndefined();
      await expect(probeTerminalBrowserOwnerPath(restrictedPool))
        .rejects.toThrow(/schema-033 browser owner/u);
      await database.adminPool.query(`GRANT INSERT ON terminal_sessions TO ${role}`);
      await expect(probeTerminalBrowserOwnerPath(restrictedPool)).resolves.toBeUndefined();
      await expect(probeTerminalRelayInstancePath(restrictedPool)).resolves.toBeUndefined();
      await expect(probeProfileRuntimePath(restrictedPool))
        .rejects.toThrow(/schema-035 profile runtime/u);
      await database.adminPool.query(
        `GRANT SELECT,INSERT,UPDATE ON agent_profile_runtime_expectations TO ${role}`,
      );
      await database.adminPool.query(
        `GRANT SELECT,INSERT ON agent_profile_runtime_adoptions TO ${role}`,
      );
      await database.adminPool.query(`GRANT SELECT,UPDATE ON agent_profiles TO ${role}`);
      await database.adminPool.query(`GRANT SELECT ON deliveries TO ${role}`);
      await expect(probeProfileRuntimePath(restrictedPool)).resolves.toBeUndefined();

      await database.adminPool.query(
        `ALTER TABLE agent_profile_runtime_adoptions
           DISABLE TRIGGER agent_profile_runtime_adoptions_expectation_guard`,
      );
      await expect(probeProfileRuntimePath(database.pool))
        .rejects.toThrow(/schema-035 profile runtime/u);
      await database.adminPool.query(
        `ALTER TABLE agent_profile_runtime_adoptions
           ENABLE TRIGGER agent_profile_runtime_adoptions_expectation_guard`,
      );
      await expect(probeProfileRuntimePath(database.pool)).resolves.toBeUndefined();

      await database.adminPool.query(
        `CREATE OR REPLACE FUNCTION cauce_profile_runtime_documents_valid(candidate jsonb)
         RETURNS boolean LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
         AS $$ BEGIN RETURN true; END $$`,
      );
      await expect(probeProfileRuntimePath(database.pool))
        .rejects.toThrow(/schema-035 profile runtime/u);

      await database.adminPool.query(
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

      await database.adminPool.query(
        `DROP INDEX terminal_sessions_request_id_idx;
         CREATE INDEX terminal_sessions_request_id_idx ON terminal_sessions(request_id)`,
      );
      await expect(probeTerminalBrowserOwnerPath(database.pool))
        .rejects.toThrow(/schema-033 browser owner/u);
      await database.adminPool.query(
        `DROP INDEX terminal_sessions_request_id_idx;
         CREATE UNIQUE INDEX terminal_sessions_request_id_idx ON terminal_sessions(request_id)`,
      );
      await expect(probeTerminalBrowserOwnerPath(database.pool)).resolves.toBeUndefined();

      // Preserve every expected fragment but add an invalid owner generation: exact comparison
      // must reject the widened CHECK rather than accepting it by substring.
      await database.adminPool.query(
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
      await database.adminPool.query(
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
        await database.adminPool.query(`DROP OWNED BY ${role}`);
        await database.adminPool.query(`DROP ROLE ${role}`);
      }
      await database.pool.end();
      await database.container.stop();
    }
  }, 120_000);
});
