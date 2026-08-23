import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { LiveFleetPage } from '../live/LiveFleetPage';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import type { FleetActivitySnapshot } from '../../api/types';

const BASE: FleetActivitySnapshot = {
  observed_at: '2026-07-27T14:52:11.000Z',
  thresholds: {
    saturation_in_flight: 8,
    stall_after_seconds: 300,
    ack_recent_seconds: 300,
    ack_lookback_seconds: 3600,
    items_per_agent: 10,
  },
  totals: {
    agents: 3,
    by_state: { idle: 1, queued: 0, working: 0, saturated: 1, stalled: 1 },
    flagged: { saturated: 2, ack_stalled: 1, overdue_acks: 1, lease_expired: 1 },
    in_flight: 50,
    queued: 0,
    retrying: 0,
    overdue_in_flight: 41,
  },
  agents: [
    {
      tenant_id: 'Isa', alias: 'salva', display_name: 'Salva', harness_id: 'claude-code',
      registered: true, agent_enabled: true,
      presence: { online: true, instance_id: 'salva-1', epoch: 1, last_heartbeat_at: '2026-07-27T14:52:09.000Z', lease_until: '2026-07-27T15:52:09.000Z' },
      work_state: 'idle', flags: [],
      in_flight: 0, started: 0, claimed_not_started: 0, queued: 0, queued_ready: 0, retrying: 0, overdue_in_flight: 0,
      oldest_claimed_at: null, oldest_in_flight_seconds: null, nearest_ack_deadline_at: null, max_attempt: null,
      last_ack_at: '2026-07-27T14:38:52.000Z', seconds_since_last_ack: 799, acks_recent: 0,
      in_flight_items_truncated: false, in_flight_items: [],
    },
    {
      tenant_id: 'Steven', alias: 'jarvis', display_name: 'Jarvis', harness_id: 'claude-code',
      registered: true, agent_enabled: true,
      presence: { online: true, instance_id: 'jarvis-1', epoch: 5, last_heartbeat_at: '2026-07-27T14:52:04.000Z', lease_until: '2026-07-27T15:52:04.000Z' },
      work_state: 'saturated', flags: ['saturated'],
      in_flight: 9, started: 9, claimed_not_started: 0, queued: 0, queued_ready: 0, retrying: 0, overdue_in_flight: 0,
      oldest_claimed_at: '2026-07-27T14:46:00.000Z', oldest_in_flight_seconds: 340,
      nearest_ack_deadline_at: '2026-07-27T14:53:00.000Z', max_attempt: 1,
      last_ack_at: '2026-07-27T14:51:50.000Z', seconds_since_last_ack: 20, acks_recent: 12,
      in_flight_items_truncated: false, in_flight_items: [],
    },
    {
      tenant_id: 'Pablo', alias: 'midas', display_name: null, harness_id: 'openclaw',
      registered: true, agent_enabled: true,
      presence: { online: false, instance_id: 'midas-1', epoch: 41, last_heartbeat_at: '2026-07-27T14:29:18.000Z', lease_until: '2026-07-27T14:29:48.000Z' },
      work_state: 'stalled', flags: ['ack_stalled', 'saturated', 'overdue_acks', 'lease_expired'],
      in_flight: 41, started: 39, claimed_not_started: 2, queued: 12, queued_ready: 12, retrying: 3, overdue_in_flight: 41,
      oldest_claimed_at: '2026-07-27T13:31:51.000Z', oldest_in_flight_seconds: 4820,
      nearest_ack_deadline_at: '2026-07-27T13:36:51.000Z', max_attempt: 2,
      // Nunca aplicó un ACK dentro de la ventana de búsqueda: la señal más grave del panel.
      last_ack_at: null, seconds_since_last_ack: null, acks_recent: 0,
      in_flight_items_truncated: true,
      in_flight_items: [
        { delivery_id: 'd-1', message_id: 'm-1', trace_id: 't-1', from_tenant: 'Pablo', from_alias: 'dedalo', lane: 'batch', origin_adapter: 'bus', published_at: '2026-07-27T13:31:49.000Z', status: 'started', attempt: 1, claimed_at: '2026-07-27T13:31:51.000Z', ack_deadline_at: '2026-07-27T13:36:51.000Z', seconds_in_flight: 4820, last_ack_at: '2026-07-27T13:32:02.000Z', last_ack_status: 'started' },
      ],
    },
  ],
};

function mockActivityOnce(snapshot: FleetActivitySnapshot) {
  server.use(http.get('http://localhost/v3/console/activity', () => HttpResponse.json(snapshot)));
}

