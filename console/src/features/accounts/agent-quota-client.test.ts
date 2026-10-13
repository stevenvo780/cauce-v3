import { expect, it, vi } from 'vitest';
import type { RequestFn } from '../../api/client/system-client';
import { ApiError } from '../../api/client/core';
import { agentQuotaClient } from './agent-quota-client';

const empty = { tenant_id: 'One', alias: 'janus', revision: 9, reader_available: false, can_query: false,
  reason: 'quota_reader_unavailable', status: 'unsupported', captured_at: null, binding: null, sample: null, operation: null };

it('lee el destino exacto sin caché y envía el contrato de consulta por el transporte existente', async () => {
  const request = vi.fn().mockResolvedValueOnce(empty).mockResolvedValueOnce({ operation_id: 'query-1', status: 'pending', duplicate: false });
  const api = agentQuotaClient(request as RequestFn);
  expect(await api.getAgentQuota('One', 'janus')).toEqual(empty);
  expect(request).toHaveBeenNthCalledWith(1, '/v3/console/agents/One/janus/quota', { cache: 'no-store' });
  await api.queryAgentQuota('One', 'janus', { expected_revision: 9, idempotency_key: 'request-1' });
  expect(request).toHaveBeenNthCalledWith(2, '/v3/console/agents/One/janus/quota', { method: 'POST', body: '{"expected_revision":9,"idempotency_key":"request-1"}' });
});

it.each([
  { ...empty, tenant_id: 'Other' }, { ...empty, alias: 'other' }, { ...empty, revision: null },
  { ...empty, reader_available: 'true' }, { ...empty, can_query: true }, { ...empty, status: 'fresh' }, { ...empty, reason: 'quota_target_missing' },
  { ...empty, captured_at: 'yesterday' }, { ...empty, sample: { provider: 'codex', ok: true, windows: [] } },
])('rechaza una medición inválida o perteneciente a otro agente', async response => {
  const request = vi.fn().mockResolvedValue(response);
  await expect(agentQuotaClient(request as RequestFn).getAgentQuota('One', 'janus')).rejects.toThrow();
});

it('no admite un saldo vinculado a otra suscripción', async () => {
  const request = vi.fn().mockResolvedValue({ ...empty, status: 'ok', captured_at: '2026-10-12T19:00:00Z',
    binding: { account_id: 'account-a', enabled: true, shared: false, agent_count: 1 },
    sample: { provider: 'codex', account_id: 'account-b', ok: true, effective_remaining_percent: 75, windows: [] } });
  await expect(agentQuotaClient(request as RequestFn).getAgentQuota('One', 'janus')).rejects.toThrow();
});

it('no envía una revisión o clave de idempotencia inválida', async () => {
  const request = vi.fn(); const api = agentQuotaClient(request as RequestFn);
  await expect(api.queryAgentQuota('One', 'janus', { expected_revision: -1, idempotency_key: 'query' })).rejects.toThrow();
  await expect(api.queryAgentQuota('One', 'janus', { expected_revision: 9, idempotency_key: '' })).rejects.toThrow();
  expect(request).not.toHaveBeenCalled();
});

it('acepta el motivo cerrado de ubicación no operativa sin convertirlo en ausencia de lector', async () => {
  const response = { ...empty, reason: 'quota_target_unplaced' };
  const request = vi.fn().mockResolvedValue(response);
  await expect(agentQuotaClient(request as RequestFn).getAgentQuota('One', 'janus')).resolves.toEqual(response);
});

it('acepta un ordenador sin respuesta conservando el lector y deshabilitando la consulta', async () => {
  const response = { ...empty, reader_available: true, reason: 'quota_host_unavailable', status: 'unknown' };
  const request = vi.fn().mockResolvedValue(response);
  await expect(agentQuotaClient(request as RequestFn).getAgentQuota('One', 'janus')).resolves.toEqual(response);
});

it('acepta una operación caducada y conserva la posibilidad de volver a consultar', async () => {
  const response = { ...empty, reader_available: true, can_query: true, reason: null, status: 'failed',
    operation: { id: 'query-expired', status: 'failed', error_code: 'EXPIRED',
      created_at: '2026-10-12T19:00:00Z', updated_at: '2026-10-12T19:05:00Z' } };
  const request = vi.fn().mockResolvedValue(response);
  await expect(agentQuotaClient(request as RequestFn).getAgentQuota('One', 'janus')).resolves.toEqual(response);
});

it.each([
  ['read', 403, 'forbidden', 'Tu rol no permite esta acción.'],
  ['query', 409, 'conflict', 'Otro cambio llegó antes, o el recurso aún tiene dependencias. Relee y vuelve a intentarlo.'],
  ['read', 409, 'quota_host_unavailable', 'El ordenador no responde; reintenta cuando vuelva a estar en línea.'],
  ['query', 409, 'quota_host_unavailable', 'El ordenador no responde; reintenta cuando vuelva a estar en línea.'],
  ['read', 504, 'timeout', 'No se pudo leer la cuota. Relee antes de consultar.'],
  ['query', 504, 'timeout', 'No se confirmó la consulta. Relee su estado antes de reintentar.'],
])('localiza el error de %s HTTP %s preservando su estado y código', async (action, status, code, message) => {
  const request = vi.fn().mockRejectedValue(new ApiError('remote agent quota error', status, code));
  const api = agentQuotaClient(request as RequestFn);
  const result = action === 'read' ? api.getAgentQuota('One', 'janus')
    : api.queryAgentQuota('One', 'janus', { expected_revision: 9, idempotency_key: 'query-1' });
  await expect(result).rejects.toMatchObject({ name: 'ApiError', status, code, message });
});

it('localiza el fallo de transporte sin confirmar la escritura ni exponer el mensaje remoto', async () => {
  const request = vi.fn().mockRejectedValue(new Error('remote transport detail'));
  const api = agentQuotaClient(request as RequestFn);
  await expect(api.queryAgentQuota('One', 'janus', { expected_revision: 9, idempotency_key: 'query-1' })).rejects
    .toThrow('No se confirmó la consulta. Relee su estado antes de reintentar.');
});
