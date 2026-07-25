import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach } from 'vitest';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import type { TerminalTarget } from './api';
import { closePtySession, ptySessionText } from './pty-session';
import { installStubWebSocket, StubWebSocket } from './pty-socket-stub';
import { TerminalPage } from './TerminalPage';

const PTY_SESSION_ID = 'pty-sess-1';
const WS_PATH = '/v3/console/terminal/ws';

function target(overrides: Partial<TerminalTarget> & Pick<TerminalTarget, 'tenant_id' | 'alias'>): TerminalTarget {
  return {
    container: 'claw', runtime_user: 'claw', harness: 'claude-code', shares_container_with: [],
    modes: ['shell'], pty_state: 'online', last_seen: null, authorized: true,
    reason: 'Autorizado por el servidor.',
    ...overrides,
  };
}

/** The global handlers keep PTY unavailable; each test opts in with its own inventory. */
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

function serveGrant(overrides: Record<string, unknown> = {}) {
  server.use(
    http.post('*/v3/console/terminal/sessions', () => HttpResponse.json({
      session_id: PTY_SESSION_ID,
      ticket: 'one-shot-ticket',
      websocket_path: WS_PATH,
      expires_at: new Date(Date.now() + 900_000).toISOString(),
      ttl_seconds: 30,
      target: { tenant_id: 'Steven', alias: 'jarvis', container: 'claw', runtime_user: 'claw', mode: 'shell', shares_container_with: [] },
      ...overrides,
    }, { status: 201 })),
    http.delete('*/v3/console/terminal/sessions/:sid', () => new HttpResponse(null, { status: 204 })),
  );
}

let restoreSocket: () => void;

beforeEach(() => {
  // The gateway serves the inventory; without a handler MSW would fail the unrelated assertions.
  serveTargets(null);
  restoreSocket = installStubWebSocket();
});
afterEach(() => {
  closePtySession(PTY_SESSION_ID);
  restoreSocket();
});

/** Drives the UI from the fleet list up to a live PTY socket. */
async function openPtyChannel(user: ReturnType<typeof userEvent.setup>, alias: string, reason: string) {
  await user.click(await screen.findByRole('button', { name: new RegExp(`abrir sesión con ${alias}`, 'i') }));
  await waitFor(() => expect(screen.getByRole('button', { name: /^PTY$/i })).toBeEnabled());
  await user.click(screen.getByRole('button', { name: /^PTY$/i }));

  const dialog = await screen.findByRole('dialog');
  await user.type(within(dialog).getByRole('textbox'), reason);
  await user.click(within(dialog).getByRole('button', { name: /abrir sesión pty/i }));

  await waitFor(() => expect(StubWebSocket.instances).toHaveLength(1));
  return StubWebSocket.last();
}

it('opens simultaneous-capable agent sessions and publishes through the durable feed', async () => {
  const user = userEvent.setup();
  renderWithApi(<TerminalPage />);

  expect(await screen.findByRole('heading', { level: 1, name: 'Ultimate Terminal' })).toBeInTheDocument();
  expect(await screen.findByText('12 agentes')).toBeInTheDocument();
  await user.click(await screen.findByRole('button', { name: /abrir sesión con kant/i }));

  const input = await screen.findByRole('textbox', { name: /entrada para kant/i });
  await user.type(input, 'Verificá el estado operativo');
  await user.click(screen.getByRole('button', { name: /^enviar$/i }));

  expect(await screen.findByText(/Aceptado por el control plane/i)).toBeInTheDocument();
  expect(screen.getByRole('tab', { name: /kant/i })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByText(/no crea workers remotos/i)).toBeInTheDocument();
});

it('keeps the durable feed operational on a real PTY 501 and disables only PTY', async () => {
  const user = userEvent.setup();
  server.use(
    http.get('http://localhost/v3/console/access', () => HttpResponse.json({
      subject: 'Steven:kant', roles: ['operator'], permissions: ['message.publish', 'delivery.replay'],
    })),
    http.get('http://localhost/v3/console/terminal/capability', () => new HttpResponse(null, { status: 501 })),
  );
  renderWithApi(<TerminalPage />);

  await user.click(await screen.findByRole('button', { name: /abrir sesión con argos/i }));
  const input = await screen.findByRole('textbox', { name: /entrada para argos/i });
  await waitFor(() => expect(input).toBeEnabled());
  expect(screen.getByRole('button', { name: /^PTY$/i })).toBeDisabled();
  expect(screen.getByRole('button', { name: /^Feed$/i })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByText(/4 ACK/i)).toBeInTheDocument();

  await user.type(input, 'El feed no depende del PTY');
  await user.click(screen.getByRole('button', { name: /^enviar$/i }));
  expect(await screen.findByText(/Aceptado por el control plane/i)).toBeInTheDocument();
  expect(screen.getByText('DENIED')).toBeInTheDocument();
});

