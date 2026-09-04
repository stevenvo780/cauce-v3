/**
 * TAKING AND GIVING BACK THE KEYBOARD OF A WRITABLE TUI.
 *
 * The four rules this suite exists to protect are the feature, not decoration:
 *
 *  1. the reason is TYPED BY A HUMAN — no default, no generated phrase. `liveTuiReason` is the
 *     sentence the console writes on its own for a read-only observation and it must never reach
 *     a write, so the take is checked against the literal text the operator typed;
 *  2. the button exists only when the GATEWAY says the action is possible: `writable_modes` of
 *     `/targets`, never the mode list. The negative control publishes `harness_rw` among the
 *     modes with an empty `writable_modes` and requires the button to be absent;
 *  3. while the control is held the screen says, in Spanish, that the bus is not delivering to
 *     that alias and that the messages are queueing;
 *  4. giving it back is always reachable and is also fired when the panel goes away: a hold that
 *     outlives the tab is what mutes an alias.
 *
 * The mirror of case 4 of `live-tui.test.tsx` lives here too: there, `harness` sends ZERO input
 * frames; here, while the control is held, the keystrokes DO reach the socket. Neither assertion
 * proves anything without the other.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StrictMode } from 'react';
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { server } from '../../mocks/server';
import { mockTerminalGrant } from '../../mocks/terminal-ticket';
import { renderWithApi } from '../../test/render';
import type { TerminalTarget } from './api';
import { CAMPOS_DE_CONTROL, CAMPOS_DE_PRORROGA } from './api-control';
import { TERMINAL_DENY_MESSAGES } from './denegaciones';
import { LIVE_TUI_MODE, SHELL_MODE, WRITABLE_TUI_MODE, terminalEsSoloLectura } from './fleet';
import { closePtySession, ptySessionType } from './pty-session';
import { installStubWebSocket, StubWebSocket } from './pty-socket-stub';
import { PTY_REASON_MAX_LENGTH, PTY_REASON_MIN_LENGTH, liveTuiReason } from './session';
import { TerminalPage } from './TerminalPage';

const TENANT = 'Steven';
const ALIAS = 'zeus';
const WS_PATH = '/v3/console/terminal/ws';
const SESION_HARNESS = 'pty-harness-1';
const SESION_ESCRIBIBLE = 'pty-rw-1';
const MOTIVO = 'destrabo a mano la aprobacion colgada de zeus';

interface SesionPedida { mode: string; reason: string }
interface ControlPedido { sid: string; body: Record<string, unknown> }

function destino(overrides: Partial<TerminalTarget> = {}): TerminalTarget {
  return {
    tenant_id: TENANT,
    alias: ALIAS,
    container: 'ws-zeus',
    runtime_user: 'dev',
    harness: 'claude-code',
    shares_container_with: [],
    modes: [SHELL_MODE, LIVE_TUI_MODE, WRITABLE_TUI_MODE],
    writable_modes: [WRITABLE_TUI_MODE],
    pty_state: 'online',
    last_seen: null,
    authorized: true,
    reason: 'Autorizado por el servidor.',
    ...overrides,
  };
}

function servirDestinos(items: TerminalTarget[]) {
  server.use(http.get('*/v3/console/terminal/targets', () => HttpResponse.json({
    observed_at: new Date().toISOString(), websocket_path: WS_PATH, items,
  })));
}

function habilitarCapacidad() {
  server.use(http.get('*/v3/console/terminal/capability', () => HttpResponse.json({
    available: true,
    plugin_id: 'ultimate-terminal.client',
    capabilities: ['terminal.pty.client'],
    websocket_path: WS_PATH,
    target_label: 'Cauce fleet PTY',
  })));
}

function servirSesiones(registro: SesionPedida[]) {
  server.use(
    http.post('*/v3/console/terminal/sessions', async ({ request }) => {
      const body = await request.json() as Record<string, unknown>;
      const mode = String(body.mode);
      registro.push({ mode, reason: String(body.reason) });
      return HttpResponse.json(mockTerminalGrant({
        sessionId: mode === WRITABLE_TUI_MODE ? SESION_ESCRIBIBLE : SESION_HARNESS,
        tenantId: TENANT,
        alias: ALIAS,
        container: 'ws-zeus',
        runtimeUser: 'dev',
        mode,
        requestId: String(body.request_id),
      }), { status: 201 });
    }),
    http.delete('*/v3/console/terminal/sessions/:sid', () => new HttpResponse(null, { status: 204 })),
  );
}

