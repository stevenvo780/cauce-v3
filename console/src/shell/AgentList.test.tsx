import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { delay, http, HttpResponse } from 'msw';
import { expect, it } from 'vitest';
import { server } from '../mocks/server';
import { renderWithApi } from '../test/render';
import { AgentList } from './AgentList';
import { FleetProvider } from './fleet';

function renderList(props: Partial<Parameters<typeof AgentList>[0]> = {}) {
  return renderWithApi(<FleetProvider><AgentList routeId="messages" {...props} /></FleetProvider>);
}

async function roster() {
  return screen.findByRole('list', { name: 'Agentes' });
}

async function linkOf(alias: string) {
  return within(await roster()).findByRole('link', { name: new RegExp(`^${alias}\\b`) });
}

function failEverySource() {
  const fail = () => HttpResponse.json({ error: 'unavailable', message: 'sin servicio' }, { status: 503 });
  server.use(
    http.get('*/v3/status', fail),
    http.get('*/v3/console/topology', fail),
    http.get('*/v3/console/activity', fail),
    http.get('*/v3/console/messages', fail),
  );
}

beforeEach(() => {
  window.history.pushState({}, '', '/messages');
});

it.each([
  ['messages', '/messages/Steven/argos'],
  ['terminal', '/terminal/Steven/argos'],
  ['live', `/live?agente=${encodeURIComponent('Steven/argos')}`],
  ['accounts', '/messages/Steven/argos'],
  ['config', '/messages/Steven/argos'],
])('en %s, cada agente enlaza a %s', async (routeId, href) => {
  renderList({ routeId });

  expect(await linkOf('argos')).toHaveAttribute('href', href);
});

it('el enlace del agente abierto lleva aria-current y los demás no', async () => {
  renderList({ activeId: 'Steven:argos' });

  expect(await linkOf('argos')).toHaveAttribute('aria-current', 'page');
  expect(await linkOf('kratos')).not.toHaveAttribute('aria-current');
});

it('mezcla a los agentes de todos los clientes y los rotula con su cliente y su estado', async () => {
  renderList();

  const argos = await linkOf('argos');
  expect(argos).toHaveTextContent('Steven');
  expect(argos).toHaveTextContent(/delegando · 1 en curso/i);
  expect(await linkOf('kratos')).toHaveTextContent('Miguel');
});

it('el buscador filtra por alias o por cliente y dice cuando nada coincide', async () => {
  const user = userEvent.setup();
  renderList();
  await linkOf('argos');

  await user.type(screen.getByRole('searchbox', { name: 'Buscar agente' }), 'miguel');
  const lista = await roster();
  await waitFor(() => { expect(within(lista).queryByRole('link', { name: /^argos/ })).toBeNull(); });
  expect(within(lista).getByRole('link', { name: /^kratos/ })).toBeInTheDocument();

  await user.clear(screen.getByRole('searchbox', { name: 'Buscar agente' }));
  await user.type(screen.getByRole('searchbox', { name: 'Buscar agente' }), 'nadie');
  expect(await screen.findByText('Ningún agente coincide.')).toBeInTheDocument();
  expect(within(lista).queryAllByRole('link')).toHaveLength(0);
});

it('mientras la flota carga lo dice y no afirma que esté vacía', async () => {
  server.use(
    http.get('*/v3/status', async () => { await delay(300); return HttpResponse.json({ presence: [] }); }),
    http.get('*/v3/console/topology', async () => { await delay(300); return HttpResponse.json({ tenants: [] }); }),
    http.get('*/v3/console/activity', async () => { await delay(300); return HttpResponse.json({ agents: [] }); }),
    http.get('*/v3/console/messages', async () => { await delay(300); return HttpResponse.json({ items: [] }); }),
  );
  renderList();

  expect(await screen.findByRole('status')).toHaveTextContent('Cargando agentes…');
  expect(screen.queryByText('Sin agentes en la flota.')).toBeNull();
});

it('si la flota no se pudo leer, el error no se disfraza de lista vacía', async () => {
  failEverySource();
  renderList();

  const alerta = await screen.findByRole('alert');
  expect(alerta).toHaveTextContent('No se pudo leer la flota');
  expect(screen.queryByText('Sin agentes en la flota.')).toBeNull();
});

it('en el riel solo hay orbes: sin buscador, y cada enlace se nombra con alias, estado y cola', async () => {
  renderList({ rail: true });

  const argos = await linkOf('argos');
  expect(argos).toHaveAttribute('aria-label', expect.stringMatching(/^argos · Delegando · 1 en curso$/));
  expect(argos).toHaveAttribute('title', argos.getAttribute('aria-label'));
  expect(screen.queryByRole('searchbox')).toBeNull();
  expect(argos).not.toHaveTextContent('Steven');
});

it('hacer clic navega dentro de la aplicación sin recargar', async () => {
  const user = userEvent.setup();
  renderList();

  await user.click(await linkOf('argos'));

  expect(window.location.pathname).toBe('/messages/Steven/argos');
});
