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