/**
 * THE FENCE THAT MADE THIS FEATURE A LIE. The gateway accepts `/control` and `/extend` only over a
 * session the relay already redeemed (`consumed_at IS NOT NULL`, `helpers.ts`); before that it
 * answers `409 stale_terminal_owner`. These handlers refuse exactly like that, so a console that
 * writes before the attach turns this suite red instead of turning into a take that never works.
 */
const enganchadas = new Set<string>();

/** Plays the relay redeeming the single-use ticket of whatever session this socket attached to. */
function engancharSocket(socket: StubWebSocket): StubWebSocket {
  act(() => {
    socket.acceptOpen();
    socket.emitControl({
      type: 'ready',
      claim_token: '12345678-1234-4234-8234-123456789abc',
      claim_epoch: '1',
      claim_lease_ms: 45_000,
    });
  });
  const attach = socket.framesOfType('attach')[0] as Record<string, unknown> | undefined;
  if (attach) enganchadas.add(String(attach.session_id));
  return socket;
}

const NEGATIVA_RANCIA = { error: 'conflict', reason: 'stale_terminal_owner' } as const;

function faltaElEnganche(sid: string): boolean {
  return !enganchadas.has(sid);
}

function servirControl(registro: ControlPedido[], fallo?: { status: number; reason: string }) {
  server.use(http.post('*/v3/console/terminal/sessions/:sid/control', async ({ request, params }) => {
    const body = await request.json() as Record<string, unknown>;
    const sid = String(params.sid);
    registro.push({ sid, body });
    if (body.action === 'take') {
      if (faltaElEnganche(sid)) return HttpResponse.json(NEGATIVA_RANCIA, { status: 409 });
      if (fallo) {
        return HttpResponse.json({ error: 'conflict', reason: fallo.reason }, { status: fallo.status });
      }
      return HttpResponse.json({
        session_id: sid,
        hold_id: 'hold-1',
        held_by: 'operador:steven',
        expires_at: new Date(Date.now() + 600_000).toISOString(),
      });
    }
    return HttpResponse.json({ session_id: sid, hold_id: 'hold-1', released: true });
  }));
}

function servirProrroga(registro: Record<string, unknown>[], fallo?: { status: number; reason: string }) {
  server.use(http.post('*/v3/console/terminal/sessions/:sid/extend', async ({ request, params }) => {
    const sid = String(params.sid);
    const body = await request.json() as Record<string, unknown>;
    registro.push(body);
    if (faltaElEnganche(sid)) return HttpResponse.json(NEGATIVA_RANCIA, { status: 409 });
    if (fallo) {
      return HttpResponse.json({ error: 'conflict', reason: fallo.reason }, { status: fallo.status });
    }
    return HttpResponse.json({
      session_id: sid,
      request_id: String(body.request_id),
      expires_at: new Date(Date.now() + 900_000).toISOString(),
    });
  }));
}

function escenario(overrides: Partial<TerminalTarget> = {}) {
  const sesiones: SesionPedida[] = [];
  const controles: ControlPedido[] = [];
  const prorrogas: Record<string, unknown>[] = [];
  habilitarCapacidad();
  servirDestinos([destino(overrides)]);
  servirSesiones(sesiones);
  servirControl(controles);
  servirProrroga(prorrogas);
  return { sesiones, controles, prorrogas };
}

/** Selects the alias and waits for the read-only TUI the panel opens on its own. */
async function abrirZeus(user: ReturnType<typeof userEvent.setup>) {
  const vista = renderWithApi(<TerminalPage />);
  await user.click(await screen.findByRole('button', { name: /abrir sesión con zeus/i }, { timeout: 5000 }));
  await waitFor(() => { expect(StubWebSocket.instances.length).toBeGreaterThan(0); }, { timeout: 5000 });
  return vista;
}

function campoDeMotivo(): HTMLElement {
  return screen.getByLabelText(/motivo/i);
}

function botonDeToma(): HTMLElement {
  return screen.getByRole('button', { name: /tomar el control/i });
}

/** Attaches the read-only TUI the panel opened on its own, which is what `/extend` is fenced on. */
function engancharLaTui(): StubWebSocket {
  return engancharSocket(StubWebSocket.last());
}

/** Takes the control with a hand-typed reason and returns the socket of the writable session. */
async function tomarElControl(user: ReturnType<typeof userEvent.setup>, controles: ControlPedido[]) {
  const abiertos = StubWebSocket.instances.length;
  await user.type(campoDeMotivo(), MOTIVO);
  await user.click(botonDeToma());
  // The writable channel is a session of its own: its socket is the one the keystrokes travel on,
  // and until the relay redeems ITS ticket the gateway refuses the take.
  await waitFor(() => { expect(StubWebSocket.instances.length).toBeGreaterThan(abiertos); }, { timeout: 5000 });
  const socket = engancharSocket(StubWebSocket.last());
  await waitFor(() => { expect(controles).toHaveLength(1); }, { timeout: 5000 });
  return socket;
}

