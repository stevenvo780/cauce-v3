/*
 * OBSERVATION MODE: WHAT FOLDS AWAY AND WHAT STAYS REACHABLE.
 *
 * ⚠️ **These tests do NOT measure height.** jsdom has no layout: `getBoundingClientRect()`
 * returns zeros and no CSS rule is applied, so a pixel test written here CANNOT go red no
 * matter what the stylesheet says. The check that the terminal stays with 60% of the
 * viewport height lives in `ops/console-legibilidad/medir-terminal.mjs`, which runs a real
 * Chrome, and that is where it goes red.
 *
 * What CAN be tested here — and is the half that matters when something folds away — is
 * that the information was not DELETED: that the six counters and the doctrine sentence are
 * still written and a click away, and that the fold does not sneak into the path where those
 * data are what you come to look at (the page with no session open).
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { TEXTO_DOCTRINA } from './doctrina';
import { installStubWebSocket } from './pty-socket-stub';
import { TerminalPage } from './TerminalPage';

/** The six counters, by their label. If one stops being written, this list tells it. */
const CONTADORES = ['Leases vigentes', 'Adaptadores', 'Tu permiso', 'Canal', 'Con PTY online', 'Emiten su TUI'];

let restoreSocket: () => void;

beforeEach(() => {
  server.use(http.get('*/v3/console/terminal/targets', () => HttpResponse.json({
    observed_at: new Date().toISOString(), websocket_path: '/v3/console/terminal/ws',
  })));
  restoreSocket = installStubWebSocket();
});

afterEach(() => {
  restoreSocket();
});

describe('la página del terminal, sin ninguna sesión abierta', () => {
  /*
   * NEGATIVE CONTROL of the fold. The six counters and the doctrine are exactly what is
   * read BEFORE opening a terminal: if the fold snuck in here too, the fix would have hidden
   * the data right when it is needed. This test goes red if someone "simplifies" the conditional
   * and always folds.
   */
  it('enseña los seis contadores desplegados, sin nada que abrir', async () => {
    const { container } = renderWithApi(<TerminalPage />);

    await screen.findByRole('button', { name: /abrir sesión con kant/i });
    // Scoped to the strip: "Adaptadores" and "Canal" are also said in the right inspector,
    // and a test that counts them across the whole page measures something else.
    const tira = container.querySelector('.terminal-overview');
    expect(tira).not.toBeNull();
    if (!(tira instanceof HTMLElement)) throw new Error('tira not found');
    for (const rotulo of CONTADORES) expect(within(tira).getByText(rotulo)).toBeInTheDocument();
    expect(container.querySelector('details.terminal-resumen')).toBeNull();
    /*
     * And it is noted why folding the doctrine footer forces writing it somewhere else: the
     * footer ONLY exists when there is an open session — it hangs off the sessions grid —
     * i.e. it is read exactly at the moment its height is being taken away from the terminal.
     */
    expect(container.querySelector('.terminal-doctrine')).toBeNull();
  });
});

describe('la página del terminal con una sesión abierta', () => {
  it('repliega los seis contadores tras un control que los devuelve de un clic', async () => {
    const user = userEvent.setup();
    const { container } = renderWithApi(<TerminalPage />);

    await user.click(await screen.findByRole('button', { name: /abrir sesión con kant/i }));

    const plegado = await waitFor(() => {
      const nodo = container.querySelector('details.terminal-resumen');
      if (!nodo) throw new Error('los contadores no se replegaron en ningún desplegable');
      return nodo as HTMLDetailsElement;
    });
    // Empieza cerrado: mientras se mira una TUI, ese alto es del terminal.
    expect(plegado.open).toBe(false);
    // And the control says what is inside: a nameless fold is a lost datum.
    expect(within(plegado).getByText(/estado de la flota/i)).toBeInTheDocument();

    await user.click(within(plegado).getByText(/estado de la flota/i));
    expect(plegado.open).toBe(true);
    for (const rotulo of CONTADORES) expect(within(plegado).getByText(rotulo)).toBeInTheDocument();
  });

  /*
   * The doctrine sentence is said by a footer that in observation mode folds away via CSS. The
   * node stays in the document (that is why this test cannot look at it), so what is required
   * is that the sentence is ALSO inside the fold, written from the same constant: if the footer
   * stops being seen and the sentence is nowhere else, the doctrine disappeared from view.
   */
  it('deja la doctrina escrita dentro del desplegable, no sólo en el pie que se repliega', async () => {
    const user = userEvent.setup();
    const { container } = renderWithApi(<TerminalPage />);

    await user.click(await screen.findByRole('button', { name: /abrir sesión con kant/i }));

    const plegado = await waitFor(() => {
      const nodo = container.querySelector('details.terminal-resumen');
      if (!nodo) throw new Error('los contadores no se replegaron en ningún desplegable');
      return nodo as HTMLElement;
    });
    expect(within(plegado).getByText(TEXTO_DOCTRINA)).toBeInTheDocument();
  });

  it('conserva el título de la página', async () => {
    const user = userEvent.setup();
    renderWithApi(<TerminalPage />);

    await user.click(await screen.findByRole('button', { name: /abrir sesión con kant/i }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Terminal de agentes' })).toBeInTheDocument();
  });
});
