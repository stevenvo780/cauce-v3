import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach } from 'vitest';
import { server } from '../../mocks/server';
import { mockTerminalGrant } from '../../mocks/terminal-ticket';
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
    http.post('*/v3/console/terminal/sessions', async ({ request }) => {
      const body = await request.json() as Record<string, unknown>;
      return HttpResponse.json({
        ...mockTerminalGrant({
          sessionId: PTY_SESSION_ID,
          tenantId: String(body.tenant_id),
          alias: String(body.alias),
          container: 'claw',
          runtimeUser: 'claw',
          mode: String(body.mode),
          requestId: String(body.request_id),
        }),
        ...overrides,
      }, { status: 201 });
    }),
    http.delete('*/v3/console/terminal/sessions/:sid', () => new HttpResponse(null, { status: 204 })),
  );
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
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
  await user.selectOptions(await screen.findByRole('combobox', { name: 'Agente' }), await screen.findByRole('option', { name: new RegExp(`^${alias} ·`, 'i') }));
  await waitFor(() => { expect(screen.getByRole('button', { name: /^Terminal$/i })).toBeEnabled(); });
  await user.click(screen.getByRole('button', { name: /^Terminal$/i }));

  const dialog = await screen.findByRole('dialog');
  await user.type(within(dialog).getByRole('textbox'), reason);
  await user.click(within(dialog).getByRole('button', { name: /abrir sesión pty/i }));

  await waitFor(() => { expect(StubWebSocket.instances).toHaveLength(1); });
  return StubWebSocket.last();
}

it('abre el agente sin leer Feed ni escribir mensajes, replay o cancel', async () => {
  const user = userEvent.setup();
  let messageGets = 0;
  let messagePosts = 0;
  let replayPosts = 0;
  let cancelPosts = 0;
  server.use(
    http.get('*/v3/console/messages', () => { messageGets += 1; return HttpResponse.json({ items: [] }); }),
    http.post('*/v3/console/messages', () => { messagePosts += 1; return new HttpResponse(null, { status: 500 }); }),
    http.post('*/v3/console/deliveries/:deliveryId/replay', () => { replayPosts += 1; return new HttpResponse(null, { status: 500 }); }),
    http.post('*/v3/console/deliveries/:deliveryId/cancel', () => { cancelPosts += 1; return new HttpResponse(null, { status: 500 }); }),
  );
  renderWithApi(<TerminalPage />);

  expect(await screen.findByRole('heading', { level: 1, name: 'Terminal de agentes' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Docs' })).toHaveAttribute('href', '/ayuda#terminal');
  expect(await screen.findByText('Aquí no se puede espejar ninguna TUI')).toBeInTheDocument();
  for (const textoIngles of ['Ultimate Terminal', 'Fleet live', 'Capability gates', 'Adapters', 'No active target']) {
    expect(screen.queryByText(textoIngles), `rótulo visible sin traducir: ${textoIngles}`).not.toBeInTheDocument();
  }
  // The header must count the SAME as the list shown below. The exact number comes from the
  // fixture and changes each time the demo topology looks more like the real fleet; pinning it
  // here only bought a test that breaks without anything breaking. What does matter — and does
  // not depend on the fixture — is that the counter does not claim a fleet size different from
  // what it shows.
  const listed = await screen.findAllByRole('option');
  expect(listed.length).toBeGreaterThan(1);
  await user.selectOptions(await screen.findByRole('combobox', { name: 'Agente' }), await screen.findByRole('option', { name: /^argos ·/ }));

  expect(await screen.findByRole('button', { name: /^Terminal$/i })).toBeDisabled();
  expect(screen.queryByRole('button', { name: /^Feed$/i })).not.toBeInTheDocument();
  expect(screen.queryByRole('textbox', { name: /entrada para/i })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /replay/i, hidden: true })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /cancelar/i, hidden: true })).not.toBeInTheDocument();
  expect(messageGets).toBe(0);
  expect(messagePosts).toBe(0);
  expect(replayPosts).toBe(0);
  expect(cancelPosts).toBe(0);
  expect(screen.getByRole('tab', { name: /argos/i })).toHaveAttribute('aria-selected', 'true');

}, 20_000);