let restaurarSocket: () => void;

beforeEach(() => {
  enganchadas.clear();
  restaurarSocket = installStubWebSocket();
});
afterEach(async () => {
  // Unmount HERE, while the handlers are still installed: the release the panel fires on its way
  // out landed after `resetHandlers` and printed an unhandled-request error over a green suite.
  cleanup();
  await act(async () => { await new Promise((listo) => setTimeout(listo, 0)); });
  closePtySession(SESION_HARNESS);
  closePtySession(SESION_ESCRIBIBLE);
  restaurarSocket();
});

describe('el botón sólo existe si el gateway publica un modo con escritura', () => {
  it('CONTROL NEGATIVO: con harness_rw entre los modos pero sin modo escribible publicado, no hay botón', async () => {
    const user = userEvent.setup();
    // The ONE thing that changes versus the case below: `writable_modes` comes back empty.
    const { controles } = escenario({ writable_modes: [] });
    await abrirZeus(user);

    expect(screen.queryByRole('button', { name: /tomar el control/i })).not.toBeInTheDocument();
    expect(controles).toHaveLength(0);
  }, 20_000);

  it('con harness_rw en writable_modes el control se ofrece, y dice qué le pasa al bus antes de escribir', async () => {
    const user = userEvent.setup();
    escenario();
    await abrirZeus(user);

    expect(await screen.findByRole('button', { name: /tomar el control/i })).toBeInTheDocument();
    // The consequence is on screen BEFORE the reason is typed, not after the take.
    expect(screen.getByText(/no le entrega mensajes/i)).toBeInTheDocument();
    expect(screen.getByText(/quedan en cola/i)).toBeInTheDocument();
  }, 20_000);
});

describe('el motivo lo escribe una persona', () => {
  it('siete caracteres no pueden enviarse, y el octavo habilita el botón', async () => {
    const user = userEvent.setup();
    escenario();
    await abrirZeus(user);
    await screen.findByRole('button', { name: /tomar el control/i });

    await user.type(campoDeMotivo(), 'siete c');
    expect(botonDeToma()).toBeDisabled();
    expect(screen.getByText(/al menos 8 caracteres/i)).toBeInTheDocument();

    await user.type(campoDeMotivo(), 'x');
    expect(botonDeToma()).toBeEnabled();
  }, 20_000);

  it('la toma manda el motivo tecleado tal cual, y ninguna frase generada por la consola', async () => {
    const user = userEvent.setup();
    const { sesiones, controles } = escenario();
    await abrirZeus(user);
    await screen.findByRole('button', { name: /tomar el control/i });

    await tomarElControl(user, controles);

    expect(controles[0].body).toMatchObject({ action: 'take', reason: MOTIVO });
    expect(Object.keys(controles[0].body).sort()).toEqual([...CAMPOS_DE_CONTROL, 'reason'].sort());
    // The writable session carries the SAME hand-typed reason...
    const escribible = sesiones.at(-1);
    expect(escribible).toMatchObject({ mode: WRITABLE_TUI_MODE, reason: MOTIVO });
    // ...and never the automatic observation sentence, which is read-only justification.
    expect(escribible?.reason).not.toBe(liveTuiReason(ALIAS));
    expect(controles[0].body.reason).not.toBe(liveTuiReason(ALIAS));
  }, 20_000);
});

