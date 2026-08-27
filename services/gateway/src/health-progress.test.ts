import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { createPool, type DatabasePool } from '@cauce/store';
import { afterEach, describe, expect, it } from 'vitest';
import { startTestDatabase } from '../../../tests/helpers/postgres.js';
import {
  buildLoopbackHealthProbe, probeAckPath, probeConsolePublishIntentPath,
  probeDeliveryAdmissionPath, probeProfileRuntimePath,
  probeTerminalBrowserOwnerPath, probeTerminalClaimPath, probeTerminalRelayInstancePath,
  probeWakePath, renderWakePumpMetrics,
} from './health.js';
import { WakePumpTelemetry } from './wake-pump-telemetry.js';

/** Pool que responde a consultas básicas para pruebas de sonda. */
const answeringPool = {
  query: async () => ({ rows: [{ ssl: true }], rowCount: 1 }),
} as unknown as DatabasePool;

let dataListener: Server | undefined;

afterEach(async () => {
  if (dataListener) await new Promise<void>((resolve) => dataListener!.close(() => resolve()));
  dataListener = undefined;
});

async function listeningDataApp(): Promise<{ server: Server }> {
  dataListener = createServer(() => undefined);
  await new Promise<void>((resolve) => dataListener!.listen(0, '127.0.0.1', resolve));
  return { server: dataListener };
}

