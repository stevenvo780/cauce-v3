import { expect, it } from 'vitest';
import { HttpResponse, http } from 'msw';
import { CauceApi } from '../client';
import { server } from '../../mocks/server';

it('registro público envía identidad y empresa sin intentar obtener sesión CSRF', async () => {
  let sessionRead = 0;
  let requestBody: unknown;
  let csrf: string | null = null;
  server.use(http.get('*/v3/auth/session', () => { sessionRead += 1; return HttpResponse.json({ authenticated: false }); }),
    http.post('*/v3/auth/register', async ({ request }) => { requestBody = await request.json(); csrf = request.headers.get('X-CSRF-Token');
      return HttpResponse.json({ user: { id: 'person', username: 'owner', email: 'owner@example.test', name: 'Dueño' },
        company: { id: 'new-company', slug: 'new-company', name: 'Empresa' }, hub: { id: 'NewHub', name: 'Empresa' } }, { status: 201 }); }));
  const api = new CauceApi('http://localhost');
  const input = { email: 'owner@example.test', name: 'Dueño', password: 'test-only-password', company: { slug: 'new-company', name: 'Empresa' } };
  const result = await api.register(input);
  expect(result.company.id).toBe('new-company'); expect(requestBody).toEqual(input);
  expect(sessionRead).toBe(0); expect(csrf).toBeNull();
});
it('mutaciones de plano y preferencias conservan CAS y CSRF del servidor', async () => {
  const writes: { path: string; csrf: string | null; body: unknown }[] = [];
  for (const path of ['office/layout', 'preferences']) server.use(http.put(`*/v3/console/${path}`, async ({ request }) => {
    writes.push({ path, csrf: request.headers.get('X-CSRF-Token'), body: await request.json() }); return HttpResponse.json({ company_id: 'test-company', version: 4, rooms: [], pinned_quota_accounts: [] });
  }));
  const api = new CauceApi('http://localhost');
  await api.saveOfficeLayout({ expected_version: 3, rooms: [] });
  await api.saveConsolePreferences({ expected_version: 3, pinned_quota_accounts: ['shared-subscription'] });
  expect(writes).toEqual([{ path: 'office/layout', csrf: 'mock-csrf-token', body: { expected_version: 3, rooms: [] } },
    { path: 'preferences', csrf: 'mock-csrf-token', body: { expected_version: 3, pinned_quota_accounts: ['shared-subscription'] } }]);
});
it('un cambio de empresa anuncia nueva generación aun con CSRF idéntico', async () => {
  const api = new CauceApi('http://localhost'); const generations: number[] = [];
  await api.getAuthSession(); api.onAuthGenerationChange(() => { generations.push(1); });
  server.use(http.post('*/v3/auth/session/company', () => HttpResponse.json({ authenticated: true, subject: 'Steven:kant',
    csrf_token: 'mock-csrf-token', authority: { role: 'platform_admin', scope: 'platform', home_company: 'humanizar', acting_company: 'praxis', platform_override: true } })));
  const state = await api.switchCompany('praxis');
  expect(state.authority?.acting_company).toBe('praxis'); expect(generations.length).toBeGreaterThan(0);
});
it('contextos compuestos, paginación y operaciones tipadas no envían shell', async () => {
  const requests: { path: string; body: unknown }[] = [];
  server.use(http.get('*/v3/console/context/agents/:tenant/:alias/history', ({ request }) => {
    expect(new URL(request.url).searchParams.get('before')).toBe('9'); return HttpResponse.json({ entries: [], next_cursor: null }); }),
    http.post('*/v3/console/quota-environments/:id/actions', async ({ request }) => {
      requests.push({ path: new URL(request.url).pathname, body: await request.json() }); return HttpResponse.json({ environment: { id: 'env-1', version: 8,
        company_id: 'one', account_id: 'subscription', host_id: 'host', provider: 'codex', label: 'Entorno', status: 'ready', created_at: '2026-10-11T00:00:00Z', updated_at: '2026-10-11T00:00:00Z' },
        operation: { id: 'op', environment_id: 'env-1', action: 'query', status: 'pending', error_code: null, result: null, created_at: '2026-10-11T00:00:00Z', updated_at: '2026-10-11T00:00:00Z' } }); }));
  const api = new CauceApi('http://localhost');
  await api.getContextVersions('Praxis', 'worker', 9);
  await api.actQuotaEnvironment('env-1', { action: 'query', expected_version: 7, idempotency_key: 'repeat-key' });
  expect(requests[0]).toEqual({ path: '/v3/console/quota-environments/env-1/actions', body: { action: 'query', expected_version: 7, idempotency_key: 'repeat-key' } });
});