describe('con el control tomado', () => {
  it('las teclas SÍ llegan al socket, y la pantalla dice que el bus está en cola', async () => {
    const user = userEvent.setup();
    const { controles } = escenario();
    await abrirZeus(user);
    await screen.findByRole('button', { name: /tomar el control/i });
    const socket = await tomarElControl(user, controles);

    await screen.findByRole('button', { name: /devolver el control/i });
    expect(screen.getByText(/quedan en cola/i)).toBeInTheDocument();
    // The keyboard guard is lifted by an effect, one commit AFTER the hold exists: a keystroke
    // typed before that is DROPPED —not queued— and the assertion below would be flaky for a
    // reason that has nothing to do with the control.
    await waitFor(() => {
      expect(document.querySelector('.pty-shell[data-read-only]')).toBeNull();
    }, { timeout: 5000 });

    // The mirror of `live-tui.test.tsx`, where the SAME call produces zero input frames.
    act(() => { ptySessionType(SESION_ESCRIBIBLE, 'ls -la\r'); });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(socket.framesOfType('input')).toHaveLength(1);
    expect(socket.framesOfType('input')[0]).toMatchObject({ data: 'ls -la\r' });
  }, 20_000);

  it('INPUT_REFUSED avisa y NO cierra el canal', async () => {
    const user = userEvent.setup();
    const { controles } = escenario();
    await abrirZeus(user);
    await screen.findByRole('button', { name: /tomar el control/i });
    const socket = await tomarElControl(user, controles);

    act(() => {
      socket.emitControl({
        type: 'input_refused', session_id: SESION_ESCRIBIBLE, reason: 'pane_input_barrier',
      });
    });

    expect(await screen.findByText(/pegada en vuelo/i)).toBeInTheDocument();
    expect(socket.readyState).toBe(StubWebSocket.OPEN);
    expect(socket.closeCode).toBeUndefined();
  }, 20_000);

  it('devolver el control se dispara al desmontar el panel', async () => {
    const user = userEvent.setup();
    const { controles } = escenario();
    const vista = await abrirZeus(user);
    await screen.findByRole('button', { name: /tomar el control/i });
    await tomarElControl(user, controles);

    vista.unmount();

    await waitFor(() => {
      expect(controles.filter((llamada) => llamada.body.action === 'release')).toHaveLength(1);
    }, { timeout: 5000 });
    expect(controles.at(-1)?.sid).toBe(SESION_ESCRIBIBLE);
  }, 20_000);

  it('cerrar la pestaña suelta el teclado SIN esperar a la red por el token CSRF', async () => {
    const user = userEvent.setup();
    const { controles } = escenario();
    await abrirZeus(user);
    engancharLaTui();
    await screen.findByRole('button', { name: /tomar el control/i });
    await tomarElControl(user, controles);
    await screen.findByRole('button', { name: /devolver el control/i });
    await act(async () => { await new Promise((listo) => setTimeout(listo, 0)); });

    const originalFetch = globalThis.fetch;
    const salidas: string[] = [];
    globalThis.fetch = (entrada: RequestInfo | URL, init?: RequestInit) => {
      salidas.push(typeof entrada === 'string' ? entrada : entrada instanceof URL ? entrada.href : entrada.url);
      return originalFetch(entrada, init);
    };
    try {
      window.dispatchEvent(new Event('beforeunload'));
      // SYNCHRONOUS on purpose: a release that first awaits `/v3/auth/session` never leaves a
      // page that is going away, and the alias stays muted until the hold expires by itself.
      expect(salidas.filter((url) => url.includes('/control'))).toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
    }

    await waitFor(() => {
      expect(controles.filter((llamada) => llamada.body.action === 'release')).toHaveLength(1);
    }, { timeout: 5000 });
  }, 20_000);

  it('un cierre 4410 dice en castellano que el control se fue, y no inventa una devolución', async () => {
    const user = userEvent.setup();
    const { controles } = escenario();
    await abrirZeus(user);
    await screen.findByRole('button', { name: /tomar el control/i });
    const socket = await tomarElControl(user, controles);

    act(() => { socket.emitClose(4410, 'control_released'); });

    expect(await screen.findByText(/el control de la TUI dejó de ser tuyo/i)).toBeInTheDocument();
    // The hold is already gone server-side: posting a release would be a lie about what happened.
    expect(controles.filter((llamada) => llamada.body.action === 'release')).toHaveLength(0);
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /devolver el control/i })).not.toBeInTheDocument();
    });
  }, 20_000);
});

