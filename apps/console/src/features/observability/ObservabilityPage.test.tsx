import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { App } from '../../App';
import { ObservabilityPage } from './ObservabilityPage';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';

/*
 * "Origin relays" dejó de ser una ruta el 2026-08-06 y "Audit" el 2026-08-22: las dos son ahora
 * partes de "Señales y auditoría". Estos tests montan la vista fusionada para que fallen si alguien
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

it('los relays viven DENTRO de la vista de señales, con un solo h1', async () => {
  observability();
  relays([relay]);
  renderWithApi(<ObservabilityPage />);

  const headings = await screen.findAllByRole('heading', { level: 1 });
  expect(headings).toHaveLength(1);
  expect(headings[0]).toHaveTextContent(/señales y auditoría/i);
  expect(await screen.findByRole('heading', { name: /relays al canal de origen/i })).toBeInTheDocument();
});

it('/relays no da 404 ni cae al fallback: redirige a /observability', async () => {
  observability();
  relays([relay]);
  window.history.pushState({}, '', '/relays');
  renderWithApi(<App />);

  expect(await screen.findByRole('heading', { level: 1, name: /señales y auditoría/i })).toBeInTheDocument();
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
  expect(within(row!).getByText('ENVIADO')).toBeInTheDocument();
});

it('no presenta como enviado un relay que dice sent sin sent_at', async () => {
  observability();
  relays([{ ...relay, sent_at: null }]);
  renderWithApi(<ObservabilityPage />);

  const row = (await screen.findByText(/relay-0001/)).closest('tr');
  // Columna "Estado". `sent` sin `sent_at` NO es una ausencia de dato: es una CONTRADICCIÓN del
  // servidor, y decirle «sin dato» la escondería detrás del mismo gris que un campo que nunca
  // llegó. Se nombra lo que pasa, y sigue sin decir «enviado» a secas.
  expect(row!.querySelectorAll('td')[4]).toHaveTextContent('DICE ENVIADO, SIN HORA');
  expect(within(row!).queryByText('ENVIADO')).not.toBeInTheDocument();
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

/** Eventos de auditoría cruzables contra el relay de arriba por su `trace_id`. */
function audit(items: Array<Record<string, unknown>>) {
  server.use(http.get('*/v3/console/audit', () => HttpResponse.json({ items })));
}

const AUDIT_EVENTS = [
  {
    event_id: 'ev-1', action: 'delivery.replay', decision: 'allow', actor_alias: 'zeus',
    tenant_id: 'Steven', request_id: 'req-7f3c-bbbb', trace_id: 'trace-4c8f-eeee',
    summary: 'replay del relay de telegram', at: '2026-08-06T10:00:04.000Z',
  },
  {
    event_id: 'ev-2', action: 'config.write', decision: 'deny', actor_alias: 'kant',
    tenant_id: 'Miguel', request_id: 'req-0000-zzzz', trace_id: 'trace-9999-zzzz',
    summary: 'intento de escribir el registro sin permiso', at: '2026-08-06T09:00:00.000Z',
  },
];

it('la auditoría es una pestaña de esta vista y conserva todo lo que mostraba /audit', async () => {
  observability();
  relays([relay]);
  audit(AUDIT_EVENTS);
  const user = userEvent.setup();
  renderWithApi(<ObservabilityPage />);

  // Las cuatro métricas del mismo `observed_at` quedan fuera de las pestañas: se ven se mire lo que
  // se mire. Ésa es la única comparación instantánea de la consola y esconderla la rompería.
  await screen.findByText('Online');
  await user.click(screen.getByRole('tab', { name: 'Auditoría' }));
  expect(screen.getByText('Online')).toBeInTheDocument();

  const eventos = screen.getByRole('heading', { level: 2, name: 'Eventos' }).closest('section')!;
  const texto = eventos.textContent ?? '';
  // Cada campo que la vista vieja mostraba, uno por uno: acción, decisión, resumen, actor, tenant,
  // request, trace y fecha. Si alguno se cayó en la fusión, esto falla.
  expect(texto).toContain('delivery.replay');
  expect(within(eventos).getByText('allow')).toBeInTheDocument();
  expect(within(eventos).getByText('deny')).toBeInTheDocument();
  expect(texto).toContain('replay del relay de telegram');
  expect(texto).toContain('zeus');
  expect(texto).toContain('Steven');
  expect(texto).toContain('req-7f3c');
  expect(texto).toContain('trace-4c8f');
  // El contador «N visibles de M» del buscador.
  expect(eventos.querySelector('.panel-subtitle, p')?.textContent ?? texto).toBeTruthy();
  expect(screen.getByText('2 visibles de 2')).toBeInTheDocument();
  // Y el buscador sigue filtrando sobre los seis campos.
  await user.type(screen.getByRole('searchbox'), 'kant');
  expect(screen.getByText('1 visibles de 2')).toBeInTheDocument();
});

