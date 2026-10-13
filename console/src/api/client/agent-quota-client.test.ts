import { expect, it, vi } from 'vitest';
import { CauceApi } from '../client';

it('conecta la ficha y el encolado al cliente HTTP común conservando el token CSRF', async () => {
  const captured = '2026-10-13T00:40:00.000Z';
  const operationId = '00000000-0000-4000-8000-000000000070';
  const reading = { tenant_id: 'Canary', alias: 'agent', revision: 7, configuration_revision: 7,
    reader_available: true, can_query: true, reason: null, status: 'ok', captured_at: captured,
    binding: { account_id: 'canonical-account', enabled: false, shared: true, agent_count: 2 }, operation: null,
    sample: { provider: 'codex', ok: true, available: true, account_id: 'canonical-account', available_groups: [], limiting_groups: [],
      windows: [{ group_key: 'default', window_key: '5h', remaining_percent: 75, account_id: 'canonical-account' }] } };
  const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const address = url instanceof Request ? url.url : url instanceof URL ? url.href : url;
    if (address.endsWith('/v3/auth/session')) return new Response(JSON.stringify({ authenticated: true,
      login_mode: 'password', subject: 'canary@example.test', home_tenant: 'Canary', csrf_token: 'fixture-csrf' }),
      { headers: { 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify(init?.method === 'POST' ? { operation_id: operationId, status: 'pending' } : reading),
      { status: init?.method === 'POST' ? 202 : 200, headers: { 'Content-Type': 'application/json' } });
  });
  const api = new CauceApi('', fetcher);
  expect(typeof api.queryAgentQuota).toBe('function');
  expect(await api.getAgentQuota('Canary', 'agent')).toMatchObject({ captured_at: captured,
    binding: { account_id: 'canonical-account', shared: true }, sample: { windows: [{ remaining_percent: 75 }] } });
  expect(await api.queryAgentQuota('Canary', 'agent', { expected_revision: 7, idempotency_key: 'agent-query' }))
    .toEqual({ operation_id: operationId, status: 'pending' });
  const call = fetcher.mock.calls.at(-1);
  expect(call?.[0]).toBe('/v3/console/agents/Canary/agent/quota');
  expect(call?.[1]?.method).toBe('POST'); expect(call?.[1]?.credentials).toBe('include');
  expect(call?.[1]?.body).toBe('{"expected_revision":7,"idempotency_key":"agent-query"}');
  const headers = new Headers(call?.[1]?.headers);
  expect(headers.get('X-CSRF-Token')).toBe('fixture-csrf'); expect(headers.get('X-Cauce-Console')).toBe('1');
});
