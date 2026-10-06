import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { vi } from 'vitest';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { CauceApi } from '../../api/client';
import { ApiProvider } from '../../api/context';
import { ContextRepositoryPanel } from './ContextRepositoryPanel';
import { contextRepositoryClient } from '../../api/client/context-repository-client';
import type { RequestFn } from '../../api/client/system-client';

const BASE = 'http://localhost/v3/console/tenants/Steven/agents/helper/context/repository';
const COMMIT = 'a'.repeat(40);
const PREVIOUS = 'b'.repeat(40);
const PROFILE = { tenant_id: 'Steven', alias: 'helper', purpose: 'Review context', role_summary: null,
  human_brief: null, responsibilities: ['Review'], restrictions: [], tools: [], operating_rules: [] };
const CAPABILITY = { tenant_id: 'Steven', alias: 'helper', state: 'configured', instance_id: 'fixture',
  storage: 'loose_objects_only', sourceState: 'not_observed', application: 'not_evaluated' };

function snapshot(commit = COMMIT) {
  return { scope: { instance_id: 'fixture', tenant_id: 'Steven', alias: 'helper' }, commit,
    profile: PROFILE, provenanceVerification: 'not_evaluated',
    sourceAgent: { tenant_id: 'Steven', alias: 'helper', source_journal: { id: '30', revision: 1 } as { id: string; revision: number } | null } };
}
function result() {
  return { tenant_id: 'Steven', alias: 'helper', sourceState: 'not_observed', application: 'not_evaluated',
    desired: snapshot(), previous: null as ReturnType<typeof snapshot> | null,
    journalVerification: { desired: 'journal_match', previous: null as string | null } };
}

async function open() {
  const user = userEvent.setup();
  renderWithApi(<ContextRepositoryPanel tenantId="Steven" alias="helper" />);
  await screen.findByLabelText('Commit completo');
  return user;
}

beforeEach(() => {
  server.use(http.get(BASE, () => HttpResponse.json(CAPABILITY)));
});

it('reads the binding on mount and remains read-only', async () => {
  const read = vi.fn(() => HttpResponse.json(CAPABILITY));
  const calls: string[] = [];
  server.use(http.get(BASE, read), http.get(`${BASE}/inspect`, ({ request }) => {
    calls.push(request.method); return HttpResponse.json(result());
  }));
  renderWithApi(<ContextRepositoryPanel tenantId="Steven" alias="helper" />);
  const user = userEvent.setup();
  await screen.findByLabelText('Commit completo');
  expect(screen.getByRole('button', { name: 'Inspeccionar versión' })).toBeDisabled();
  await user.type(screen.getByLabelText('Commit completo'), COMMIT);
  await user.click(screen.getByRole('button', { name: 'Inspeccionar versión' }));
  expect(await screen.findByText('Review context')).toBeInTheDocument();
  expect(screen.getByText(/Coincide con la revisión del diario consultada/)).toBeInTheDocument();
  expect(screen.getByText(/Árbol de trabajo e índice no observados/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /guardar|aplicar|restaurar/i })).not.toBeInTheDocument();
  expect(calls).toEqual(['GET']);
});

it('compares two explicit commits without editing the profile', async () => {
  const response = result();
  response.previous = { ...snapshot(PREVIOUS), profile: { ...PROFILE, purpose: 'Old context' } };
  response.journalVerification.previous = 'journal_mismatch';
  const urls: URL[] = [];
  server.use(http.get(`${BASE}/inspect`, ({ request }) => { urls.push(new URL(request.url)); return HttpResponse.json(response); }));
  const user = await open();
  await user.type(screen.getByLabelText('Commit completo'), COMMIT);
  await user.type(screen.getByLabelText('Comparar con otro commit (opcional)'), PREVIOUS);
  await user.click(screen.getByRole('button', { name: 'Inspeccionar versión' }));
  expect(await screen.findByText('Antes: Old context')).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: /· cambiado/ })).toBeInTheDocument();
  expect(urls[0]?.searchParams.get('previous_commit')).toBe(PREVIOUS);
  expect([...new URL(urls[0] ?? BASE).searchParams.keys()].sort()).toEqual(['commit', 'previous_commit']);
});

it.each([
  ['not_configured', 'Esta instancia todavía no tiene un repositorio Git vinculado por el servidor.'],
  ['not_published', 'Este gateway todavía no publica la inspección Git.'],
])('keeps %s honest and offers no path or mutation input', async (state, message) => {
  server.use(http.get(BASE, () => state === 'not_published'
    ? HttpResponse.json({ error: 'unavailable' }, { status: 501 })
    : HttpResponse.json({ ...CAPABILITY, state, instance_id: null })));
  renderWithApi(<ContextRepositoryPanel tenantId="Steven" alias="helper" />);
  expect(await screen.findByText(message)).toBeInTheDocument();
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
});

