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
import { PTY_REASON_MIN_LENGTH, PTY_REASON_MAX_LENGTH, controlTuiReason, liveTuiReason } from './session';
import { TerminalPage } from './TerminalPage';

const TENANT = 'Steven';
const ALIAS = 'zeus';
const WS_PATH = '/v3/console/terminal/ws';
const SESION_HARNESS = 'pty-harness-1';
const SESION_ESCRIBIBLE = 'pty-rw-1';
const MOTIVO = controlTuiReason(ALIAS);

interface SesionPedida { mode: string; reason: string }
interface ControlPedido { sid: string; body: Record<string, unknown> }

const sesionesTerminalEmitidas = new Set<string>();

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
      const writableGrant = mode === WRITABLE_TUI_MODE;
      const sessionId = writableGrant ? `pty-rw-${String(registro.filter((item) => item.mode === WRITABLE_TUI_MODE).length)}` : SESION_HARNESS;
      sesionesTerminalEmitidas.add(sessionId);
      return HttpResponse.json(mockTerminalGrant({
        sessionId,
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

const enganchadas = new Set<string>();

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

async function abrirZeus(user: ReturnType<typeof userEvent.setup>, expectSocket = true) {
  const vista = renderWithApi(<TerminalPage />);
  await user.selectOptions(await screen.findByRole('combobox', { name: 'Agente' }), await screen.findByRole('option', { name: /^zeus ·/ }));
  if (expectSocket) await waitFor(() => { expect(StubWebSocket.instances.length).toBeGreaterThan(0); }, { timeout: 5000 });
  return vista;
}

function botonDeToma(): HTMLElement {
  return screen.getByRole('button', { name: /tomar el control/i });
}

function engancharLaTui(): StubWebSocket {
  return engancharSocket(StubWebSocket.last());
}

async function tomarElControl(_user: ReturnType<typeof userEvent.setup>, controles: ControlPedido[]) {
  const socket = StubWebSocket.last();
  const attach = socket.framesOfType('attach')[0] as Record<string, unknown> | undefined;
  if (!attach || !enganchadas.has(String(attach.session_id))) engancharSocket(socket);
  await waitFor(() => { expect(controles.filter((item) => item.body.action === 'take')).toHaveLength(1); }, { timeout: 5000 });
  return socket;
}

let restaurarSocket: () => void;

beforeEach(() => {
  enganchadas.clear();
  restaurarSocket = installStubWebSocket();
});
afterEach(async () => {
  cleanup();
  await act(async () => { await new Promise((listo) => setTimeout(listo, 0)); });
  closePtySession(SESION_HARNESS);
  closePtySession(SESION_ESCRIBIBLE);
  for (const sessionId of sesionesTerminalEmitidas) closePtySession(sessionId);
  sesionesTerminalEmitidas.clear();
  restaurarSocket();
});

describe('el botón sólo existe si el gateway publica un modo con escritura', () => {
  it('la toma inicial durante un turno usa allow_busy sin una segunda acción', async () => {
    const user = userEvent.setup();
    const { controles } = escenario();
    server.use(http.post('*/v3/console/terminal/sessions/:sid/control', async ({ request, params }) => {
      const body = await request.json() as Record<string, unknown>;
      const sid = String(params.sid);
      controles.push({ sid, body });
      if (faltaElEnganche(sid)) return HttpResponse.json(NEGATIVA_RANCIA, { status: 409 });
      if (body.allow_busy !== true) return HttpResponse.json({ error: 'conflict', reason: 'agent_busy' }, { status: 409 });
      return HttpResponse.json({ session_id: sid, hold_id: 'hold-busy', held_by: 'operador:steven',
        expires_at: new Date(Date.now() + 600_000).toISOString() });
    }));
    await abrirZeus(user);
    expect(controles).toHaveLength(0);
    await tomarElControl(user, controles);
    expect(controles[0]?.body).toMatchObject({ action: 'take', reason: MOTIVO, allow_busy: true });
    expect(await screen.findByText(/Tenés el teclado/)).toBeInTheDocument();
    expect(controles).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Tomar control durante el turno' })).not.toBeInTheDocument();
  });

  it('CONTROL NEGATIVO: con harness_rw entre los modos pero sin modo escribible publicado, no hay botón', async () => {
    const user = userEvent.setup();
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
    expect(screen.getByRole('button', { name: /tomar el control/i })).toHaveAttribute('title', expect.stringContaining('mensajes del bus quedan en cola'));
  }, 20_000);
});

describe('control directo con auditoría', () => {
  it('seleccionar la TUI abre escritura sin formulario y espera ready antes de tomar', async () => {
    const user = userEvent.setup();
    const { sesiones, controles } = escenario();
    await abrirZeus(user);
    expect(screen.queryByRole('textbox', { name: /motivo/i })).not.toBeInTheDocument();
    expect(sesiones).toEqual([{ mode: WRITABLE_TUI_MODE, reason: MOTIVO }]);
    expect(controles).toHaveLength(0);
    await tomarElControl(user, controles);
    expect(controles[0].body).toMatchObject({ action: 'take', reason: MOTIVO });
    expect(Object.keys(controles[0].body).sort()).toEqual([...CAMPOS_DE_CONTROL, 'reason', 'allow_busy'].sort());
    expect(controles[0].body.reason).not.toBe(liveTuiReason(ALIAS));
  }, 20_000);

  it('devolver el teclado no dispara otra toma automática', async () => {
    const user = userEvent.setup();
    const { controles } = escenario();
    await abrirZeus(user);
    await tomarElControl(user, controles);
    await user.click(await screen.findByRole('button', { name: /devolver el control/i }));
    await waitFor(() => { expect(controles.filter((item) => item.body.action === 'release')).toHaveLength(1); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); });
    expect(controles.filter((item) => item.body.action === 'take')).toHaveLength(1);
    expect(screen.getByRole('button', { name: /tomar el control/i })).toBeEnabled();
  }, 20_000);
});

describe('con el control tomado', () => {
  it('las teclas SÍ llegan al socket, y la pantalla dice que el bus está en cola', async () => {
    const user = userEvent.setup();
    const { controles } = escenario();
    await abrirZeus(user);
    const socket = await tomarElControl(user, controles);

    await screen.findByRole('button', { name: /devolver el control/i });
    expect(screen.getByText(/Tenés el teclado/)).toHaveAttribute('title', expect.stringContaining('cola'));
    await waitFor(() => {
      expect(document.querySelector('.pty-shell[data-read-only]')).toBeNull();
    }, { timeout: 5000 });

    act(() => { ptySessionType(SESION_ESCRIBIBLE, 'ls -la\r'); });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(socket.framesOfType('input')).toHaveLength(1);
    expect(socket.framesOfType('input')[0]).toMatchObject({ data: 'ls -la\r' });
  }, 20_000);

  it('INPUT_REFUSED avisa y NO cierra el canal', async () => {
    const user = userEvent.setup();
    const { controles } = escenario();
    await abrirZeus(user);
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
    const socket = await tomarElControl(user, controles);

    act(() => { socket.emitClose(4410, 'control_released'); });

    expect(await screen.findByText(/el control de la TUI dejó de ser tuyo/i)).toBeInTheDocument();
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

    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 600)); });
    expect(prorrogas).toHaveLength(1);
  }, 20_000);
});

