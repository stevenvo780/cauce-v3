import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { LiveFleetPage } from './LiveFleetPage';
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
      // Never applied an ACK inside the search window: the most severe signal of the panel.
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
  // The first data row (after the header) must be the stalled one, not the alphabetical one.
  const dataRows = rows.filter((row) => within(row).queryAllByRole('cell').length > 0);
  expect(dataRows[0].textContent).toMatch(/midas/i);

  // The count of visible aliases now lives in the header description, not on a card labelled with
  // the SQL expression that produces it.
  expect(screen.getByText(/Los 3 alias que podés ver/)).toBeInTheDocument();
  // And the figures moved down to the verdict's text line, in Spanish. The server definition
  // ("leased + accepted + started") is still available: it is in the tooltip.
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
  // Saturation is a SIGNAL, not an eighth state: the state says "Trabajando" — the same word as
  // the chip and the legend — and the signal chip says "Saturado". Before the row emitted
  // "SATURADO" twice, once in each spot, and neither matched the legend.
  expect(within(jarvisRow).getByText('Trabajando')).toBeInTheDocument();
  expect(within(jarvisRow).getByText('Saturado')).toBeInTheDocument();
  // Only ONCE. `work_state: 'saturated'` and `flags: ['saturated']` are two server fields for the
  // same fact, and the cell used to paint both: "SATURADO SATURADO".
  expect(within(jarvisRow).getAllByText('Saturado')).toHaveLength(1);
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
   * The agent is `stalled` AND with an expired lease. The row shows the down label because that
   * is what its bot shows: `liveState` precedence puts the expired lease above the stall — an
   * agent without a lease is not going to unstick anything — and the tally chip counts it as
   * down. The row and the chip must say THE SAME THING; before they said `COLGADO` and the
   * down label.
   */
  const celdaEstado = within(midasRow).getAllByRole('cell')[2];
  expect(celdaEstado).toHaveTextContent('Caído');
  expect(midasRow).toHaveAttribute('data-state', 'down');
  expect(midasRow.className).toContain('row-critical');
  // The agent is both saturated and not acknowledging at the same time: signals coexist, they do
  // not collide.
  expect(within(midasRow).getByText('Saturado')).toBeInTheDocument();
  // The down label is shown by the "Presencia" column, ONCE across the whole row.
  // The down label appears TWICE in the row and they are two different questions whose answer
  // coincides: the "Estado" column says the derived state — same as its bot, which for an expired
  // lease is the down label and wins over the stall — and the "Presencia" column says the
  // presence.
  // What does disappear is the THIRD down label: the `lease_expired` chip in the signals panel.
  expect(within(midasRow).getAllByText('Caído')).toHaveLength(2);

  // But the five are NOT stacked. "Sin ACK" and "ACK vencido" are the definition of being stalled,
  // and the down label is already shown by the next column: repeating them does not inform five
  // times, it informs less.
  // What was measured in production was FIVE badges in one cell to say "it is stalled".
  const insignias = celdaEstado.querySelectorAll('.badge');
  expect(insignias.length).toBeLessThanOrEqual(3);
  // And not a single measured signal is lost: the cell's `title=` names them all.
  for (const palabra of ['Sin ACK', 'ACK vencido', 'Saturado', 'Caído']) {
    expect(celdaEstado.getAttribute('title')).toContain(palabra);
  }
});

it('never renders a null seconds_since_last_ack as zero or a dash: it reads as an explicit ACK gap', async () => {
  mockActivityOnce(BASE);
  renderWithApi(<LiveFleetPage />);

  const midasRow = await screen.findByRole('row', { name: /midas/i });
  const ackCell = within(midasRow).getAllByRole('cell')[7];
  expect(ackCell.textContent).not.toBe('0');
  expect(ackCell.textContent.toLowerCase()).toContain('ack');
});

it('reflects totals.flagged without inventing zeroes for absent keys, and keeps it separate from the seven states', async () => {
  mockActivityOnce(BASE);
  renderWithApi(<LiveFleetPage />);

  // `flagged` is cumulative and CANNOT be derived from the per-state count: midas is both
  // saturated and stalled, so it adds to both columns. That is why this panel survived the
  // merge while "Por estado" — five exclusive server buckets, a coarser version of the seven
  // states the page already draws — was removed as redundant.
  // The fold's `<summary>` and the panel's title share the name, so we look up the panel by its
  // title inside the fold, not by a text that appears twice.
  const fold = (await screen.findAllByText('Señales activas'))
    .map((nodo) => nodo.closest('section'))
    .find((seccion): seccion is HTMLElement => seccion !== null);
  expect(fold).toBeDefined();
  if (!fold) throw new Error('fold section not found');
  expect(within(fold).getByText('Saturado').closest('.chip')).toHaveTextContent('2');
  expect(within(fold).getByText('Caído').closest('.chip')).toHaveTextContent('1');
  expect(within(fold).queryByText('Nunca conectó')).not.toBeInTheDocument();

  expect(screen.queryByText('Por estado')).not.toBeInTheDocument();
});