it('renders agents from GET /v3/console/activity, sorted with the most urgent first', async () => {
  mockActivityOnce(BASE);
  renderWithApi(<LiveFleetPage />);

  const rows = await screen.findAllByRole('row');
  // La primera fila de datos (después del header) tiene que ser la colgada, no la alfabética.
  const dataRows = rows.filter((row) => within(row).queryAllByRole('cell').length > 0);
  expect(dataRows[0].textContent).toMatch(/midas/i);

  // El recuento de alias visibles vive ahora en la descripción de la cabecera, no en una tarjeta
  // rotulada con la expresión SQL que lo produce.
  expect(screen.getByText(/Los 3 alias que podés ver/)).toBeInTheDocument();
  // Y las cifras bajaron a la línea de texto del veredicto, en castellano. La definición del
  // servidor ("leased + accepted + started") sigue disponible: está en el tooltip.
  expect(screen.getByText(/en vuelo$/)).toHaveTextContent('50 en vuelo');
});

it('shows an error state with a working retry button when the request fails', async () => {
  server.use(http.get('http://localhost/v3/console/activity', () => HttpResponse.json({ error: 'boom', message: 'actividad caída' }, { status: 500 })));
  renderWithApi(<LiveFleetPage />);

  expect(await screen.findByRole('alert')).toHaveTextContent(/actividad caída/i);
  expect(screen.getByRole('button', { name: /reintentar/i })).toBeInTheDocument();
});

it('makes the saturated agent stand out visually with its own badge and highlight class, distinct from a healthy one', async () => {
  mockActivityOnce(BASE);
  renderWithApi(<LiveFleetPage />);

  const jarvisRow = await screen.findByRole('row', { name: /jarvis/i });
  // La saturación es una SEÑAL, no un octavo estado: el estado dice «Trabajando» —la misma
  // palabra que el chip y la leyenda— y el chip de señal dice «Saturado». Antes la fila emitía
  // «SATURADO» dos veces, una en cada sitio, y ninguna de las dos coincidía con la leyenda.
  expect(within(jarvisRow).getByText('Trabajando')).toBeInTheDocument();
  expect(within(jarvisRow).getByText('Saturado')).toBeInTheDocument();
  expect(jarvisRow.className).toContain('row-warning');

  const salvaRow = screen.getByRole('row', { name: /salva/i });
  expect(salvaRow.className).not.toContain('row-warning');
  expect(salvaRow.className).not.toContain('row-critical');
});

it('makes the stalled (incident) agent stand out even harder, and stacks its flags instead of hiding any of them', async () => {
  mockActivityOnce(BASE);
  renderWithApi(<LiveFleetPage />);

  const midasRow = await screen.findByRole('row', { name: /midas/i });
  /*
   * midas está `stalled` Y con el lease vencido. La fila dice «Caído» porque es lo que dice su
   * muñeco: la precedencia de `liveState` pone el lease vencido por encima del estancamiento —un
   * agente sin lease no va a desatascar nada— y el chip de la cinta lo cuenta como caído. La fila
   * y el chip tienen que decir LO MISMO; antes decían `COLGADO` y «Caído».
   */
  const celdaEstado = within(midasRow).getAllByRole('cell')[2];
  expect(celdaEstado).toHaveTextContent('Caído');
  expect(midasRow).toHaveAttribute('data-state', 'down');
  expect(midasRow.className).toContain('row-critical');
  // El agente está saturado Y sin acusar recibo a la vez: las señales conviven, no se pisan.
  expect(within(midasRow).getByText('Saturado')).toBeInTheDocument();
  expect(within(midasRow).getByText('Sin ACK')).toBeInTheDocument();
  expect(within(midasRow).getByText('ACK vencido')).toBeInTheDocument();
  // Y el lease vencido NO se dice tres veces: el chip `lease_expired` se cae cuando la columna de
  // presencia ya emite esa misma palabra.
  expect(within(midasRow).getAllByText('Caído')).toHaveLength(2);
});

it('never renders a null seconds_since_last_ack as zero or a dash: it reads as an explicit ACK gap', async () => {
  mockActivityOnce(BASE);
  renderWithApi(<LiveFleetPage />);

  const midasRow = await screen.findByRole('row', { name: /midas/i });
  const ackCell = within(midasRow).getAllByRole('cell')[7];
  expect(ackCell.textContent).not.toBe('0');
  expect(ackCell.textContent?.toLowerCase()).toContain('ack');
});

it('reflects totals.flagged without inventing zeroes for absent keys, and keeps it separate from the seven states', async () => {
  mockActivityOnce(BASE);
  renderWithApi(<LiveFleetPage />);

  // `flagged` es acumulativo y NO se puede derivar del recuento por estado: midas está saturado Y
  // colgado a la vez, así que suma en las dos columnas. Por eso este panel sobrevivió a la fusión
  // mientras que "Por estado" —cinco baldes excluyentes del servidor, una versión más gruesa de
  // los siete estados que la página ya dibuja— se quitó por redundante.
  const flaggedPanel = (await screen.findByText('Señales activas')).closest('section')!;
  expect(within(flaggedPanel).getByText('Saturado').closest('.chip')).toHaveTextContent('2');
  expect(within(flaggedPanel).getByText('Caído').closest('.chip')).toHaveTextContent('1');
  expect(within(flaggedPanel).queryByText('Nunca conectó')).not.toBeInTheDocument();

  expect(screen.queryByText('Por estado')).not.toBeInTheDocument();
});
