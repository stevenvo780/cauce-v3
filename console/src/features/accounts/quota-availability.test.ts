import { describe, expect, it } from 'vitest';
import type { QuotaAccount } from '../../api/client/my-quotas-client';
import { accountFatigue, agentFatigue, agentQuotaAccounts } from './quota-availability';

const account: QuotaAccount = { id: 'subscription', provider: 'codex', label: 'Cuenta compartida', enabled: true, version: 1,
  payer_tenant_id: 'Humanizar', shared: true, agents: [{ tenant_id: 'Humanizar', alias: 'kant', enabled: true },
    { tenant_id: 'Humanizar', alias: 'zeus', enabled: true }], paused_until: null, paused_reason: null,
  observation_status: 'ok', remaining_percent: 60, note: null, windows: [] };
describe('disponibilidad derivada de suscripciones', () => {
  it('mantiene desconocido, antiguo y error distintos del agotamiento', () => {
    expect(accountFatigue(undefined)).toBe('unknown');
    for (const observation_status of ['unknown', 'error', 'stale'] as const) {
      expect(accountFatigue({ ...account, observation_status, remaining_percent: 0 })).toBe(observation_status);
    }
    expect(accountFatigue({ ...account, remaining_percent: null })).toBe('unknown');
    expect(accountFatigue({ ...account, remaining_percent: 0 })).toBe('exhausted');
    expect(accountFatigue({ ...account, remaining_percent: 24 })).toBe('low');
    expect(accountFatigue(account)).toBe('available');
  });
  it('los agentes comparten el mismo objeto de cuenta sin duplicar su saldo', () => {
    const one = agentQuotaAccounts([account], 'Humanizar', 'kant');
    const two = agentQuotaAccounts([account], 'Humanizar', 'zeus');
    expect(one).toEqual(two); expect(one[0]).toBe(account);
    expect(agentQuotaAccounts([account], 'Praxis', 'kant')).toEqual([]);
  });
  it('una pausa manual o deshabilitación impide presentar saldo disponible', () => {
    expect(accountFatigue({ ...account, enabled: false })).toBe('paused');
    expect(accountFatigue({ ...account, paused_until: '2030-01-01T00:00:00Z' }, 0)).toBe('paused');
    expect(agentFatigue([{ ...account, remaining_percent: 0 }, { ...account, id: 'second', observation_status: 'error' }], 'Humanizar', 'kant')).toBe('error');
  });
  it('un límite de modelo agotado no acredita agotamiento global de los agentes', () => {
    const window = { group_key: 'models', window_key: 'weekly', model: 'one', label: 'Semanal', host: 'host', used_percent: 100,
      remaining_percent: 0, window_minutes: 10_080, captured_at: null, received_at: null, reset_at: null, observation_status: 'ok' as const };
    const partial = { ...account, remaining_percent: 0, windows: [window, { ...window, model: 'two', remaining_percent: 80, used_percent: 20 }] };
    expect(accountFatigue(partial)).toBe('model_dependent');
    expect(agentFatigue([partial], 'Humanizar', 'kant')).toBe('model_dependent');
    expect(agentFatigue([{ ...partial, windows: [...partial.windows, { ...window, model: null }] }], 'Humanizar', 'kant')).toBe('exhausted');
  });
});