describe('la prórroga es un acto humano, no un latido', () => {
  it('no se ofrece hasta que el relay consume el ticket, que es cuando el gateway la aceptaría', async () => {
    const user = userEvent.setup();
    const { prorrogas } = escenario();
    await abrirZeus(user);

    // The grant already exists and the bar is painted: before, that alone made the button live.
    const boton = await screen.findByRole('button', { name: /prorrogar/i });
    expect(boton).toBeDisabled();
    expect(boton.getAttribute('title')).toMatch(/el relay ya enganchó/i);

    engancharLaTui();

    await waitFor(() => { expect(screen.getByRole('button', { name: /prorrogar/i })).toBeEnabled(); });
    await user.click(screen.getByRole('button', { name: /prorrogar/i }));
    await waitFor(() => { expect(prorrogas).toHaveLength(1); });
  }, 20_000);

  it('un 409 de prórroga agotada se dice, en vez de no hacer nada', async () => {
    const user = userEvent.setup();
    escenario();
    servirProrroga([], { status: 409, reason: 'extension_exhausted' });
    await abrirZeus(user);
    engancharLaTui();

    await user.click(await screen.findByRole('button', { name: /prorrogar/i }));

    expect(await screen.findByText(new RegExp(TERMINAL_DENY_MESSAGES.extension_exhausted.titulo, 'i')))
      .toBeInTheDocument();
    expect(document.body.textContent).not.toContain('extension_exhausted');
  }, 20_000);

  it('un 409 stale_terminal_owner de prórroga se traduce y no se le cita el código al operador', async () => {
    const user = userEvent.setup();
    escenario();
    servirProrroga([], { status: 409, reason: 'stale_terminal_owner' });
    await abrirZeus(user);
    engancharLaTui();

    await user.click(await screen.findByRole('button', { name: /prorrogar/i }));

    const aviso = await screen.findByRole('alert');
    expect(aviso).toHaveAttribute('data-codigo', 'stale_terminal_owner');
    expect(aviso).toHaveTextContent(new RegExp(TERMINAL_DENY_MESSAGES.stale_terminal_owner.titulo, 'i'));
    expect(aviso).not.toHaveTextContent('stale_terminal_owner');
    expect(aviso).toHaveTextContent(/HTTP 409/);
  }, 20_000);

  it('la prórroga que el gateway concede empuja la ventana y no se pide sola', async () => {
    const user = userEvent.setup();
    const { prorrogas } = escenario();
    await abrirZeus(user);
    engancharLaTui();

    await user.click(await screen.findByRole('button', { name: /prorrogar/i }));
    await waitFor(() => { expect(prorrogas).toHaveLength(1); });
    expect(Object.keys(prorrogas[0]).sort()).toEqual([...CAMPOS_DE_PRORROGA].sort());

    // No timer asks for a second one: the extension is explicit and audited, never ambient.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 600)); });
    expect(prorrogas).toHaveLength(1);
  }, 20_000);
});

/* ---------------------------------------------------------------------------------------------
 * THE ORDER OF THE TAKE. `/control` is fenced on `consumed_at IS NOT NULL`: posting it the moment
 * the grant exists —which is what the panel did— answered `409 stale_terminal_owner` every time
 * and left the operator on a writable session with no keyboard and no way forward but closing it.
 * ------------------------------------------------------------------------------------------- */