describe('la toma espera al enganche del relay', () => {
  it.each(['writable_tui_disabled', 'no_grant', 'control_permission_required', 'writable_requires_named_operator'] as const)(
    'blocks retry after a permanent %s denial during admission or take', async (reason) => {
      for (const phase of ['admission', 'take'] as const) {
        const user = userEvent.setup({ delay: null });
        const { controles } = escenario();
        if (phase === 'admission') {
          server.use(http.post('*/v3/console/terminal/sessions', () => HttpResponse.json({ reason }, { status: 403 })));
          await abrirZeus(user, false);
        } else {
          servirControl(controles, { status: 403, reason });
          await abrirZeus(user);
          await tomarElControl(user, controles);
        }
        expect(await screen.findByText(TERMINAL_DENY_MESSAGES[reason].titulo)).toBeInTheDocument();
        const blocked = phase === 'take' ? await screen.findByRole('button', { name: 'Escritura no disponible' }) : screen.getByRole('button', { name: 'TUI' });
        if (phase === 'take') expect(blocked).toBeDisabled();
        expect(screen.queryByRole('button', { name: /reintentar la toma/i })).not.toBeInTheDocument();
        expect(screen.getByRole('alert')).toHaveTextContent(TERMINAL_DENY_MESSAGES[reason].quienLoLevanta);
        await user.click(blocked);
        expect(controles.filter(call => call.body.action === 'take')).toHaveLength(phase === 'take' ? 1 : 0);
        cleanup();
        closePtySession(SESION_HARNESS);
        closePtySession(SESION_ESCRIBIBLE);
      }
    }, 20_000,
  );

  it.each([408, 429, 503])('keeps an HTTP %i failure retryable without automatically taking control', async (status) => {
    const user = userEvent.setup({ delay: null });
    const { controles } = escenario();
    await abrirZeus(user);
    engancharLaTui();
    servirControl(controles, { status, reason: 'temporary_failure' });
    await tomarElControl(user, controles);
    const retry = await screen.findByRole('button', { name: /reintentar la toma/i });
    expect(retry).toBeEnabled();
    expect(screen.queryByRole('textbox', { name: /motivo/i })).not.toBeInTheDocument();
    expect(controles).toHaveLength(1);
    servirControl(controles);
    await user.click(retry);
    expect(await screen.findByText(/Tenés el teclado/)).toBeInTheDocument();
    expect(controles.filter(call => call.body.action === 'take')).toHaveLength(2);
  }, 20_000);

  it('no manda /control antes de que el ticket se consuma', async () => {
    const user = userEvent.setup();
    const { controles } = escenario();
    await abrirZeus(user);
    expect(controles).toHaveLength(0);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
    expect(controles).toHaveLength(0);
    engancharSocket(StubWebSocket.last());
    await waitFor(() => { expect(controles).toHaveLength(1); });
    expect(controles[0]).toMatchObject({ sid: SESION_ESCRIBIBLE, body: { action: 'take' } });
    await screen.findByRole('button', { name: /devolver el control/i });
  }, 20_000);

  it('la negativa al abrir automáticamente se muestra sin intentar tomar el teclado', async () => {
    const user = userEvent.setup();
    const { controles } = escenario();
    server.use(http.post('*/v3/console/terminal/sessions', () => HttpResponse.json(
      { error: 'conflict', reason: 'container_busy' }, { status: 409 },
    )));
    await abrirZeus(user, false);
    expect(await screen.findByText(TERMINAL_DENY_MESSAGES.container_busy.titulo)).toBeInTheDocument();
    expect(controles).toHaveLength(0);
    expect(StubWebSocket.instances).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'TUI' })).toBeEnabled();
  }, 20_000);

  it('si el enganche no llega lo dice, no toca /control y el reintento SÍ toma el teclado', async () => {
    const user = userEvent.setup();
    const { controles, sesiones } = escenario();
    await abrirZeus(user);
    const abiertos = StubWebSocket.instances.length;
    await user.click(botonDeToma());
    act(() => { StubWebSocket.last().emitClose(4404, 'agent_offline'); });
    expect(await screen.findByText(/no llegó a engancharse/i)).toBeInTheDocument();
    expect(document.body.textContent).toMatch(/sesión escribible en solo lectura/i);
    expect(controles).toHaveLength(0);
    const pedidas = sesiones.length;
    await user.click(await screen.findByRole('button', { name: /reintentar la toma/i }));
    await waitFor(() => { expect(sesiones.length).toBeGreaterThan(pedidas); }, { timeout: 5000 });
    await waitFor(() => { expect(StubWebSocket.instances.length).toBeGreaterThan(abiertos); }, { timeout: 5000 });
    engancharSocket(StubWebSocket.last());
    await waitFor(() => { expect(controles).toHaveLength(1); }, { timeout: 5000 });
    expect(sesiones.at(-1)).toMatchObject({ mode: WRITABLE_TUI_MODE, reason: MOTIVO });
    await screen.findByRole('button', { name: /devolver el control/i });
  }, 20_000);

  it('CONTROL NEGATIVO de montaje doble: con StrictMode la toma sigue viva y llega a /control', async () => {
    const user = userEvent.setup();
    const { controles } = escenario();
    const vista = renderWithApi(<StrictMode><TerminalPage /></StrictMode>);
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Agente' }), await screen.findByRole('option', { name: /^zeus ·/ }));
    await waitFor(() => { expect(StubWebSocket.instances.length).toBeGreaterThan(0); }, { timeout: 5000 });
    engancharLaTui();

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

    await waitFor(() => { expect(controles).toHaveLength(1); });

    const aviso = await screen.findByRole('alert');
    expect(aviso).toHaveAttribute('data-codigo', 'stale_terminal_owner');
    expect(aviso).toHaveTextContent(new RegExp(TERMINAL_DENY_MESSAGES.stale_terminal_owner.titulo, 'i'));
    expect(aviso).not.toHaveTextContent('stale_terminal_owner');
    expect(screen.queryByRole('button', { name: /devolver el control/i })).not.toBeInTheDocument();
  }, 20_000);

  it('un recibo incompleto NO pierde el arriendo: se dice y se devuelve igual al desmontar', async () => {
    const user = userEvent.setup();
    const { controles } = escenario();
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
    await tomarElControl(user, controles);

    await screen.findByRole('button', { name: /devolver el control/i });
    const recibo = screen.getByText(/recibo incompleto/i);
    expect(recibo).toHaveTextContent(/held_by/);
    expect(recibo).toHaveClass('pty-control-perdido');

    vista.unmount();
    await waitFor(() => {
      expect(controles.filter((llamada) => llamada.body.action === 'release')).toHaveLength(1);
    }, { timeout: 5000 });
  }, 20_000);
});

