import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { App } from '../../App';
import { ObservabilityPage } from './ObservabilityPage';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';

/*
 * "Origin relays" dejó de ser una ruta el 2026-08-06: su tabla es la mitad de abajo de
 * "Observabilidad y relays". Estos tests montan la vista fusionada para que fallen si alguien
 * vuelve a partirla, y para que fallen si la tabla vuelve a alimentarse del snapshot de
 * observabilidad —que NO pasa por la fachada de visibilidad— en vez de su endpoint dedicado.
 */

const relay = {
  id: 'relay-0001-aaaa', tenant_id: 'Steven', adapter: 'telegram',
  request_id: 'req-7f3c-bbbb', message_id: 'msg-91ab-cccc', delivery_id: 'del-22de-dddd',
  trace_id: 'trace-4c8f-eeee', status: 'sent', attempts: 2,
  created_at: '2026-08-06T10:00:00.000Z', sent_at: '2026-08-06T10:00:03.000Z',
};

/** El snapshot de observabilidad trae un relay AJENO: la vista no debe dibujarlo nunca. */
function observability(overrides: Record<string, unknown> = {}) {
  server.use(http.get('*/v3/console/observability', () => HttpResponse.json({
    observed_at: '2026-08-06T10:00:05.000Z',
    status: { online: 16, queued: 3, dead_letters: 1, outbox_pending: 0 },
    queues: { pending: 3, retrying: 1, dead: 1, items: [] },
    jobs: { items: [{ job_id: 'job-1', tenant_id: 'Miguel', lane: 'batch', kind: 'x', status: 'queued' }] },
    origin_relays: { items: [{ ...relay, id: 'relay-de-otro-tenant', tenant_id: 'Pablo' }] },
    ...overrides,
  })));
}

function relays(items: Array<Record<string, unknown>>) {
  server.use(http.get('*/v3/console/origin-relays', () => HttpResponse.json({ items })));
}

it('los relays viven DENTRO de la vista de observabilidad, con un solo h1', async () => {
  observability();
  relays([relay]);
  renderWithApi(<ObservabilityPage />);

  const headings = await screen.findAllByRole('heading', { level: 1 });
  expect(headings).toHaveLength(1);
  expect(headings[0]).toHaveTextContent(/observabilidad y relays/i);
  expect(await screen.findByRole('heading', { name: /relays al canal de origen/i })).toBeInTheDocument();
});

it('/relays no da 404 ni cae al fallback: redirige a /observability', async () => {
  observability();
  relays([relay]);
  window.history.pushState({}, '', '/relays');
  renderWithApi(<App />);

  expect(await screen.findByRole('heading', { level: 1, name: /observabilidad y relays/i })).toBeInTheDocument();
  await waitFor(() => expect(window.location.pathname).toBe('/observability'));
});

it('la tabla sale del endpoint con fachada, no del snapshot sin fachada', async () => {
  observability();
  relays([relay]);
  renderWithApi(<ObservabilityPage />);

  // El relay de `/v3/console/origin-relays` (visibleOriginRelays) está…
  expect(await screen.findByText(/relay-0001/)).toBeInTheDocument();
  // …y el que sólo venía en el snapshot de observabilidad, que el gateway devuelve SIN filtrar por
  // participación, no. Ése era el que el volcado JSON estaba publicando.
  expect(screen.queryByText(/relay-de-otro/)).not.toBeInTheDocument();
  expect(screen.queryByText(/"origin_relays"/)).not.toBeInTheDocument();
  expect(screen.queryByText(/"job_id"/)).not.toBeInTheDocument();
});

it('conserva request_id, message_id y trace_id, que sólo estaban en el volcado JSON', async () => {
  observability();
  relays([relay]);
  renderWithApi(<ObservabilityPage />);

  const row = (await screen.findByText(/relay-0001/)).closest('tr');
  expect(row).not.toBeNull();
  expect(within(row!).getByText(/req-7f3c/)).toBeInTheDocument();
  expect(within(row!).getByText(/trace-4c8f/)).toBeInTheDocument();
  expect(within(row!).getByText(/msg-91ab/)).toBeInTheDocument();
  expect(within(row!).getByText(/del-22de/)).toBeInTheDocument();
  expect(within(row!).getByText('SENT')).toBeInTheDocument();
});

it('no presenta como enviado un relay que dice sent sin sent_at', async () => {
  observability();
  relays([{ ...relay, sent_at: null }]);
  renderWithApi(<ObservabilityPage />);

  const row = (await screen.findByText(/relay-0001/)).closest('tr');
  // Columna "Estado", no cualquier UNKNOWN de la fila: la de "Enviado" también dice UNKNOWN, y
  // confundirlas dejaría pasar justamente el caso que este test cuida.
  expect(row!.querySelectorAll('td')[4]).toHaveTextContent('UNKNOWN');
  expect(within(row!).queryByText('SENT')).not.toBeInTheDocument();
});

it('mantiene las señales del gateway medidas en un mismo instante', async () => {
  observability();
  relays([relay]);
  renderWithApi(<ObservabilityPage />);

  expect(await screen.findByText('Online')).toBeInTheDocument();
  expect(screen.getByText('16')).toBeInTheDocument();
  expect(screen.getByText(/observado:/i)).toBeInTheDocument();
});

it('si fallan los relays, las señales siguen en pantalla y la falla se declara', async () => {
  observability();
  server.use(http.get('*/v3/console/origin-relays', () => HttpResponse.json({ error: 'boom' }, { status: 500 })));
  renderWithApi(<ObservabilityPage />);

  expect(await screen.findByRole('alert')).toHaveTextContent(/no se pudieron leer los origin relays/i);
  expect(screen.getByText('Online')).toBeInTheDocument();
});
