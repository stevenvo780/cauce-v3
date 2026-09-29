/**
 * T041 · La sesión sin atribución no toma el teclado; T042 · la shell y la lectura siguen.
 *
 * El gateway niega con 403 `writable_requires_attribution` / `writable_requires_named_operator`
 * la toma de teclado (`POST .../control` acción `take`) cuando la sesión no acredita a una
 * persona con nombre. La consola traduce esas dos negativas al castellano operativo, no entrega
 * el teclado y no manda ni una tecla. En cambio, abrir una shell y leer (TUI de solo lectura,
 * feed, inventario) SIGUE permitido por decisión del dueño (T042 = dejar como está): la consola
 * no inventa una puerta propia sobre la shell.
 *
 * Y la caída del relay (reinicio: cierra con 1001 `relay_shutdown` por diseño) se anuncia DE
 * INMEDIATO en la consola —estado ERROR con código y motivo, sin reintento silencioso y con el
 * polling de vuelta—, no se opera a ciegas esperando al siguiente polling de 30 s.
 */
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { server } from '../../mocks/server';
import { mockTerminalGrant } from '../../mocks/terminal-ticket';
import { renderWithApi } from '../../test/render';
import type { TerminalTarget } from './api';
import { TERMINAL_DENY_MESSAGES } from './denegaciones';
import { LIVE_TUI_MODE, SHELL_MODE, WRITABLE_TUI_MODE } from './fleet';
import { closePtySession, ptySessionText, readPtySession } from './pty-session';
import { installStubWebSocket, StubWebSocket } from './pty-socket-stub';
import { TerminalPage } from './TerminalPage';

const TENANT = 'Steven';
const ALIAS = 'zeus';
const WS_PATH = '/v3/console/terminal/ws';
const SESION_HARNESS = 'pty-harness-t041';
const SESION_ESCRIBIBLE = 'pty-rw-t041';
const SESION_SHELL = 'pty-shell-t041';
const MOTIVO = 'destrabo a mano la aprobacion colgada de zeus';
const READY = {
  type: 'ready',
  claim_token: '12345678-1234-4234-8234-123456789abc',
  claim_epoch: '1',
  claim_lease_ms: 45_000,
};
/** El relay sólo ofrece continuidad con resume token; menos de 80 caracteres no vale. */
const RESUME_TOKEN = `r1.${'a'.repeat(96)}.${'b'.repeat(43)}`;

interface SesionPedida {
  mode: string;
  reason: string;
}
interface ControlPedido {
  sid: string;
  body: Record<string, unknown>;
}

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

function servirDestinos(items: TerminalTarget[]): void {
  server.use(
    http.get('*/v3/console/terminal/targets', () =>
      HttpResponse.json({
        observed_at: new Date().toISOString(),
        websocket_path: WS_PATH,
        items,
      }),
    ),
  );
}

function habilitarCapacidad(contador?: { lecturas: number }): void {
  server.use(
    http.get('*/v3/console/terminal/capability', () => {
      if (contador) contador.lecturas += 1;
      return HttpResponse.json({
        available: true,
        plugin_id: 'ultimate-terminal.client',
        capabilities: ['terminal.pty.client'],
        websocket_path: WS_PATH,
        target_label: 'Cauce fleet PTY',
      });
    }),
  );
}

function servirSesiones(registro: SesionPedida[]): void {
  server.use(
    http.post('*/v3/console/terminal/sessions', async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      const mode = String(body.mode);
      registro.push({ mode, reason: String(body.reason) });
      const sessionId = mode === WRITABLE_TUI_MODE ? SESION_ESCRIBIBLE : mode === SHELL_MODE ? SESION_SHELL : SESION_HARNESS;
      return HttpResponse.json(
        mockTerminalGrant({
          sessionId,
          tenantId: TENANT,
          alias: ALIAS,
          container: 'ws-zeus',
          runtimeUser: 'dev',
          mode,
          requestId: String(body.request_id),
        }),
        { status: 201 },
      );
    }),
    http.delete('*/v3/console/terminal/sessions/:sid', () => new HttpResponse(null, { status: 204 })),
  );
}

/** El gateway sólo acepta /control sobre una sesión que el relay ya redimió. */
const enganchadas = new Set<string>();

function engancharSocket(socket: StubWebSocket, listo: Record<string, unknown> = READY): StubWebSocket {
  act(() => {
    socket.acceptOpen();
    socket.emitControl(listo);
  });
  const attach = socket.framesOfType('attach')[0] as Record<string, unknown> | undefined;
  if (attach) enganchadas.add(String(attach.session_id));
  return socket;
}

function servirControl(registro: ControlPedido[], fallo: { status: number; reason: string }): void {
  server.use(
    http.post('*/v3/console/terminal/sessions/:sid/control', async ({ request, params }) => {
      const body = (await request.json()) as Record<string, unknown>;
      const sid = String(params.sid);
      registro.push({ sid, body });
      if (body.action === 'take' && !enganchadas.has(sid)) {
        return HttpResponse.json({ error: 'conflict', reason: 'stale_terminal_owner' }, { status: 409 });
      }
      if (body.action === 'take') {
        return HttpResponse.json({ error: 'forbidden', reason: fallo.reason }, { status: fallo.status });
      }
      return HttpResponse.json({ session_id: sid, hold_id: 'hold-1', released: true });
    }),
  );
}

