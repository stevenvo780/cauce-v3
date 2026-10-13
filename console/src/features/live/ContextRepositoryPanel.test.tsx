import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { ContextRepositoryPanel } from './ContextRepositoryPanel';
import { contextRepositoryClient } from '../../api/client/context-repository-client';
import type { RequestFn } from '../../api/client/system-client';

const BASE = 'http://localhost/v3/console/tenants/Steven/agents/helper/context/repository';
const COMMIT = 'a'.repeat(40);
const CAPABILITY = { tenant_id: 'Steven', alias: 'helper', state: 'configured', instance_id: 'fixture',
  storage: 'loose_objects_only', sourceState: 'not_observed', application: 'not_evaluated' };

beforeEach(() => {
  server.use(http.get(BASE, () => HttpResponse.json(CAPABILITY)));
});

it('reads the binding on mount and offers only the native manual inspection', async () => {
  const user = userEvent.setup();
  renderWithApi(<ContextRepositoryPanel tenantId="Steven" alias="helper" />);
  await screen.findByLabelText('Commit completo');
  expect(screen.queryByRole('button', { name: 'Inspeccionar versión' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /aplicar|restaurar/i })).not.toBeInTheDocument();
  await user.click(screen.getByText('Manual nativo de Git · sólo inspección'));
  expect(await screen.findByRole('button', { name: /Inspeccionar manual/u })).toBeDisabled();
  await user.type(screen.getByLabelText('Commit completo'), COMMIT);
  expect(screen.getByRole('button', { name: /Inspeccionar manual/u })).toBeEnabled();
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

it('validates capability identity and never sends a client root, instance or principal', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const request: RequestFn = async <T,>(url: string, init?: RequestInit) => {
    calls.push({ url, init }); return CAPABILITY as T;
  };
  await contextRepositoryClient(request).getContextRepository('Steven', 'helper');
  expect(calls[0]?.url).toBe('/v3/console/tenants/Steven/agents/helper/context/repository');
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
