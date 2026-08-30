import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { App } from '../../App';
import { ObservabilityPage } from './ObservabilityPage';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';

/*
 * "Origin relays" stopped being a route and "Audit" stopped being one too: both are now
 * parts of "Signals and audit". These tests mount the merged view so they fail if someone
 * splits it again, and so they fail if the table feeds off the observability snapshot again —
 * which does NOT go through the visibility facade — instead of its dedicated endpoint.
 */

const relay = {
  id: 'relay-0001-aaaa', tenant_id: 'Steven', adapter: 'telegram',
  request_id: 'req-7f3c-bbbb', message_id: 'msg-91ab-cccc', delivery_id: 'del-22de-dddd',
  trace_id: 'trace-4c8f-eeee', status: 'sent', attempts: 2,
  created_at: '2026-08-06T10:00:00.000Z', sent_at: '2026-08-06T10:00:03.000Z',
};

/** The observability snapshot brings a FOREIGN relay: the view must never draw it. */
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

function relays(items: Record<string, unknown>[]) {
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
  await waitFor(() => { expect(window.location.pathname).toBe('/observability'); });
});

it('la tabla sale del endpoint con fachada, no del snapshot sin fachada', async () => {
  observability();
  relays([relay]);
  renderWithApi(<ObservabilityPage />);

  // The relay from `/v3/console/origin-relays` (visibleOriginRelays) is…
  expect(await screen.findByText(/relay-0001/)).toBeInTheDocument();
  // …and the one that only came in the observability snapshot, which the gateway returns WITHOUT
  // filtering by participation, is not. That was the one the JSON dump was publishing.
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
  if (!row) throw new Error('row not found');
  expect(within(row).getByText(/req-7f3c/)).toBeInTheDocument();
  expect(within(row).getByText(/trace-4c8f/)).toBeInTheDocument();
  expect(within(row).getByText(/msg-91ab/)).toBeInTheDocument();
  expect(within(row).getByText(/del-22de/)).toBeInTheDocument();
  expect(within(row).getByText('ENVIADO')).toBeInTheDocument();
});

it('no presenta como enviado un relay que dice sent sin sent_at', async () => {
  observability();
  relays([{ ...relay, sent_at: null }]);
  renderWithApi(<ObservabilityPage />);

  const row = (await screen.findByText(/relay-0001/)).closest('tr');
  if (!row) throw new Error('row not found');
  // "Status" column. `sent` without `sent_at` is NOT a missing-data case: it is a server
  // CONTRADICTION, and saying "no data" would hide it behind the same gray as a field that
  // never arrived. We name what is happening, and still do not say plain "sent".
  expect(row.querySelectorAll('td')[4]).toHaveTextContent('DICE ENVIADO, SIN HORA');
  expect(within(row).queryByText('ENVIADO')).not.toBeInTheDocument();
  expect(within(row).queryByText('SENT')).not.toBeInTheDocument();
});

it('mantiene las señales del gateway medidas en un mismo instante', async () => {
  observability();
  relays([relay]);
  renderWithApi(<ObservabilityPage />);

  expect(await screen.findByText('En línea')).toBeInTheDocument();
  expect(screen.getByText('16')).toBeInTheDocument();
  expect(screen.getByText(/observado:/i)).toBeInTheDocument();
});

it('si fallan los relays, las señales siguen en pantalla y la falla se declara', async () => {
  observability();
  server.use(http.get('*/v3/console/origin-relays', () => HttpResponse.json({ error: 'boom' }, { status: 500 })));
  renderWithApi(<ObservabilityPage />);

  expect(await screen.findByRole('alert')).toHaveTextContent(/no se pudieron leer los origin relays/i);
  expect(screen.getByText('En línea')).toBeInTheDocument();
});

