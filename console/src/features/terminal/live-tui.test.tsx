/**
 * La TUI en vivo: lo que 
 * las TUI directamente".
 *
 * Cada caso positivo va con su CONTROL NEGATIVO en la misma corrida: el fixture cambia UNA sola
 * cosa (el modo `harness` que el servidor publica) y todo lo demás queda idéntico. Sin ese par,
 * un test que ve la TUI no prueba que la TUI dependa de la TUI: puede estar pasando por otra
 * razón. La afirmación fuerte no es "se ve", es "se ve, y sin el modo publicado no se ve".
 */
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach } from 'vitest';
import { server } from '../../mocks/server';
import { mockTerminalGrant } from '../../mocks/terminal-ticket';
import { renderWithApi } from '../../test/render';
import type { TerminalTarget } from './api';
import { closePtySession, ptySessionText, ptySessionType } from './pty-session';
import { installStubWebSocket, StubWebSocket } from './pty-socket-stub';
import { TerminalPage } from './TerminalPage';

const PTY_SESSION_ID = 'pty-tui-1';
const WS_PATH = '/v3/console/terminal/ws';
/** Un pedazo real de la TUI de Claude Code, tal como la pinta tmux. */
const TUI_FRAME = '[2J[H> zeus esta corriendo pnpm test --run\r\n  esc to interrupt\r\n';

function target(overrides: Partial<TerminalTarget> & Pick<TerminalTarget, 'tenant_id' | 'alias'>): TerminalTarget {
  return {
    container: 'ws-zeus', runtime_user: 'dev', harness: 'claude-code', shares_container_with: [],
    modes: ['shell'], pty_state: 'online', last_seen: null, authorized: true,
    reason: 'Autorizado por el servidor.',
    ...overrides,
  };
}

function serveTargets(items: TerminalTarget[] | null) {
  server.use(http.get('*/v3/console/terminal/targets', () => HttpResponse.json({
    observed_at: new Date().toISOString(), websocket_path: WS_PATH, ...(items ? { items } : {}),
  })));
}

function enableCapability() {
  server.use(http.get('*/v3/console/terminal/capability', () => HttpResponse.json({
    available: true,
    plugin_id: 'ultimate-terminal.client',
    capabilities: ['terminal.pty.client'],
    websocket_path: WS_PATH,
    target_label: 'Cauce fleet PTY',
  })));
}

interface SessionCall { mode: unknown; reason: unknown; alias: unknown }

/** Registra CADA POST de sesión: el control negativo se apoya en que la cuenta quede en cero. */
function recordSessions(calls: SessionCall[], mode = 'harness') {
  server.use(
    http.post('*/v3/console/terminal/sessions', async ({ request }) => {
      const body = await request.json() as Record<string, unknown>;
      calls.push({ mode: body.mode, reason: body.reason, alias: body.alias });
      return HttpResponse.json(mockTerminalGrant({
        sessionId: PTY_SESSION_ID, tenantId: 'Steven', alias: 'zeus', container: 'ws-zeus',
        runtimeUser: 'dev', mode, requestId: String(body.request_id),
      }), { status: 201 });
    }),
    http.delete('*/v3/console/terminal/sessions/:sid', () => new HttpResponse(null, { status: 204 })),
  );
}

let restoreSocket: () => void;

beforeEach(() => {
  serveTargets(null);
  restoreSocket = installStubWebSocket();
});
afterEach(() => {
  closePtySession(PTY_SESSION_ID);
  restoreSocket();
});

it('transmite la TUI viva del agente en cuanto se elige el alias, sin diálogo y en solo lectura', async () => {
  const user = userEvent.setup();
  const calls: SessionCall[] = [];
  enableCapability();
  serveTargets([target({ tenant_id: 'Steven', alias: 'zeus', modes: ['shell', 'harness'] })]);
  recordSessions(calls);
  renderWithApi(<TerminalPage />);

  // Elegir el agente es TODO lo que hace el operador: ni elegir modo, ni escribir un motivo.
  await user.click(await screen.findByRole('button', { name: /abrir sesión con zeus/i }));

  await waitFor(() => { expect(StubWebSocket.instances).toHaveLength(1); });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  // El canal pedido es el de la TUI, no una shell nueva, y el motivo queda auditado igual.
  expect(calls).toHaveLength(1);
  expect(calls[0].mode).toBe('harness');
  expect(String(calls[0].reason)).toMatch(/TUI en vivo de zeus \(solo lectura\)/i);

  const socket = StubWebSocket.last();
  act(() => { socket.acceptOpen(); });
  expect(socket.frames()[0]).toMatchObject({
    type: 'attach', session_id: PTY_SESSION_ID, ticket: expect.stringMatching(/^v1\./u) as unknown,
  });

  act(() => {
    socket.emitControl({
      type: 'ready',
      claim_token: '12345678-1234-4234-8234-123456789abc',
      claim_epoch: '1',
      claim_lease_ms: 45_000,
    });
    socket.emitOutput(TUI_FRAME);
  });
  await waitFor(() => { expect(ptySessionText(PTY_SESSION_ID)).toContain('zeus esta corriendo pnpm test'); });

  const bar = screen.getByLabelText('Sesión PTY activa');
  expect(bar).toHaveTextContent(/TUI en vivo · solo lectura/i);
  expect(bar).toHaveTextContent('harness');

  // Solo lectura DE VERDAD: una tecla por el camino real de xterm no produce frame de input.
  act(() => { ptySessionType(PTY_SESSION_ID, 'rm -rf /\r'); });
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(socket.framesOfType('input')).toHaveLength(0);
}, 20_000);

