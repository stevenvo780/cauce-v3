/**
 * **The trap that left Ultimate Terminal dead, with its negative control.**
 *
 *   open the TUI of two aliases → 2 cards, 2 `.pty-host`, 2 `active` rows in `terminal_sessions`
 *   navigate to Home and back    → 0 cards, 2 LIVE `.pty-host`, 2 `active` rows
 *   open a third alias          → 409 `session_limit`
 * and the screen answered "close one of your open sessions" without having a single session
 * to close in view. Fifteen minutes dead, with no error saying so.
 *
 * Each case here was written asking what would have to happen for it to go RED:
 *  · if the unmount cleanup looked at the first render's grants (empty), the DELETE does not
 *    go out;
 *  · if `ocupaPlaza` only looked at `state`, an expired ticket at 17:50 would keep being
 *    offered;
 *  · if the grid went back to painting all stacked panels, there would be two headers, not one.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { server } from '../../mocks/server';
import { mockTerminalGrant } from '../../mocks/terminal-ticket';
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
    request_id: '11111111-1111-4111-8111-111111111111',
    owner_generation: '1',
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

  it('el estado del servidor gana aunque el reloj del navegador esté adelantado', () => {
    const servidorDiceAbierta = fila({
      state: 'issued',
      expires_at: new Date(Date.now() - 6 * 3_600_000).toISOString(),
    });
    expect(ocupaPlaza(servidorDiceAbierta)).toBe(true);
  });

  it('closed es la única prueba de que no ocupa; la fecha no sustituye al veredicto del servidor', () => {
    expect(ocupaPlaza(fila({ state: 'closed', expires_at: '' }))).toBe(false);
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
    http.post('*/v3/console/terminal/sessions/:sid/owner', async ({ params, request }) => {
      const body = await request.json() as Record<string, unknown>;
      return HttpResponse.json({
        session_id: String(params.sid),
        request_id: body.request_id,
        owner_generation: (BigInt(String(body.expected_owner_generation)) + 1n).toString(),
      });
    }),
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
      return HttpResponse.json(mockTerminalGrant({
        sessionId: id,
        tenantId: String(body.tenant_id),
        alias: String(body.alias),
        container: 'ws-zeus',
        runtimeUser: 'dev',
        mode: String(body.mode),
        requestId: String(body.request_id),
      }), { status: 201 });
    }),
    http.delete('*/v3/console/terminal/sessions/:sid', ({ params }) => {
      borrados.push(String(params.sid));
      return new HttpResponse(null, { status: 204 });
    }),
  );
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

type Deferred<T> = ReturnType<typeof deferred<T>>;