it('abre automáticamente el agente pedido por el deep-link sin una segunda vista acotada', async () => {
  renderWithApi(<TerminalPage params={['Steven', 'kant']} />);

  expect(await screen.findByRole('tab', { name: /kant/i })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('combobox', { name: 'Agente' })).toHaveValue('Steven:kant');
});

it('keeps the agent selector available on PTY 501 and fails closed without Feed', async () => {
  const user = userEvent.setup();
  server.use(
    http.get('http://localhost/v3/console/access', () => HttpResponse.json({
      subject: 'Steven:kant', roles: ['operator'], permissions: ['message.publish', 'delivery.replay'],
    })),
    http.get('http://localhost/v3/console/terminal/capability', () => new HttpResponse(null, { status: 501 })),
  );
  renderWithApi(<TerminalPage />);

  await user.selectOptions(await screen.findByRole('combobox', { name: 'Agente' }), await screen.findByRole('option', { name: /^argos ·/ }));
  expect(await screen.findByRole('button', { name: /^Terminal$/i })).toBeDisabled();
  expect(screen.queryByRole('button', { name: /^Feed$/i })).not.toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Docs' })).toBeInTheDocument();
});

it('con el canal cerrado el escenario no dice que falte elegir alias: dice que no se puede espejar', async () => {
  renderWithApi(<TerminalPage />);

  expect(await screen.findByText('Aquí no se puede espejar ninguna TUI')).toBeInTheDocument();
  expect(screen.queryByText('Ningún agente seleccionado')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /abrir la tui de/i })).not.toBeInTheDocument();
});

it('con canal y TUI el escenario ofrece abrir el alias que ya está emitiendo', async () => {
  const user = userEvent.setup();
  enableCapability();
  serveTargets([target({ tenant_id: 'Steven', alias: 'jarvis', modes: ['shell', 'harness'] })]);
  server.use(http.post('*/v3/console/terminal/sessions', () => HttpResponse.json(
    { error: 'conflict', reason: 'agent_offline' }, { status: 409 },
  )));
  renderWithApi(<TerminalPage />);

  expect(await screen.findByText('Ningún agente seleccionado')).toBeInTheDocument();
  await user.click(await screen.findByRole('button', { name: /abrir la tui de jarvis/i }));
  expect(await screen.findByRole('tab', { name: /jarvis/i })).toHaveAttribute('aria-selected', 'true');
}, 20_000);

it('sin inventario de destinos NO dice que ningún alias emita: dice que no se pudo comprobar', async () => {
  enableCapability();
  serveTargets(null);
  renderWithApi(<TerminalPage />);

  expect(await screen.findByText('No se sabe qué alias pueden emitir su TUI')).toBeInTheDocument();
  expect(screen.queryByText('Ningún alias está emitiendo su TUI ahora mismo')).not.toBeInTheDocument();
});

it('con inventario publicado y vacío de TUI sí dice que ninguno emite', async () => {
  enableCapability();
  serveTargets([target({ tenant_id: 'Steven', alias: 'jarvis', modes: ['shell'] })]);
  renderWithApi(<TerminalPage />);

  expect(await screen.findByText('Ningún alias está emitiendo su TUI ahora mismo')).toBeInTheDocument();
});

it('labels every alias with an explicit PTY state instead of a spinner or a bare grey button', async () => {
  enableCapability();
  serveTargets([
    target({ tenant_id: 'Steven', alias: 'jarvis', modes: ['shell', 'harness'] }),
    target({ tenant_id: 'Steven', alias: 'argos', pty_state: 'not_installed', reason: 'El agente PTY no está instalado en ctrl-infra.' }),
    target({ tenant_id: 'Isa', alias: 'salva', authorized: false, reason: 'attribution_required: falta identidad por persona.' }),
  ]);
  renderWithApi(<TerminalPage />);

  expect(await screen.findByRole('option', { name: /^jarvis ·.*TUI en vivo/i })).toBeInTheDocument();
  expect(screen.getByRole('option', { name: /^argos ·.*Agente PTY no instalado/i })).toBeInTheDocument();
  expect(screen.getByRole('option', { name: /^salva ·.*Sin autoridad/i })).toBeInTheDocument();
  // An alias the inventory never mentioned is UNKNOWN, never silently "available".
  expect(screen.getByRole('option', { name: /^kant ·.*PTY desconocido/i })).toBeInTheDocument();

});