describe('la toma no se dispara dos veces y la devolución tolera un CSRF rotado', () => {
  it('dos clics en el MISMO frame abren UNA sola sesión con teclado', async () => {
    const user = userEvent.setup();
    const { controles, sesiones } = escenario();
    await abrirZeus(user);
    const abiertos = StubWebSocket.instances.length;
    const boton = botonDeToma();
    act(() => { boton.click(); boton.click(); });

    engancharSocket(StubWebSocket.last());
    await waitFor(() => { expect(controles).toHaveLength(1); }, { timeout: 5000 });
    expect(sesiones.filter((sesion) => sesion.mode === WRITABLE_TUI_MODE)).toHaveLength(1);
    expect(StubWebSocket.instances.length).toBe(abiertos);
    await screen.findByRole('button', { name: /devolver el control/i });
    expect(screen.queryByText(/no llegó a abrir la sesión con teclado/i)).not.toBeInTheDocument();
  }, 20_000);

  it('un 403 en la devolución de `beforeunload` se reintenta resolviendo el CSRF vigente', async () => {
    const user = userEvent.setup();
    const { controles } = escenario();
    await abrirZeus(user);
    engancharLaTui();
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

  it.each(['stale_terminal_owner', 'control_held'])(
    'un 409 %s al devolver informa que esta sesión perdió el control sin afirmar que el bus se reanudó', async (reason) => {
    const user = userEvent.setup();
    const { controles } = escenario();
    await abrirZeus(user);
    engancharLaTui();
    await tomarElControl(user, controles);
    await screen.findByText(/Tenés el teclado de esta TUI/i);

    server.use(http.post('*/v3/console/terminal/sessions/:sid/control', () => HttpResponse.json(
      { error: 'conflict', reason },
      { status: 409 },
    )));

    await user.click(await screen.findByRole('button', { name: /devolver el control/i }));

    await waitFor(() => { expect(document.querySelector(`.pty-negativa[data-codigo="${reason}"]`)).toBeInTheDocument(); });
    expect(screen.queryByText(/El bus volvió a entregarle/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Tenés el teclado de esta TUI/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /devolver el control/i })).not.toBeInTheDocument();
    expect(screen.getByText(/Esta sesión ya no tiene el control de la TUI de zeus/i)).toBeInTheDocument();
    expect(screen.getByText(/Otra sesión puede mantener el bus en pausa/i)).toBeInTheDocument();
  }, 20_000);

  it('un 409 sin evidencia de pérdida conserva el control local para poder reintentar la devolución', async () => {
    const user = userEvent.setup();
    const { controles } = escenario();
    await abrirZeus(user);
    engancharLaTui();
    await tomarElControl(user, controles);

    server.use(http.post('*/v3/console/terminal/sessions/:sid/control', () => HttpResponse.json(
      { error: 'conflict', reason: 'release_not_confirmed' },
      { status: 409 },
    )));

    await user.click(await screen.findByRole('button', { name: /devolver el control/i }));

    await screen.findByText(/Tenés el teclado de esta TUI/i);
    expect(screen.getByRole('button', { name: /devolver el control/i })).toBeEnabled();
    expect(screen.queryByText(/Esta sesión ya no tiene el control/i)).not.toBeInTheDocument();
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

  it('el motivo auditado tiene los mismos límites que el del gateway', () => {
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
