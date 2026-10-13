import { expect, it, vi } from 'vitest';
import type { RequestFn } from '../../api/client/system-client';
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
  { ...empty, reader_available: 'true' }, { ...empty, can_query: true }, { ...empty, status: 'fresh' },
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
