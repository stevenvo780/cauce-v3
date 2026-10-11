import { expect, it } from 'vitest';
import { quotaAccounts, quotaEnvironments } from './quota-responses';

const date = '2026-10-11T00:00:00Z';
const window = { group_key: 'primary', window_key: 'weekly', host: 'host', model: null, label: null, used_percent: 40,
  remaining_percent: 60, window_minutes: 10_080, captured_at: date, received_at: date, reset_at: null, observation_status: 'ok' };
const account = { id: 'legacy', provider: 'opencode', payer_tenant_id: 'one', label: null, enabled: true, shared: false, version: 1,
  paused_until: null, paused_reason: null, note: null, remaining_percent: 60, observation_status: 'ok', agents: [], windows: [window] };
function snapshot(overrides: Record<string, unknown>) { return { company_id: 'one', observed_at: date, accounts: [{ ...account, ...overrides }] }; }
it('conserva proveedor legado y nombre nulo sin inventar timestamps o ventanas', () => {
  expect(quotaAccounts(snapshot({})).accounts[0]).toMatchObject({ provider: 'opencode', label: 'legacy', windows: [window] });
  expect(quotaAccounts(snapshot({ windows: [{ ...window, received_at: null }] })).accounts[0]?.windows[0]?.received_at).toBeNull();
});
it('rechaza DTOs de cuotas con CAS, timestamp, modelo o dimensiones de ventana defectuosos', () => {
  for (const overrides of [{ version: 0 }, { paused_until: 'invalid' }, { windows: [{ ...window, received_at: 'invalid' }] },
    { windows: [{ ...window, model: {} }] }, { windows: [{ ...window, label: [] }] }, { windows: [{ ...window, window_minutes: -1 }] }]) {
    expect(() => quotaAccounts(snapshot(overrides))).toThrow('No se pudo verificar');
  }
});
it('rechaza timestamps defectuosos de entornos antes de mostrar un comando como ejecutable', () => {
  expect(() => quotaEnvironments({ company_id: 'one', environments: [{ id: 'env', company_id: 'one', account_id: 'legacy', host_id: 'host', provider: 'codex',
    label: 'Entorno', version: 1, status: 'ready', created_at: date, updated_at: 'invalid' }], operations: [],
    capabilities: { available: true, providers: ['codex'], hosts: [], actions: ['query'] } })).toThrow('No se pudo verificar');
});
it('exige capacidades por host y valida los proveedores y acciones de ese host', () => {
  const host = { host_id: 'host', display_name: 'Host', providers: ['codex'], provider_actions: { codex: ['query'] } };
  const snapshot = (host: unknown) => ({ company_id: 'one', environments: [], operations: [],
    capabilities: { available: true, providers: ['codex'], hosts: [host], actions: ['query'] } });
  expect(quotaEnvironments(snapshot(host)).capabilities.hosts[0]).toEqual(host);
  for (const invalid of [{ host_id: 'host', display_name: 'Legacy' }, { ...host, provider_actions: null },
    { ...host, providers: ['unknown'] }, { ...host, provider_actions: { codex: ['shell'] } },
    { ...host, provider_actions: { claude: ['query'] } }, { ...host, provider_actions: { codex: 'query' } }]) {
    expect(() => quotaEnvironments(snapshot(invalid))).toThrow('No se pudo verificar');
  }
});