async function abrirZeus(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  renderWithApi(<TerminalPage />);
  await user.click(await screen.findByRole('button', { name: /abrir sesión con zeus/i }, { timeout: 5000 }));
  await waitFor(() => {
    expect(StubWebSocket.instances.length).toBeGreaterThan(0);
  }, { timeout: 5000 });
}

let restaurarSocket: () => void;

beforeEach(() => {
  enganchadas.clear();
  restaurarSocket = installStubWebSocket();
});

afterEach(async () => {
  cleanup();
  await act(async () => {
    await new Promise((listo) => setTimeout(listo, 0));
  });
  closePtySession(SESION_HARNESS);
  closePtySession(SESION_ESCRIBIBLE);
  closePtySession(SESION_SHELL);
  restaurarSocket();
});

describe('T041 · la toma de teclado exige persona con nombre', () => {
  it.each([
    ['writable_requires_attribution', 'Escribir en una TUI exige una persona con nombre'],
    ['writable_requires_named_operator', 'Una concesión comodín no abre modos con teclado'],
  ])('403 %s se dice en castellano y el teclado no se entrega', async (codigo, titulo) => {
    const user = userEvent.setup();
    const sesiones: SesionPedida[] = [];
    const controles: ControlPedido[] = [];
    habilitarCapacidad();
    servirDestinos([destino()]);
    servirSesiones(sesiones);
    servirControl(controles, { status: 403, reason: codigo });
    await abrirZeus(user);
    engancharSocket(StubWebSocket.last());
    await screen.findByRole('button', { name: /tomar el control/i });

    const abiertos = StubWebSocket.instances.length;
    await user.type(screen.getByLabelText(/motivo/i), MOTIVO);
    await user.click(screen.getByRole('button', { name: /tomar el control/i }));
    await waitFor(() => {
      expect(StubWebSocket.instances.length).toBeGreaterThan(abiertos);
    }, { timeout: 5000 });
    const escribible = engancharSocket(StubWebSocket.last());
    await waitFor(() => {
      expect(controles).toHaveLength(1);
    }, { timeout: 5000 });

    const aviso = await screen.findByRole('alert');
    expect(aviso).toHaveAttribute('data-codigo', codigo);
    expect(aviso).toHaveTextContent(titulo);
    expect(aviso).toHaveTextContent(/HTTP 403/);
    expect(aviso).toHaveTextContent(/Lo levanta:/);
    expect(aviso).not.toHaveTextContent(codigo);
    expect(document.body.textContent).not.toContain(codigo);
    // La negativa pintada es la de la tabla, no una frase suelta inventada acá.
    expect(aviso).toHaveTextContent(
      new RegExp(TERMINAL_DENY_MESSAGES[codigo as keyof typeof TERMINAL_DENY_MESSAGES].titulo, 'i'),
    );

    // Sin teclado: ni estado sostenido ni tecla viajando al relay.
    expect(screen.queryByText(/Tenés el teclado de esta TUI/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /devolver el control/i })).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /reintentar la toma/i })).toBeEnabled();
    expect(escribible.framesOfType('input')).toHaveLength(0);
  }, 20_000);
});