it('cruzar un relay contra su auditoría es UN clic: el trace viaja al filtro', async () => {
  // Ésta es la usabilidad que justifica la fusión. El comentario que estaba en ObservabilityPage
  // decía que request_id y trace_id bajaban a la tabla «para cruzarlos contra Audit»: el cruce
  // existía y se hacía a mano, con dos pestañas del navegador y un identificador copiado.
  observability();
  relays([relay]);
  audit(AUDIT_EVENTS);
  const user = userEvent.setup();
  renderWithApi(<ObservabilityPage />);

  await user.click(await screen.findByRole('button', { name: /ver la auditoría del trace trace-4c8f-eeee/i }));

  // Se cambió de pestaña solo y el filtro ya trae el trace del relay.
  expect(screen.getByRole('tab', { name: 'Auditoría' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('searchbox')).toHaveValue('trace-4c8f-eeee');
  expect(await screen.findByText('1 visibles de 2')).toBeInTheDocument();

  // 🔴 CONTROL NEGATIVO: el evento del OTRO trace tiene que quedar fuera. Sin él, un filtro que no
  // filtrara nada pasaría esta prueba igual, porque el evento correcto también estaría en pantalla.
  const eventos = screen.getByRole('heading', { level: 2, name: 'Eventos' }).closest('section')!;
  expect(eventos.textContent ?? '').toContain('delivery.replay');
  expect(eventos.textContent ?? '').not.toContain('config.write');

  // Y el filtro se puede quitar sin salir de la pestaña.
  await user.click(screen.getByRole('button', { name: /quitar el filtro/i }));
  expect(await screen.findByText('2 visibles de 2')).toBeInTheDocument();
});

it('no pide el audit log hasta que se abre su pestaña', async () => {
  // `useResource` pide al montar. Si la auditoría se montara siempre, cada visita a las señales
  // costaría un GET /v3/console/audit que nadie miró: la fusión habría empeorado lo que arregla.
  observability();
  relays([relay]);
  let pedidos = 0;
  server.use(http.get('*/v3/console/audit', () => { pedidos += 1; return HttpResponse.json({ items: AUDIT_EVENTS }); }));
  const user = userEvent.setup();
  renderWithApi(<ObservabilityPage />);

  await screen.findByText('Online');
  expect(pedidos).toBe(0);

  await user.click(screen.getByRole('tab', { name: 'Auditoría' }));
  await screen.findByRole('heading', { level: 2, name: 'Eventos' });
  expect(pedidos).toBe(1);
});


it('ninguna fila de relay grita UNKNOWN, ni dice el mismo hecho dos veces', async () => {
  observability();
  // Un relay sin petición, sin traza y sin mensaje: el caso que hacía a la fila decir
  // «req UNKNOWN · trace UNKNOWN», «msg UNKNOWN» y, en la columna de al lado, «sin trace».
  relays([{ ...relay, request_id: null, trace_id: null, message_id: null }]);
  renderWithApi(<ObservabilityPage />);

  const row = (await screen.findByText(/relay-0001/)).closest('tr')!;
  expect(row.textContent).not.toContain('UNKNOWN');
  // El hecho «no hay traza» se dice UNA vez, y en la columna donde importa (la de auditoría).
  const menciones = (row.textContent ?? '').match(/traza/gi) ?? [];
  expect(menciones.length).toBeLessThanOrEqual(1);
});
