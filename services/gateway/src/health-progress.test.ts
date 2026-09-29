import type { DatabasePool } from '@cauce/store';
import { describe, expect, it } from 'vitest';
import {
  probeAckPath, probeConsolePublishIntentPath, probeDeliveryAdmissionPath, probeProfileRuntimePath,
  probeTerminalBrowserOwnerPath, probeTerminalClaimPath, probeTerminalRelayInstancePath, probeWakePath,
} from './health.js';

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

    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
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

    const calls = query.mock.calls.map(([sql]) => sql);
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

    const calls = query.mock.calls.map(([sql]) => sql);
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

    const calls = query.mock.calls.map(([sql]) => sql);
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

    const calls = query.mock.calls.map(([sql]) => sql);
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

    const calls = query.mock.calls.map(([sql]) => sql);
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

    const calls = query.mock.calls.map(([sql]) => sql);
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

    const calls = query.mock.calls.map(([sql]) => sql);
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
    expect(query.mock.calls.map(([sql]) => sql).at(-1)).toBe('ROLLBACK');
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

    const calls = query.mock.calls.map(([sql]) => sql);
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

    const calls = query.mock.calls.map(([sql]) => sql);
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
    const calls = query.mock.calls.map(([sql]) => sql);
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

    const calls = query.mock.calls.map(([sql]) => sql);
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
});
