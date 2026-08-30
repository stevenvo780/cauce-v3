import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { ObservabilityPage } from './ObservabilityPage';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';

/**
 * The states of the view: the ones that are NOT the happy path.
 *
 * Everything the other file asserts happens with a snapshot that arrived complete and a relay that was sent. What
 * is exercised here is what the operator sees the rest of the time: the two reads failing, a signal that did not
 * travel, a relay still in the queue or already failed, and one without a trace to open. They are the readings
 * where the console has the most to lose —saying "0" where nothing was measured, or "sent" where nothing was.
 */

const OBSERVABILITY_URL = '*/v3/console/observability';
const RELAYS_URL = '*/v3/console/origin-relays';

const relay = {
  id: 'relay-0001-aaaa', tenant_id: 'Steven', adapter: 'telegram',
  request_id: 'req-7f3c-bbbb', message_id: 'msg-91ab-cccc', delivery_id: 'del-22de-dddd',
  trace_id: 'trace-4c8f-eeee', status: 'sent', attempts: 2,
  created_at: '2026-08-06T10:00:00.000Z', sent_at: '2026-08-06T10:00:03.000Z',
};

function observability(body: Record<string, unknown> = {}) {
  server.use(http.get(OBSERVABILITY_URL, () => HttpResponse.json({
    observed_at: '2026-08-06T10:00:05.000Z',
    status: { online: 16, queued: 3, dead_letters: 1, outbox_pending: 0 },
    queues: { pending: 3, retrying: 1, dead: 1, items: [] },
    ...body,
  })));
}

function relays(items: Record<string, unknown>[]) {
  server.use(http.get(RELAYS_URL, () => HttpResponse.json({ items })));
}

/** The row of a relay, located by its shortened id. */
async function relayRow(shortId: string): Promise<HTMLElement> {
  const row = (await screen.findByText(new RegExp(shortId))).closest('tr');
  if (!row) throw new Error(`fila ${shortId} no encontrada`);
  return row;
}

it('un relay en cola o fallido se nombra por lo que es, y nunca como entregado', async () => {
  observability();
  relays([
    { ...relay, id: 'relay-espera', status: 'pending', sent_at: null, attempts: 0 },
    { ...relay, id: 'relay-curso', status: 'processing', sent_at: null, attempts: 1 },
    { ...relay, id: 'relay-fallo', status: 'failed', sent_at: null, attempts: 5 },
  ]);
  renderWithApi(<ObservabilityPage />);

  expect(within(await relayRow('relay-espera')).getByText('EN ESPERA')).toBeInTheDocument();
  expect(within(await relayRow('relay-curso')).getByText('EN CURSO')).toBeInTheDocument();
  const fallido = await relayRow('relay-fallo');
  expect(within(fallido).getByText('FALLÓ')).toBeInTheDocument();
  expect(fallido.querySelector('.badge')?.className).toContain('badge-danger');
  // None of the three has an arrival time, and none pretends to: the "Enviado" column says it does not apply.
  for (const id of ['relay-espera', 'relay-curso', 'relay-fallo']) {
    const row = await relayRow(id);
    expect(within(row).getByLabelText('no aplica')).toBeInTheDocument();
    expect(within(row).queryByText('ENVIADO')).not.toBeInTheDocument();
  }
});

it('un estado que la consola no conoce no se traduce a nada: se dice que no hay dato', async () => {
  // The gateway could publish a fifth state tomorrow. Inventing a Spanish word for it, or falling back to
  // "sent", would be worse than admitting it is not understood.
  observability();
  relays([{ ...relay, status: 'teletransportado', sent_at: null }]);
  renderWithApi(<ObservabilityPage />);

  const row = await relayRow('relay-0001');
  expect(row.querySelectorAll('td')[4]).toHaveTextContent('sin dato');
  expect(row.textContent).not.toContain('teletransportado');
});

it('sin traza no ofrece un botón que no llevaría a ninguna parte', async () => {
  observability();
  relays([{ ...relay, trace_id: null }]);
  renderWithApi(<ObservabilityPage />);

  const row = await relayRow('relay-0001');
  expect(within(row).getByText('no hay traza que abrir')).toBeInTheDocument();
  expect(within(row).queryByRole('button', { name: /ver auditoría/i })).not.toBeInTheDocument();
});

it('cero relays visibles no se presenta como «no hay relays»', async () => {
  observability();
  relays([]);
  renderWithApi(<ObservabilityPage />);

  const panel = (await screen.findByRole('heading', { name: /relays al canal de origen/i })).closest('section');
  if (!panel) throw new Error('panel not found');
  expect(panel).toHaveTextContent(/no es «no hay relays»: es que no se ve ninguno desde acá/i);
  expect(within(panel).queryByRole('table')).not.toBeInTheDocument();
});

it('una señal que no llegó se declara sin dato, nunca como un cero medido', async () => {
  // `queued: 0` and "the gateway did not report queued" are opposite answers, and the metric strip is the only
  // place in the console where four numbers of the same instant can be compared.
  observability({ status: { online: 16 }, queues: null });
  relays([relay]);
  renderWithApi(<ObservabilityPage />);

  const enCola = (await screen.findByText('En cola')).closest('article');
  if (!enCola) throw new Error('métrica no encontrada');
  expect(enCola).toHaveTextContent('sin dato');
  expect(enCola.textContent).not.toMatch(/\b0\b/);
  // And the queues line says the same, field by field, instead of writing three zeros.
  expect(screen.getByText(/sin dato de pendientes/i)).toBeInTheDocument();
});

it('si la lectura de señales falla entera, la pantalla lo dice y el reintento vuelve a pedir las dos', async () => {
  let intentos = 0;
  server.use(http.get(OBSERVABILITY_URL, () => {
    intentos += 1;
    return HttpResponse.json({ error: 'boom', message: 'observabilidad caída' }, { status: 500 });
  }));
  let relaysPedidos = 0;
  server.use(http.get(RELAYS_URL, () => { relaysPedidos += 1; return HttpResponse.json({ items: [relay] }); }));
  const user = userEvent.setup();
  renderWithApi(<ObservabilityPage />);

  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent(/observabilidad caída/i);
  // No half-drawn table with the relays that DID arrive: without the snapshot there is no instant to hang them on.
  expect(screen.queryByRole('table')).not.toBeInTheDocument();

  const antes = intentos;
  const antesRelays = relaysPedidos;
  await user.click(within(alert).getByRole('button', { name: /reintentar/i }));
  await waitFor(() => { expect(intentos).toBeGreaterThan(antes); });
  // The retry pulls BOTH reads: leaving the relays behind would show a fresh snapshot with an old table.
  await waitFor(() => { expect(relaysPedidos).toBeGreaterThan(antesRelays); });
});

it('el botón de actualizar vuelve a pedir las dos lecturas, no sólo la que se está mirando', async () => {
  let senales = 0;
  let listados = 0;
  server.use(
    http.get(OBSERVABILITY_URL, () => {
      senales += 1;
      return HttpResponse.json({ observed_at: '2026-08-06T10:00:05.000Z', status: { online: 1 }, queues: null });
    }),
    http.get(RELAYS_URL, () => { listados += 1; return HttpResponse.json({ items: [relay] }); }),
  );
  const user = userEvent.setup();
  renderWithApi(<ObservabilityPage />);

  await screen.findByText('En línea');
  await waitFor(() => { expect(listados).toBe(1); });
  await user.click(screen.getByRole('button', { name: /actualizar/i }));
  await waitFor(() => { expect(senales).toBe(2); });
  await waitFor(() => { expect(listados).toBe(2); });
});