it('keeps inaccessible agents distinct from unpublished routes and can retry', async () => {
  server.use(http.get(BASE, () => HttpResponse.json({ error: 'not_found' }, { status: 404 })));
  renderWithApi(<ContextRepositoryPanel tenantId="Steven" alias="helper" />);
  expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo consultar');
  expect(screen.queryByText('Este gateway todavía no publica la inspección Git.')).not.toBeInTheDocument();
  server.use(http.get(BASE, () => HttpResponse.json(CAPABILITY)));
  await userEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
  expect(await screen.findByLabelText('Commit completo')).toBeInTheDocument();
});

it('invalidates an in-flight result when the requested commit changes', async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started = false;
  server.use(http.get(`${BASE}/inspect`, async () => { started = true; await gate; return HttpResponse.json(result()); }));
  const user = await open();
  await user.type(screen.getByLabelText('Commit completo'), COMMIT);
  await user.click(screen.getByRole('button', { name: 'Inspeccionar versión' }));
  await waitFor(() => { expect(started).toBe(true); });
  fireEvent.change(screen.getByLabelText('Commit completo'), { target: { value: PREVIOUS } });
  await act(async () => { release?.(); await gate; });
  expect(screen.queryByRole('region', { name: 'Resultado de inspección Git' })).not.toBeInTheDocument();
  expect(screen.getByLabelText('Commit completo')).toHaveValue(PREVIOUS);
});

it('unmounting and mounting again discards an in-flight result and stale input', async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started = false;
  server.use(http.get(`${BASE}/inspect`, async () => { started = true; await gate; return HttpResponse.json(result()); }));
  const user = userEvent.setup();
  const view = renderWithApi(<ContextRepositoryPanel tenantId="Steven" alias="helper" />);
  await user.type(await screen.findByLabelText('Commit completo'), COMMIT);
  await user.click(screen.getByRole('button', { name: 'Inspeccionar versión' }));
  await waitFor(() => { expect(started).toBe(true); });
  view.unmount();
  await act(async () => { release?.(); await gate; });
  renderWithApi(<ContextRepositoryPanel tenantId="Steven" alias="helper" />);
  expect(await screen.findByLabelText('Commit completo')).toHaveValue('');
  expect(screen.queryByText('Review context')).not.toBeInTheDocument();
});

it('switching agents cannot display the former agent response', async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  server.use(http.get(`${BASE}/inspect`, async () => { await gate; return HttpResponse.json(result()); }),
    http.get(BASE.replace('/helper/', '/other/'), () => HttpResponse.json({ ...CAPABILITY, alias: 'other' })));
  const api = new CauceApi('http://localhost');
  const view = renderWithApi(<ContextRepositoryPanel tenantId="Steven" alias="helper" />);
  fireEvent.change(await screen.findByLabelText('Commit completo'), { target: { value: COMMIT } });
  await userEvent.click(screen.getByRole('button', { name: 'Inspeccionar versión' }));
  view.rerender(<ApiProvider api={api}><ContextRepositoryPanel tenantId="Steven" alias="other" /></ApiProvider>);
  await act(async () => { release?.(); await gate; });
  expect(await screen.findByLabelText('Commit completo')).toHaveValue('');
  expect(screen.queryByText('Review context')).not.toBeInTheDocument();
});

