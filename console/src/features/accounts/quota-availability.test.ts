import { describe, expect, it } from 'vitest';
import type { QuotaAccount } from '../../api/client/my-quotas-client';
import { accountFatigue, agentFatigue, agentQuotaAccounts, FATIGUE_LABEL, NO_READER_MESSAGE, quotaFailureReason, readerUnavailableReason } from './quota-availability';

const account: QuotaAccount = { id: 'subscription', provider: 'codex', label: 'Cuenta compartida', enabled: true, version: 1,
  payer_tenant_id: 'Humanizar', agent_count: 2, shared: true, agents: [{ tenant_id: 'Humanizar', alias: 'kant', enabled: true },
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
  it('una cuenta recién registrada dice pendiente de autenticación y no en pausa', () => {
    const fresh = { ...account, enabled: false, observation_status: 'unknown' as const, remaining_percent: null };
    expect(accountFatigue(fresh)).toBe('pending_auth');
    expect(FATIGUE_LABEL.pending_auth).toBe('Pendiente de autenticación');
    expect(accountFatigue({ ...fresh, paused_until: '2030-01-01T00:00:00Z' }, 0)).toBe('paused');
  });
  it('traduce cada código de fallo a una acción y un 429 nunca es agotado', () => {
    const failed = (note: string | null) => ({ observation_status: 'error' as const, note });
    expect(quotaFailureReason(failed('token_expired'))).toBe('Sesión caducada: autenticar de nuevo');
    expect(quotaFailureReason(failed('rate_limited'))).toBe('El proveedor limitó la consulta; se reintentará');
    for (const code of ['not_authenticated', 'forbidden_credential_type', 'network', 'provider_error']) expect(quotaFailureReason(failed(code))).toBeTruthy();
    expect(quotaFailureReason(failed('weird_code'))).toBe('Error de consulta (weird_code)');
    expect(quotaFailureReason(failed('quota probe unavailable'))).toBeNull();
    expect(quotaFailureReason({ observation_status: 'ok', note: 'token_expired' })).toBeNull();
    expect(accountFatigue({ ...account, observation_status: 'error', note: 'rate_limited', remaining_percent: 0 })).toBe('error');
  });
  it('un agente con solo una cuenta sin autenticar no sale agotado', () => {
    const fresh = { ...account, enabled: false, observation_status: 'unknown' as const, remaining_percent: null };
    expect(agentFatigue([fresh], 'Humanizar', 'kant')).toBe('pending_auth');
  });
  it('una cuenta nueva con consulta fallida not_authenticated sigue pendiente de autenticación', () => {
    const failed = { ...account, enabled: false, observation_status: 'error' as const, note: 'not_authenticated', remaining_percent: null };
    expect(accountFatigue(failed)).toBe('pending_auth');
  });
  it('sin lector es un estado propio con su motivo, ni error ni desconocido', () => {
    const snapshot = { tenant_id: 'Humanizar', alias: 'argos', reader_available: false, can_query: false,
      reason: 'quota_reader_unavailable' as const, status: 'unsupported' as const, revision: 1 };
    expect(readerUnavailableReason(snapshot)).toBe(NO_READER_MESSAGE);
    expect(NO_READER_MESSAGE).toContain('Sin lector de cuota para este harness');
    expect(FATIGUE_LABEL.no_reader).toBe('Sin lector de cuota');
    expect(readerUnavailableReason({ ...snapshot, reader_available: true, reason: null, status: 'unknown' as const })).toBeNull();
    expect(readerUnavailableReason(undefined)).toBeNull();
  });
  it('traduce el código también cuando el dato ya está antiguo', () => {
    expect(quotaFailureReason({ observation_status: 'stale', note: 'token_expired' })).toBe('Último fallo: Sesión caducada: autenticar de nuevo');
    expect(quotaFailureReason({ observation_status: 'stale', note: 'weird_code' })).toBe('Último fallo: Error de consulta (weird_code)');
    expect(quotaFailureReason({ observation_status: 'stale', note: 'texto libre' })).toBeNull();
  });
});
