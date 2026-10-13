import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { mockActivity, topology } from '../../mocks/data';
import { server } from '../../mocks/server';
import { renderLive } from './render-live';

it('un fallo de topología se dice como error, no como «aún no hay salas»', async () => {
  server.use(http.get('*/v3/console/topology', () => HttpResponse.json(
    { error: 'unavailable', message: 'topología caída' }, { status: 503 },
  )));
  renderLive();

  const aviso = await screen.findByRole('alert', {}, { timeout: 8000 });
  expect(aviso).toHaveTextContent(/topología caída/);
  expect(screen.queryByText(/Aún no hay salas/)).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: /reintentar/i })).toBeInTheDocument();
}, 20_000);

it('sin agentes el campus invita a registrar el primero', async () => {
  const vacia = mockActivity();
  server.use(
    http.get('*/v3/console/activity', () => HttpResponse.json({ ...vacia, agents: [], totals: { ...vacia.totals, agents: 0 } })),
    http.get('*/v3/console/topology', () => HttpResponse.json({ observed_at: vacia.observed_at, tenants: [] })),
  );
  renderLive();

  expect(await screen.findByText(/Todavía no hay agentes en esta empresa/, {}, { timeout: 8000 })).toBeVisible();
  expect(screen.getByRole('link', { name: /Registrar un agente/ })).toHaveAttribute('href', '/config?seccion=agentes');
}, 20_000);

it('una relectura de topología fallida avisa y conserva el campus', async () => {
  let lecturas = 0;
  server.use(http.get('*/v3/console/topology', () => {
    lecturas += 1;
    return lecturas === 1
      ? HttpResponse.json(topology)
      : HttpResponse.json({ error: 'unavailable', message: 'topología caída' }, { status: 503 });
  }));
  const user = userEvent.setup();
  renderLive();
  await screen.findByRole('heading', { level: 1, name: 'Oficina' }, { timeout: 8000 });

  await user.click(screen.getByRole('button', { name: /^actualizar$/i }));

  expect(await screen.findByText(/No se pudo actualizar la topología: topología caída/, {}, { timeout: 8000 })).toBeInTheDocument();
  expect(screen.getByRole('heading', { level: 1, name: 'Oficina' })).toBeInTheDocument();
  expect(screen.queryByText('No se pudo leer Cauce V3')).not.toBeInTheDocument();
}, 20_000);