describe('la toma espera al enganche del relay', () => {
  it('no manda /control antes de que el ticket se consuma, y lo dice mientras espera', async () => {
    const user = userEvent.setup();
    const { controles } = escenario();
    await abrirZeus(user);
    engancharLaTui();
    await screen.findByRole('button', { name: /tomar el control/i });

    const abiertos = StubWebSocket.instances.length;
    await user.type(campoDeMotivo(), MOTIVO);
    await user.click(botonDeToma());

    // The writable session exists and its socket is open, but the relay has not redeemed its
    // ticket: not one byte of `/control` may travel yet.
    await waitFor(() => { expect(StubWebSocket.instances.length).toBeGreaterThan(abiertos); }, { timeout: 5000 });
    expect(await screen.findByRole('button', { name: /enganchando la sesión/i })).toBeDisabled();
    expect(controles).toHaveLength(0);

    engancharSocket(StubWebSocket.last());

    await waitFor(() => { expect(controles).toHaveLength(1); }, { timeout: 5000 });
    expect(controles[0]).toMatchObject({ sid: SESION_ESCRIBIBLE, body: { action: 'take' } });
    await screen.findByRole('button', { name: /devolver el control/i });
  }, 20_000);

  it('si la sesión con teclado no llega a abrirse, el botón no se queda callado', async () => {
    const user = userEvent.setup();
    const { controles } = escenario();
    await abrirZeus(user);
    engancharLaTui();
    await screen.findByRole('button', { name: /tomar el control/i });
    server.use(http.post('*/v3/console/terminal/sessions', () => HttpResponse.json(
      { error: 'conflict', reason: 'container_busy' }, { status: 409 },
    )));

    await user.type(campoDeMotivo(), MOTIVO);
    await user.click(botonDeToma());

    expect(await screen.findByText(/no llegó a abrir la sesión con teclado/i)).toBeInTheDocument();
    expect(controles).toHaveLength(0);
    expect(await screen.findByRole('button', { name: /reintentar la toma/i })).toBeEnabled();
  }, 20_000);

  it('si el enganche no llega lo dice, no toca /control y el reintento SÍ toma el teclado', async () => {
    const user = userEvent.setup();
    const { controles, sesiones } = escenario();
    await abrirZeus(user);
    engancharLaTui();
    await screen.findByRole('button', { name: /tomar el control/i });

    const abiertos = StubWebSocket.instances.length;
    await user.type(campoDeMotivo(), MOTIVO);
    await user.click(botonDeToma());
    await waitFor(() => { expect(StubWebSocket.instances.length).toBeGreaterThan(abiertos); }, { timeout: 5000 });
    // The relay drops the channel before redeeming the ticket: the attach is never going to come.
    act(() => { StubWebSocket.last().emitClose(4404, 'agent_offline'); });

    const aviso = await screen.findByText(/no llegó a engancharse/i);
    expect(aviso).toBeInTheDocument();
    expect(document.body.textContent).toMatch(/sesión escribible en solo lectura/i);
    expect(controles).toHaveLength(0);
    const pedidas = sesiones.length;

    // A second click is NOT a silent no-op: it reopens the dead channel and finishes the take.
    const reintento = await screen.findByRole('button', { name: /reintentar la toma/i });
    await user.click(reintento);
    await waitFor(() => { expect(sesiones.length).toBeGreaterThan(pedidas); }, { timeout: 5000 });
    await waitFor(() => { expect(StubWebSocket.instances.length).toBeGreaterThan(abiertos + 1); }, { timeout: 5000 });
    engancharSocket(StubWebSocket.last());

    await waitFor(() => { expect(controles).toHaveLength(1); }, { timeout: 5000 });
    expect(sesiones.at(-1)).toMatchObject({ mode: WRITABLE_TUI_MODE, reason: MOTIVO });
    await screen.findByRole('button', { name: /devolver el control/i });
  }, 20_000);

  it('CONTROL NEGATIVO de montaje doble: con StrictMode la toma sigue viva y llega a /control', async () => {
    const user = userEvent.setup();
    const { controles } = escenario();
    // StrictMode runs cleanup+setup on the SAME mount. A liveness flag that only ever went false
    // froze the take on «Abriendo la sesión…» for ever, and no suite without StrictMode saw it.
    const vista = renderWithApi(<StrictMode><TerminalPage /></StrictMode>);
    await user.click(await screen.findByRole('button', { name: /abrir sesión con zeus/i }, { timeout: 5000 }));
    await waitFor(() => { expect(StubWebSocket.instances.length).toBeGreaterThan(0); }, { timeout: 5000 });
    engancharLaTui();
    await screen.findByRole('button', { name: /tomar el control/i });

    await tomarElControl(user, controles);

    await screen.findByRole('button', { name: /devolver el control/i });
    vista.unmount();
  }, 20_000);

  it('un 409 stale_terminal_owner en la toma se traduce en vez de citarle el código al operador', async () => {
    const user = userEvent.setup();
    const { controles } = escenario();
    servirControl(controles, { status: 409, reason: 'stale_terminal_owner' });
    await abrirZeus(user);
    engancharLaTui();
    await screen.findByRole('button', { name: /tomar el control/i });

    const abiertos = StubWebSocket.instances.length;
    await user.type(campoDeMotivo(), MOTIVO);
    await user.click(botonDeToma());
    await waitFor(() => { expect(StubWebSocket.instances.length).toBeGreaterThan(abiertos); }, { timeout: 5000 });
    engancharSocket(StubWebSocket.last());

    const aviso = await screen.findByRole('alert');
    expect(aviso).toHaveAttribute('data-codigo', 'stale_terminal_owner');
    expect(aviso).toHaveTextContent(new RegExp(TERMINAL_DENY_MESSAGES.stale_terminal_owner.titulo, 'i'));
    expect(aviso).not.toHaveTextContent('stale_terminal_owner');
    expect(screen.queryByRole('button', { name: /devolver el control/i })).not.toBeInTheDocument();
  }, 20_000);

  it('un recibo incompleto NO pierde el arriendo: se dice y se devuelve igual al desmontar', async () => {
    const user = userEvent.setup();
    const { controles } = escenario();
    // The gateway granted the hold —the alias is already muted— but the receipt came back without
    // `expires_at` nor `held_by`. Throwing here left the browser with no record of a real hold.
    server.use(http.post('*/v3/console/terminal/sessions/:sid/control', async ({ request, params }) => {
      const body = await request.json() as Record<string, unknown>;
      const sid = String(params.sid);
      controles.push({ sid, body });
      if (body.action !== 'take') return HttpResponse.json({ session_id: sid, hold_id: 'hold-1', released: true });
      if (faltaElEnganche(sid)) return HttpResponse.json(NEGATIVA_RANCIA, { status: 409 });
      return HttpResponse.json({ session_id: sid, hold_id: 'hold-1' });
    }));
    const vista = await abrirZeus(user);
    engancharLaTui();
    await screen.findByRole('button', { name: /tomar el control/i });
    await tomarElControl(user, controles);

    await screen.findByRole('button', { name: /devolver el control/i });
    const recibo = screen.getByText(/recibo incompleto/i);
    expect(recibo).toHaveTextContent(/held_by/);
    // The notice has no rule of its own: it borrows the panel's amber notice. Pinned here so a
    // later edit cannot leave it as unstyled body text without the suite noticing.
    expect(recibo).toHaveClass('pty-control-perdido');

    vista.unmount();
    await waitFor(() => {
      expect(controles.filter((llamada) => llamada.body.action === 'release')).toHaveLength(1);
    }, { timeout: 5000 });
  }, 20_000);
});