describe('la sesión no sobrevive a la vista que la abrió', () => {
  it('al desmontar la vista suelta CONTRA EL SERVIDOR las sesiones que tenía abiertas', async () => {
    const user = userEvent.setup();
    const borrados: string[] = [];
    servirEntorno([target({ tenant_id: 'Steven', alias: 'zeus' })]);
    servirAperturas(() => 'sid-zeus', borrados);
    const vista = renderWithApi(<TerminalPage />);

    await user.selectOptions(await screen.findByRole('combobox', { name: 'Agente' }), await screen.findByRole('option', { name: /^zeus ·/ }));
    await waitFor(() => { expect(StubWebSocket.instances).toHaveLength(1); });
    act(() => { StubWebSocket.last().acceptOpen(); });

    expect(borrados).toEqual([]);
    // Navegar a otra vista de la consola es EXACTAMENTE esto: el workspace se desmonta.
    vista.unmount();
    await waitFor(() => { expect(borrados).toEqual(['sid-zeus']); });
    // And the local socket was cut too: a live node hanging off the `<body>` was half the bug.
    expect(StubWebSocket.last().readyState).toBe(3);
  });

  it('si la vista se desmonta antes del 201 compensa sólo el grant exacto que llega tarde', async () => {
    const user = userEvent.setup();
    const gate = deferred();
    const borrados: string[] = [];
    let posts = 0;
    servirEntorno([target({ tenant_id: 'Steven', alias: 'zeus' })]);
    server.use(
      http.post('*/v3/console/terminal/sessions', async ({ request }) => {
        posts += 1;
        const body = await request.json() as Record<string, unknown>;
        await gate.promise;
        return HttpResponse.json(mockTerminalGrant({
          sessionId: 'sid-late-owned',
          tenantId: String(body.tenant_id),
          alias: String(body.alias),
          container: 'ws-zeus',
          runtimeUser: 'dev',
          mode: String(body.mode),
          requestId: String(body.request_id),
        }), { status: 201 });
      }),
      http.delete('*/v3/console/terminal/sessions/:sid', ({ params }) => {
        borrados.push(String(params.sid));
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const vista = renderWithApi(<TerminalPage />);

    await user.selectOptions(await screen.findByRole('combobox', { name: 'Agente' }), await screen.findByRole('option', { name: /^zeus ·/ }));
    await waitFor(() => { expect(posts).toBe(1); });
    // Auto-open owns the sole attempt. A click while it is pending is visibly fenced and cannot
    // create a second reservation.
    const tui = screen.getByRole('button', { name: /^TUI$/i });
    expect(tui).toBeDisabled();
    fireEvent.click(tui);
    expect(posts).toBe(1);

    vista.unmount();
    gate.resolve(undefined);

    await waitFor(() => { expect(borrados).toEqual(['sid-late-owned']); });
    expect(StubWebSocket.instances).toHaveLength(0);
    expect(posts).toBe(1);
  });

  it('el replay de efectos de StrictMode adopta el mismo intento y no duplica el POST automático', async () => {
    const user = userEvent.setup();
    let posts = 0;
    const borrados: string[] = [];
    servirEntorno([target({ tenant_id: 'Steven', alias: 'zeus' })]);
    server.use(
      http.post('*/v3/console/terminal/sessions', async ({ request }) => {
        posts += 1;
        const body = await request.json() as Record<string, unknown>;
        return HttpResponse.json(mockTerminalGrant({
          sessionId: 'sid-strict-mode',
          tenantId: String(body.tenant_id),
          alias: String(body.alias),
          container: 'ws-zeus',
          runtimeUser: 'dev',
          mode: String(body.mode),
          requestId: String(body.request_id),
        }), { status: 201 });
      }),
      http.delete('*/v3/console/terminal/sessions/:sid', ({ params }) => {
        borrados.push(String(params.sid));
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const vista = renderWithApi(<StrictMode><TerminalPage /></StrictMode>);

    await user.selectOptions(await screen.findByRole('combobox', { name: 'Agente' }), await screen.findByRole('option', { name: /^zeus ·/ }));
    await waitFor(() => { expect(StubWebSocket.instances).toHaveLength(1); });
    expect(posts).toBe(1);

    vista.unmount();
    await waitFor(() => { expect(borrados).toEqual(['sid-strict-mode']); });
  });

  it('cambiar A→B→A compensa respuestas antiguas sin adoptar ni revocar la nueva intención', async () => {
    const user = userEvent.setup();
    const pending: { alias: string; body: Record<string, unknown>; gate: Deferred<void>; sid: string }[] = [];
    const borrados: { sid: string; body: Record<string, unknown> }[] = [];
    servirEntorno([
      target({ tenant_id: 'Steven', alias: 'zeus' }),
      target({ tenant_id: 'Isa', alias: 'salva', container: 'ws-isa' }),
    ]);
    server.use(
      http.post('*/v3/console/terminal/sessions', async ({ request }) => {
        const body = await request.json() as Record<string, unknown>;
        const alias = String(body.alias);
        const item = { alias, body, gate: deferred(), sid: `sid-pending-${String(pending.length)}` };
        pending.push(item); abiertas.push(item.sid);
        await item.gate.promise;
        return HttpResponse.json(mockTerminalGrant({
          sessionId: item.sid, tenantId: String(body.tenant_id), alias,
          container: alias === 'salva' ? 'ws-isa' : 'ws-zeus', runtimeUser: 'dev',
          mode: String(body.mode), requestId: String(body.request_id),
        }), { status: 201 });
      }),
      http.delete('*/v3/console/terminal/sessions/:sid', async ({ params, request }) => {
        borrados.push({ sid: String(params.sid), body: await request.json() as Record<string, unknown> });
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const vista = renderWithApi(<TerminalPage />);
    const select = async (alias: string) => user.selectOptions(await screen.findByRole('combobox', { name: 'Agente' }),
      await screen.findByRole('option', { name: new RegExp(`^${alias} ·`) }));
    await select('zeus'); await waitFor(() => { expect(pending).toHaveLength(1); });
    await select('salva'); await waitFor(() => { expect(pending).toHaveLength(2); });
    await select('zeus'); await waitFor(() => { expect(pending).toHaveLength(3); });
    expect(pending[2].body.request_id).not.toBe(pending[0].body.request_id);
    pending[2].gate.resolve(undefined);
    await waitFor(() => { expect(StubWebSocket.instances).toHaveLength(1); });
    pending[0].gate.resolve(undefined); pending[1].gate.resolve(undefined);
    await waitFor(() => { expect(borrados).toHaveLength(2); });
    expect(new Set(borrados.map(item => item.sid))).toEqual(new Set(['sid-pending-0', 'sid-pending-1']));
    for (const deleted of borrados) {
      const issued = pending.find(item => item.sid === deleted.sid);
      expect(deleted.body.request_id).toBe(issued?.body.request_id);
      expect(deleted.body.owner_token).toBe(issued?.body.owner_token);
    }
    expect(StubWebSocket.instances).toHaveLength(1);
    vista.unmount();
    await waitFor(() => { expect(borrados.map(item => item.sid)).toContain('sid-pending-2'); });
  });

  it('cerrar y reabrir crea otra intención y la respuesta vieja sólo compensa su propio owner', async () => {
    const user = userEvent.setup();
    const pending: {
      gate: Deferred<void>;
      body: Record<string, unknown>;
      sid: string;
    }[] = [];
    const borrados: { sid: string; body: Record<string, unknown> }[] = [];
    servirEntorno([target({ tenant_id: 'Steven', alias: 'zeus' })]);
    server.use(
      http.post('*/v3/console/terminal/sessions', async ({ request }) => {
        const body = await request.json() as Record<string, unknown>;
        const reservation = {
          gate: deferred(),
          body,
          sid: pending.length === 0 ? 'sid-old-incarnation' : 'sid-new-incarnation',
        };
        pending.push(reservation);
        await reservation.gate.promise;
        return HttpResponse.json(mockTerminalGrant({
          sessionId: reservation.sid,
          tenantId: String(body.tenant_id),
          alias: String(body.alias),
          container: 'ws-zeus',
          runtimeUser: 'dev',
          mode: String(body.mode),
          requestId: String(body.request_id),
        }), { status: 201 });
      }),
      http.delete('*/v3/console/terminal/sessions/:sid', async ({ params, request }) => {
        borrados.push({
          sid: String(params.sid),
          body: await request.json() as Record<string, unknown>,
        });
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const vista = renderWithApi(<TerminalPage />);

    await user.selectOptions(await screen.findByRole('combobox', { name: 'Agente' }), await screen.findByRole('option', { name: /^zeus ·/ }));
    await waitFor(() => { expect(pending).toHaveLength(1); });
    await user.click(screen.getByRole('button', { name: /cerrar sesión zeus/i }));
    await waitFor(() => { expect(screen.queryByRole('tab', { name: /zeus/i })).not.toBeInTheDocument(); });

    await user.selectOptions(screen.getByRole('combobox', { name: 'Agente' }), screen.getByRole('option', { name: /^zeus ·/ }));
    await waitFor(() => { expect(pending).toHaveLength(2); });
    expect(pending[1].body.request_id).not.toBe(pending[0].body.request_id);
    expect(pending[1].body.owner_token).not.toBe(pending[0].body.owner_token);

    // The replacement wins first. A later continuation from the closed incarnation must not
    // adopt or revoke it, even though both tabs have the same React/session alias key.
    pending[1].gate.resolve(undefined);
    await waitFor(() => { expect(StubWebSocket.instances).toHaveLength(1); });
    pending[0].gate.resolve(undefined);
    await waitFor(() => { expect(borrados.map((item) => item.sid)).toEqual(['sid-old-incarnation']); });
    expect(borrados[0]?.body).toEqual({
      request_id: pending[0].body.request_id,
      owner_generation: '1',
      owner_token: pending[0].body.owner_token,
    });
    expect(StubWebSocket.instances).toHaveLength(1);
    expect(screen.getByRole('tab', { name: /zeus/i })).toHaveAttribute('aria-selected', 'true');

    vista.unmount();
    await waitFor(() => { expect(borrados.map((item) => item.sid)).toEqual([
      'sid-old-incarnation', 'sid-new-incarnation',
    ]); });
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
            request_id: '11111111-1111-4111-8111-111111111111', owner_generation: '1',
          },
          {
            // The gateway evaluates its clock and projects the expired one as closed: it is NOT offered.
            session_id: 'ticket-muerto', tenant_id: 'Steven', alias: 'socrates', mode: 'shell',
            opened_at: new Date(Date.now() - 7 * 3_600_000).toISOString(),
            expires_at: new Date(Date.now() - 6 * 3_600_000).toISOString(), state: 'closed',
            request_id: '22222222-2222-4222-8222-222222222222', owner_generation: '1',
          },
        ],
      })),
      http.delete('*/v3/console/terminal/sessions/:sid', ({ params }) => {
        borrados.push(String(params.sid));
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderWithApi(<TerminalPage />);

    await user.selectOptions(await screen.findByRole('combobox', { name: 'Agente' }), await screen.findByRole('option', { name: /^zeus ·/ }));

    const tira = await screen.findByLabelText('Sesiones de terminal que siguen ocupando plaza');
    expect(tira).toHaveTextContent('tales');
    expect(tira).toHaveTextContent(/se suelta sola en 8 min/);
    expect(tira).not.toHaveTextContent('socrates');

    await user.click(within(tira).getByRole('button', { name: /cerrar ahora/i }));
    await waitFor(() => { expect(borrados).toEqual(['colgada-tales']); });
    await waitFor(() => { expect(screen.queryByLabelText('Sesiones de terminal que siguen ocupando plaza')).not.toBeInTheDocument(); });
  });

  it.each([
    ['sin items', () => HttpResponse.json({})],
    ['con error del store', () => HttpResponse.json({ error: 'unavailable', message: 'inventario temporalmente inaccesible' }, { status: 503 })],
  ])('no convierte un inventario %s en «cero sesiones» ni afirma que todas estén a la vista', async (_case, sessionsResponse) => {
    const user = userEvent.setup();
    servirEntorno([target({ tenant_id: 'Steven', alias: 'zeus' })]);
    server.use(
      http.post('*/v3/console/terminal/sessions', () => HttpResponse.json({ error: 'conflict', reason: 'session_limit' }, { status: 409 })),
      http.get('*/v3/console/terminal/sessions', sessionsResponse),
    );
    renderWithApi(<TerminalPage />);

    await user.selectOptions(await screen.findByRole('combobox', { name: 'Agente' }), await screen.findByRole('option', { name: /^zeus ·/ }));

    const tira = await screen.findByLabelText('Sesiones de terminal que siguen ocupando plaza');
    expect(tira).toHaveTextContent('No se pudo leer qué sesiones están ocupando el tope');
    expect(tira).toHaveTextContent(/no se infiere que haya cero sesiones/i);
    expect(tira).not.toHaveTextContent(/las 0 que lo gastan están abiertas acá/i);
    expect(within(tira).getByRole('button', { name: /revisar/i })).toBeEnabled();
  });

  it('explica la carrera 409 seguida de inventario exacto vacío sin inventar cero ocupantes', async () => {
    const user = userEvent.setup();
    let lecturas = 0;
    servirEntorno([target({ tenant_id: 'Steven', alias: 'zeus' })]);
    server.use(
      http.post('*/v3/console/terminal/sessions', () => HttpResponse.json({ error: 'conflict', reason: 'session_limit' }, { status: 409 })),
      http.get('*/v3/console/terminal/sessions', () => {
        lecturas += 1;
        return HttpResponse.json({ items: [] });
      }),
    );
    renderWithApi(<TerminalPage />);

    await user.selectOptions(await screen.findByRole('combobox', { name: 'Agente' }), await screen.findByRole('option', { name: /^zeus ·/ }));

    const tira = await screen.findByLabelText('Sesiones de terminal que siguen ocupando plaza');
    expect(tira).toHaveTextContent('El tope se liberó antes de terminar la verificación');
    expect(tira).toHaveTextContent(/GET exacto posterior ya no encontró ninguna sesión/i);
    expect(tira).toHaveTextContent(/podés reintentar la apertura/i);
    expect(tira).not.toHaveTextContent(/las 0 que lo gastan/i);
    expect(lecturas).toBeGreaterThanOrEqual(2);
  });

  it('concilia un grant mal formado por GET visible y no revoca el id no confiable', async () => {
    const user = userEvent.setup();
    const borrados: string[] = [];
    let lecturas = 0;
    servirEntorno([target({ tenant_id: 'Steven', alias: 'zeus' })]);
    server.use(
      http.post('*/v3/console/terminal/sessions', () => HttpResponse.json({
        // The broken receipt states the id of a session that already existed in another tab.
        session_id: 'sesion-de-otra-pestana',
        websocket_path: WS_PATH,
      }, { status: 201 })),
      http.get('*/v3/console/terminal/sessions', () => {
        lecturas += 1;
        return HttpResponse.json({ items: [{
          session_id: 'sesion-de-otra-pestana', tenant_id: 'Steven', alias: 'argos', mode: 'harness',
          opened_at: new Date(Date.now() - 120_000).toISOString(),
          expires_at: new Date(Date.now() + 480_000).toISOString(), state: 'active',
          request_id: '11111111-1111-4111-8111-111111111111', owner_generation: '1',
        }] });
      }),
      http.delete('*/v3/console/terminal/sessions/:sid', ({ params }) => {
        borrados.push(String(params.sid));
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderWithApi(<TerminalPage />);

    await user.selectOptions(await screen.findByRole('combobox', { name: 'Agente' }), await screen.findByRole('option', { name: /^zeus ·/ }));

    const tira = await screen.findByLabelText('Sesiones de terminal que siguen ocupando plaza');
    expect(tira).toHaveTextContent('El grant fue inválido; estas son las reservas visibles');
    expect(tira).toHaveTextContent(/No se usó el session_id del recibo roto para borrar nada/i);
    expect(tira).toHaveTextContent('argos');
    expect(lecturas).toBeGreaterThanOrEqual(2);
    // Neither the POST nor the reconciliation read authority from an invalid receipt to DELETE.
    expect(borrados).toEqual([]);
    await user.click(within(tira).getByRole('button', { name: /cerrar ahora/i }));
    await waitFor(() => { expect(borrados).toEqual(['sesion-de-otra-pestana']); });
  });
});

describe('la geometría de la vista', () => {
  it('cambiar de agente conserva un único escenario y una única sesión visible', async () => {
    const user = userEvent.setup();
    servirEntorno([
      target({ tenant_id: 'Steven', alias: 'zeus' }),
      target({ tenant_id: 'Isa', alias: 'salva', container: 'ws-isa' }),
    ]);
    servirAperturas((alias) => `sid-${alias}`, []);
    renderWithApi(<TerminalPage />);

    await user.selectOptions(await screen.findByRole('combobox', { name: 'Agente' }), await screen.findByRole('option', { name: /^zeus ·/ }));
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Agente' }), await screen.findByRole('option', { name: /^salva ·/ }));

    await waitFor(() => { expect(screen.getAllByRole('tab')).toHaveLength(1); });
    /*
     * THIS is the assertion that previously returned 2 and made the page measure 3,537 px: a
     * 600 px panel per session, stacked, and the terminal off-screen. Now only the active stage
     * is mounted; the other stays alive outside React, with its socket and its scrollback.
     */
    expect(document.querySelectorAll('.terminal-session-head')).toHaveLength(1);
    expect(screen.getByRole('tab', { selected: true })).toHaveTextContent('salva');

    // And the page declares it is in observation mode, which is what folds the counters.
    expect(document.querySelector('.ultimate-terminal-page')).toHaveAttribute('data-tui', 'abierta');
  }, 20_000);
});

describe('el selector libera plaza antes de cambiar', () => {
  it('recorre tres agentes con un tope de una sesión sin recibir session_limit', async () => {
    const user = userEvent.setup();
    const vivas = new Set<string>();
    const borrados: string[] = [];
    let refusals = 0;
    servirEntorno([
      target({ tenant_id: 'Steven', alias: 'zeus' }),
      target({ tenant_id: 'Isa', alias: 'salva', container: 'ws-isa' }),
      target({ tenant_id: 'Steven', alias: 'kant', container: 'ws-server2' }),
    ]);
    server.use(
      http.post('*/v3/console/terminal/sessions', async ({ request }) => {
        const body = await request.json() as Record<string, unknown>;
        if (vivas.size) {
          refusals += 1;
          return HttpResponse.json({ reason: 'session_limit' }, { status: 409 });
        }
        const id = `sid-${String(body.alias)}`;
        vivas.add(id); abiertas.push(id);
        return HttpResponse.json(mockTerminalGrant({ sessionId: id, tenantId: String(body.tenant_id),
          alias: String(body.alias), container: 'c', runtimeUser: 'dev',
          mode: String(body.mode), requestId: String(body.request_id) }), { status: 201 });
      }),
      http.delete('*/v3/console/terminal/sessions/:sid', ({ params }) => {
        const id = String(params.sid); vivas.delete(id); borrados.push(id);
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderWithApi(<TerminalPage />);
    for (const alias of ['zeus', 'salva', 'kant']) {
      await user.selectOptions(await screen.findByRole('combobox', { name: 'Agente' }),
        await screen.findByRole('option', { name: new RegExp(`^${alias} ·`) }));
      await waitFor(() => { expect([...vivas]).toEqual([`sid-${alias}`]); });
    }
    expect(refusals).toBe(0);
    expect(borrados).toEqual(['sid-zeus', 'sid-salva']);
    expect(screen.queryByLabelText('Sesiones de terminal que siguen ocupando plaza')).not.toBeInTheDocument();
  });
});