describe('gateway readiness stops lying about the listener the agents actually use', () => {
  it('probes the ACK ledger under bounded PostgreSQL timeouts without reading payloads', async () => {
    const query = vi.fn(async (sql: string, parameters?: readonly unknown[]) => {
      void parameters;
      void sql;
      return { rows: [], rowCount: 0 };
    });
    const client = {
      query,
      on: vi.fn(),
      off: vi.fn(),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) } as unknown as DatabasePool;

    await probeAckPath(pool);

    expect(query.mock.calls.map(([sql]) => String(sql))).toEqual([
      'BEGIN',
      "SET LOCAL lock_timeout='1000ms'",
      "SET LOCAL statement_timeout='2000ms'",
      expect.stringMatching(/FROM deliveries d[\s\S]*LEFT JOIN delivery_acks/u),
      'COMMIT',
    ]);
    expect(client.release).toHaveBeenCalledWith(false);
  });

  it('probes delivery admission schema, privileges and live-capacity SQL read-only', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('AS capacity_column_exact')) {
        return {
          rows: [{
            migration_applied: true,
            capacity_column_exact: true,
            capacity_constraint_valid: true,
            inflight_index_valid: true,
            claim_permissions: true,
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const client = { query, on: vi.fn(), off: vi.fn(), release: vi.fn() };
    const pool = { connect: vi.fn(async () => client) } as unknown as DatabasePool;

    await probeDeliveryAdmissionPath(pool);

    const calls = query.mock.calls.map(([sql]) => String(sql));
    expect(calls).toEqual([
      'BEGIN',
      'SET TRANSACTION READ ONLY',
      "SET LOCAL lock_timeout='1000ms'",
      "SET LOCAL statement_timeout='2000ms'",
      expect.stringMatching(/015_delivery_concurrency_cap[\s\S]*capacity_column_exact[\s\S]*delivery_lane_fairness[\s\S]*claim_permissions/u),
      expect.stringMatching(/WITH requested[\s\S]*max_concurrent_deliveries[\s\S]*memberships[\s\S]*role_policies[\s\S]*acl_edges[\s\S]*ack_deadline_at>now\(\)[\s\S]*message\.priority/u),
      'COMMIT',
    ]);
    expect(calls[5]).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|TRUNCATE|FOR\s+UPDATE|FOR\s+SHARE)\b/iu);
    expect(client.release).toHaveBeenCalledWith(false);
  });

  it('rejects an incomplete delivery-capacity contract before running its SQL probe', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('AS capacity_column_exact')) {
        return {
          rows: [{
            migration_applied: true,
            capacity_column_exact: false,
            capacity_constraint_valid: true,
            inflight_index_valid: true,
            claim_permissions: true,
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const client = { query, on: vi.fn(), off: vi.fn(), release: vi.fn() };
    const pool = { connect: vi.fn(async () => client) } as unknown as DatabasePool;

    await expect(probeDeliveryAdmissionPath(pool)).rejects.toThrow(/schema-015 delivery admission/u);

    const calls = query.mock.calls.map(([sql]) => String(sql));
    expect(calls.at(-1)).toBe('ROLLBACK');
    expect(calls.some((sql) => sql.includes('WITH requested'))).toBe(false);
  });

  it('probes the schema-031 wake claim read-only, bounded and without a real recipient', async () => {
    const query = vi.fn(async (sql: string, parameters?: readonly unknown[]) => {
      void parameters;
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
      return { rows: [], rowCount: 0 };
    });
    const client = { query, on: vi.fn(), off: vi.fn(), release: vi.fn() };
    const pool = { connect: vi.fn(async () => client) } as unknown as DatabasePool;

    await probeWakePath(pool);

    const calls = query.mock.calls.map(([sql]) => String(sql));
    expect(calls).toEqual([
      'BEGIN',
      'SET TRANSACTION READ ONLY',
      "SET LOCAL lock_timeout='1000ms'",
      "SET LOCAL statement_timeout='2000ms'",
      expect.stringMatching(/031_connection_session_fencing[\s\S]*connection_token_exact/u),
      expect.stringMatching(/WITH requested[\s\S]*NULL::uuid[\s\S]*JOIN connection_leases[\s\S]*FROM adapter_outbox[\s\S]*FROM outbox_dead_letters/u),
      'COMMIT',
    ]);
    expect(calls[5]).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|TRUNCATE|FOR\s+UPDATE)\b/iu);
    expect(query.mock.calls[5]?.[1]).toBeUndefined();
    expect(client.release).toHaveBeenCalledWith(false);
  });

  it('rejects a missing schema-031 contract before pretending the wake SQL is usable', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('AS migration_applied')) {
        return {
          rows: [{
            migration_applied: false,
            connection_token_exact: false,
            claim_permissions: true,
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const client = { query, on: vi.fn(), off: vi.fn(), release: vi.fn() };
    const pool = { connect: vi.fn(async () => client) } as unknown as DatabasePool;

    await expect(probeWakePath(pool)).rejects.toThrow(/schema-031 claim contract/u);

    const calls = query.mock.calls.map(([sql]) => String(sql));
    expect(calls.at(-1)).toBe('ROLLBACK');
    expect(calls.some((sql) => sql.includes('WITH requested'))).toBe(false);
  });

  it('probes schema-032 and its exact-fence CAS read-only without observing a session', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('AS columns_exact')) {
        return {
          rows: [{
            migration_applied: true,
            columns_exact: true,
            constraint_exact: true,
            claim_permissions: true,
            audit_permissions: true,
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const client = { query, on: vi.fn(), off: vi.fn(), release: vi.fn() };
    const pool = { connect: vi.fn(async () => client) } as unknown as DatabasePool;

    await probeTerminalClaimPath(pool);

    const calls = query.mock.calls.map(([sql]) => String(sql));
    expect(calls).toEqual([
      'BEGIN',
      'SET TRANSACTION READ ONLY',
      "SET LOCAL lock_timeout='1000ms'",
      "SET LOCAL statement_timeout='2000ms'",
      expect.stringMatching(/pg_get_constraintdef[\s\S]*terminal_sessions_relay_claim_shape[\s\S]*032_terminal_session_claim_fencing[\s\S]*audit_events[\s\S]*INSERT/u),
      expect.stringMatching(/WITH requested[\s\S]*NULL::bytea[\s\S]*relay_claim_sha256=requested\.claim_sha256[\s\S]*relay_claim_epoch=requested\.claim_epoch[\s\S]*closed_at IS NULL/u),
      'COMMIT',
    ]);
    expect(calls[5]).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|TRUNCATE|FOR\s+UPDATE)\b/iu);
    expect(client.release).toHaveBeenCalledWith(false);
  });

  it('rejects a missing schema-032 constraint before running the claim CAS probe', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('AS columns_exact')) {
        return {
          rows: [{
            migration_applied: true,
            columns_exact: true,
            constraint_exact: false,
            claim_permissions: true,
            audit_permissions: true,
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const client = { query, on: vi.fn(), off: vi.fn(), release: vi.fn() };
    const pool = { connect: vi.fn(async () => client) } as unknown as DatabasePool;

    await expect(probeTerminalClaimPath(pool)).rejects.toThrow(/schema-032 claim contract/u);

    const calls = query.mock.calls.map(([sql]) => String(sql));
    expect(calls.at(-1)).toBe('ROLLBACK');
    expect(calls.some((sql) => sql.includes('WITH requested'))).toBe(false);
  });

  it('probes schema-033 columns, owner CHECK, unique request index and CAS read-only', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('AS request_index_exact')) {
        return {
          rows: [{
            migration_applied: true,
            columns_exact: true,
            constraint_exact: true,
            request_index_exact: true,
            mutation_permissions: true,
            audit_permissions: true,
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const client = { query, on: vi.fn(), off: vi.fn(), release: vi.fn() };
    const pool = { connect: vi.fn(async () => client) } as unknown as DatabasePool;

    await probeTerminalBrowserOwnerPath(pool);

    const calls = query.mock.calls.map(([sql]) => String(sql));
    expect(calls).toEqual([
      'BEGIN',
      'SET TRANSACTION READ ONLY',
      "SET LOCAL lock_timeout='1000ms'",
      "SET LOCAL statement_timeout='2000ms'",
      expect.stringMatching(/terminal_sessions_browser_owner_shape[\s\S]*terminal_sessions_request_id_idx[\s\S]*033_terminal_browser_owner_fencing[\s\S]*'INSERT'[\s\S]*'UPDATE'/u),
      expect.stringMatching(/WITH requested[\s\S]*NULL::uuid[\s\S]*request_sha256=requested\.request_sha256[\s\S]*browser_owner_generation=requested\.browser_owner_generation/u),
      'COMMIT',
    ]);
    expect(calls[5]).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|TRUNCATE|FOR\s+UPDATE)\b/iu);
    expect(client.release).toHaveBeenCalledWith(false);
  });

  it('rejects a merely named but non-unique schema-033 request index', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('AS request_index_exact')) {
        return {
          rows: [{
            migration_applied: true,
            columns_exact: true,
            constraint_exact: true,
            request_index_exact: false,
            mutation_permissions: true,
            audit_permissions: true,
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const client = { query, on: vi.fn(), off: vi.fn(), release: vi.fn() };
    const pool = { connect: vi.fn(async () => client) } as unknown as DatabasePool;

    await expect(probeTerminalBrowserOwnerPath(pool)).rejects.toThrow(/schema-033 browser owner/u);
    expect(query.mock.calls.map(([sql]) => String(sql)).at(-1)).toBe('ROLLBACK');
  });

  it('probes schema-034 relay instance and UUIDv4 process fencing read-only', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('schema-034 relay instance contract')) return { rows: [], rowCount: 0 };
      if (sql.includes('AS mutation_permissions') && sql.includes('relay_constraint')) {
        return {
          rows: [{
            migration_applied: true,
            columns_exact: true,
            constraint_exact: true,
            mutation_permissions: true,
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const client = { query, on: vi.fn(), off: vi.fn(), release: vi.fn() };
    const pool = { connect: vi.fn(async () => client) } as unknown as DatabasePool;

    await probeTerminalRelayInstancePath(pool);

    const calls = query.mock.calls.map(([sql]) => String(sql));
    expect(calls).toEqual([
      'BEGIN',
      'SET TRANSACTION READ ONLY',
      "SET LOCAL lock_timeout='1000ms'",
      "SET LOCAL statement_timeout='2000ms'",
      expect.stringMatching(/terminal_sessions_relay_instance_shape[\s\S]*034_terminal_relay_instance_fencing[\s\S]*relay_boot_id::text/u),
      expect.stringMatching(/WITH requested[\s\S]*NULL::text[\s\S]*relay_instance_id=requested\.relay_instance_id[\s\S]*relay_boot_id IS NOT DISTINCT FROM/u),
      'COMMIT',
    ]);
    expect(calls[5]).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|TRUNCATE|FOR\s+UPDATE)\b/iu);
  });

  it('probes the exact schema-035 profile evidence topology and behavior read-only', async () => {
    const query = vi.fn(async (sql: string, parameters?: readonly unknown[]) => {
      if (sql.includes('AS functions_exact')) {
        expect(parameters).toEqual([
          expect.stringMatching(/jsonb_array_elements[\s\S]*document_count/u),
          expect.stringMatching(/runtime profile adoption does not match[\s\S]*RETURN NEW/u),
        ]);
        return {
          rows: [{
            migration_applied: true,
            columns_exact: true,
            constraints_exact: true,
            functions_exact: true,
            triggers_exact: true,
            mutation_permissions: true,
          }],
          rowCount: 1,
        };
      }
      if (sql.includes('AS documents_contract')) {
        return { rows: [{ documents_contract: true }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const client = { query, on: vi.fn(), off: vi.fn(), release: vi.fn() };
    const pool = { connect: vi.fn(async () => client) } as unknown as DatabasePool;

    await probeProfileRuntimePath(pool);

    const calls = query.mock.calls.map(([sql]) => String(sql));
    expect(calls).toEqual([
      'BEGIN',
      'SET TRANSACTION READ ONLY',
      "SET LOCAL lock_timeout='1000ms'",
      "SET LOCAL statement_timeout='2000ms'",
      expect.stringMatching(/035_agent_profile_runtime_adoption[\s\S]*functions_exact[\s\S]*triggers_exact[\s\S]*audit_events/u),
      expect.stringMatching(/WITH requested[\s\S]*NULL::uuid[\s\S]*agent_profile_runtime_expectations[\s\S]*agent_profile_runtime_adoptions[\s\S]*agent_profiles/u),
      'COMMIT',
    ]);
    expect(calls[5]).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|TRUNCATE|FOR\s+UPDATE)\b/iu);
    expect(client.release).toHaveBeenCalledWith(false);
  });

  it('rejects a disabled schema-035 adoption trigger before its behavior probe', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('AS functions_exact')) {
        return {
          rows: [{
            migration_applied: true,
            columns_exact: true,
            constraints_exact: true,
            functions_exact: true,
            triggers_exact: false,
            mutation_permissions: true,
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const client = { query, on: vi.fn(), off: vi.fn(), release: vi.fn() };
    const pool = { connect: vi.fn(async () => client) } as unknown as DatabasePool;

    await expect(probeProfileRuntimePath(pool)).rejects.toThrow(/schema-035 profile runtime/u);
    const calls = query.mock.calls.map(([sql]) => String(sql));
    expect(calls.at(-1)).toBe('ROLLBACK');
    expect(calls.some((sql) => sql.includes('AS documents_contract'))).toBe(false);
  });

  it('probes schema-037 ledger, exact index topology and journal authority read-only', async () => {
    const query = vi.fn(async (sql: string, parameters?: readonly unknown[]) => {
      if (sql.includes('AS migration_ledger_exact')) {
        expect(parameters).toEqual([
          '0daeb89c224e940600562ab162fba03c4facd4cb0b80b65f20feedc02b33f281',
        ]);
        return {
          rows: [{
            migration_ledger_exact: true,
            indexes_exact: true,
            journal_permissions: true,
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const client = { query, on: vi.fn(), off: vi.fn(), release: vi.fn() };
    const pool = { connect: vi.fn(async () => client) } as unknown as DatabasePool;

    await probeConsolePublishIntentPath(pool);

    const calls = query.mock.calls.map(([sql]) => String(sql));
    expect(calls).toEqual([
      'BEGIN',
      'SET TRANSACTION READ ONLY',
      "SET LOCAL lock_timeout='1000ms'",
      "SET LOCAL statement_timeout='2000ms'",
      expect.any(String),
      'COMMIT',
    ]);
    expect(calls[4]).toMatch(/audit_events_console_publish_key_037_idx/u);
    expect(calls[4]).toMatch(/audit_events_console_publish_nonce_037_idx/u);
    expect(calls[4]).toMatch(/audit_events_console_publish_rate_037_idx/u);
    expect(calls[4]).toMatch(/audit_events_console_publish_head_037_idx/u);
    expect(calls[4]).toMatch(/pg_get_indexdef[\s\S]*schema_migration_ledger/u);
    expect(calls[4]).toMatch(/console\.publish\.prepare/u);
    expect(calls[4]).toMatch(/journal_permissions/u);
    expect(client.release).toHaveBeenCalledWith(false);
  });

  it('rejects schema-037 when same-named indexes do not match the exact definitions', async () => {
    const query = vi.fn(async (sql: string) => {
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
    expect(query.mock.calls.map(([sql]) => String(sql)).at(-1)).toBe('ROLLBACK');
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

    // Simula caída del listener de datos.
    await new Promise<void>((resolve) => dataListener!.close(() => resolve()));
    expect(await answeringPool.query('SELECT 1')).toBeTruthy();

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
    const clientQuery = vi.fn(async (sql: string) => {
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
    expect(clientQuery.mock.calls.some(([sql]) => String(sql).includes('WITH requested'))).toBe(true);
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
    // Verifica que la sonda de salud esté correctamente integrada en main.ts.
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

  it('proves exact 015/031/032/033/034/035 contracts on PostgreSQL 16 and rejects false structural greens', async () => {
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
      await expect(restrictedPool.query('SELECT 1')).resolves.toBeTruthy();
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

      // A same-named ordinary index is not the idempotency fence promised by schema-033.
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
