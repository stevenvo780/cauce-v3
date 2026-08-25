/*
 * MODO OBSERVACIÓN: QUÉ SE REPLIEGA Y QUÉ SIGUE ALCANZABLE.
 *
 * ⚠️ **Estas pruebas NO miden alto.** jsdom no tiene maquetación: `getBoundingClientRect()`
 * devuelve ceros y ninguna regla de CSS se aplica, así que una prueba de píxeles escrita acá NO
 * PUEDE PONERSE ROJA dijera lo que dijera la hoja de estilos. La comprobación de que el terminal se
 * queda con el 60 % del alto de la ventana vive en `ops/console-legibilidad/medir-terminal.mjs`,
 * que corre un Chrome de verdad, y ahí es donde da rojo.
 *
 * Lo que SÍ se puede probar acá —y es la mitad que importa cuando se repliega algo— es que la
 * información no se BORRÓ: que los seis contadores y la frase de doctrina siguen escritos y a un
 * clic de distancia, y que el repliegue no se cuela en el camino en el que esos datos son lo que se
 * viene a mirar (la página sin ninguna sesión abierta).
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

/** Los seis contadores, por su rótulo. Si uno deja de estar escrito, esta lista lo dice. */
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
   * CONTROL NEGATIVO del repliegue. Los seis contadores y la doctrina son exactamente lo que se
   * viene a leer ANTES de abrir una terminal: si el desplegable se colara también acá, el arreglo
   * habría escondido el dato justo en el momento en que hace falta. Esta prueba se pone roja si
   * alguien "simplifica" el condicional y pliega siempre.
   */
  it('enseña los seis contadores desplegados, sin nada que abrir', async () => {
    const { container } = renderWithApi(<TerminalPage />);

    await screen.findByRole('button', { name: /abrir sesión con kant/i });
    // Acotado a la tira: «Adaptadores» y «Canal» también se dicen en el inspector de la derecha, y
    // una prueba que los cuente en toda la página mide otra cosa.
    const tira = container.querySelector('.terminal-overview') as HTMLElement | null;
    expect(tira).not.toBeNull();
    for (const rotulo of CONTADORES) expect(within(tira!).getByText(rotulo)).toBeInTheDocument();
    expect(container.querySelector('details.terminal-resumen')).toBeNull();
    /*
     * Y queda anotado por qué replegar el pie de doctrina obliga a escribirla en otro sitio: el pie
     * SÓLO existe cuando hay una sesión abierta —cuelga de la rejilla de sesiones—, o sea que se
     * lee exactamente en el único momento en el que su alto se le está quitando al terminal.
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
    // Y el control dice qué hay dentro: un desplegable sin nombre es un dato perdido.
    expect(within(plegado).getByText(/estado de la flota/i)).toBeInTheDocument();

    await user.click(within(plegado).getByText(/estado de la flota/i));
    expect(plegado.open).toBe(true);
    for (const rotulo of CONTADORES) expect(within(plegado).getByText(rotulo)).toBeInTheDocument();
  });

  /*
   * La frase de doctrina la dice un pie que en modo observación se repliega por CSS. El nodo sigue
   * en el documento (por eso esta prueba no puede mirarlo a él), así que lo que se exige es que la
   * frase esté ADEMÁS dentro del desplegable, escrita desde la misma constante: si el pie deja de
   * verse y la frase no está en ninguna otra parte, la doctrina desapareció de la vista.
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

  /* El título de la página se achica; no se borra. */
  it('conserva el título de la página', async () => {
    const user = userEvent.setup();
    renderWithApi(<TerminalPage />);

    await user.click(await screen.findByRole('button', { name: /abrir sesión con kant/i }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Terminal de agentes' })).toBeInTheDocument();
  });
});