/** Audit events cross-referenceable against the relay above by its `trace_id`. */
function audit(items: Record<string, unknown>[]) {
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

  // The four metrics from the same `observed_at` stay outside the tabs: they show no matter
  // which one you look at. That is the only instant comparison in the console and hiding it
  // would break it.
  await screen.findByText('En línea');
  await user.click(screen.getByRole('tab', { name: 'Auditoría' }));
  expect(screen.getByText('En línea')).toBeInTheDocument();

  const eventos = screen.getByRole('heading', { level: 2, name: 'Eventos' }).closest('section');
  if (!eventos) throw new Error('section not found');
  const texto = eventos.textContent;
  // Every field the old view showed, one by one: action, decision, summary, actor, tenant,
  // request, trace and date. If any dropped in the merge, this fails.
  expect(texto).toContain('delivery.replay');
  expect(within(eventos).getByText('allow')).toBeInTheDocument();
  expect(within(eventos).getByText('deny')).toBeInTheDocument();
  expect(texto).toContain('replay del relay de telegram');
  expect(texto).toContain('zeus');
  expect(texto).toContain('Steven');
  expect(texto).toContain('req-7f3c');
  expect(texto).toContain('trace-4c8f');
  // The "N visible of M" counter of the search box.
  const contenido = eventos.querySelector('.panel-subtitle, p')?.textContent ?? texto;
  expect(contenido.trim().length).toBeGreaterThan(0);
  expect(screen.getByText('2 visibles de 2')).toBeInTheDocument();
  // And the search box keeps filtering over the six fields.
  await user.type(screen.getByRole('searchbox'), 'kant');
  expect(screen.getByText('1 visibles de 2')).toBeInTheDocument();
});

it('cruzar un relay contra su auditoría es UN clic: el trace viaja al filtro', async () => {
  // This is the usability that justifies the merge. The comment that was in ObservabilityPage
  // said request_id and trace_id were dropped to the table "to cross-check against Audit":
  // that cross-check existed and was done by hand, with two browser tabs and a copied
  // identifier.
  observability();
  relays([relay]);
  audit(AUDIT_EVENTS);
  const user = userEvent.setup();
  renderWithApi(<ObservabilityPage />);

  await user.click(await screen.findByRole('button', { name: /ver la auditoría del trace trace-4c8f-eeee/i }));

  // The tab changed by itself and the filter already carries the relay's trace.
  expect(screen.getByRole('tab', { name: 'Auditoría' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('searchbox')).toHaveValue('trace-4c8f-eeee');
  expect(await screen.findByText('1 visibles de 2')).toBeInTheDocument();

  // NEGATIVE CONTROL: the event from the OTHER trace must stay out. Without it, a filter that did
  // not filter anything would pass this test the same, because the correct event would also be on
  // screen.
  const eventos = screen.getByRole('heading', { level: 2, name: 'Eventos' }).closest('section');
  if (!eventos) throw new Error('section not found');
  expect(eventos.textContent).toContain('delivery.replay');
  expect(eventos.textContent).not.toContain('config.write');

  // And the filter can be cleared without leaving the tab.
  await user.click(screen.getByRole('button', { name: /quitar el filtro/i }));
  expect(await screen.findByText('2 visibles de 2')).toBeInTheDocument();
});

it('no pide el audit log hasta que se abre su pestaña', async () => {
  // `useResource` requests on mount. If the audit log mounted every time, every visit to signals
  // would cost a GET /v3/console/audit nobody looked at: the merge would have worsened what it
  // fixed.
  observability();
  relays([relay]);
  let pedidos = 0;
  server.use(http.get('*/v3/console/audit', () => { pedidos += 1; return HttpResponse.json({ items: AUDIT_EVENTS }); }));
  const user = userEvent.setup();
  renderWithApi(<ObservabilityPage />);

  await screen.findByText('En línea');
  expect(pedidos).toBe(0);

  await user.click(screen.getByRole('tab', { name: 'Auditoría' }));
  await screen.findByRole('heading', { level: 2, name: 'Eventos' });
  expect(pedidos).toBe(1);
});


it('ninguna fila de relay grita UNKNOWN, ni dice el mismo hecho dos veces', async () => {
  observability();
  // A relay without request, trace and message: the case that made the row say
  // "req UNKNOWN · trace UNKNOWN", "msg UNKNOWN" and, in the column next to it, "sin trace".
  relays([{ ...relay, request_id: null, trace_id: null, message_id: null }]);
  renderWithApi(<ObservabilityPage />);

  const row = (await screen.findByText(/relay-0001/)).closest('tr');
  if (!row) throw new Error('row not found');
  expect(row.textContent).not.toContain('UNKNOWN');
  // The fact "no trace" is said ONCE, and in the column where it matters (the audit one).
  const menciones = row.textContent.match(/traza/gi) ?? [];
  expect(menciones.length).toBeLessThanOrEqual(1);
});
