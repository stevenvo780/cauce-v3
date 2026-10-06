import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FleetActivitySnapshot } from '../../api/types';
import { must } from '../../test/must';
import { sortAgents } from './activity';
import { FleetActivityTable } from './FleetActivityTable';

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

function aliases(): string[] {
  return [...document.querySelectorAll('tr[data-agent-key]')].map((row) => row.getAttribute('data-agent-key') ?? '');
}

it('ordena por urgencia: lo trabado arriba, lo saturado después y lo libre al final', () => {
  render(<FleetActivityTable snapshot={BASE} onOpen={() => undefined} />);
  expect(aliases()).toEqual(['Pablo/midas', 'Steven/jarvis', 'Isa/salva']);
  expect(document.querySelector('tr[data-agent-key="Pablo/midas"]')).toHaveAttribute('data-urgency', 'critical');
  expect(document.querySelector('tr[data-agent-key="Steven/jarvis"]')).toHaveAttribute('data-urgency', 'warning');
});

it('ordena por columna y vuelve a invertir con un segundo clic', async () => {
  const user = userEvent.setup();
  render(<FleetActivityTable snapshot={BASE} onOpen={() => undefined} />);

  await user.click(screen.getByRole('button', { name: 'Último ACK' }));
  expect(screen.getByRole('columnheader', { name: /último ack/i })).toHaveAttribute('aria-sort', 'descending');
  expect(aliases()[0]).toBe('Pablo/midas');
  await user.click(screen.getByRole('button', { name: 'Último ACK' }));
  expect(aliases()).toEqual(['Steven/jarvis', 'Isa/salva', 'Pablo/midas']);
});

it('un ACK nulo se lee como un hueco explícito, nunca como cero o un guion', () => {
  render(<FleetActivityTable snapshot={BASE} onOpen={() => undefined} />);
  const midas = must(document.querySelector<HTMLElement>('tr[data-agent-key="Pablo/midas"]'), 'the midas row');
  expect(within(midas).getByText(/sin ACK/)).toBeInTheDocument();
});

it('apila las señales del agente trabado sin repetir la palabra del estado', () => {
  const estados = new Map([['Pablo/midas', 'down' as const], ['Steven/jarvis', 'thinking' as const], ['Isa/salva', 'idle' as const]]);
  render(<FleetActivityTable snapshot={BASE} estados={estados} onOpen={() => undefined} />);
  const estado = within(must(document.querySelector<HTMLElement>('tr[data-agent-key="Pablo/midas"]'), 'the midas row')).getAllByRole('cell')[1];
  expect(estado).toHaveTextContent('Caído');
  const palabras = within(estado).getAllByText(/.+/).map((nodo) => nodo.textContent);
  expect(new Set(palabras).size).toBe(palabras.length);
});

it('la fila y el nombre abren la ficha del agente, también con el teclado', async () => {
  const user = userEvent.setup();
  const abiertos: string[] = [];
  render(<FleetActivityTable snapshot={BASE} onOpen={(key) => { abiertos.push(key); }} />);

  await user.click(screen.getByRole('row', { name: /jarvis/i }));
  screen.getByRole('button', { name: 'Salva' }).focus();
  await user.keyboard('{Enter}');
  expect(abiertos).toEqual(['Steven/jarvis', 'Isa/salva']);
});

it('respeta el filtro de estado y la búsqueda, y dice por qué queda vacía', async () => {
  const user = userEvent.setup();
  const { rerender } = render(<FleetActivityTable snapshot={BASE} only={new Set(['Isa/salva'])} onOpen={() => undefined} />);
  expect(aliases()).toEqual(['Isa/salva']);

  rerender(<FleetActivityTable snapshot={BASE} only={new Set()} onOpen={() => undefined} />);
  expect(screen.getByText(/ningún agente en ese estado/i)).toBeInTheDocument();

  rerender(<FleetActivityTable snapshot={BASE} onOpen={() => undefined} />);
  await user.type(screen.getByRole('searchbox', { name: /buscar un agente/i }), 'zzz');
  expect(screen.getByText('Ningún alias coincide con «zzz».')).toBeInTheDocument();
});

it('sortAgents no muta la entrada y desempata por urgencia', () => {
  const agents = BASE.agents ?? [];
  const copia = [...agents];
  const porCola = sortAgents(agents, undefined, 'cola', true);
  expect(agents).toEqual(copia);
  expect(porCola.map((agent) => agent.alias)).toEqual(['midas', 'jarvis', 'salva']);
});