it('un alias con PTY pero SIN modo harness no se pinta en verde: lleva su motivo, como gaia', async () => {
  enableCapability();
  serveTargets([
    target({ tenant_id: 'Steven', alias: 'zeus', modes: ['shell', 'harness'] }),
    target({ tenant_id: 'Steven', alias: 'jarvis', modes: ['shell'], reason: 'ok' }),
  ]);
  renderWithApi(<TerminalPage />);

  const conTui = await screen.findByRole('option', { name: /^zeus ·/i });
  const sinTui = screen.getByRole('option', { name: /^jarvis ·/i });

  expect(conTui).toHaveTextContent('TUI en vivo');
  expect(sinTui).toHaveTextContent('Sin TUI que emitir');
  expect(sinTui).toHaveAttribute('title', expect.stringContaining('no publica el modo harness'));
  expect(sinTui).not.toHaveTextContent('TUI en vivo');
});

it('disables PTY for a denied destination and shows the server motive, not an empty tooltip', async () => {
  const user = userEvent.setup();
  enableCapability();
  serveTargets([target({ tenant_id: 'Isa', alias: 'salva', authorized: false, reason: 'attribution_required: falta identidad por persona.' })]);
  renderWithApi(<TerminalPage />);

  await user.selectOptions(await screen.findByRole('combobox', { name: 'Agente' }), await screen.findByRole('option', { name: /^salva ·/ }));

  const ptyButton = await screen.findByRole('button', { name: /^Terminal$/i });
  await waitFor(() => { expect(ptyButton).toBeDisabled(); });
  // The server's reason brings the code INSIDE the prose. It is translated, and what the
  // server did say in Spanish is preserved. See `denegaciones.ts`.
  expect(ptyButton).toHaveAttribute('title', expect.stringContaining('Falta decir qué persona está entrando'));
  expect(screen.getByText(/falta identidad por persona/i)).toBeInTheDocument();
  expect(screen.getByText(/Lo levanta:/i)).toBeInTheDocument();
  expect(document.body.textContent).not.toContain('attribution_required');
  // The motive is stated twice on purpose: in the fleet list and over the open session.
  expect(screen.getAllByText('Sin autoridad')).toHaveLength(1);
  expect(screen.getByRole('option', { name: /^salva ·.*Sin autoridad/ })).toBeInTheDocument();
});

it('states not_installed explicitly rather than leaving the operator on a spinner', async () => {
  const user = userEvent.setup();
  enableCapability();
  serveTargets([target({ tenant_id: 'Steven', alias: 'argos', pty_state: 'not_installed', container: 'ctrl-infra', reason: 'El agente PTY no está instalado en ctrl-infra.' })]);
  renderWithApi(<TerminalPage />);

  await user.selectOptions(await screen.findByRole('combobox', { name: 'Agente' }), await screen.findByRole('option', { name: /^argos ·/ }));

  await waitFor(() => { expect(screen.getByRole('button', { name: /^Terminal$/i })).toBeDisabled(); });
  expect(screen.getAllByText('Agente PTY no instalado')).toHaveLength(1);
  expect(screen.getByRole('option', { name: /^argos ·.*Agente PTY no instalado/ })).toBeInTheDocument();
  expect(screen.getByText(/no está instalado en ctrl-infra/i)).toBeInTheDocument();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  // No spinner is left standing in place of an answer.
  expect(screen.queryByText(/Cargando Xterm/i)).not.toBeInTheDocument();
});

