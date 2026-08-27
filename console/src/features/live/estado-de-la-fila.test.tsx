import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import type { FleetActivitySnapshot } from '../../api/types';
import { mockActivity } from '../../mocks/data';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { LIVE_STATE_META, LIVE_STATES } from './agent-state';
import { LiveFleetPage } from './LiveFleetPage';

/**
 * **LA FILA Y EL CHIP, DEL MISMO AGENTE, TIENEN QUE DECIR LO MISMO.**
 *
 *  la
 * columna ESTADO de la tabla emitía sólo dos valores para 18 alias —`TRABAJANDO ×2` e
 * `INACTIVO ×16`— y ese `INACTIVO` se tragaba a los 5 que el veredicto llamaba «caídos» y a los 2
 * que el chip llamaba «Delegando».
 *
 * Renombrar los rótulos NO bastaba, y hacerlo lo empeoraba: con `idle → «Libre»`, el alias `iza`
 * —lease vencido, cero trabajo— pasaba de decir `INACTIVO` a decir **«Libre»** en su fila
 * mientras el chip lo contaba como «Caído». Se midió así, en Chrome, antes de arreglarlo. La
 * razón es de fondo: `work_state` (cinco baldes del servidor sobre el TRABAJO) y `LiveState`
 * (siete, que además miran presencia y delegaciones) son particiones distintas, y ninguna tabla
 * de traducción podía hacerlas coincidir.
 *
 * La única forma de que no se contradigan es que **haya un solo cálculo**: la página deriva el
 * estado una vez y la tabla lo consume. Esta prueba lo comprueba donde se ve — sobre la página
 * montada, fila por fila contra el chip— y no sobre la implementación.
 */

function conActividad(snapshot: FleetActivitySnapshot): void {
  server.use(http.get('http://localhost/v3/console/activity', () => HttpResponse.json(snapshot)));
}

/** Cada fila de datos con su alias y el rótulo de su celda «Estado». */
function filasPintadas(): Array<{ alias: string; estado: string }> {
  return screen.getAllByRole('row')
    .filter((fila) => within(fila).queryAllByRole('cell').length > 3)
    .map((fila) => {
      const celdas = within(fila).getAllByRole('cell');
      return {
        alias: celdas[1].textContent ?? '',
        // La celda lleva el estado y, debajo, los chips de señal. El estado es el primero.
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
     * El caso `iza`, exacto: el servidor manda `work_state: 'idle'` —no tiene trabajo— y el lease
     * venció. Es la fila que decía «LIBRE» debajo de un chip que lo contaba como caído.
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
    // Y el chip cuenta exactamente lo mismo: uno caído, cero libres.
    expect(screen.getByRole('button', { name: /Caído 1/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Libre 0/ })).toBeInTheDocument();
  });

  it('CONTROL POSITIVO — un alias conectado y sin trabajo SÍ dice «Libre»', async () => {
    // Si el arreglo fuera «llamar caído a todo el que no trabaja», este caso se caería: «Libre» es
    // el estado normal de casi toda la flota casi todo el tiempo, y no es una avería.
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
      .map((chip) => chip.textContent?.replace(/\d+$/, '').trim() ?? '');
    const rangos = filasPintadas().map((fila) => ordenDeLaCinta.indexOf(fila.estado));

    expect(rangos).not.toContain(-1);
    expect([...rangos].sort((a, b) => a - b)).toEqual(rangos);
  });
});
