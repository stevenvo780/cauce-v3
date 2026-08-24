/**
 * **La trampa que dejaba muerta Ultimate Terminal, con su control negativo.**
 *
 * Medido contra producción el 2026-08-23 (navegador real, auditoría del propio gateway):
 *   abrir la TUI de dos alias  → 2 tarjetas, 2 `.pty-host`, 2 filas `active` en `terminal_sessions`
 *   navegar a Portada y volver → 0 tarjetas, 2 `.pty-host` VIVOS, 2 filas `active`
 *   abrir un tercer alias      → 409 `session_limit`
 * y la pantalla contestaba «cerrá alguna de las sesiones que tenés abiertas» sin tener a la vista
 * una sola sesión que cerrar. Quince minutos muerta, sin un error que lo dijera.
 *
 * Cada caso de acá se escribió preguntándose qué tendría que pasar para que diera ROJO:
 *  · si la limpieza al desmontar mirase los grants del primer render (vacíos), el DELETE no sale;
 *  · si `ocupaPlaza` sólo mirase `state`, un ticket vencido a las 17:50 se seguiría ofreciendo;
 *  · si la rejilla volviera a pintar todos los paneles apilados, habría dos cabeceras, no una.
 */
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import type { TerminalSessionListItem, TerminalTarget } from './api';
import { minutosParaLiberar, ocupaPlaza, plazasColgadas, plazasOcupadas } from './plazas';
import { closePtySession } from './pty-session';
import { installStubWebSocket, StubWebSocket } from './pty-socket-stub';
import { TerminalPage } from './TerminalPage';

const WS_PATH = '/v3/console/terminal/ws';

function fila(overrides: Partial<TerminalSessionListItem> = {}): TerminalSessionListItem {
  return {
    session_id: 'sid-1',
    tenant_id: 'Isa',
    alias: 'salva',
    mode: 'harness',
    opened_at: new Date(Date.now() - 60_000).toISOString(),
    expires_at: new Date(Date.now() + 600_000).toISOString(),
    state: 'active',
    ...overrides,
  };
}

describe('qué sesiones están gastando plaza', () => {
  it('una sesión consumida y todavía dentro de su ventana ocupa plaza', () => {
    expect(ocupaPlaza(fila())).toBe(true);
  });

  it('una cerrada no ocupa nada', () => {
    expect(ocupaPlaza(fila({ state: 'closed' }))).toBe(false);
  });

  /*
   * EL CONTROL NEGATIVO DEL RELOJ. Producción tenía, ahora mismo, dos filas `issued` de zeus con
   * `expires_at` a las 17:50 de HOY —seis horas pasadas— porque el listado del gateway calcula
   * `state` sin mirar el vencimiento. El `openPredicate` del propio gateway SÍ lo mira, así que
   * esas filas no ocupan nada. Sin esta comprobación la consola le pediría al operador que cierre
   * sesiones que no le están quitando ninguna plaza: ruido puro justo en el momento de más apuro.
   */
  it('un ticket que ya venció NO ocupa plaza, aunque el servidor lo siga listando como abierto', () => {
    const vencido = fila({ state: 'issued', expires_at: new Date(Date.now() - 6 * 3_600_000).toISOString() });
    expect(vencido.state).not.toBe('closed');
    expect(ocupaPlaza(vencido)).toBe(false);
  });

  it('sin fecha de vencimiento legible no se asume que ocupa: no se inventa una plaza', () => {
    expect(ocupaPlaza(fila({ expires_at: '' }))).toBe(false);
  });

  it('las colgadas son las que ocupan plaza y esta pestaña NO gobierna', () => {
    const mias = fila({ session_id: 'mia', alias: 'zeus' });
    const colgada = fila({ session_id: 'huerfana', alias: 'tales' });
    expect(plazasOcupadas([mias, colgada])).toHaveLength(2);
    const fuera = plazasColgadas([mias, colgada], ['mia']);
    expect(fuera.map((item) => item.alias)).toEqual(['tales']);
  });

  it('dice cuántos minutos le faltan para soltarse sola, redondeando hacia arriba', () => {
    const item = fila({ expires_at: new Date(Date.now() + 61_000).toISOString() });
    expect(minutosParaLiberar(item)).toBe(2);
  });
});

/* ============================================================================================= */

function target(overrides: Partial<TerminalTarget> & Pick<TerminalTarget, 'tenant_id' | 'alias'>): TerminalTarget {
  return {
    container: 'ws-zeus', runtime_user: 'dev', harness: 'claude-code', shares_container_with: [],
    modes: ['shell', 'harness'], pty_state: 'online', last_seen: null, authorized: true,
    reason: 'Autorizado por el servidor.',
    ...overrides,
  };
}