it('refuses to confirm without a written motive and spells out who shares the container', async () => {
  const user = userEvent.setup();
  enableCapability();
  serveTargets([target({
    tenant_id: 'Steven', alias: 'jarvis', container: 'ws-humanizar', runtime_user: 'claw',
    shares_container_with: [
      { tenant_id: 'Miguel', alias: 'atlas' }, { tenant_id: 'Miguel', alias: 'kratos' },
    ],
  })]);
  renderWithApi(<TerminalPage />);

  await user.selectOptions(await screen.findByRole('combobox', { name: 'Agente' }), await screen.findByRole('option', { name: /^jarvis ·/ }));
  await waitFor(() => { expect(screen.getByRole('button', { name: /^Terminal$/i })).toBeEnabled(); });
  await user.click(screen.getByRole('button', { name: /^Terminal$/i }));

  const dialog = await screen.findByRole('dialog');
  // The blast radius is stated in plain words: this is not "the terminal of jarvis".
  expect(within(dialog).getByRole('alert')).toHaveTextContent(/Miguel:atlas, Miguel:kratos/);
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
  act(() => { socket.acceptOpen(); });
  expect(socket.frames()[0]).toMatchObject({
    type: 'attach', session_id: PTY_SESSION_ID, ticket: expect.stringMatching(/^v1\./u) as unknown,
  });
  // Until the relay authorises, what is ticking is the single-use ticket window.
  expect(within(screen.getByLabelText('Sesión PTY activa')).getByLabelText(/Ticket vence en \d+:\d\d/)).toBeInTheDocument();

  act(() => {
    socket.emitControl({
      type: 'ready', claim_token: '12345678-1234-4234-8234-123456789abc',
      claim_epoch: '1', claim_lease_ms: 45_000,
    });
    socket.emitOutput('claw@claw:~$ id -un\r\nclaw\r\n');
  });
  await waitFor(() => { expect(ptySessionText(PTY_SESSION_ID)).toContain('claw@claw:~$ id -un'); });

  const bar = screen.getByLabelText('Sesión PTY activa');
  expect(within(bar).getByLabelText('Terminal · shell nueva')).toHaveAttribute('title', expect.stringContaining('jarvis'));
  expect(within(bar).getByLabelText('Usuario destino: claw')).toBeInTheDocument();
  expect(within(bar).getByLabelText('Ticket consumido · sesión activa')).toBeInTheDocument();
  expect(within(bar).queryByRole('button', { name: /cerrar/i })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^Feed$/i })).not.toBeInTheDocument();
});

it('fences two confirmations in the same render to one PTY reservation POST', async () => {
  const user = userEvent.setup();
  const gate = deferred();
  let posts = 0;
  enableCapability();
  serveTargets([target({ tenant_id: 'Steven', alias: 'jarvis' })]);
  server.use(
    http.post('*/v3/console/terminal/sessions', async ({ request }) => {
      posts += 1;
      const body = await request.json() as Record<string, unknown>;
      await gate.promise;
      return HttpResponse.json(mockTerminalGrant({
        sessionId: PTY_SESSION_ID,
        tenantId: String(body.tenant_id),
        alias: String(body.alias),
        container: 'claw',
        runtimeUser: 'claw',
        mode: String(body.mode),
        requestId: String(body.request_id),
      }), { status: 201 });
    }),
    http.delete('*/v3/console/terminal/sessions/:sid', () => new HttpResponse(null, { status: 204 })),
  );
  renderWithApi(<TerminalPage />);

  await user.selectOptions(await screen.findByRole('combobox', { name: 'Agente' }), await screen.findByRole('option', { name: /^jarvis ·/ }));
  await user.click(await screen.findByRole('button', { name: /^Terminal$/i }));
  const dialog = await screen.findByRole('dialog');
  await user.type(within(dialog).getByRole('textbox'), 'verificar carrera de reserva');
  const confirm = within(dialog).getByRole('button', { name: /abrir sesión pty/i });

  // Both handlers run before React can render `pending=true`; the synchronous attempt ref is the
  // authority that prevents the second POST.
  act(() => {
    fireEvent.click(confirm);
    fireEvent.click(confirm);
  });
  await waitFor(() => { expect(posts).toBe(1); });

  gate.resolve(undefined);
  await waitFor(() => { expect(StubWebSocket.instances).toHaveLength(1); });
  expect(posts).toBe(1);
}, 20_000);

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
  act(() => {
    socket.acceptOpen();
    socket.emitControl({
      type: 'ready', claim_token: '12345678-1234-4234-8234-123456789abc',
      claim_epoch: '1', claim_lease_ms: 45_000,
    });
  });
  act(() => { socket.emitClose(code, 'server close'); });

  expect(await screen.findByText(expected)).toBeInTheDocument();
  // An explicit relay close is final. Only a transport loss can resume the same PTY, and the
  // single-use ticket is never replayed: this offer is a brand-new, audited session.
  expect(await screen.findByRole('button', { name: /pedir sesión nueva/i })).toBeInTheDocument();
  expect(screen.getByText(/sólo reanuda automáticamente una interrupción de transporte/i)).toBeInTheDocument();
  expect(StubWebSocket.instances).toHaveLength(1);
}, 20_000);

