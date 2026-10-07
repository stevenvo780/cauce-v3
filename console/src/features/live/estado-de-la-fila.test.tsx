import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import type { FleetActivityAgent, FleetActivitySnapshot } from '../../api/types';
import { mockActivity } from '../../mocks/data';
import { server } from '../../mocks/server';
import { LIVE_STATE_META, LIVE_STATES } from './agent-state';
import { renderLive } from './render-live';

/**
 * **THE OFFICE AND THE CHIP, FOR THE SAME AGENT, MUST SAY THE SAME THING.**
 *
 * `work_state` (five server buckets about WORK) and `LiveState` (seven, which also look at
 * presence and delegations) are different partitions. The page derives the state once and every
 * reading of it — the office's agent list, the chips and the attention list — consumes it.
 */

function conActividad(snapshot: FleetActivitySnapshot): void {
  server.use(http.get('http://localhost/v3/console/activity', () => HttpResponse.json(snapshot)));
}

async function opciones(): Promise<{ alias: string; estado: string }[]> {
  const lista = await screen.findByRole('listbox', { name: /oficina con \d+ agentes/i });
  return within(lista).getAllByRole('option').map((opcion) => {
    const [alias, resto] = opcion.textContent.split(': ');
    return { alias, estado: resto.split('.')[0] };
  });
}

const solo = (alias: string, online: boolean, flags: FleetActivityAgent['flags']): FleetActivitySnapshot => ({
  observed_at: new Date().toISOString(),
  thresholds: { saturation_in_flight: 8, stall_after_seconds: 300 },
  agents: [{
    tenant_id: 'Miguel', alias, display_name: alias, harness_id: 'openclaw',
    registered: true, agent_enabled: true,
    presence: { online, epoch: 12, lease_until: online ? '2027-01-01T00:00:00.000Z' : '2026-08-23T09:00:00.000Z' },
    work_state: 'idle', flags,
    in_flight: 0, started: 0, claimed_not_started: 0, queued: 0, in_flight_items: [],
  }],
});

describe('el estado de cada agente en /live', () => {
  it('la oficina sólo emite palabras del vocabulario de los chips', async () => {
    conActividad(mockActivity());
    renderLive();

    const permitidas = new Set(LIVE_STATES.map((estado) => LIVE_STATE_META[estado].label));
    expect((await opciones()).map((opcion) => opcion.estado).filter((etiqueta) => !permitidas.has(etiqueta))).toEqual([]);
  });

  it('un alias con el lease vencido dice «Caído» en la oficina y en la lista de atención, no «Libre»', async () => {
    conActividad(solo('iza', false, ['lease_expired']));
    renderLive();

    expect(await opciones()).toEqual([{ alias: 'iza', estado: LIVE_STATE_META.down.label }]);
    expect(screen.getByRole('button', { name: /Caído 1/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Libre/ })).not.toBeInTheDocument();
    const atencion = screen.getByRole('region', { name: 'Necesitan atención' });
    expect(within(atencion).getByRole('button', { name: /iza/ })).toHaveAttribute('data-state', 'down');
  });

  it('CONTROL POSITIVO — un alias conectado y sin trabajo SÍ dice «Libre» y no pide atención', async () => {
    conActividad(solo('salva', true, []));
    renderLive();

    expect(await opciones()).toEqual([{ alias: 'salva', estado: LIVE_STATE_META.idle.label }]);
    expect(screen.getByRole('button', { name: /Libre 1/ })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Necesitan atención' })).not.toBeInTheDocument();
  });
});