it('CONTROL NEGATIVO: el mismo alias sin el modo harness no abre ninguna sesión y dice por qué', async () => {
  const user = userEvent.setup();
  const calls: SessionCall[] = [];
  enableCapability();
  // Único cambio contra el caso de arriba: el servidor publica sólo `shell`.
  serveTargets([target({ tenant_id: 'Steven', alias: 'zeus', modes: ['shell'] })]);
  recordSessions(calls);
  renderWithApi(<TerminalPage />);

  await user.click(await screen.findByRole('button', { name: /abrir sesión con zeus/i }));
  await screen.findByRole('textbox', { name: /entrada para zeus/i });
  // El PTY sigue disponible (es el mismo destino autorizado): lo que falta es la TUI.
  await waitFor(() => { expect(screen.getByRole('button', { name: /^PTY$/i })).toBeEnabled(); });

  expect(screen.getByRole('button', { name: /^TUI$/i })).toBeDisabled();
  // Dicho DOS veces a propósito, igual que «Sin autoridad»: en el chip de la lista de flota y
  // sobre la sesión abierta. Antes el chip de la lista decía «PTY online», en verde.
  expect(screen.getAllByText('Sin TUI que emitir')).toHaveLength(2);
  expect(screen.getByText(/no publica el modo harness.*Modos publicados: shell/i)).toBeInTheDocument();
  // Nada se pidió al gateway y ningún socket se abrió: la ausencia del modo cierra la puerta.
  expect(calls).toHaveLength(0);
  expect(StubWebSocket.instances).toHaveLength(0);
  expect(screen.getByRole('button', { name: /^Feed$/i })).toHaveAttribute('aria-pressed', 'true');
});

it('CONTROL NEGATIVO: publica harness pero el agente PTY está offline; no se inventa una TUI', async () => {
  const user = userEvent.setup();
  const calls: SessionCall[] = [];
  enableCapability();
  serveTargets([target({
    tenant_id: 'Steven', alias: 'zeus', modes: ['shell', 'harness'],
    pty_state: 'agent_offline', reason: 'El agente PTY no está conectado al relay.',
  })]);
  recordSessions(calls);
  renderWithApi(<TerminalPage />);

  await user.click(await screen.findByRole('button', { name: /abrir sesión con zeus/i }));
  await screen.findByRole('textbox', { name: /entrada para zeus/i });

  await waitFor(() => { expect(screen.getByRole('button', { name: /^TUI$/i })).toBeDisabled(); });
  expect(screen.getByText('TUI no habilitada')).toBeInTheDocument();
  expect(calls).toHaveLength(0);
  expect(StubWebSocket.instances).toHaveLength(0);
});

it('un rechazo del gateway no se reintenta en bucle: la apertura automática es UNA sola', async () => {
  const user = userEvent.setup();
  let attempts = 0;
  enableCapability();
  serveTargets([target({ tenant_id: 'Steven', alias: 'zeus', modes: ['shell', 'harness'] })]);
  server.use(http.post('*/v3/console/terminal/sessions', () => {
    attempts += 1;
    return HttpResponse.json({ error: 'conflict', reason: 'container_busy' }, { status: 409 });
  }));
  renderWithApi(<TerminalPage />);

  await user.click(await screen.findByRole('button', { name: /abrir sesión con zeus/i }));
  await waitFor(() => { expect(attempts).toBe(1); });
  // El panel sigue vivo y refrescando (targets cada 15 s, feed cada 2.5 s) sin volver a pedir.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 600)); });
  expect(attempts).toBe(1);
  expect(StubWebSocket.instances).toHaveLength(0);
});

it('la shell sigue exigiendo motivo escrito a mano aunque la TUI se abra sola', async () => {
  const user = userEvent.setup();
  const calls: SessionCall[] = [];
  enableCapability();
  serveTargets([target({ tenant_id: 'Steven', alias: 'zeus', modes: ['shell', 'harness'] })]);
  recordSessions(calls, 'harness');
  renderWithApi(<TerminalPage />);

  await user.click(await screen.findByRole('button', { name: /abrir sesión con zeus/i }));
  await waitFor(() => { expect(calls).toHaveLength(1); });

  await user.click(screen.getByRole('button', { name: /^PTY$/i }));
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByRole('button', { name: /abrir sesión pty/i })).toBeDisabled();
  expect(within(dialog).getByText(/al menos 8 caracteres/i)).toBeInTheDocument();
});

