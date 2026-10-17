import { expect, it } from 'vitest';
import type { QuotaEnvironment, QuotaEnvironmentsSnapshot } from '../../api/client/my-quotas-client';
import { quotaEnvironmentActionBlock } from './quota-environment-capabilities';

const environment: QuotaEnvironment = {
  id: 'env', company_id: 'one', account_id: 'codex', host_id: 'host', provider: 'codex', label: 'GPT',
  status: 'ready', version: 1, created_at: '2026-10-11T00:00:00Z', updated_at: '2026-10-11T00:00:00Z',
};
const snapshot: QuotaEnvironmentsSnapshot = {
  company_id: 'one', environments: [environment], operations: [],
  capabilities: {
    available: true, providers: ['codex'], actions: ['create', 'authenticate', 'query', 'update_cli', 'delete'],
    hosts: [{ host_id: 'host', display_name: 'Host', providers: ['codex'], provider_actions: { codex: ['query'] } }],
  },
};

it('allows query and explains why update_cli is blocked on this host', () => {
  expect(quotaEnvironmentActionBlock(snapshot, environment, 'query', true, false)).toBeUndefined();
  expect(quotaEnvironmentActionBlock(snapshot, environment, 'update_cli', true, false)).toContain('no puede ejecutar esta acción');
});

it('explains a read-only role before any other block', () => {
  expect(quotaEnvironmentActionBlock(snapshot, environment, 'query', false, false)).toContain('Tu rol no permite');
});

it('explains an unavailable executor', () => {
  const down = { ...snapshot, capabilities: { ...snapshot.capabilities, available: false } };
  expect(quotaEnvironmentActionBlock(down, environment, 'query', true, false)).toContain('No hay un ejecutor');
});

it('explains an environment busy with another operation', () => {
  const busySnapshot = {
    ...snapshot,
    operations: [{ id: 'op', environment_id: 'env', action: 'query' as const, status: 'running' as const, error_code: null, result: null, created_at: environment.created_at, updated_at: environment.updated_at }],
  };
  expect(quotaEnvironmentActionBlock(busySnapshot, environment, 'query', true, false)).toContain('Ya hay una operación en curso');
});