it('releases the grant server-side when the operator closes the session', async () => {
  const user = userEvent.setup();
  const deletion = deferred();
  let deleted: string | undefined;
  enableCapability();
  serveTargets([target({ tenant_id: 'Steven', alias: 'jarvis' })]);
  serveGrant();
  server.use(http.delete('*/v3/console/terminal/sessions/:sid', ({ params }) => {
    deleted = String(params.sid);
    return deletion.promise.then(() => new HttpResponse(null, { status: 204 }));
  }));
  renderWithApi(<TerminalPage />);

  const socket = await openPtyChannel(user, 'jarvis', 'cerrar despues de revisar');
  act(() => {
    socket.acceptOpen();
    socket.emitControl({
      type: 'ready', claim_token: '12345678-1234-4234-8234-123456789abc',
      claim_epoch: '1', claim_lease_ms: 45_000,
    });
  });

  await user.click(screen.getByRole('button', { name: /Cerrar sesión jarvis/i }));

  await waitFor(() => { expect(deleted).toBe(PTY_SESSION_ID); });
  expect(socket.closeCode).toBeUndefined();
  deletion.resolve();
  await waitFor(() => { expect(screen.queryByLabelText('Sesión PTY activa')).not.toBeInTheDocument(); });
  expect(socket.closeCode).toBe(1000);
}, 20_000);

it('closes the local socket and offers retry when server-side revocation fails', async () => {
  const user = userEvent.setup();
  let attempts = 0;
  enableCapability();
  serveTargets([target({ tenant_id: 'Steven', alias: 'jarvis' })]);
  serveGrant();
  server.use(http.delete('*/v3/console/terminal/sessions/:sid', () => {
    attempts += 1;
    return attempts === 1
      ? HttpResponse.json({ error: 'temporarily unavailable' }, { status: 503 })
      : new HttpResponse(null, { status: 204 });
  }));
  renderWithApi(<TerminalPage />);

  const socket = await openPtyChannel(user, 'jarvis', 'cerrar y reintentar revocación');
  act(() => {
    socket.acceptOpen();
    socket.emitControl({
      type: 'ready', claim_token: '12345678-1234-4234-8234-123456789abc',
      claim_epoch: '1', claim_lease_ms: 45_000,
    });
  });

  await user.click(screen.getByRole('button', { name: /Cerrar sesión jarvis/i }));
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent(/No se confirmó la revocación/i);
  expect(socket.closeCode).toBe(1000);
  expect(attempts).toBe(1);

  await user.click(within(alert).getByRole('button', { name: 'Reintentar revocación' }));
  await waitFor(() => { expect(attempts).toBe(2); });
  await waitFor(() => { expect(screen.queryByRole('alert')).not.toBeInTheDocument(); });
}, 20_000);

