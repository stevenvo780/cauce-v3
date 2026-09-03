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
import { act, screen, waitFor } from '@testing-library/react';
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

function servirControl(registro: ControlPedido[], fallo?: { status: number; reason: string }) {
  server.use(http.post('*/v3/console/terminal/sessions/:sid/control', async ({ request, params }) => {
    const body = await request.json() as Record<string, unknown>;
    const sid = String(params.sid);
    registro.push({ sid, body });
    if (fallo && body.action === 'take') {
      return HttpResponse.json({ error: 'conflict', reason: fallo.reason }, { status: fallo.status });
    }
    if (body.action === 'take') {
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

function escenario(overrides: Partial<TerminalTarget> = {}) {
  const sesiones: SesionPedida[] = [];
  const controles: ControlPedido[] = [];
  habilitarCapacidad();
  servirDestinos([destino(overrides)]);
  servirSesiones(sesiones);
  servirControl(controles);
  return { sesiones, controles };
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

/** Takes the control with a hand-typed reason and returns the socket of the writable session. */
async function tomarElControl(user: ReturnType<typeof userEvent.setup>, controles: ControlPedido[]) {
  const abiertos = StubWebSocket.instances.length;
  await user.type(campoDeMotivo(), MOTIVO);
  await user.click(botonDeToma());
  await waitFor(() => { expect(controles).toHaveLength(1); }, { timeout: 5000 });
  // The writable channel is a session of its own: its socket is the one the keystrokes travel on.
  await waitFor(() => { expect(StubWebSocket.instances.length).toBeGreaterThan(abiertos); }, { timeout: 5000 });
  const socket = StubWebSocket.last();
  act(() => {
    socket.acceptOpen();
    socket.emitControl({
      type: 'ready',
      claim_token: '12345678-1234-4234-8234-123456789abc',
      claim_epoch: '1',
      claim_lease_ms: 45_000,
    });
  });
  return socket;
}

let restaurarSocket: () => void;

beforeEach(() => { restaurarSocket = installStubWebSocket(); });
afterEach(() => {
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
  it('un 409 de prórroga agotada se dice, en vez de no hacer nada', async () => {
    const user = userEvent.setup();
    escenario();
    server.use(http.post('*/v3/console/terminal/sessions/:sid/extend', () => HttpResponse.json(
      { error: 'conflict', reason: 'extension_exhausted' }, { status: 409 },
    )));
    await abrirZeus(user);

    await user.click(await screen.findByRole('button', { name: /prorrogar/i }));

    expect(await screen.findByText(new RegExp(TERMINAL_DENY_MESSAGES.extension_exhausted.titulo, 'i')))
      .toBeInTheDocument();
    expect(document.body.textContent).not.toContain('extension_exhausted');
  }, 20_000);

  it('la prórroga que el gateway concede empuja la ventana y no se pide sola', async () => {
    const user = userEvent.setup();
    const prorrogas: Record<string, unknown>[] = [];
    escenario();
    server.use(http.post('*/v3/console/terminal/sessions/:sid/extend', async ({ request, params }) => {
      const body = await request.json() as Record<string, unknown>;
      prorrogas.push(body);
      return HttpResponse.json({
        session_id: String(params.sid),
        request_id: String(body.request_id),
        expires_at: new Date(Date.now() + 900_000).toISOString(),
      });
    }));
    await abrirZeus(user);

    await user.click(await screen.findByRole('button', { name: /prorrogar/i }));
    await waitFor(() => { expect(prorrogas).toHaveLength(1); });
    expect(Object.keys(prorrogas[0]).sort()).toEqual([...CAMPOS_DE_PRORROGA].sort());

    // No timer asks for a second one: the extension is explicit and audited, never ambient.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 600)); });
    expect(prorrogas).toHaveLength(1);
  }, 20_000);
});

/* ---------------------------------------------------------------------------------------------
 * `readOnly` stops being "is this the live TUI" and becomes "is this writable AND do I hold it".
 * ------------------------------------------------------------------------------------------- */
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
