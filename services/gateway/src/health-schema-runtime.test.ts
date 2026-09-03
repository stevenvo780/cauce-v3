import type { DatabasePool } from '@cauce/store';
import { describe, expect, it, vi } from 'vitest';
import {
  probeConsolePublishIntentPath,
  probeDeliveryAdmissionPath,
  probeProfileRuntimePath,
  probeTerminalBrowserOwnerPath,
  probeTerminalClaimPath,
  probeTerminalRelayInstancePath,
  probeWakePath,
} from './health.js';
import {
  readStaleProfileExpectations, type LiveProfilePresence,
} from './health/schema-profile-runtime.js';

interface SchemaProbeCase {
  readonly label: string;
  readonly marker: string;
  readonly probe: (pool: DatabasePool) => Promise<void>;
  readonly row: Readonly<Record<string, boolean>>;
}

const schemaProbeCases: readonly SchemaProbeCase[] = [
  {
    label: 'delivery admission',
    marker: 'AS capacity_column_exact',
    probe: probeDeliveryAdmissionPath,
    row: {
      migration_applied: true,
      capacity_column_exact: true,
      capacity_constraint_valid: true,
      inflight_index_valid: true,
      claim_permissions: true,
    },
  },
  {
    label: 'wake claim',
    marker: 'AS connection_token_exact',
    probe: probeWakePath,
    row: {
      migration_applied: true,
      connection_token_exact: true,
      claim_permissions: true,
    },
  },
  {
    label: 'terminal claim',
    marker: 'terminal_sessions_relay_claim_shape',
    probe: probeTerminalClaimPath,
    row: {
      migration_applied: true,
      columns_exact: true,
      constraint_exact: true,
      claim_permissions: true,
      audit_permissions: true,
    },
  },
  {
    label: 'terminal browser owner',
    marker: 'terminal_sessions_browser_owner_shape',
    probe: probeTerminalBrowserOwnerPath,
    row: {
      migration_applied: true,
      columns_exact: true,
      constraint_exact: true,
      request_index_exact: true,
      mutation_permissions: true,
      audit_permissions: true,
    },
  },
  {
    label: 'terminal relay instance',
    marker: 'terminal_sessions_relay_instance_shape',
    probe: probeTerminalRelayInstancePath,
    row: {
      migration_applied: true,
      columns_exact: true,
      constraint_exact: true,
      mutation_permissions: true,
    },
  },
  {
    label: 'profile runtime',
    marker: 'AS columns_exact',
    probe: probeProfileRuntimePath,
    row: {
      migration_applied: true,
      columns_exact: true,
      constraints_exact: true,
      functions_exact: true,
      triggers_exact: true,
      mutation_permissions: true,
    },
  },
  {
    label: 'console publish intent',
    marker: 'AS migration_ledger_exact',
    probe: probeConsolePublishIntentPath,
    row: {
      migration_ledger_exact: true,
      indexes_exact: true,
      journal_permissions: true,
    },
  },
];

const malformedValues: readonly unknown[] = ['false', 1, null];
const adversarialCases = schemaProbeCases.flatMap((probeCase) =>
  Object.keys(probeCase.row).flatMap((field) =>
    malformedValues.map((value) => ({
      field,
      probeCase,
      value,
      valueLabel: String(value),
    })),
  ),
);

function poolReturning(marker: string, row: Readonly<Record<string, unknown>>): DatabasePool {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes(marker)) return { rows: [row], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  const client = {
    query,
    on: vi.fn(),
    off: vi.fn(),
    release: vi.fn(),
  };
  return { connect: vi.fn(async () => client) } as unknown as DatabasePool;
}

function poolWithExpectations(rows: readonly Readonly<Record<string, unknown>>[]): {
  readonly pool: DatabasePool;
  readonly statements: string[];
} {
  const statements: string[] = [];
  const query = vi.fn(async (sql: string) => {
    statements.push(sql);
    return sql.includes('agent_profile_runtime_expectations')
      ? { rows: [...rows], rowCount: rows.length }
      : { rows: [], rowCount: 0 };
  });
  const client = { query, on: vi.fn(), off: vi.fn(), release: vi.fn() };
  return { statements, pool: { connect: vi.fn(async () => client) } as unknown as DatabasePool };
}