/* ---------------------------------------------------------------------------------------------
 * `readOnly` stops being "is this the live TUI" and becomes "is this writable AND do I hold it".
 * ------------------------------------------------------------------------------------------- */
describe('la toma no se dispara dos veces y la devolución tolera un CSRF rotado', () => {
  it('dos clics en el MISMO frame abren UNA sola sesión con teclado', async () => {
    const user = userEvent.setup();
    const { controles, sesiones } = escenario();
    await abrirZeus(user);
    engancharLaTui();
    await screen.findByRole('button', { name: /tomar el control/i });
    await user.type(campoDeMotivo(), MOTIVO);

    const abiertos = StubWebSocket.instances.length;
    const boton = botonDeToma();
    act(() => { boton.click(); boton.click(); });

    await waitFor(() => { expect(StubWebSocket.instances.length).toBeGreaterThan(abiertos); }, { timeout: 5000 });
    engancharSocket(StubWebSocket.last());
    await waitFor(() => { expect(controles).toHaveLength(1); }, { timeout: 5000 });
    expect(sesiones.filter((sesion) => sesion.mode === WRITABLE_TUI_MODE)).toHaveLength(1);
    expect(StubWebSocket.instances.length).toBe(abiertos + 1);
    await screen.findByRole('button', { name: /devolver el control/i });
    expect(screen.queryByText(/no llegó a abrir la sesión con teclado/i)).not.toBeInTheDocument();
  }, 20_000);

  it('un 403 en la devolución de `beforeunload` se reintenta resolviendo el CSRF vigente', async () => {
    const user = userEvent.setup();
    const { controles } = escenario();
    await abrirZeus(user);
    engancharLaTui();
    await screen.findByRole('button', { name: /tomar el control/i });
    await tomarElControl(user, controles);

    let devoluciones = 0;
    const tokens: (string | null)[] = [];
    server.use(
      http.get('*/v3/auth/session', () => HttpResponse.json({
        authenticated: true, subject: 'Steven:kant', roles: ['operator'],
        permissions: ['route', 'read', 'control'],
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        csrf_token: 'mock-csrf-token-rotado',
      })),
      http.post('*/v3/console/terminal/sessions/:sid/control', async ({ request, params }) => {
        const body = await request.json() as Record<string, unknown>;
        const sid = String(params.sid);
        controles.push({ sid, body });
        tokens.push(request.headers.get('x-csrf-token'));
        devoluciones += 1;
        return devoluciones === 1
          ? HttpResponse.json({ error: 'forbidden', reason: 'csrf_invalid' }, { status: 403 })
          : HttpResponse.json({ session_id: sid, hold_id: 'hold-1', released: true });
      }),
    );

    act(() => { window.dispatchEvent(new Event('beforeunload')); });

    await waitFor(() => { expect(devoluciones).toBe(2); }, { timeout: 5000 });
    expect(controles.filter((pedido) => pedido.body.action === 'release')).toHaveLength(2);
    expect(tokens[0]).toBe('mock-csrf-token');
    expect(tokens[1]).toBe('mock-csrf-token-rotado');
  }, 20_000);

  it('un 409 al devolver suelta el estado local: el arriendo ya no es de esta sesión', async () => {
    const user = userEvent.setup();
    const { controles } = escenario();
    await abrirZeus(user);
    engancharLaTui();
    await screen.findByRole('button', { name: /tomar el control/i });
    await tomarElControl(user, controles);
    await screen.findByText(/Tenés el teclado de esta TUI/i);

    server.use(http.post('*/v3/console/terminal/sessions/:sid/control', () => HttpResponse.json(
      { error: 'conflict', reason: 'stale_terminal_owner', message: 'el arriendo pertenece a otra sesión' },
      { status: 409 },
    )));

    await user.click(await screen.findByRole('button', { name: /devolver el control/i }));

    await waitFor(() => { expect(screen.queryByText(/Tenés el teclado de esta TUI/i)).not.toBeInTheDocument(); }, { timeout: 5000 });
    expect(screen.queryByRole('button', { name: /devolver el control/i })).not.toBeInTheDocument();
    expect(screen.getByText(/El bus volvió a entregarle a zeus/i)).toBeInTheDocument();
  }, 20_000);
});