function servirEntorno(items: TerminalTarget[]) {
  server.use(
    http.get('*/v3/console/terminal/capability', () => HttpResponse.json({
      available: true,
      plugin_id: 'ultimate-terminal.client',
      capabilities: ['terminal.pty.client'],
      websocket_path: WS_PATH,
      target_label: 'Cauce fleet PTY',
    })),
    http.get('*/v3/console/terminal/targets', () => HttpResponse.json({
      observed_at: new Date().toISOString(), websocket_path: WS_PATH, items,
    })),
  );
}

let restoreSocket: () => void;
const abiertas: string[] = [];

beforeEach(() => { restoreSocket = installStubWebSocket(); abiertas.length = 0; });
afterEach(() => {
  for (const id of abiertas) closePtySession(id);
  restoreSocket();
});

function servirAperturas(sid: (alias: string) => string, borrados: string[]) {
  server.use(
    http.post('*/v3/console/terminal/sessions', async ({ request }) => {
      const body = await request.json() as Record<string, unknown>;
      const id = sid(String(body.alias));
      abiertas.push(id);
      return HttpResponse.json({
        session_id: id,
        ticket: 'one-shot-ticket',
        websocket_path: WS_PATH,
        expires_at: new Date(Date.now() + 900_000).toISOString(),
        ttl_seconds: 30,
        target: { tenant_id: String(body.tenant_id), alias: String(body.alias), container: 'ws-zeus', runtime_user: 'dev', mode: String(body.mode), shares_container_with: [] },
      }, { status: 201 });
    }),
    http.delete('*/v3/console/terminal/sessions/:sid', ({ params }) => {
      borrados.push(String(params.sid));
      return new HttpResponse(null, { status: 204 });
    }),
  );
}

describe('la sesión no sobrevive a la vista que la abrió', () => {
  it('al desmontar la vista suelta CONTRA EL SERVIDOR las sesiones que tenía abiertas', async () => {
    const user = userEvent.setup();
    const borrados: string[] = [];
    servirEntorno([target({ tenant_id: 'Steven', alias: 'zeus' })]);
    servirAperturas(() => 'sid-zeus', borrados);
    const vista = renderWithApi(<TerminalPage />);

    await user.click(await screen.findByRole('button', { name: /abrir sesión con zeus/i }));
    await waitFor(() => expect(StubWebSocket.instances).toHaveLength(1));
    act(() => StubWebSocket.last().acceptOpen());

    expect(borrados).toEqual([]);
    // Navegar a otra vista de la consola es EXACTAMENTE esto: el workspace se desmonta.
    vista.unmount();
    await waitFor(() => expect(borrados).toEqual(['sid-zeus']));
    // Y el socket local también se cortó: un nodo vivo colgando del `<body>` era la mitad del bug.
    expect(StubWebSocket.last().readyState).toBe(3);
  });
});

