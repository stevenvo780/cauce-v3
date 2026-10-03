import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { vi } from 'vitest';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { ApiProvider } from '../../api/context';
import { CauceApi } from '../../api/client';
import { contextRepositoryClient } from '../../api/client/context-repository-client';
import type { RequestFn } from '../../api/client/system-client';
import { ContextRepositoryApply } from './ContextRepositoryApply';

const BASE = 'http://localhost/v3/console/tenants/Steven/agents/helper';
const COMMIT = 'a'.repeat(40);
const HASH = 'b'.repeat(64);
const PROFILE = { tenant_id: 'Steven', alias: 'helper', purpose: 'Reviewed version', role_summary: null,
  human_brief: null, responsibilities: [], restrictions: [], tools: [], operating_rules: [] };
const REASON = 'Restore the reviewed version';
const SOURCE = { instance_id: 'fixture', commit: COMMIT, tree: 'c'.repeat(40), profile_sha256: HASH,
  source_journal_id: '30', source_revision: 1, expected_journal_id: '42', runtime_fingerprint: HASH, application_id: HASH };
const PREVIEW = { tenant_id: 'Steven', alias: 'helper', expected_revision: 4, before: { ...PROFILE, purpose: 'Current version' },
  profile: PROFILE, context_source: SOURCE, ficheros: [{ nombre: 'AGENTS.md', texto: 'Reviewed projection' }],
  application: 'not_applied', sourceState: 'not_observed' };
const PATH = '/home/dev/.codex/AGENTS.md';
const verification = { state: 'current', generation: 'gen-1', container_id: 'runtime', observed_at: 'now',
  documents: [{ name: 'AGENTS.md', path: PATH, expected_sha: HASH, observed_sha: HASH, expected_bytes: 19, observed_bytes: 19, current: true }] };
const RECEIPT = { ok: true, tenant_id: 'Steven', alias: 'helper', revision: 5, applied_revision: 3,
  state: 'pending_session_refresh', runtime_adoption: null, runtime_verification: verification,
  acknowledgements: [{ name: 'AGENTS.md', path: PATH, sha: HASH, bytes: 19, state: 'written', generation: 'gen-1', container_id: 'runtime' }] };
const REFRESHED = { publicado: true, tenant_id: 'Steven', alias: 'helper', perfil: PROFILE, revision: 5, applied_revision: 3,
  agent_enabled: true, exists: true, runtime_state: 'pending_session_refresh', runtime_verification: verification, runtime_adoption: null,
  ficheros: [{ nombre: 'AGENTS.md', texto: 'Reviewed projection' }] };

function props() {
  return { tenantId: 'Steven', alias: 'helper', instanceId: 'fixture', commit: COMMIT, canApply: true, blocked: false,
    refreshRevision: 0, onSettled: vi.fn(), onWriteInFlightChange: vi.fn() };
}
function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error('not ready'); };
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function prepare(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Motivo de la aplicación'), REASON);
  await user.click(screen.getByRole('button', { name: 'Preparar aplicación' }));
  return screen.findByRole('button', { name: 'Aplicar versión confirmada' });
}
beforeEach(() => {
  server.use(http.post(`${BASE}/context/repository/preview`, () => HttpResponse.json(PREVIEW)),
    http.get(`${BASE}/perfil`, () => HttpResponse.json(REFRESHED)));
});

it('requires preview plus explicit confirmation and reuses the canonical profile PUT', async () => {
  const written: unknown[] = [];
  server.use(http.put(`${BASE}/perfil`, async ({ request }) => { written.push(await request.json()); return HttpResponse.json(RECEIPT); }));
  const callbacks = props(); const user = userEvent.setup(); renderWithApi(<ContextRepositoryApply {...callbacks} />);
  expect(screen.getByRole('button', { name: 'Preparar aplicación' })).toBeDisabled();
  const apply = await prepare(user);
  expect(apply).toBeDisabled(); expect(written).toEqual([]);
  expect(screen.getByText(/Vigente:.*Current version/)).toBeInTheDocument();
  expect(screen.getByText(/Propuesto:.*Reviewed version/)).toBeInTheDocument();
  await user.click(screen.getByRole('checkbox')); await user.click(apply);
  expect(await screen.findByText(/Versión guardada; la adopción de sesión sigue pendiente/)).toBeInTheDocument();
  const fields = Object.fromEntries(Object.entries(PROFILE).filter(([key]) => key !== 'tenant_id' && key !== 'alias'));
  expect(written).toEqual([{ expected_revision: 4, profile: fields, reason: REASON, context_source: SOURCE }]);
  expect(callbacks.onWriteInFlightChange.mock.calls).toEqual([[true], [false]]);
  expect(callbacks.onSettled).toHaveBeenCalledOnce();
});

