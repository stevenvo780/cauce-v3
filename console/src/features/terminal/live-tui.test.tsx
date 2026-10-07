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

interface SessionCall { mode: unknown; hasReason: boolean; alias: unknown }

function recordSessions(calls: SessionCall[], mode = 'harness') {
  server.use(
    http.post('*/v3/console/terminal/sessions', async ({ request }) => {
      const body = await request.json() as Record<string, unknown>;
      calls.push({ mode: body.mode, hasReason: Object.hasOwn(body, 'reason'), alias: body.alias });
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
  const calls: SessionCall[] = [];
  enableCapability();
  serveTargets([target({ tenant_id: 'Steven', alias: 'zeus', modes: ['shell', 'harness'] })]);
  recordSessions(calls);
  renderWithApi(<TerminalPage params={['Steven', 'zeus']} />);

  await waitFor(() => { expect(StubWebSocket.instances).toHaveLength(1); });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(calls).toHaveLength(1);
  expect(calls[0].mode).toBe('harness');
  expect(calls[0].hasReason).toBe(false);

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
  expect(within(bar).getByLabelText('Solo lectura')).toBeInTheDocument();
  expect(within(bar).getByLabelText('TUI en vivo')).toBeInTheDocument();
  act(() => { ptySessionType(PTY_SESSION_ID, 'rm -rf /\r'); });
  act(() => { ptySessionType(PTY_SESSION_ID, DA_PRIMARIA); }); // a DA reply DOES cross the read-only channel
  await new Promise((resolve) => setTimeout(resolve, 30)); // keystrokes coalesce behind an 8 ms timer
  expect(socket.framesOfType('terminal_response')).toHaveLength(1);
  expect(socket.framesOfType('input')).toHaveLength(0);
}, 20_000);

it('CONTROL NEGATIVO: el mismo alias sin el modo harness no abre ninguna sesión y dice por qué', async () => {
  const calls: SessionCall[] = [];
  enableCapability();
  serveTargets([target({ tenant_id: 'Steven', alias: 'zeus', modes: ['shell'] })]);
  recordSessions(calls);
  renderWithApi(<TerminalPage params={['Steven', 'zeus']} />);
  await screen.findByRole('button', { name: /^TUI$/i });
  await waitFor(() => { expect(screen.getByRole('button', { name: /^Terminal$/i })).toBeEnabled(); });

  expect(screen.getByRole('button', { name: /^TUI$/i })).toBeDisabled();
  expect(screen.getByRole('button', { name: /^TUI$/i })).toHaveAttribute('title', expect.stringContaining('Sin TUI que emitir'));
  expect(screen.getByRole('button', { name: /^TUI$/i })).toHaveAttribute('title', expect.stringMatching(/no publica el modo harness.*Modos publicados: shell/i));
  expect(calls).toHaveLength(0);
  expect(StubWebSocket.instances).toHaveLength(0);
});

it('CONTROL NEGATIVO: publica harness pero el agente PTY está offline; no se inventa una TUI', async () => {
  const calls: SessionCall[] = [];
  enableCapability();
  serveTargets([target({
    tenant_id: 'Steven', alias: 'zeus', modes: ['shell', 'harness'],
    pty_state: 'agent_offline', reason: 'El agente PTY no está conectado al relay.',
  })]);
  recordSessions(calls);
  renderWithApi(<TerminalPage params={['Steven', 'zeus']} />);
  await screen.findByRole('button', { name: /^TUI$/i });

  await waitFor(() => { expect(screen.getByRole('button', { name: /^TUI$/i })).toBeDisabled(); });
  expect(screen.getByRole('button', { name: /^TUI$/i })).toHaveAttribute('title', expect.stringContaining('TUI no habilitada'));
  expect(calls).toHaveLength(0);
  expect(StubWebSocket.instances).toHaveLength(0);
});

it('un rechazo del gateway no se reintenta en bucle: la apertura automática es UNA sola', async () => {
  let attempts = 0;
  enableCapability();
  serveTargets([target({ tenant_id: 'Steven', alias: 'zeus', modes: ['shell', 'harness'] })]);
  server.use(http.post('*/v3/console/terminal/sessions', () => {
    attempts += 1;
    return HttpResponse.json({ error: 'conflict', reason: 'container_busy' }, { status: 409 });
  }));
  renderWithApi(<TerminalPage params={['Steven', 'zeus']} />);
  await waitFor(() => { expect(attempts).toBe(1); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 600)); });
  expect(attempts).toBe(1);
  expect(StubWebSocket.instances).toHaveLength(0);
});