it('publishes cross-tenant from the operator source room and blocks destinations without ACL', async () => {
  const user = userEvent.setup();
  let published: Record<string, unknown> | undefined;
  server.use(http.post('http://localhost/v3/console/messages', async ({ request }) => {
    published = await request.json() as Record<string, unknown>;
    return HttpResponse.json({ message_id: 'cross-tenant-message' }, { status: 202 });
  }));
  renderWithApi(<TerminalPage />);

  await user.click(await screen.findByRole('button', { name: /abrir sesión con kratos/i }));
  const allowedInput = await screen.findByRole('textbox', { name: /entrada para kratos/i });
  await waitFor(() => expect(allowedInput).toBeEnabled());
  await user.type(allowedInput, 'Diagnóstico remoto');
  await user.click(screen.getByRole('button', { name: /^enviar$/i }));
  await waitFor(() => expect(published).toMatchObject({
    room_id: 'grp.steven',
    recipients: [{ tenant_id: 'Miguel', alias: 'kratos' }],
  }));

  await user.click(screen.getByRole('button', { name: /abrir sesión con salva/i }));
  expect(await screen.findByRole('textbox', { name: /entrada para salva/i })).toBeDisabled();
  expect(screen.getByText(/ACL Steven → Isa no concede route \+ control/i)).toBeInTheDocument();
});

it('derives the operator ACL from /v3/console/topology and never calls a route the gateway does not serve', async () => {
  const user = userEvent.setup();
  let phantomCalls = 0;
  // Reproduces production: the gateway only registers /v3/console/topology.
  server.use(http.get('*/v3/console/topology/access', () => {
    phantomCalls += 1;
    return HttpResponse.json({ error: 'not_found', message: 'Route GET:/v3/console/topology/access not found' }, { status: 404 });
  }));
  renderWithApi(<TerminalPage />);

  await user.click(await screen.findByRole('button', { name: /abrir sesión con kant/i }));
  const input = await screen.findByRole('textbox', { name: /entrada para kant/i });
  await waitFor(() => expect(input).toBeEnabled());
  expect(phantomCalls).toBe(0);
  expect(screen.queryByText(/Topología de acceso del tenant operador UNKNOWN/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/ACL del operador/i)).not.toBeInTheDocument();
});

it('labels every alias with an explicit PTY state instead of a spinner or a bare grey button', async () => {
  enableCapability();
  serveTargets([
    target({ tenant_id: 'Steven', alias: 'jarvis' }),
    target({ tenant_id: 'Steven', alias: 'argos', pty_state: 'not_installed', reason: 'El agente PTY no está instalado en ctrl-infra.' }),
    target({ tenant_id: 'Isa', alias: 'salva', authorized: false, reason: 'attribution_required: falta identidad por persona.' }),
  ]);
  renderWithApi(<TerminalPage />);

  expect(await screen.findByRole('button', { name: /abrir sesión con jarvis.*PTY: PTY online/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /abrir sesión con argos.*PTY: Agente PTY no instalado/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /abrir sesión con salva.*PTY: Sin autoridad/i })).toBeInTheDocument();
  // An alias the inventory never mentioned is UNKNOWN, never silently "available".
  expect(screen.getByRole('button', { name: /abrir sesión con kant.*PTY: PTY desconocido/i })).toBeInTheDocument();
  expect(await screen.findByText('1 / 3')).toBeInTheDocument();
});