it.each([{ canApply: false }, { blocked: true }])('does not prepare or apply when blocked: %j', (blocked) => {
  renderWithApi(<ContextRepositoryApply {...props()} {...blocked} />);
  expect(screen.getByLabelText('Motivo de la aplicación')).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Preparar aplicación' })).toBeDisabled();
});

it.each(['reason', 'cancel', 'refresh', 'permission', 'target', 'instance', 'commit'])('invalidates confirmation after %s changes', async (kind) => {
  const callbacks = props(); const user = userEvent.setup(); const view = renderWithApi(<ContextRepositoryApply {...callbacks} />);
  await prepare(user); await user.click(screen.getByRole('checkbox'));
  if (kind === 'reason') await user.type(screen.getByLabelText('Motivo de la aplicación'), ' changed');
  if (kind === 'cancel') await user.click(screen.getByRole('button', { name: 'Cancelar' }));
  if (['refresh', 'permission', 'target', 'instance', 'commit'].includes(kind)) view.rerender(<ApiProvider api={new CauceApi('http://localhost')}>
    <ContextRepositoryApply {...callbacks} {...(kind === 'refresh' ? { refreshRevision: 1 } : kind === 'permission' ? { canApply: false }
      : kind === 'target' ? { alias: 'other' } : kind === 'instance' ? { instanceId: 'other' } : { commit: 'e'.repeat(40) })} />
  </ApiProvider>);
  await waitFor(() => { expect(screen.queryByRole('button', { name: 'Aplicar versión confirmada' })).toBeNull(); });
});

it('discards a late preview when closed without applying it', async () => {
  const held = deferred<Response>(); let called = false;
  server.use(http.post(`${BASE}/context/repository/preview`, () => { called = true; return held.promise; }));
  const callbacks = props(); const user = userEvent.setup(); const view = renderWithApi(<ContextRepositoryApply {...callbacks} />);
  await user.type(screen.getByLabelText('Motivo de la aplicación'), REASON);
  await user.click(screen.getByRole('button', { name: 'Preparar aplicación' }));
  await waitFor(() => { expect(called).toBe(true); });
  view.unmount(); await act(async () => { held.resolve(HttpResponse.json(PREVIEW)); });
  expect(callbacks.onWriteInFlightChange).not.toHaveBeenCalled(); expect(callbacks.onSettled).not.toHaveBeenCalled();
});

it('sends one PUT for repeated confirmation clicks', async () => {
  const held = deferred<Response>(); let calls = 0;
  server.use(http.put(`${BASE}/perfil`, () => { calls += 1; return held.promise; }));
  const user = userEvent.setup(); renderWithApi(<ContextRepositoryApply {...props()} />);
  const apply = await prepare(user); await user.click(screen.getByRole('checkbox'));
  fireEvent.click(apply); fireEvent.click(apply);
  await waitFor(() => { expect(calls).toBe(1); });
  await act(async () => { held.resolve(HttpResponse.json(RECEIPT)); });
  await screen.findByText(/Versión guardada;/); expect(calls).toBe(1);
});