it('la shell abre sin diálogo de justificación después de seleccionar Terminal', async () => {
  const user = userEvent.setup();
  const calls: SessionCall[] = [];
  enableCapability();
  serveTargets([target({ tenant_id: 'Steven', alias: 'zeus', modes: ['shell', 'harness'] })]);
  recordSessions(calls, 'harness');
  renderWithApi(<TerminalPage params={['Steven', 'zeus']} />);
  await waitFor(() => { expect(calls).toHaveLength(1); });

  await user.click(screen.getByRole('button', { name: /^Terminal$/i }));
  // One click: no modal and no text box stand between the operator and the request.
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  await waitFor(() => { expect(calls).toHaveLength(2); });
  expect(calls[1]).toMatchObject({ mode: 'shell', hasReason: false });
});

describe('un rechazo del servidor al abrir la TUI se VE, y dice de quién es la culpa', () => {
  function rechazaSesiones(status: number, cuerpo: Record<string, unknown>) {
    server.use(http.post('*/v3/console/terminal/sessions', () => HttpResponse.json(cuerpo, { status })));
  }

  it('pinta el 403 por CSRF como lo que es: un fallo de la consola, no del permiso ni del alias', async () => {
    enableCapability();
    serveTargets([target({ tenant_id: 'Steven', alias: 'zeus', modes: ['shell', 'harness'] })]);
    rechazaSesiones(403, { error: 'forbidden', message: 'se requiere un token CSRF válido' });
    renderWithApi(<TerminalPage params={['Steven', 'zeus']} />);

    const aviso = await screen.findByRole('alert');
    expect(aviso).toHaveTextContent(/token CSRF/i);
    expect(aviso).toHaveTextContent(/es la consola/i);
    expect(aviso).toHaveTextContent(/no es tu permiso ni el alias/i);
    expect(aviso).toHaveAttribute('data-consola', 'true');
    expect(screen.queryByText(/no está desplegado en este stack/i)).not.toBeInTheDocument();
  });

  it('un 403 que NO es de CSRF se muestra con el motivo del servidor y sin acusar a la consola', async () => {
    enableCapability();
    serveTargets([target({ tenant_id: 'Steven', alias: 'zeus', modes: ['shell', 'harness'] })]);
    rechazaSesiones(403, { error: 'forbidden', reason: 'attribution_required: falta identidad por persona.' });
    renderWithApi(<TerminalPage params={['Steven', 'zeus']} />);

    const aviso = await screen.findByRole('alert');
    expect(aviso).toHaveAttribute('data-codigo', 'attribution_required');
    expect(aviso).not.toHaveTextContent('attribution_required');
    expect(aviso).toHaveTextContent(/persona con nombre/i);
    expect(aviso).toHaveTextContent(/HTTP 403/);
    expect(aviso).not.toHaveAttribute('data-consola');
  });

  it('CONTROL NEGATIVO: cuando el servidor SÍ abre la sesión no aparece ningún aviso de rechazo', async () => {
    const calls: SessionCall[] = [];
    enableCapability();
    serveTargets([target({ tenant_id: 'Steven', alias: 'zeus', modes: ['shell', 'harness'] })]);
    recordSessions(calls);
    renderWithApi(<TerminalPage params={['Steven', 'zeus']} />);
    await waitFor(() => { expect(calls).toHaveLength(1); });
    expect(screen.queryByText(/rechazó la apertura de sesión|falta el token CSRF|No se pudo abrir el canal/i))
      .not.toBeInTheDocument();
  });
});

it('Terminal pide una shell nueva aunque la TUI actual tenga teclado', async () => {
  const user = userEvent.setup();
  const calls: SessionCall[] = [];
  enableCapability();
  serveTargets([target({ tenant_id: 'Steven', alias: 'zeus',
    modes: ['shell', 'harness', 'harness_rw'], writable_modes: ['harness_rw'] })]);
  recordSessions(calls, 'harness_rw');
  renderWithApi(<TerminalPage params={['Steven', 'zeus']} />);
  await waitFor(() => { expect(calls).toHaveLength(1); });
  expect(calls[0].mode).toBe('harness_rw');
  await user.click(screen.getByRole('button', { name: /^Terminal$/i }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  await waitFor(() => { expect(calls).toHaveLength(2); });
  expect(calls.at(-1)).toMatchObject({ mode: 'shell', hasReason: false });
});