it('shows a failed inspection without preserving an older result', async () => {
  server.use(http.get(`${BASE}/inspect`, () => HttpResponse.json(result())));
  const user = await open();
  await user.type(screen.getByLabelText('Commit completo'), COMMIT);
  await user.click(screen.getByRole('button', { name: 'Inspeccionar versión' }));
  await screen.findByText('Review context');
  server.use(http.get(`${BASE}/inspect`, () => HttpResponse.json({ error: 'context_snapshot_unavailable' }, { status: 422 })));
  await user.click(screen.getByRole('button', { name: 'Inspeccionar versión' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo inspeccionar');
  expect(screen.queryByText('Review context')).not.toBeInTheDocument();
});

it.each([
  { tenant_id: 'steven' }, { alias: 'other' }, { sourceState: 'clean' }, { application: 'applied' },
  { desired: { ...snapshot(), commit: PREVIOUS } },
  { desired: { ...snapshot(), scope: { ...snapshot().scope, instance_id: 'other' } } },
  { desired: { ...snapshot(), profile: { ...PROFILE, tools: 'invalid' } } },
  { journalVerification: { desired: 'applied', previous: null } },
])('rejects incomplete or wrong-identity inspection responses %#', async (override) => {
  const request = vi.fn(async () => ({ ...result(), ...override })) as unknown as RequestFn;
  await expect(contextRepositoryClient(request).inspectContextRepository('Steven', 'helper', 'fixture', COMMIT))
    .rejects.toMatchObject({ code: 'invalid_context_repository' });
});

it('validates capability identity and never sends a client root, instance or principal', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const request: RequestFn = async <T,>(url: string, init?: RequestInit) => {
    calls.push({ url, init }); return result() as T;
  };
  await contextRepositoryClient(request).inspectContextRepository('Steven', 'helper', 'fixture', COMMIT);
  expect(calls[0]?.url).toBe(`/v3/console/tenants/Steven/agents/helper/context/repository/inspect?commit=${COMMIT}`);
  expect(calls[0]?.init).toEqual({ cache: 'no-store' });
  const wrong = (async () => ({ ...CAPABILITY, tenant_id: 'steven' })) as unknown as RequestFn;
  await expect(contextRepositoryClient(wrong).getContextRepository('Steven', 'helper')).rejects.toMatchObject({ code: 'invalid_context_repository' });
});


it.each([
  { error: 'unclassified_gateway_failure' },
  { message: 'transient response without a route code' },
])('preserves an ambiguous 404 as a retryable failure: %j', async (body) => {
  let calls = 0;
  server.use(http.get(BASE, () => {
    calls += 1;
    return calls === 1 ? HttpResponse.json(body, { status: 404 }) : HttpResponse.json(CAPABILITY);
  }));
  const user = userEvent.setup();
  renderWithApi(<ContextRepositoryPanel tenantId="Steven" alias="helper" />);
  expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo consultar la vinculación Git');
  expect(screen.queryByText('Este gateway todavía no publica la inspección Git.')).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Reintentar' }));
  expect(await screen.findByLabelText('Commit completo')).toBeInTheDocument();
  expect(calls).toBe(2);
});

it('preserves a non-JSON transport 404 as a retryable failure', async () => {
  server.use(http.get(BASE, () => new HttpResponse('upstream resource missing', { status: 404 })));
  renderWithApi(<ContextRepositoryPanel tenantId="Steven" alias="helper" />);
  expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo consultar');
  expect(screen.getByRole('button', { name: 'Reintentar' })).toBeEnabled();
});

it('recognizes explicit HTTP 501 without disguising a failure to find the agent', async () => {
  server.use(http.get(BASE, () => HttpResponse.json({ error: 'unavailable' }, { status: 501 })));
  renderWithApi(<ContextRepositoryPanel tenantId="Steven" alias="helper" />);
  expect(await screen.findByText('Este gateway todavía no publica la inspección Git.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Reintentar' })).toBeNull();
});

it.each(['journal_match', 'git_authored', 'journal_mismatch', 'journal_unavailable'])(
  'offers explicit preview only for an admissible %s origin', async (provenance) => {
    const response = result(); response.journalVerification.desired = provenance;
    if (provenance === 'git_authored') response.desired.sourceAgent.source_journal = null;
    let previews = 0; let writes = 0;
    server.use(http.get(`${BASE}/inspect`, () => HttpResponse.json(response)),
      http.post(`${BASE}/preview`, () => { previews += 1; return HttpResponse.json({}); }),
      http.put(BASE.replace('/context/repository', '/perfil'), () => { writes += 1; return HttpResponse.json({}); }));
    const user = userEvent.setup(); renderWithApi(<ContextRepositoryPanel tenantId="Steven" alias="helper" canApply />);
    fireEvent.change(await screen.findByLabelText('Commit completo'), { target: { value: COMMIT } });
    await user.click(screen.getByRole('button', { name: 'Inspeccionar versión' }));
    await screen.findByText('Review context');
    if (['journal_match', 'git_authored'].includes(provenance)) {
      expect(screen.getByRole('button', { name: 'Preparar aplicación' })).toBeDisabled();
    } else expect(screen.queryByRole('button', { name: 'Preparar aplicación' })).toBeNull();
    if (provenance === 'git_authored') expect(screen.getByText(/Contenido nuevo de Git; no declara/)).toBeInTheDocument();
    expect(previews).toBe(0); expect(writes).toBe(0);
  },
);

it.each([
  { journal: 'git_authored', source: snapshot().sourceAgent },
  { journal: 'journal_match', source: { ...snapshot().sourceAgent, source_journal: null } },
  { journal: 'git_authored', source: { ...snapshot().sourceAgent, source_journal: undefined } },
  { journal: 'git_authored', source: { ...snapshot().sourceAgent, alias: 'other', source_journal: null } },
])('client refuses an inspection provenance contradiction: %j', async ({ journal, source }) => {
  const response = { ...result(), desired: { ...snapshot(), sourceAgent: source },
    journalVerification: { desired: journal, previous: null } };
  const request = vi.fn(async () => response) as unknown as RequestFn;
  await expect(contextRepositoryClient(request).inspectContextRepository('Steven', 'helper', 'fixture', COMMIT))
    .rejects.toMatchObject({ code: 'invalid_context_repository' });
});