it.each([
  { state: 'effect_unknown', source_receipt: { application_id: HASH, revision: 5 } },
  { ...RECEIPT, acknowledgements: [] },
  { ...RECEIPT, revision: 6 },
  { ...RECEIPT, state: 'applied', runtime_adoption: null },
])('never paints malformed, replayed, or unadopted results as applied: %j', async (result) => {
  let calls = 0;
  server.use(http.put(`${BASE}/perfil`, () => { calls += 1; return HttpResponse.json(result); }));
  const user = userEvent.setup(); renderWithApi(<ContextRepositoryApply {...props()} />);
  const apply = await prepare(user); await user.click(screen.getByRole('checkbox')); await user.click(apply);
  expect(await screen.findByRole('alert')).toHaveTextContent('puede haber efectos parciales');
  expect(screen.queryByText('Versión guardada y adopción de sesión acreditada.')).toBeNull();
  expect(calls).toBe(1); expect(screen.queryByRole('button', { name: 'Aplicar versión confirmada' })).toBeNull();
});

it('does not reuse a valid receipt when the reread has been superseded', async () => {
  server.use(http.put(`${BASE}/perfil`, () => HttpResponse.json(RECEIPT)),
    http.get(`${BASE}/perfil`, () => HttpResponse.json({ ...REFRESHED, revision: 6 })));
  const user = userEvent.setup(); renderWithApi(<ContextRepositoryApply {...props()} />);
  const apply = await prepare(user); await user.click(screen.getByRole('checkbox')); await user.click(apply);
  expect(await screen.findByRole('alert')).toHaveTextContent('lectura posterior');
});

it.each([
  { tenant_id: 'Other' }, { alias: 'other' }, { expected_revision: 0 }, { application: 'applied' },
  { sourceState: 'clean' }, { context_source: { ...SOURCE, instance_id: 'other' } },
  { context_source: { ...SOURCE, commit: 'd'.repeat(40) } }, { context_source: { ...SOURCE, expected_journal_id: null } },
  { context_source: { ...SOURCE, repositoryPath: '/browser' } }, { ficheros: [] },
  { ficheros: [{ nombre: '../../private', texto: 'not admitted' }] },
])('client refuses mismatched preview contract: %j', async (changed) => {
  const request = vi.fn(async () => ({ ...PREVIEW, ...changed })) as unknown as RequestFn;
  await expect(contextRepositoryClient(request).previewContextSource('Steven', 'helper', 'fixture', COMMIT, REASON))
    .rejects.toMatchObject({ code: 'invalid_context_repository' });
});


const ADOPTION = { evidence: 'adapter_delivery', revision: 5, generation: 'gen-1',
  adopted_at: '2026-01-01T00:00:00.000Z', documents: [{ name: 'AGENTS.md', path: PATH, sha: HASH }] };
const APPLIED = { ...RECEIPT, state: 'applied', applied_revision: 5, runtime_adoption: ADOPTION };
const ADOPTED = { ...REFRESHED, runtime_state: 'applied', applied_revision: 5, runtime_adoption: ADOPTION };

it.each(['pending', 'applied'])('requires matching reread identity for the %s success path', async (state) => {
  server.use(http.put(`${BASE}/perfil`, () => HttpResponse.json(state === 'applied' ? APPLIED : RECEIPT)),
    http.get(`${BASE}/perfil`, () => HttpResponse.json(state === 'applied' ? ADOPTED : REFRESHED)));
  const user = userEvent.setup(); renderWithApi(<ContextRepositoryApply {...props()} />);
  const apply = await prepare(user); await user.click(screen.getByRole('checkbox')); await user.click(apply);
  const text = state === 'applied' ? 'Versión guardada y adopción de sesión acreditada.'
    : 'Versión guardada; la adopción de sesión sigue pendiente de acreditación.';
  expect(await screen.findByText(text)).toBeInTheDocument();
  expect(screen.queryByRole('alert')).toBeNull();
});

