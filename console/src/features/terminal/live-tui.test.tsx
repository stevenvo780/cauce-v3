/**
 * The live TUI: what depends on the harness mode the gateway publishes.
 *
 * Each positive case goes with its NEGATIVE CONTROL in the same run: the fixture changes ONE
 * thing only (the `harness` mode the gateway publishes) and everything else stays identical.
 * Without that pair, a test that sees the TUI does not prove the TUI depends on the TUI: it
 * may be passing for another reason. The strong assertion is not "it shows", it is "it shows,
 * and without the published mode it does not".
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
const DA_PRIMARIA = '\x1b[?1;2c'; // the terminal's own DA reply: the only data read-only lets through
/** A real chunk of Claude Code's TUI, as tmux paints it. */
const TUI_FRAME = '[2J[H> zeus esta corriendo pnpm test --run\r\n  esc to interrupt\r\n';

function target(overrides: Partial<TerminalTarget> & Pick<TerminalTarget, 'tenant_id' | 'alias'>): TerminalTarget {
  return {
    container: 'ws-zeus', runtime_user: 'dev', harness: 'claude-code', shares_container_with: [],
    modes: ['shell'], writable_modes: [], pty_state: 'online', last_seen: null, authorized: true,
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

/** Records EVERY session POST: the negative control relies on the count staying at zero. */
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

  // Choosing the agent is ALL the operator does: no mode choice, no written motive.
  await user.click(await screen.findByRole('button', { name: /abrir sesión con zeus/i }));

  await waitFor(() => { expect(StubWebSocket.instances).toHaveLength(1); });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  // The requested channel is the TUI's, not a new shell, and the motive is audited the same.
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

  // Read-only FOR REAL: a keystroke through xterm's real path does not produce an input frame.
  act(() => { ptySessionType(PTY_SESSION_ID, 'rm -rf /\r'); });
  act(() => { ptySessionType(PTY_SESSION_ID, DA_PRIMARIA); }); // a DA reply DOES cross the read-only channel
  await new Promise((resolve) => setTimeout(resolve, 30)); // keystrokes coalesce behind an 8 ms timer
  expect(socket.framesOfType('terminal_response')).toHaveLength(1);
  expect(socket.framesOfType('input')).toHaveLength(0);
}, 20_000);

it('CONTROL NEGATIVO: el mismo alias sin el modo harness no abre ninguna sesión y dice por qué', async () => {
  const user = userEvent.setup();
  const calls: SessionCall[] = [];
  enableCapability();
  // The only change versus the case above: the gateway publishes only `shell`.
  serveTargets([target({ tenant_id: 'Steven', alias: 'zeus', modes: ['shell'] })]);
  recordSessions(calls);
  renderWithApi(<TerminalPage />);

  await user.click(await screen.findByRole('button', { name: /abrir sesión con zeus/i }));
  await screen.findByRole('link', { name: /escribir a zeus en mensajes/i });
  // The PTY is still available (it is the same authorised destination): what is missing is the TUI.
  await waitFor(() => { expect(screen.getByRole('button', { name: /^PTY$/i })).toBeEnabled(); });

  expect(screen.getByRole('button', { name: /^TUI$/i })).toBeDisabled();
  // Said TWICE on purpose, like "Sin autoridad": on the fleet list chip and over the open
  // session. Before, the list chip said "PTY online", in green.
  expect(screen.getAllByText('Sin TUI que emitir')).toHaveLength(2);
  expect(screen.getByText(/no publica el modo harness.*Modos publicados: shell/i)).toBeInTheDocument();
  // Nothing was asked of the gateway and no socket opened: the absence of the mode closes the door.
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
  await screen.findByRole('link', { name: /escribir a zeus en mensajes/i });

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
  // The panel stays alive and keeps refreshing (targets every 15 s, feed every 2.5 s) without asking again.
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
 * The 403 was swallowed by the interface.
 *
 * With kant: two 403 with the CSRF-missing message in a row
 * and the panel kept saying "PTY ONLINE / ok" and "TUI EN VIVO". Zero visible change and zero
 * warning — text nodes were searched for `/403|denegad|permiso|no autoriz|error/` and none new
 * appeared. The TUI opens with one click, with no dialog, and the only place this error was
 * painted was... inside the dialog. The operator clicked and nothing happened.
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
    // The wording comes from `TERMINAL_DENY_MESSAGES.csrf_missing`, which is the ONLY place the
    // Spanish of the PTY-plane negatives lives. What the test pins down are the three facts,
    // not a hand-copied sentence: what is missing, that it is the console's fault, and that it
    // is not your permission.
    expect(aviso).toHaveTextContent(/token CSRF/i);
    expect(aviso).toHaveTextContent(/es la consola/i);
    expect(aviso).toHaveTextContent(/no es tu permiso ni el alias/i);
    // And it is marked as a console bug, which is what decides the color and the tone.
    expect(aviso).toHaveAttribute('data-consola', 'true');
    // The deployment is not blamed and the operator is not sent to inspect containers.
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
    // The raw code is NOT painted: it is translated. It stays available in `data-codigo`, which is
    // what is pasted into a report. This is the rule `denegaciones.test.tsx` guards for all eight.
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

    // The rejection warning is searched for by its text: the `role="alert"` of `.pty-render-error`
    // (xterm does not mount in jsdom) is another card and has nothing to do with this.
    expect(screen.queryByText(/rechazó la apertura de sesión|falta el token CSRF|No se pudo abrir el canal/i))
      .not.toBeInTheDocument();
  });
});