describe('solo lectura es una función del modo y del control', () => {
  it.each([
    [LIVE_TUI_MODE, false, true],
    [LIVE_TUI_MODE, true, true],
    [WRITABLE_TUI_MODE, false, true],
    [WRITABLE_TUI_MODE, true, false],
    [SHELL_MODE, false, false],
    [undefined, false, false],
  ])('modo %s con control %s es solo lectura: %s', (modo, sostenido, esperado) => {
    expect(terminalEsSoloLectura(modo, sostenido)).toBe(esperado);
  });
});

/* ---------------------------------------------------------------------------------------------
 * PARITY WITH THE GATEWAY SOURCE. The request and response shapes are READ from disk, exactly
 * like `denegaciones.test.tsx` reads the denial unions: a drift in the gateway turns this red
 * here, instead of turning into a 400 in front of an operator.
 * ------------------------------------------------------------------------------------------- */
describe('el contrato de /control, /extend y writable_modes sale del gateway, no de la memoria', () => {
  function fuenteDelGateway(...partes: string[]): string {
    let directorio = dirname(fileURLToPath(import.meta.url));
    for (let salto = 0; salto < 10; salto += 1) {
      const candidato = join(directorio, 'services', 'gateway', 'src', 'terminal', ...partes);
      try {
        return readFileSync(candidato, 'utf8');
      } catch {
        directorio = dirname(directorio);
      }
    }
    throw new Error(`No se encontró services/gateway/src/terminal/${partes.join('/')}`);
  }

  /** Members of a `const X = ['a', 'b'] as const;` list in the gateway source. */
  function listaDelGateway(fuente: string, nombre: string): string[] {
    const bloque = new RegExp(`const ${nombre} = \\[([\\s\\S]*?)\\]`).exec(fuente);
    if (!bloque) throw new Error(`No se encontró la lista ${nombre} en el gateway`);
    return [...bloque[1].matchAll(/'([a-z_]+)'/g)].map((match) => match[1]).sort();
  }

  const plugin = fuenteDelGateway('plugin.ts');
  const control = fuenteDelGateway('session-control', 'control.ts');
  const extend = fuenteDelGateway('session-control', 'extend.ts');
  const targets = fuenteDelGateway('session-control', 'targets.ts');

  it('los campos del cuerpo de /control son los que `parseControlRequest` acepta', () => {
    expect([...CAMPOS_DE_CONTROL].sort()).toEqual(listaDelGateway(plugin, 'CONTROL_KEYS'));
  });

  it('los campos del cuerpo de /extend son los del cuerpo con dueño', () => {
    expect([...CAMPOS_DE_PRORROGA].sort()).toEqual(listaDelGateway(plugin, 'DELETE_SESSION_KEYS'));
  });

  it('el motivo tecleado tiene los mismos límites que el del gateway', () => {
    const minimo = /const REASON_MIN = (\d+);/.exec(plugin);
    const maximo = /const REASON_MAX = (\d+);/.exec(plugin);
    expect(Number(minimo?.[1])).toBe(PTY_REASON_MIN_LENGTH);
    expect(Number(maximo?.[1])).toBe(PTY_REASON_MAX_LENGTH);
  });

  it('la toma contesta con el identificador de arriendo y su vencimiento', () => {
    for (const campo of ['session_id', 'hold_id', 'held_by', 'expires_at']) {
      expect(control, `/control ya no contesta ${campo}`).toContain(`${campo}:`);
    }
    expect(plugin).toContain("action must be 'take' or 'release'");
  });

  it('las dos negativas que esta consola traduce siguen saliendo de /control y /extend', () => {
    expect(control).toContain("reason: 'control_held'");
    expect(extend).toContain("'extension_exhausted'");
  });

  it('el inventario publica los modos con escritura y no se infieren de la lista de modos', () => {
    expect(targets).toContain('writable_modes');
    expect(targets).toContain('isWritableMode');
  });
});