it.each(['pending', 'applied'].flatMap((state) => [
  { state, mismatch: 'top tenant', changed: { tenant_id: 'Other' } },
  { state, mismatch: 'top alias', changed: { alias: 'other' } },
  { state, mismatch: 'profile tenant', changed: { perfil: { ...PROFILE, tenant_id: 'Other' } } },
  { state, mismatch: 'profile alias', changed: { perfil: { ...PROFILE, alias: 'other' } } },
  { state, mismatch: 'missing top tenant', changed: { tenant_id: undefined } },
  { state, mismatch: 'missing top alias', changed: { alias: undefined } },
  { state, mismatch: 'missing profile tenant', changed: { perfil: { ...PROFILE, tenant_id: undefined } } },
  { state, mismatch: 'missing profile alias', changed: { perfil: { ...PROFILE, alias: undefined } } },
]))('rejects $mismatch on the $state reread without a saved or adopted success claim', async ({ state, changed }) => {
  let writes = 0;
  server.use(http.put(`${BASE}/perfil`, () => { writes += 1; return HttpResponse.json(state === 'applied' ? APPLIED : RECEIPT); }),
    http.get(`${BASE}/perfil`, () => HttpResponse.json({ ...(state === 'applied' ? ADOPTED : REFRESHED), ...changed })));
  const user = userEvent.setup(); renderWithApi(<ContextRepositoryApply {...props()} />);
  const apply = await prepare(user); await user.click(screen.getByRole('checkbox')); await user.click(apply);
  expect(await screen.findByRole('alert')).toHaveTextContent('lectura posterior');
  expect(screen.queryByText(/^Versión guardada/)).toBeNull();
  expect(screen.queryByRole('button', { name: 'Aplicar versión confirmada' })).toBeNull();
  expect(writes).toBe(1);
});

const AUTHORED_SOURCE = { instance_id: SOURCE.instance_id, commit: SOURCE.commit, tree: SOURCE.tree,
  profile_sha256: SOURCE.profile_sha256, source_kind: 'git_authored', expected_journal_id: SOURCE.expected_journal_id,
  runtime_fingerprint: SOURCE.runtime_fingerprint, application_id: SOURCE.application_id };

it('shows all new Git-authored fields and the native projection before the explicit canonical PUT', async () => {
  const written: unknown[] = [];
  server.use(http.post(`${BASE}/context/repository/preview`, () => HttpResponse.json({ ...PREVIEW, context_source: AUTHORED_SOURCE })),
    http.put(`${BASE}/perfil`, async ({ request }) => { written.push(await request.json()); return HttpResponse.json(RECEIPT); }));
  const user = userEvent.setup(); renderWithApi(<ContextRepositoryApply {...props()} />);
  const apply = await prepare(user);
  expect(screen.getByText(/Aplicar contenido nuevo de Git/)).toHaveTextContent('operador autenticado');
  expect(screen.getAllByText(/^Vigente:/)).toHaveLength(7);
  expect(screen.getAllByText(/^Propuesto:/)).toHaveLength(7);
  expect(screen.getByText('Reviewed projection')).toBeInTheDocument();
  expect(apply).toBeDisabled(); expect(written).toEqual([]);
  await user.click(screen.getByRole('checkbox')); await user.click(apply);
  expect(await screen.findByText(/Versión guardada; la adopción/)).toBeInTheDocument();
  expect(written).toHaveLength(1);
  expect(written[0]).toMatchObject({ context_source: AUTHORED_SOURCE, expected_revision: 4, reason: REASON });
  expect(written[0]).not.toHaveProperty('context_source.source_journal_id');
});

it.each([
  { ...AUTHORED_SOURCE, source_kind: undefined }, { ...AUTHORED_SOURCE, source_kind: 'journal_match' },
  { ...AUTHORED_SOURCE, source_journal_id: '30' }, { ...AUTHORED_SOURCE, source_revision: 1 },
  { ...SOURCE, source_kind: 'git_authored' }, { ...SOURCE, source_journal_id: null },
])('client rejects omitted, mixed or forged Git provenance: %j', async (context_source) => {
  const request = vi.fn(async () => ({ ...PREVIEW, context_source })) as unknown as RequestFn;
  await expect(contextRepositoryClient(request).previewContextSource('Steven', 'helper', 'fixture', COMMIT, REASON))
    .rejects.toMatchObject({ code: 'invalid_context_repository' });
});

it('labels an existing journal snapshot as a restore', async () => {
  const user = userEvent.setup(); renderWithApi(<ContextRepositoryApply {...props()} />);
  await prepare(user);
  expect(screen.getByText('Restaurar contenido del diario 30, revisión 1.')).toBeInTheDocument();
});
