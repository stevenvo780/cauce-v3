import { useState } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, it, vi } from 'vitest';
import type { QuotaAccount } from '../../api/client/my-quotas-client';
import { ApiProvider } from '../../api/context';
import { server } from '../../mocks/server';
import { FleetProvider } from '../../shell/fleet';
import { testApi } from '../../test/render';
import { AgentQuotaDetail } from '../accounts/AgentQuotaDetail';
import { CompanySessionProvider } from '../auth/company-session';
import { OfficeWorkspace } from './OfficeWorkspace';

const account = (remaining: number): QuotaAccount => ({
  id: 'subscription', provider: 'codex', label: 'Cuenta compartida', enabled: true, version: 1, payer_tenant_id: 'One',
  shared: false, agent_count: 1, agents: [{ tenant_id: 'One', alias: 'worker', enabled: true }],
  paused_until: null, paused_reason: null, observation_status: 'ok', remaining_percent: remaining, note: null, windows: [],
});
const topology = { tenants: [{ id: 'One', rooms: [{ id: 'general', label: 'General', members: [{ alias: 'worker', enabled: true }] }] }] };

function Office({ role = 'company_owner' }: { role?: 'company_owner' | 'reader' }) {
  const [sheet, setSheet] = useState(false);
  return <CompanySessionProvider state={{ authenticated: true, authority: {
    role, scope: role === 'reader' ? 'tenant' : 'company', home_company: 'one', acting_company: 'one', platform_override: false,
  } }}>
    <button type="button" onClick={() => { setSheet(open => !open); }}>{sheet ? 'Cerrar ficha' : 'Abrir ficha'}</button>
    <OfficeWorkspace campus={<p>Campus actual</p>} topology={topology} agents={[]} now={Date.now()} onAgent={() => { setSheet(true); }} />
    {sheet ? <AgentQuotaDetail tenant="One" alias="worker" /> : null}
  </CompanySessionProvider>;
}
const mount = (role?: 'company_owner' | 'reader') => render(<ApiProvider api={testApi}><FleetProvider><Office role={role} /></FleetProvider></ApiProvider>);

it('plano y ficha comparten una sola lectura de cuotas y reabrir la ficha no la repite', async () => {
  let remaining = 60; const reads = vi.fn();
  server.use(http.get('*/v3/console/quota-accounts', () => {
    reads(); return HttpResponse.json({ company_id: 'one', observed_at: new Date().toISOString(), accounts: [account(remaining)] });
  }));
  const user = userEvent.setup(); mount();
  await user.click(screen.getByRole('button', { name: 'Plano editable' }));
  await user.click(await screen.findByRole('button', { name: 'General One' }));
  expect(await within(screen.getByRole('region', { name: 'Agentes de sala One/General' })).findByText('Disponible')).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Abrir ficha' }));
  const fatigue = () => screen.getByRole('region', { name: 'Disponibilidad de worker' }).querySelector('[data-fatigue]');
  expect(fatigue()).toHaveAttribute('data-fatigue', 'available');
  expect(within(screen.getByRole('region', { name: 'Disponibilidad de worker' })).getByText('Cuenta compartida')).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Cerrar ficha' }));
  await user.click(screen.getByRole('button', { name: 'Abrir ficha' }));
  expect(fatigue()).toHaveAttribute('data-fatigue', 'available');
  expect(reads).toHaveBeenCalledTimes(1);

  remaining = 10;
  await user.click(screen.getByRole('button', { name: 'Releer plano y cuotas' }));
  await waitFor(() => { expect(fatigue()).toHaveAttribute('data-fatigue', 'low'); });
  expect(within(screen.getByRole('region', { name: 'Agentes de sala One/General' })).getByText('Cansado')).toBeVisible();
  expect(reads).toHaveBeenCalledTimes(2);
});

it('el error de cuotas da la acción en español, conserva el motivo del servidor y muestra su código en plano y ficha', async () => {
  server.use(http.get('*/v3/console/quota-accounts', () => HttpResponse.json(
    { error: 'forbidden', message: 'La cuenta de cuota pertenece a otra empresa.' }, { status: 403 },
  )));
  const user = userEvent.setup(); mount();
  await user.click(screen.getByRole('button', { name: 'Plano editable' }));
  await user.click(screen.getByRole('button', { name: 'Abrir ficha' }));
  await waitFor(() => { expect(screen.getAllByRole('alert')).toHaveLength(2); });
  for (const alert of screen.getAllByRole('alert')) {
    expect(alert).toHaveTextContent('Tu rol no permite esta acción.');
    expect(alert).toHaveTextContent('Motivo: La cuenta de cuota pertenece a otra empresa.');
    expect(within(alert).getByText('forbidden', { selector: 'code' })).toBeVisible();
  }
});