describe('T042 · abrir shell y leer sigue permitido (dejar como está)', () => {
  it('la shell se abre, pinta salida y manda teclas: la consola no inventa una puerta de atribución', async () => {
    const user = userEvent.setup();
    const sesiones: SesionPedida[] = [];
    habilitarCapacidad();
    // Sólo shell: nada se autoabre y el canal bajo prueba es el interactivo.
    servirDestinos([destino({ modes: [SHELL_MODE], writable_modes: [] })]);
    servirSesiones(sesiones);
    renderWithApi(<TerminalPage />);

    await user.click(await screen.findByRole('button', { name: /abrir sesión con zeus/i }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^PTY$/i })).toBeEnabled();
    });
    // El botón no nace bloqueado por atribución: el motivo que lleva es el del canal.
    expect(screen.getByRole('button', { name: /^PTY$/i })).toHaveAttribute(
      'title',
      expect.not.stringContaining('persona con nombre') as unknown,
    );
    await user.click(screen.getByRole('button', { name: /^PTY$/i }));

    const dialogo = await screen.findByRole('dialog');
    await user.type(within(dialogo).getByRole('textbox'), 'revisar el despliegue de zeus');
    await user.click(within(dialogo).getByRole('button', { name: /abrir sesión pty/i }));

    await waitFor(() => {
      expect(StubWebSocket.instances).toHaveLength(1);
    });
    const socket = StubWebSocket.last();
    act(() => {
      socket.acceptOpen();
      socket.emitControl(READY);
      socket.emitOutput('zeus shell lista\r\n');
    });
    await waitFor(() => {
      expect(ptySessionText(SESION_SHELL)).toContain('zeus shell lista');
    });
    expect(sesiones).toHaveLength(1);
    expect(sesiones[0]).toMatchObject({ mode: SHELL_MODE });
    // Ninguna negativa de atribución mancha la apertura de la shell.
    expect(document.body.textContent).not.toContain('writable_requires_attribution');
    expect(document.body.textContent).not.toContain('writable_requires_named_operator');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    // La shell abierta tiene teclado propio: no pasa por la toma de la TUI.
    const { ptySessionType } = await import('./pty-session');
    act(() => {
      ptySessionType(SESION_SHELL, 'id -un\r');
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(socket.framesOfType('input')).toHaveLength(1);
  }, 20_000);

  it('la TUI de solo lectura se abre sola y se lee sin teclado ni negativa', async () => {
    const user = userEvent.setup();
    habilitarCapacidad();
    servirDestinos([destino({ modes: [SHELL_MODE, LIVE_TUI_MODE], writable_modes: [] })]);
    servirSesiones([]);
    renderWithApi(<TerminalPage />);

    await user.click(await screen.findByRole('button', { name: /abrir sesión con zeus/i }));
    await waitFor(() => {
      expect(StubWebSocket.instances).toHaveLength(1);
    });
    const socket = StubWebSocket.last();
    act(() => {
      socket.acceptOpen();
      socket.emitControl(READY);
      socket.emitOutput('zeus corriendo pnpm test\r\n');
    });
    await waitFor(() => {
      expect(ptySessionText(SESION_HARNESS)).toContain('zeus corriendo');
    });

    // Leer no pide persona: ni alerta ni código crudo en pantalla.
    expect(document.body.textContent).not.toContain('writable_requires_attribution');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    // Y el espejo no manda teclas aunque se teclee encima.
    const { ptySessionType } = await import('./pty-session');
    act(() => {
      ptySessionType(SESION_HARNESS, 'rm -rf /\r');
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(socket.framesOfType('input')).toHaveLength(0);
  }, 20_000);
});

describe('T041 · la caída del relay se anuncia de inmediato', () => {
  it('un 1001 relay_shutdown pinta ERROR con código y motivo sin reintentar en silencio ni esperar al polling', async () => {
    const user = userEvent.setup();
    const capacidad = { lecturas: 0 };
    const sesiones: SesionPedida[] = [];
    habilitarCapacidad(capacidad);
    servirDestinos([destino({ modes: [SHELL_MODE, LIVE_TUI_MODE], writable_modes: [] })]);
    servirSesiones(sesiones);
    renderWithApi(<TerminalPage />);

    await user.click(await screen.findByRole('button', { name: /abrir sesión con zeus/i }));
    await waitFor(() => {
      expect(StubWebSocket.instances).toHaveLength(1);
    });
    const socket = engancharSocket(StubWebSocket.last(), { ...READY, resume_token: RESUME_TOKEN });
    act(() => {
      socket.emitOutput('zeus corriendo\r\n');
    });
    await waitFor(() => {
      expect(ptySessionText(SESION_HARNESS)).toContain('zeus corriendo');
    });
    const barra = await screen.findByLabelText('Sesión PTY activa');
    expect(within(barra).getByText('POLLING EN PAUSA')).toBeInTheDocument();
    const lecturasAntes = capacidad.lecturas;
    expect(lecturasAntes).toBeGreaterThan(0);

    // El relay reinicia y mata terminales por diseño: 1001 `relay_shutdown` a la pata browser.
    act(() => {
      socket.emitClose(1001, 'relay_shutdown');
    });

    // Inmediato a nivel de manager: sin esperar timers ni polling, el canal ya es error.
    expect(readPtySession(SESION_HARNESS)).toMatchObject({ state: 'error', closeCode: 1001 });

    // E inmediato en pantalla: estado, código y motivo, con su explicación de no-reanudación.
    const estado = await screen.findByText(/código 1001/);
    expect(estado.textContent).toMatch(/ERROR/);
    expect(estado.textContent).toMatch(/cerró el canal PTY/);
    expect(estado.textContent).toContain('relay_shutdown');
    expect(await screen.findByRole('button', { name: /pedir sesión nueva/i })).toBeInTheDocument();
    expect(screen.getByText(/sólo reanuda automáticamente una interrupción de transporte/i)).toBeInTheDocument();
    // Un 1001 no es una interrupción 1006: no se finge una reanudación del mismo PTY.
    expect(screen.queryByText(/reanudando el mismo PTY/i)).not.toBeInTheDocument();

    // Sin reintento silencioso: el mismo PTY muerto no abre otro socket solo.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
    });
    expect(StubWebSocket.instances).toHaveLength(1);

    // Y el feed durable vuelve: la barra deja de decir que está en pausa.
    expect(within(barra).queryByText('POLLING EN PAUSA')).not.toBeInTheDocument();
    expect(within(barra).getByText('POLLING ACTIVO')).toBeInTheDocument();

    // La prueba de que no se esperó al polling: el anuncio llegó sin releer capability.
    expect(capacidad.lecturas).toBe(lecturasAntes);
  }, 20_000);
});
