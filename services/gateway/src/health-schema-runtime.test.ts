import { readFile } from 'node:fs/promises';
import type { DatabasePool } from '@cauce/store';
import { describe, expect, it, vi } from 'vitest';
import {
  buildLoopbackHealthProbe,
  probeConsolePublishIntentPath,
  probeDeliveryAdmissionPath,
  probeProfileRuntimePath,
  probeTerminalBrowserOwnerPath,
  probeTerminalClaimPath,
  probeTerminalRelayInstancePath,
  probeWakePath,
  renderProfileRuntimeExpectationMetrics,
} from './health.js';
import {
  readStaleProfileExpectations, type LiveProfilePresence,
} from './health/schema-profile-runtime.js';
import { AgentRegistry } from './terminal/registry.js';
import type { AgentPresence } from './terminal/types.js';

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
    available: () => true,
    generationFor: (tenantId: string, alias: string) => generations[`${tenantId}/${alias}`],
  };
}

function observedPresence(alias: string, generation: string): AgentPresence {
  return {
    tenant_id: 'Steven', alias, container_id: `container-${alias}`, generation,
    image_id: 'sha256:test', runtime_user: 'dev', runtime_uid: 1000, harness: 'codex',
    modes: ['shell'], connected_since: new Date().toISOString(),
  };
}

const metricsPool = {
  query: vi.fn(async () => ({ rows: [{ '?column?': 1 }], rowCount: 1 })),
} as unknown as DatabasePool;

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
      unobserved: 1,
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
      expect(degraded.unobserved).toBe(0);
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
    expect(degraded.unobserved).toBe(0);
  });

  it('degrada expectativas ausentes o ambiguas aunque otro relay siga fresco', async () => {
    const registry = new AgentRegistry();
    registry.observe({
      relay_instance_id: 'a'.repeat(64),
      relay_boot_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    }, [
      observedPresence('live', 'gen-new'),
      observedPresence('ambiguous', 'gen-a'),
    ]);
    registry.observe({
      relay_instance_id: 'b'.repeat(64),
      relay_boot_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    }, [observedPresence('ambiguous', 'gen-b')]);
    const { pool } = poolWithExpectations([
      { tenant_id: 'Steven', alias: 'live', revision: 1, generation: 'gen-old' },
      { tenant_id: 'Steven', alias: 'missing', revision: 1, generation: 'gen-old' },
      { tenant_id: 'Steven', alias: 'ambiguous', revision: 1, generation: 'gen-old' },
    ]);

    expect(registry.available()).toBe(true);
    const degraded = await readStaleProfileExpectations(pool, registry);
    expect(degraded.stale).toEqual([{
      tenant_id: 'Steven', alias: 'live', revision: 1,
      recorded_generation: 'gen-old', live_generation: 'gen-new',
    }]);
    expect(degraded.unobserved).toBe(2);
    expect(degraded.malformed).toEqual([]);
    expect(degraded.truncated).toBe(false);
  });

  it('exports bounded drift without identities and keeps readiness non-blocking', async () => {
    const app = await buildLoopbackHealthProbe({
      pool: metricsPool,
      profileRuntimePresence: presenceOf({ 'Steven/zeus': 'live-generation' }),
      profileRuntimeExpectationsProbe: async () => ({
        stale: [{
          tenant_id: 'Steven', alias: 'zeus', revision: 4,
          recorded_generation: 'old-generation', live_generation: 'live-generation',
        }],
        malformed: [{ tenant_id: 'Miguel', alias: null, reason: 'invalid alias' }],
        unobserved: 2,
        truncated: true,
      }),
    });

    const metrics = await app.inject({ method: 'GET', url: '/metrics' });
    expect(metrics.statusCode).toBe(200);
    for (const sample of [
      'degraded 1', 'scan_success 1', 'source_available 1', 'stale 1',
      'malformed 1', 'unobserved 2', 'truncated 1',
    ]) expect(metrics.body).toContain(`cauce_gateway_profile_runtime_expectations_${sample}`);
    expect(metrics.body).toContain('cauce_gateway_publish_redaction_total{outcome="hit"}');
    expect(metrics.body).not.toMatch(/Steven|zeus|Miguel|old-generation|live-generation|invalid alias/u);
    expect((await app.inject({ method: 'GET', url: '/health/ready' })).json())
      .toEqual({ status: 'ready' });
    await app.close();
  });

  it('exposes scan failure without failing readiness', async () => {
    const app = await buildLoopbackHealthProbe({
      pool: metricsPool,
      profileRuntimePresence: { available: () => false, generationFor: () => undefined },
      profileRuntimeExpectationsProbe: async () => { throw new Error('scan unavailable'); },
    });

    const metrics = await app.inject({ method: 'GET', url: '/metrics' });
    expect(metrics.body).toContain('cauce_gateway_profile_runtime_expectations_degraded 1');
    expect(metrics.body).toContain('cauce_gateway_profile_runtime_expectations_scan_success 0');
    expect(metrics.body).toContain('cauce_gateway_profile_runtime_expectations_source_available 0');
    expect((await app.inject({ method: 'GET', url: '/health/ready' })).statusCode).toBe(200);
    await app.close();
  });

  it('degrades on unobserved expectations until every alias has exact live evidence', () => {
    const snapshot = { stale: [], malformed: [], unobserved: 1, truncated: false };
    expect(renderProfileRuntimeExpectationMetrics(snapshot, true))
      .toContain('cauce_gateway_profile_runtime_expectations_degraded 1');
    expect(renderProfileRuntimeExpectationMetrics({ ...snapshot, unobserved: 0 }, true))
      .toContain('cauce_gateway_profile_runtime_expectations_degraded 0');
  });

  it('wires the shared registry into the profile expectation metrics', async () => {
    const main = await readFile(new URL('./main.ts', import.meta.url), 'utf8');
    expect(main).toMatch(/registry: terminalRegistry[\s\S]*?profileRuntimePresence: terminalRegistry/u);
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