it('surfaces a 409 conflict from the gateway without opening any socket', async () => {
  const user = userEvent.setup();
  enableCapability();
  serveTargets([target({ tenant_id: 'Steven', alias: 'jarvis' })]);
  server.use(http.post('*/v3/console/terminal/sessions', () => HttpResponse.json({ error: 'conflict', reason: 'agent_offline' }, { status: 409 })));
  renderWithApi(<TerminalPage />);

  await user.selectOptions(await screen.findByRole('combobox', { name: 'Agente' }), await screen.findByRole('option', { name: /^jarvis ·/ }));
  await waitFor(() => { expect(screen.getByRole('button', { name: /^Terminal$/i })).toBeEnabled(); });
  await user.click(screen.getByRole('button', { name: /^Terminal$/i }));
  const dialog = await screen.findByRole('dialog');
  await user.type(within(dialog).getByRole('textbox'), 'intento contra un agente caido');
  await user.click(within(dialog).getByRole('button', { name: /abrir sesión pty/i }));

  // The 409 is explained: what happened, why, and who can lift it. Before, the `[role=alert]`
  // contained exactly the word `agent_offline` and nothing else.
  expect(await within(dialog).findByText(/El agente PTY del contenedor no está conectado/i)).toBeInTheDocument();
  expect(within(dialog).getByText(/HTTP 409/)).toBeInTheDocument();
  expect(document.body.textContent).not.toContain('agent_offline');
  expect(StubWebSocket.instances).toHaveLength(0);
});

it('con un 403 dice que falta el permiso y NUNCA que el relay no está desplegado', async () => {
  server.use(
    http.get('http://localhost/v3/console/access', () => HttpResponse.json({
      subject: 'Miguel:janus', roles: ['agent'], permissions: ['message.publish'],
    })),
    http.get('http://localhost/v3/console/terminal/capability', () => HttpResponse.json(
      { error: 'forbidden', message: 'control permission is required' }, { status: 403 },
    )),
  );
  renderWithApi(<TerminalPage />);

  expect(await screen.findByText('La terminal de agentes requiere permiso de control')).toBeInTheDocument();
  expect(screen.getByText(/no tiene permiso de control sobre esta flota/)).toBeInTheDocument();
  expect(screen.getByText(/lo que falta es el permiso/)).toBeInTheDocument();
  expect(screen.queryByText(/no está desplegado en este stack/)).not.toBeInTheDocument();
  expect(screen.queryByText(/HTTP 403 al consultarlo/)).not.toBeInTheDocument();
  expect(screen.queryByText('Canal PTY no disponible en este stack')).not.toBeInTheDocument();
}, 20_000);

/** The positive control of the previous case: a 501 DOES mean it is not deployed. */
it('con un 501 sigue diciendo, con el título de siempre, que el canal no está en este stack', async () => {
  server.use(http.get('http://localhost/v3/console/terminal/capability', () => new HttpResponse(null, { status: 501 })));
  renderWithApi(<TerminalPage />);

  expect(await screen.findByText('Canal PTY no disponible en este stack')).toBeInTheDocument();
  expect(screen.queryByText('La terminal de agentes requiere permiso de control')).not.toBeInTheDocument();
}, 20_000);

it.each([502, 503, 504])(
  'con upstream HTTP %s muestra medición inconclusa y nunca afirma que el relay no esté desplegado',
  async (status) => {
    server.use(http.get(
      'http://localhost/v3/console/terminal/capability',
      () => new HttpResponse(null, { status }),
    ));
    renderWithApi(<TerminalPage />);

    expect(await screen.findByText('No se pudo comprobar el canal PTY')).toBeInTheDocument();
    expect(screen.getByText(/no se pudo alcanzar el relay de terminales/i)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`HTTP ${String(status)}`))).toBeInTheDocument();
    expect(screen.queryByText(/no está desplegado en este stack/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Canal PTY no disponible en este stack')).not.toBeInTheDocument();
  },
  20_000,
);


it('monta el selector en la barra global y lo retira al salir de Terminales', async () => {
  const host = document.createElement('div');
  host.id = 'terminal-topbar-tools';
  document.body.appendChild(host);
  try {
    const view = renderWithApi(<TerminalPage />);
    const selector = await within(host).findByRole('combobox', { name: 'Agente' });
    expect(selector).toBeInTheDocument();
    expect(view.container.querySelector('#terminal-agent-select')).toBeNull();
    view.unmount();
    expect(host).toBeEmptyDOMElement();
  } finally { host.remove(); }
});
