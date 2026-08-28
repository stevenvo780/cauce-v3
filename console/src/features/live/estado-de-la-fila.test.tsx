import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import type { FleetActivitySnapshot } from '../../api/types';
import { mockActivity } from '../../mocks/data';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { LIVE_STATE_META, LIVE_STATES } from './agent-state';
import { LiveFleetPage } from './LiveFleetPage';

/**
 * **THE ROW AND THE CHIP, FOR THE SAME AGENT, MUST SAY THE SAME THING.**
 *
 * The STATUS column of the table only emitted two values for 18 aliases — only two labels
 * in English-typed text — and the second one swallowed the 5 the verdict called "caidos" and
 * the 2 the chip called "Delegando" in chip text.
 *
 * Renaming the labels did NOT suffice, and doing it made it worse: with `idle → "Libre"`, the
 * agent `iza` — expired lease, zero work — went from `INACTIVO` to **"Libre"** in its row while
 * the chip counted it as down. It was measured that way, in Chrome, before fixing it. The
 * reason is fundamental: `work_state` (five server buckets about WORK) and `LiveState` (seven,
 * which also look at presence and delegations) are different partitions, and no translation
 * table could make them match.
 *
 * The only way they cannot contradict each other is **a single calculation**: the page derives
 * the state once and the table consumes it. This test checks it where it is seen — on the
 * mounted page, row by row against the chip — and not on the implementation.
 */

function conActividad(snapshot: FleetActivitySnapshot): void {
  server.use(http.get('http://localhost/v3/console/activity', () => HttpResponse.json(snapshot)));
}

/** Each data row with its alias and the label of its "Status" cell. */
function filasPintadas(): { alias: string; estado: string }[] {
  return screen.getAllByRole('row')
    .filter((fila) => within(fila).queryAllByRole('cell').length > 3)
    .map((fila) => {
      const celdas = within(fila).getAllByRole('cell');
      return {
        alias: celdas[1].textContent,
        // The cell contains the state and, below, the signal chips. The state is the first.
        estado: within(celdas[2]).getAllByText(/.+/)[0]?.textContent ?? '',
      };
    });
}

describe('la columna «Estado» de la tabla de /live', () => {
  it('sólo emite palabras del vocabulario de los chips, nunca un juego propio', async () => {
    conActividad(mockActivity());
    renderWithApi(<LiveFleetPage />);
    await screen.findByLabelText('Veredicto de la flota');

    const permitidas = new Set(LIVE_STATES.map((estado) => LIVE_STATE_META[estado].label));
    const ajenas = filasPintadas()
      .map((fila) => fila.estado)
      .filter((etiqueta) => !permitidas.has(etiqueta));
    expect(ajenas).toEqual([]);
  });

  it('un alias con el lease vencido dice «Caído» en su fila, no «Libre»', async () => {
    /*
     * The exact case: the server sends `work_state: 'idle'` — no work — and the lease
     * expired. The row said "LIBRE" below a chip that counted it as down.
     */
    conActividad({
      observed_at: new Date().toISOString(),
      thresholds: { saturation_in_flight: 8, stall_after_seconds: 300 },
      agents: [{
        tenant_id: 'Miguel', alias: 'iza', display_name: 'Iza', harness_id: 'openclaw',
        registered: true, agent_enabled: true,
        presence: { online: false, epoch: 12, lease_until: '2026-08-23T09:00:00.000Z' },
        work_state: 'idle', flags: ['lease_expired'],
        in_flight: 0, started: 0, claimed_not_started: 0, queued: 0, in_flight_items: [],
      }],
    });
    renderWithApi(<LiveFleetPage />);
    await screen.findByLabelText('Veredicto de la flota');

    const fila = await screen.findByRole('row', { name: /iza/i });
    const estado = within(fila).getAllByRole('cell')[2];
    expect(estado).toHaveTextContent(LIVE_STATE_META.down.label);
    expect(estado).not.toHaveTextContent(LIVE_STATE_META.idle.label);
    // And the chip counts exactly the same: one down, zero libre.
    expect(screen.getByRole('button', { name: /Caído 1/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Libre 0/ })).toBeInTheDocument();
  });

  it('CONTROL POSITIVO — un alias conectado y sin trabajo SÍ dice «Libre»', async () => {
    // If the fix were "call down anyone who is not working", this case would fall: "Libre" is
    // the normal state of almost the entire fleet almost all of the time, and it is not a
    // fault.
    conActividad({
      observed_at: new Date().toISOString(),
      thresholds: { saturation_in_flight: 8, stall_after_seconds: 300 },
      agents: [{
        tenant_id: 'Isa', alias: 'salva', display_name: 'Salva', harness_id: 'claude-code',
        registered: true, agent_enabled: true,
        presence: { online: true, epoch: 63, lease_until: '2027-01-01T00:00:00.000Z' },
        work_state: 'idle', flags: [],
        in_flight: 0, started: 0, claimed_not_started: 0, queued: 0, in_flight_items: [],
      }],
    });
    renderWithApi(<LiveFleetPage />);
    await screen.findByLabelText('Veredicto de la flota');

    const fila = await screen.findByRole('row', { name: /salva/i });
    expect(within(fila).getAllByRole('cell')[2]).toHaveTextContent(LIVE_STATE_META.idle.label);
    expect(screen.getByRole('button', { name: /Libre 1/ })).toBeInTheDocument();
  });

  it('la tabla se ordena en el MISMO orden que la cinta de chips, no en otro', async () => {
    conActividad(mockActivity());
    renderWithApi(<LiveFleetPage />);
    await screen.findByLabelText('Veredicto de la flota');

    const ordenDeLaCinta = [...document.querySelectorAll('.live-tally-chip:not(.is-unreported)')]
      .map((chip) => chip.textContent.replace(/\d+$/, '').trim());
    const rangos = filasPintadas().map((fila) => ordenDeLaCinta.indexOf(fila.estado));

    expect(rangos).not.toContain(-1);
    expect([...rangos].sort((a, b) => a - b)).toEqual(rangos);
  });
});