it('disables PTY for a denied destination and shows the server motive, not an empty tooltip', async () => {
  const user = userEvent.setup();
  enableCapability();
  serveTargets([target({ tenant_id: 'Isa', alias: 'salva', authorized: false, reason: 'attribution_required: falta identidad por persona.' })]);
  renderWithApi(<TerminalPage />);

  await user.click(await screen.findByRole('button', { name: /abrir sesión con salva/i }));

  const ptyButton = await screen.findByRole('button', { name: /^PTY$/i });
  await waitFor(() => expect(ptyButton).toBeDisabled());
  expect(ptyButton).toHaveAttribute('title', expect.stringContaining('attribution_required'));
  expect(screen.getByText(/attribution_required: falta identidad por persona\./i)).toBeInTheDocument();
  // The motive is stated twice on purpose: in the fleet list and over the open session.
  expect(screen.getAllByText('Sin autoridad')).toHaveLength(2);
});

it('states not_installed explicitly rather than leaving the operator on a spinner', async () => {
  const user = userEvent.setup();
  enableCapability();
  serveTargets([target({ tenant_id: 'Steven', alias: 'argos', pty_state: 'not_installed', container: 'ctrl-infra', reason: 'El agente PTY no está instalado en ctrl-infra.' })]);
  renderWithApi(<TerminalPage />);

  await user.click(await screen.findByRole('button', { name: /abrir sesión con argos/i }));

  await waitFor(() => expect(screen.getByRole('button', { name: /^PTY$/i })).toBeDisabled());
  expect(screen.getAllByText('Agente PTY no instalado')).toHaveLength(2);
  expect(screen.getByText(/no está instalado en ctrl-infra/i)).toBeInTheDocument();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  // No spinner is left standing in place of an answer.
  expect(screen.queryByText(/Cargando Xterm/i)).not.toBeInTheDocument();
});

it('refuses to confirm without a written motive and spells out who shares the container', async () => {
  const user = userEvent.setup();
  enableCapability();
  serveTargets([target({ tenant_id: 'Steven', alias: 'jarvis', container: 'ws-humanizar', runtime_user: 'claw', shares_container_with: ['atlas', 'kratos'] })]);
  renderWithApi(<TerminalPage />);

  await user.click(await screen.findByRole('button', { name: /abrir sesión con jarvis/i }));
  await waitFor(() => expect(screen.getByRole('button', { name: /^PTY$/i })).toBeEnabled());
  await user.click(screen.getByRole('button', { name: /^PTY$/i }));

  const dialog = await screen.findByRole('dialog');
  // The blast radius is stated in plain words: this is not "the terminal of jarvis".
  expect(within(dialog).getByRole('alert')).toHaveTextContent(/atlas, kratos/);
  expect(within(dialog).getByRole('alert')).toHaveTextContent(/no es .la terminal de jarvis./i);
  expect(within(dialog).getByText('ws-humanizar')).toBeInTheDocument();

  const confirm = within(dialog).getByRole('button', { name: /abrir sesión pty/i });
  expect(confirm).toBeDisabled();
  await user.type(within(dialog).getByRole('textbox'), 'corto');
  expect(confirm).toBeDisabled();
  expect(within(dialog).getByText(/al menos 8 caracteres/i)).toBeInTheDocument();

  await user.type(within(dialog).getByRole('textbox'), ' pero ya no');
  expect(confirm).toBeEnabled();
  expect(StubWebSocket.instances).toHaveLength(0);
});

it('sends attach as the first frame and renders binary PTY output', async () => {
  const user = userEvent.setup();
  enableCapability();
  serveTargets([target({ tenant_id: 'Steven', alias: 'jarvis' })]);
  serveGrant();
  renderWithApi(<TerminalPage />);

  const socket = await openPtyChannel(user, 'jarvis', 'verificar el despliegue atrasado');

  expect(socket.frames()).toHaveLength(0);
  act(() => socket.acceptOpen());
  expect(socket.frames()[0]).toMatchObject({ type: 'attach', session_id: PTY_SESSION_ID, ticket: 'one-shot-ticket' });
  // Until the relay authorises, what is ticking is the single-use ticket window.
  expect(screen.getByLabelText('Sesión PTY activa')).toHaveTextContent(/Ticket vence en \d+:\d\d/);

  act(() => {
    socket.emitControl({ type: 'ready' });
    socket.emitOutput('claw@claw:~$ id -un\r\nclaw\r\n');
  });
  await waitFor(() => expect(ptySessionText(PTY_SESSION_ID)).toContain('claw@claw:~$ id -un'));

  // The permanent bar states who, where, as whom and how long is left.
  const bar = screen.getByLabelText('Sesión PTY activa');
  expect(bar).toHaveTextContent('jarvis');
  expect(bar).toHaveTextContent('claw');
  expect(bar).toHaveTextContent('shell');
  // The ticket is spent once the relay is ready; the bar says so instead of freezing at 0:00.
  expect(bar).toHaveTextContent(/Ticket consumido · sesión activa/);
  expect(within(bar).getByRole('button', { name: /cerrar sesión/i })).toBeInTheDocument();
  // An open PTY is the live source, so the redundant 2.5 s feed polling stands down.
  expect(screen.getByText('POLLING EN PAUSA')).toBeInTheDocument();
});