function presenceOf(generations: Readonly<Record<string, string>>): LiveProfilePresence {
  return {
    generationFor: (tenantId: string, alias: string) => generations[`${tenantId}/${alias}`],
  };
}

describe('expectativas ancladas a una generación que ya no existe', () => {
  it('degrada sólo las filas cuya generación difiere de la presencia viva', async () => {
    const { pool, statements } = poolWithExpectations([
      { tenant_id: 'Steven', alias: 'zeus', revision: '7', generation: 'gen-vieja' },
      { tenant_id: 'Steven', alias: 'kant', revision: 3, generation: 'gen-viva' },
      { tenant_id: 'Miguel', alias: 'iza', revision: '2', generation: 'gen-apagada' },
    ]);

    const degraded = await readStaleProfileExpectations(pool, presenceOf({
      'Steven/zeus': 'gen-nueva',
      'Steven/kant': 'gen-viva',
    }));

    expect(degraded).toEqual({
      stale: [{
        tenant_id: 'Steven', alias: 'zeus', revision: 7,
        recorded_generation: 'gen-vieja', live_generation: 'gen-nueva',
      }],
      malformed: [],
      truncated: false,
    });
    expect(statements).toContain('SET TRANSACTION READ ONLY');
    expect(statements.some((statement) => /LIMIT \d+/u.test(statement))).toBe(true);
  });

  it('una fila inválida se degrada sola y no tumba la lectura de las sanas', async () => {
    const invalidas: Readonly<Record<string, unknown>>[] = [
      { tenant_id: 'Steven', alias: 'zeus', revision: '0', generation: 'gen-vieja' },
      { tenant_id: 'Steven', alias: 'zeus', revision: '1.5', generation: 'gen-vieja' },
      { tenant_id: 'Steven', alias: '', revision: '7', generation: 'gen-vieja' },
      { tenant_id: 'Steven', alias: 'zeus', revision: '7', generation: 7 },
      { tenant_id: 'Steven', alias: 'kant', revision: null, generation: 'gen-viva' },
    ];
    for (const fila of invalidas) {
      const { pool } = poolWithExpectations([
        fila,
        { tenant_id: 'Miguel', alias: 'iza', revision: '2', generation: 'gen-vieja' },
      ]);
      const degraded = await readStaleProfileExpectations(pool, presenceOf({
        'Steven/zeus': 'gen-nueva', 'Steven/': 'gen-nueva', 'Steven/kant': 'gen-viva',
        'Miguel/iza': 'gen-nueva',
      }));

      expect(degraded.malformed).toHaveLength(1);
      expect(degraded.malformed[0]?.reason).toMatch(/invalid (tenant|alias|generation|revision)/u);
      expect(degraded.stale).toEqual([{
        tenant_id: 'Miguel', alias: 'iza', revision: 2,
        recorded_generation: 'gen-vieja', live_generation: 'gen-nueva',
      }]);
    }
  });

  it('un censo más largo que el tope se acredita como truncado', async () => {
    const filas = Array.from({ length: 501 }, (_, index) => ({
      tenant_id: 'Steven', alias: `alias-${String(index)}`, revision: '1', generation: 'gen-vieja',
    }));
    const { pool } = poolWithExpectations(filas);

    const degraded = await readStaleProfileExpectations(pool, presenceOf(
      Object.fromEntries(filas.map((fila) => [`Steven/${fila.alias}`, 'gen-nueva'])),
    ));

    expect(degraded.truncated).toBe(true);
    expect(degraded.stale).toHaveLength(500);
  });
});

describe('gateway schema probes reject malformed PostgreSQL boolean authority', () => {
  it.each(adversarialCases)(
    '$probeCase.label rejects $field=$valueLabel',
    async ({ field, probeCase, value }) => {
      const row: Readonly<Record<string, unknown>> = { ...probeCase.row, [field]: value };
      await expect(probeCase.probe(poolReturning(probeCase.marker, row)))
        .rejects.toThrow(/contract is unavailable/u);
    },
  );
});