/**
 * El 403 se lo tragaba la interfaz. **
 *
 * Con kant: dos `403 {"error":"forbidden","message":"se requiere un token CSRF válido"}` seguidos
 * y el panel siguió diciendo «PTY ONLINE / ok» y «TUI EN VIVO». Cero cambio visible y cero aviso
 * —se buscaron nodos de texto con `/403|denegad|permiso|no autoriz|error/` y no apareció ninguno
 * nuevo—. La TUI se abre de un clic, sin diálogo, y el único sitio donde este error se pintaba
 * era… dentro del diálogo. El operador pulsaba y no pasaba nada.
 */
describe('un rechazo del servidor al abrir la TUI se VE, y dice de quién es la culpa', () => {
  function rechazaSesiones(status: number, cuerpo: Record<string, unknown>) {
    server.use(http.post('*/v3/console/terminal/sessions', () => HttpResponse.json(cuerpo, { status })));
  }

  it('pinta el 403 por CSRF como lo que es: un fallo de la consola, no del permiso ni del alias', async () => {
    const user = userEvent.setup();
    enableCapability();
    serveTargets([target({ tenant_id: 'Steven', alias: 'zeus', modes: ['shell', 'harness'] })]);
    rechazaSesiones(403, { error: 'forbidden', message: 'se requiere un token CSRF válido' });
    renderWithApi(<TerminalPage />);

    await user.click(await screen.findByRole('button', { name: /abrir sesión con zeus/i }));

    const aviso = await screen.findByRole('alert');
    // La redacción sale de `TERMINAL_DENY_MESSAGES.csrf_missing`, que es el ÚNICO sitio donde vive
    // el castellano de las negativas del plano PTY. Lo que la prueba fija son los tres hechos, no
    // una frase copiada a mano: qué falta, que la culpa es de la consola, y que no es tu permiso.
    expect(aviso).toHaveTextContent(/token CSRF/i);
    expect(aviso).toHaveTextContent(/es la consola/i);
    expect(aviso).toHaveTextContent(/no es tu permiso ni el alias/i);
    // Y se marca como defecto de la consola, que es lo que decide el color y el tono.
    expect(aviso).toHaveAttribute('data-consola', 'true');
    // No se culpa al despliegue ni se manda al operador a mirar contenedores.
    expect(screen.queryByText(/no está desplegado en este stack/i)).not.toBeInTheDocument();
  });

  it('un 403 que NO es de CSRF se muestra con el motivo del servidor y sin acusar a la consola', async () => {
    const user = userEvent.setup();
    enableCapability();
    serveTargets([target({ tenant_id: 'Steven', alias: 'zeus', modes: ['shell', 'harness'] })]);
    rechazaSesiones(403, { error: 'forbidden', reason: 'attribution_required: falta identidad por persona.' });
    renderWithApi(<TerminalPage />);

    await user.click(await screen.findByRole('button', { name: /abrir sesión con zeus/i }));

    const aviso = await screen.findByRole('alert');
    // El código crudo NO se pinta: se traduce. Sigue disponible en `data-codigo`, que es lo que se
    // pega en un informe. Esta es la regla que `denegaciones.test.tsx` guarda para los ocho.
    expect(aviso).toHaveAttribute('data-codigo', 'attribution_required');
    expect(aviso).not.toHaveTextContent('attribution_required');
    expect(aviso).toHaveTextContent(/persona con nombre/i);
    expect(aviso).toHaveTextContent(/HTTP 403/);
    expect(aviso).not.toHaveAttribute('data-consola');
  });

  it('CONTROL NEGATIVO: cuando el servidor SÍ abre la sesión no aparece ningún aviso de rechazo', async () => {
    const user = userEvent.setup();
    const calls: SessionCall[] = [];
    enableCapability();
    serveTargets([target({ tenant_id: 'Steven', alias: 'zeus', modes: ['shell', 'harness'] })]);
    recordSessions(calls);
    renderWithApi(<TerminalPage />);

    await user.click(await screen.findByRole('button', { name: /abrir sesión con zeus/i }));
    await waitFor(() => { expect(calls).toHaveLength(1); });

    // Se busca el aviso de rechazo por su texto: el `role="alert"` de `.pty-render-error` (xterm
    // no monta en jsdom) es otro cartel y no tiene nada que ver con esto.
    expect(screen.queryByText(/rechazó la apertura de sesión|falta el token CSRF|No se pudo abrir el canal/i))
      .not.toBeInTheDocument();
  });
});
