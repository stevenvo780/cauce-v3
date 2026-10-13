import type { AgentQuotaSnapshot, QuotaAccount, QuotaObservationStatus } from '../../api/client/my-quotas-client';

export type FatigueState = QuotaObservationStatus | 'available' | 'low' | 'exhausted' | 'paused' | 'model_dependent' | 'pending_auth' | 'no_reader';
export const OBSERVATION_LABEL: Record<QuotaObservationStatus, string> = {
  unknown: 'Sin datos', error: 'Error de consulta', stale: 'Datos antiguos', ok: 'Actualizada',
};
export const FATIGUE_LABEL: Record<FatigueState, string> = {
  ...OBSERVATION_LABEL, available: 'Disponible', low: 'Cansado', exhausted: 'Sin disponibilidad', paused: 'En pausa', model_dependent: 'Varía por modelo', pending_auth: 'Pendiente de autenticación', no_reader: 'Sin lector de cuota',
};
export const NO_READER_MESSAGE = 'Sin lector de cuota para este harness: el proveedor no expone una ventana de consumo medible.';
export function readerUnavailableReason(snapshot: AgentQuotaSnapshot | undefined): string | null {
  if (!snapshot || snapshot.reader_available) return null;
  return snapshot.reason === 'quota_reader_unavailable' ? NO_READER_MESSAGE : null;
}
export function accountFatigue(account: QuotaAccount | undefined, now = Date.now()): FatigueState {
  if (!account) return 'unknown';
  if (!account.enabled && !account.paused_until && account.observation_status !== 'ok' && !account.windows.length) return 'pending_auth';
  if (!account.enabled || account.paused_until && Date.parse(account.paused_until) > now) return 'paused';
  if (account.observation_status !== 'ok') return account.observation_status;
  const remaining = account.remaining_percent;
  if (remaining === null || !Number.isFinite(remaining)) return 'unknown';
  if (remaining <= 0 && account.windows.some(window => window.model !== null)
    && !account.windows.some(window => window.model === null && window.observation_status === 'ok' && window.remaining_percent !== null && window.remaining_percent <= 0)) return 'model_dependent';
  return remaining <= 0 ? 'exhausted' : remaining < 25 ? 'low' : 'available';
}
export function agentQuotaAccounts(accounts: readonly QuotaAccount[], tenant: string, alias: string): QuotaAccount[] {
  return accounts.filter(account => account.agents.some(agent => agent.tenant_id === tenant && agent.alias === alias && agent.enabled));
}
export function agentFatigue(accounts: readonly QuotaAccount[], tenant: string, alias: string): FatigueState {
  const bound = agentQuotaAccounts(accounts, tenant, alias);
  if (!bound.length) return 'unknown';
  const states = bound.map(account => accountFatigue(account));
  if (states.includes('available')) return 'available';
  if (states.includes('low')) return 'low';
  for (const unknown of ['error', 'stale', 'unknown', 'model_dependent', 'pending_auth'] as const) if (states.includes(unknown)) return unknown;
  return states.every(state => state === 'paused') ? 'paused' : 'exhausted';
}

export function failedQuotaRead(account: QuotaAccount): QuotaAccount {
  return { ...account, observation_status: 'error', windows: account.windows.map(window => ({ ...window, observation_status: 'error' })) };
}

export const QUOTA_FAILURE_ACTION: Record<string, string> = {
  not_authenticated: 'Cuenta sin autenticar: autentícala desde su entorno',
  token_expired: 'Sesión caducada: autenticar de nuevo',
  forbidden_credential_type: 'Tipo de credencial no permitido: autentica con una suscripción del proveedor',
  rate_limited: 'El proveedor limitó la consulta; se reintentará',
  network: 'No se pudo contactar al proveedor; se reintentará',
  provider_error: 'El proveedor devolvió un error; reintenta más tarde',
};
const FAILURE_CODE = /^[a-z][a-z0-9_]*$/u;
export function quotaFailureReason(account: Pick<QuotaAccount, 'observation_status' | 'note'>): string | null {
  if (account.observation_status !== 'error' && account.observation_status !== 'stale') return null;
  const code = account.note?.trim();
  if (!code || !FAILURE_CODE.test(code)) return null;
  const reason = QUOTA_FAILURE_ACTION[code] ?? `Error de consulta (${code})`;
  return account.observation_status === 'stale' ? `Último fallo: ${reason}` : reason;
}