describe('la salida de la trampa cuando el tope ya está gastado', () => {
  it('un 409 session_limit nombra las sesiones colgadas y las cierra de un clic', async () => {
    const user = userEvent.setup();
    const borrados: string[] = [];
    servirEntorno([target({ tenant_id: 'Steven', alias: 'zeus' })]);
    server.use(
      http.post('*/v3/console/terminal/sessions', () => HttpResponse.json({ error: 'conflict', reason: 'session_limit' }, { status: 409 })),
      http.get('*/v3/console/terminal/sessions', () => HttpResponse.json({
        items: [
          {
            session_id: 'colgada-tales', tenant_id: 'Jhon', alias: 'tales', mode: 'harness',
            opened_at: new Date(Date.now() - 120_000).toISOString(),
            expires_at: new Date(Date.now() + 480_000).toISOString(), state: 'active',
          },
          {
            // Control negativo en el mismo fixture: vencida hace horas, NO se puede ofrecer.
            session_id: 'ticket-muerto', tenant_id: 'Steven', alias: 'socrates', mode: 'shell',
            opened_at: new Date(Date.now() - 7 * 3_600_000).toISOString(),
            expires_at: new Date(Date.now() - 6 * 3_600_000).toISOString(), state: 'issued',
          },
        ],
      })),
      http.delete('*/v3/console/terminal/sessions/:sid', ({ params }) => {
        borrados.push(String(params.sid));
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderWithApi(<TerminalPage />);

    await user.click(await screen.findByRole('button', { name: /abrir sesión con zeus/i }));

    const tira = await screen.findByLabelText('Sesiones de terminal que siguen ocupando plaza');
    expect(tira).toHaveTextContent('tales');
    expect(tira).toHaveTextContent(/se suelta sola en 8 min/);
    expect(tira).not.toHaveTextContent('socrates');

    await user.click(within(tira).getByRole('button', { name: /cerrar ahora/i }));
    await waitFor(() => expect(borrados).toEqual(['colgada-tales']));
    await waitFor(() => expect(screen.queryByLabelText('Sesiones de terminal que siguen ocupando plaza')).not.toBeInTheDocument());
  });
});

describe('la geometría de la vista', () => {
  it('con dos sesiones abiertas hay DOS pestañas y UN solo escenario', async () => {
    const user = userEvent.setup();
    servirEntorno([
      target({ tenant_id: 'Steven', alias: 'zeus' }),
      target({ tenant_id: 'Isa', alias: 'salva', container: 'ws-isa' }),
    ]);
    servirAperturas((alias) => `sid-${alias}`, []);
    renderWithApi(<TerminalPage />);

    await user.click(await screen.findByRole('button', { name: /abrir sesión con zeus/i }));
    await user.click(await screen.findByRole('button', { name: /abrir sesión con salva/i }));

    await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(2));
    /*
     * ESTA es la aserción que antes daba 2 y por la que la página medía 3.537 px: un panel de
     * 600 px por sesión, apilados, y el terminal fuera de pantalla. Ahora sólo se monta el
     * escenario activo; el otro sigue vivo fuera de React, con su socket y su scrollback.
     */
    expect(document.querySelectorAll('.terminal-session-head')).toHaveLength(1);
    expect(screen.getByRole('tab', { selected: true })).toHaveTextContent('salva');

    // Y la página declara que está en modo observación, que es lo que repliega los contadores.
    expect(document.querySelector('.ultimate-terminal-page')).toHaveAttribute('data-tui', 'abierta');
  });
});

describe('el tope gastado con todo a la vista', () => {
  /*
   * El otro lado del mismo 409, y hace falta probarlo aparte: cuando NO hay ninguna colgada, las
   * que gastan el tope son las pestañas de arriba. Repetir ahí «cerrá alguna de las sesiones que
   * tenés abiertas» no ayuda a nadie —ya están abiertas y a la vista—; lo que hay que decir es que
   * la salida es cerrar una pestaña. Sin este caso, la rama entera del texto nuevo no la mira
   * nadie y podría decir cualquier cosa.
   */
  it('cuando las que gastan el tope están a la vista, lo dice y no ofrece cerrar nada de fuera', async () => {
    const user = userEvent.setup();
    let permitir = 2;
    servirEntorno([
      target({ tenant_id: 'Steven', alias: 'zeus' }),
      target({ tenant_id: 'Isa', alias: 'salva', container: 'ws-isa' }),
      target({ tenant_id: 'Jhon', alias: 'hegel', container: 'ws-jhon' }),
    ]);
    const vivas: string[] = [];
    server.use(
      http.post('*/v3/console/terminal/sessions', async ({ request }) => {
        const body = await request.json() as Record<string, unknown>;
        if (permitir <= 0) return HttpResponse.json({ error: 'conflict', reason: 'session_limit' }, { status: 409 });
        permitir -= 1;
        const id = `sid-${String(body.alias)}`;
        vivas.push(id);
        abiertas.push(id);
        return HttpResponse.json({
          session_id: id, ticket: 'one-shot-ticket', websocket_path: WS_PATH,
          expires_at: new Date(Date.now() + 900_000).toISOString(), ttl_seconds: 30,
          target: { tenant_id: String(body.tenant_id), alias: String(body.alias), container: 'c', runtime_user: 'dev', mode: String(body.mode), shares_container_with: [] },
        }, { status: 201 });
      }),
      http.get('*/v3/console/terminal/sessions', () => HttpResponse.json({
        items: vivas.map((id) => ({
          session_id: id, tenant_id: 'x', alias: id.slice(4), mode: 'harness',
          opened_at: new Date(Date.now() - 30_000).toISOString(),
          expires_at: new Date(Date.now() + 600_000).toISOString(), state: 'active',
        })),
      })),
      http.delete('*/v3/console/terminal/sessions/:sid', () => new HttpResponse(null, { status: 204 })),
    );
    renderWithApi(<TerminalPage />);

    await user.click(await screen.findByRole('button', { name: /abrir sesión con zeus/i }));
    await user.click(await screen.findByRole('button', { name: /abrir sesión con salva/i }));
    await user.click(await screen.findByRole('button', { name: /abrir sesión con hegel/i }));

    const tira = await screen.findByLabelText('Sesiones de terminal que siguen ocupando plaza');
    expect(tira).toHaveTextContent('Tope de sesiones alcanzado: las 2 que lo gastan están abiertas acá');
    // Ni una sola fila con «Cerrar ahora»: no hay nada de fuera que cerrar, y ofrecerlo sería mentir.
    expect(within(tira).queryByRole('button', { name: /cerrar ahora/i })).not.toBeInTheDocument();
  });
});