it('el campus muestra el código y la recuperación cuando falla la lectura compartida de cuotas', async () => {
  server.use(http.get('*/v3/console/quota-accounts', () => HttpResponse.json(
    { error: 'forbidden', message: 'La cuenta de cuota pertenece a otra empresa.' }, { status: 403 },
  )));
  mount();
  const alert = await screen.findByRole('alert');
  expect(alert).toBeVisible();
  expect(alert).toHaveTextContent('Motivo: La cuenta de cuota pertenece a otra empresa.');
  expect(alert).toHaveTextContent('Relee el plano y las cuotas.');
  expect(within(alert).getByText('forbidden', { selector: 'code' })).toBeVisible();
});

it.each([500, 504])('un error HTTP %s del plano conserva el código sin publicar detalles internos', async status => {
  server.use(http.get('*/v3/console/office/layout', () => HttpResponse.json(
    { error: 'office_unavailable', message: 'Private upstream exception at /srv/private' }, { status },
  )));
  const user = userEvent.setup(); mount();
  await user.click(screen.getByRole('button', { name: 'Plano editable' }));
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('El servidor no pudo leer o guardar el plano. Inténtalo más tarde.');
  expect(alert.textContent).not.toContain('Private upstream exception');
  expect(within(alert).getByText('office_unavailable', { selector: 'code' })).toBeVisible();
});

it('un 504 de cuotas conserva su código y ofrece recuperación sin la frase interna', async () => {
  server.use(http.get('*/v3/console/quota-accounts', () => HttpResponse.json(
    { error: 'quota_gateway_timeout', message: 'Private upstream exception at /srv/private' }, { status: 504 },
  )));
  const user = userEvent.setup(); mount();
  await user.click(screen.getByRole('button', { name: 'Plano editable' }));
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('Relee el plano y las cuotas.');
  expect(alert.textContent).not.toContain('Private upstream exception');
  expect(within(alert).getByText('quota_gateway_timeout', { selector: 'code' })).toBeVisible();
});

it('oculta la frase interna de un 500 pero conserva su código y explica por qué un lector no puede guardar', async () => {
  server.use(http.get('*/v3/console/quota-accounts', () => HttpResponse.json(
    { error: 'internal', message: 'Internal Server Error' }, { status: 500 },
  )));
  const user = userEvent.setup(); mount('reader');
  await user.click(screen.getByRole('button', { name: 'Plano editable' }));
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('No se pudieron leer las cuotas de los agentes. Relee el plano y las cuotas.');
  expect(alert.textContent).not.toContain('Internal Server Error');
  expect(within(alert).getByText('internal', { selector: 'code' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Guardar plano' })).toBeDisabled();
  expect(screen.getByText(/Tu rol permite ver el plano, pero no cambiarlo/u)).toBeVisible();
});

it('el conflicto al guardar muestra solo el panel común, sin la banda con código', async () => {
  server.use(http.put('*/v3/console/office/layout', () => HttpResponse.json(
    { error: 'conflict', message: 'office layout version changed; reload and retry' }, { status: 409 },
  )));
  const user = userEvent.setup(); mount();
  await user.click(screen.getByRole('button', { name: 'Plano editable' }));
  await waitFor(() => { expect(screen.getByRole('button', { name: 'General One' })).toBeEnabled(); });
  await user.click(screen.getByRole('button', { name: 'General One' }));
  await user.click(screen.getByRole('button', { name: 'Añadir parte' }));
  expect(screen.getByText('Guarda o descarta los cambios de plano antes de releerlo.')).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Guardar plano' }));
  const panel = await screen.findByRole('group', { name: 'Conflicto de versión' });
  expect(panel).toHaveTextContent('Otra persona guardó una versión nueva del plano.');
  expect(panel).toHaveTextContent('Tu borrador se conserva en el formulario');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(document.body.textContent).not.toContain('Código:');
  expect(document.body.textContent).not.toContain('reload and retry');
  expect(screen.getByText('Plano sin guardar')).toBeVisible();
});