it.each([
  [4401, /Ticket inválido o vencido/i],
  [4403, /Permiso revocado/i],
  [4404, /El agente PTY no está conectado/i],
  [4408, /inactividad/i],
  [4409, /Ya hay una sesión abierta/i],
  [4413, /exceso de salida/i],
  [4423, /tiempo máximo de sesión/i],
  [4400, /Error de protocolo/i],
  [1011, /Error interno del relay/i],
])('explains close code %s in the panel', async (code, expected) => {
  const user = userEvent.setup();
  enableCapability();
  serveTargets([target({ tenant_id: 'Steven', alias: 'jarvis' })]);
  serveGrant();
  renderWithApi(<TerminalPage />);

  const socket = await openPtyChannel(user, 'jarvis', 'diagnóstico de la sesión');
  act(() => { socket.acceptOpen(); socket.emitControl({ type: 'ready' }); });
  act(() => socket.emitClose(code, 'server close'));

  expect(await screen.findByText(expected)).toBeInTheDocument();
  // A single-use ticket is never replayed: the offer is a brand-new, audited session.
  expect(await screen.findByRole('button', { name: /pedir sesión nueva/i })).toBeInTheDocument();
  expect(screen.getByText(/no reconecta sola/i)).toBeInTheDocument();
  expect(StubWebSocket.instances).toHaveLength(1);
});

it('releases the grant server-side when the operator closes the session', async () => {
  const user = userEvent.setup();
  let deleted: string | undefined;
  enableCapability();
  serveTargets([target({ tenant_id: 'Steven', alias: 'jarvis' })]);
  serveGrant();
  server.use(http.delete('*/v3/console/terminal/sessions/:sid', ({ params }) => {
    deleted = String(params.sid);
    return new HttpResponse(null, { status: 204 });
  }));
  renderWithApi(<TerminalPage />);

  const socket = await openPtyChannel(user, 'jarvis', 'cerrar despues de revisar');
  act(() => { socket.acceptOpen(); socket.emitControl({ type: 'ready' }); });

  await user.click(within(screen.getByLabelText('Sesión PTY activa')).getByRole('button', { name: /cerrar sesión/i }));

  await waitFor(() => expect(deleted).toBe(PTY_SESSION_ID));
  await waitFor(() => expect(screen.getByRole('button', { name: /^Feed$/i })).toHaveAttribute('aria-pressed', 'true'));
  expect(socket.closeCode).toBe(1000);
});

it('surfaces a 409 conflict from the gateway without opening any socket', async () => {
  const user = userEvent.setup();
  enableCapability();
  serveTargets([target({ tenant_id: 'Steven', alias: 'jarvis' })]);
  server.use(http.post('*/v3/console/terminal/sessions', () => HttpResponse.json({ error: 'conflict', reason: 'agent_offline' }, { status: 409 })));
  renderWithApi(<TerminalPage />);

  await user.click(await screen.findByRole('button', { name: /abrir sesión con jarvis/i }));
  await waitFor(() => expect(screen.getByRole('button', { name: /^PTY$/i })).toBeEnabled());
  await user.click(screen.getByRole('button', { name: /^PTY$/i }));
  const dialog = await screen.findByRole('dialog');
  await user.type(within(dialog).getByRole('textbox'), 'intento contra un agente caido');
  await user.click(within(dialog).getByRole('button', { name: /abrir sesión pty/i }));

  expect(await within(dialog).findByText('agent_offline')).toBeInTheDocument();
  expect(StubWebSocket.instances).toHaveLength(0);
});
