import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach } from 'vitest';
import { server } from '../../mocks/server';
import { mockTerminalGrant } from '../../mocks/terminal-ticket';
import { renderWithApi } from '../../test/render';
import { must } from '../../test/must';
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

function renderAgent(alias: string, tenant = 'Steven') {
  return renderWithApi(<TerminalPage params={[tenant, alias]} />);
}

/** One click on the mode switch: there is no confirmation step between the operator and the socket. */
async function openPtyChannel(user: ReturnType<typeof userEvent.setup>) {
  await waitFor(() => { expect(screen.getByRole('button', { name: /^Terminal$/i })).toBeEnabled(); });
  await user.click(screen.getByRole('button', { name: /^Terminal$/i }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  await waitFor(() => { expect(StubWebSocket.instances).toHaveLength(1); });
  return StubWebSocket.last();
}

it('en /terminal ofrece las tarjetas de agentes y no escribe mensajes, replay ni cancel', async () => {
  let messagePosts = 0;
  let replayPosts = 0;
  let cancelPosts = 0;
  server.use(
    http.post('*/v3/console/messages', () => { messagePosts += 1; return new HttpResponse(null, { status: 500 }); }),
    http.post('*/v3/console/deliveries/:deliveryId/replay', () => { replayPosts += 1; return new HttpResponse(null, { status: 500 }); }),
    http.post('*/v3/console/deliveries/:deliveryId/cancel', () => { cancelPosts += 1; return new HttpResponse(null, { status: 500 }); }),
  );
  renderWithApi(<TerminalPage />);

  expect(await screen.findByRole('heading', { level: 1, name: 'Terminal de agentes' })).toBeInTheDocument();
  expect(await screen.findByText('Aquí no se puede espejar ninguna TUI', { exact: false })).toBeInTheDocument();
  for (const textoIngles of ['Ultimate Terminal', 'Fleet live', 'Capability gates', 'Adapters', 'No active target']) {
    expect(screen.queryByText(textoIngles), `rótulo visible sin traducir: ${textoIngles}`).not.toBeInTheDocument();
  }
  const cards = await within(await screen.findByRole('list', { name: 'Agentes' })).findAllByRole('link');
  expect(cards.length).toBeGreaterThan(1);
  expect(screen.getByRole('link', { name: /^argos/ })).toHaveAttribute('href', '/terminal/Steven/argos');
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  expect(screen.queryByRole('textbox', { name: /entrada para/i })).not.toBeInTheDocument();
  expect(messagePosts + replayPosts + cancelPosts).toBe(0);
}, 20_000);

it('abre el agente pedido por la dirección con Feed, TUI y Terminal en un solo selector', async () => {
  renderAgent('kant');

  expect(await screen.findByRole('heading', { level: 2, name: /kant/ })).toBeInTheDocument();
  const modes = screen.getByRole('group', { name: 'Vista de la sesión' });
  expect(within(modes).getAllByRole('button').map((button) => button.textContent)).toEqual(['Feed', 'TUI', 'Terminal']);
  expect(within(modes).getByRole('button', { name: 'Feed' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
});

it('con el PTY en 501 el agente se ve en Feed y TUI y Terminal quedan cerrados', async () => {
  server.use(
    http.get('http://localhost/v3/console/access', () => HttpResponse.json({
      subject: 'Steven:kant', roles: ['operator'], permissions: ['message.publish', 'delivery.replay'],
    })),
    http.get('http://localhost/v3/console/terminal/capability', () => new HttpResponse(null, { status: 501 })),
  );
  renderAgent('argos');

  expect(await screen.findByRole('button', { name: /^Terminal$/i })).toBeDisabled();
  expect(screen.getByRole('button', { name: /^TUI$/i })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Feed' })).toBeEnabled();
});

it('con el canal cerrado el selector no ofrece ninguna TUI y dice por qué', async () => {
  renderWithApi(<TerminalPage />);

  expect(await screen.findByText('Aquí no se puede espejar ninguna TUI', { exact: false })).toBeInTheDocument();
  expect(screen.queryByText('Elegí un agente para abrir su TUI')).not.toBeInTheDocument();
});

it('con canal y TUI la tarjeta del alias que emite lo marca y lleva primero', async () => {
  enableCapability();
  serveTargets([target({ tenant_id: 'Steven', alias: 'jarvis', modes: ['shell', 'harness'] })]);
  renderWithApi(<TerminalPage />);

  const first = (await within(await screen.findByRole('list', { name: 'Agentes' })).findAllByRole('link'))[0];
  expect(first).toHaveTextContent(/jarvis/);
  expect(first).toHaveTextContent('TUI en vivo');
  expect(screen.queryByText(/Aquí no se puede espejar|Ningún alias está emitiendo/)).not.toBeInTheDocument();
}, 20_000);

it('sin inventario de destinos NO dice que ningún alias emita: dice que no se pudo comprobar', async () => {
  enableCapability();
  serveTargets(null);
  renderWithApi(<TerminalPage />);

  expect(await screen.findByText('No se sabe qué alias pueden emitir su TUI', { exact: false })).toBeInTheDocument();
  expect(screen.queryByText('Ningún alias está emitiendo su TUI ahora mismo', { exact: false })).not.toBeInTheDocument();
});

it('con inventario publicado y vacío de TUI sí dice que ninguno emite', async () => {
  enableCapability();
  serveTargets([target({ tenant_id: 'Steven', alias: 'jarvis', modes: ['shell'] })]);
  renderWithApi(<TerminalPage />);

  expect(await screen.findByText('Ningún alias está emitiendo su TUI ahora mismo', { exact: false })).toBeInTheDocument();
});

it('cada tarjeta lleva un estado PTY explícito, nunca un botón gris sin motivo', async () => {
  enableCapability();
  serveTargets([
    target({ tenant_id: 'Steven', alias: 'jarvis', modes: ['shell', 'harness'] }),
    target({ tenant_id: 'Steven', alias: 'argos', pty_state: 'not_installed', reason: 'El agente PTY no está instalado en ctrl-infra.' }),
    target({ tenant_id: 'Isa', alias: 'salva', authorized: false, reason: 'attribution_required: falta identidad por persona.' }),
  ]);
  renderWithApi(<TerminalPage />);

  expect(await screen.findByRole('link', { name: /^jarvis.*TUI en vivo/i })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: /^argos.*Conexión sin comprobar/i })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: /^salva.*Sin autoridad/i })).toBeInTheDocument();
  // An alias the inventory never mentioned is UNKNOWN, never silently "available".
  expect(screen.getByRole('link', { name: /^kant.*Conexión sin comprobar/i })).toBeInTheDocument();
});

it('un alias con PTY pero SIN modo harness no se pinta en verde: lleva su motivo', async () => {
  enableCapability();
  serveTargets([
    target({ tenant_id: 'Steven', alias: 'zeus', modes: ['shell', 'harness'] }),
    target({ tenant_id: 'Steven', alias: 'jarvis', modes: ['shell'], reason: 'ok' }),
  ]);
  renderWithApi(<TerminalPage />);

  const conTui = await screen.findByRole('link', { name: /^zeus/i });
  const sinTui = screen.getByRole('link', { name: /^jarvis/i });

  expect(conTui).toHaveTextContent('TUI en vivo');
  expect(sinTui).toHaveTextContent('Sin TUI que emitir');
  expect(within(sinTui).getByText('Sin TUI que emitir')).toHaveAttribute('title', expect.stringContaining('no publica el modo harness'));
  expect(sinTui).not.toHaveTextContent('TUI en vivo');
});

it('disables PTY for a denied destination and shows the server motive, not an empty tooltip', async () => {
  enableCapability();
  serveTargets([target({ tenant_id: 'Isa', alias: 'salva', authorized: false, reason: 'attribution_required: falta identidad por persona.' })]);
  renderAgent('salva', 'Isa');

  const ptyButton = await screen.findByRole('button', { name: /^Terminal$/i });
  await waitFor(() => { expect(ptyButton).toBeDisabled(); });
  // The server's reason brings the code INSIDE the prose. It is translated, and what the
  // server did say in Spanish is preserved. See `denegaciones.ts`.
  expect(ptyButton).toHaveAttribute('title', expect.stringContaining('Falta decir qué persona está entrando'));
  expect(await screen.findByText(/falta identidad por persona/i)).toBeInTheDocument();
  expect(document.body.textContent).not.toContain('attribution_required');
  expect(screen.getAllByText(/Sin autoridad/)).toHaveLength(1);
});

it('treats legacy not_installed metadata as an unobserved connection, not proof of absence', async () => {
  enableCapability();
  serveTargets([target({ tenant_id: 'Steven', alias: 'argos', pty_state: 'not_installed', container: 'ctrl-infra', reason: 'El agente PTY no está instalado en ctrl-infra.' })]);
  renderAgent('argos');

  await waitFor(() => { expect(screen.getByRole('button', { name: /^Terminal$/i })).toBeDisabled(); });
  expect(await screen.findByText(/Conexión sin comprobar\./)).toBeInTheDocument();
  expect(screen.getByText(/(?:no se observó presencia|presencia no observada).*instalación.*sin comprobar/i)).toBeInTheDocument();
  expect(document.body.textContent).not.toMatch(/nunca tuvo agente|no está instalado en ctrl-infra/i);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.queryByText(/Cargando Xterm/i)).not.toBeInTheDocument();
});

it('muestra el aviso de contenedor compartido en la propia vista, sin modal ni cuadro de texto', async () => {
  const user = userEvent.setup();
  enableCapability();
  serveTargets([target({
    tenant_id: 'Steven', alias: 'jarvis', container: 'ws-humanizar', runtime_user: 'claw',
    shares_container_with: [
      { tenant_id: 'Miguel', alias: 'atlas' }, { tenant_id: 'Miguel', alias: 'kratos' },
    ],
  })]);
  serveGrant();
  renderAgent('jarvis');

  await waitFor(() => { expect(screen.getByRole('button', { name: /^Terminal$/i })).toBeEnabled(); });
  // The blast radius is on the control itself before the click, and inline after it.
  expect(screen.getByRole('button', { name: /^Terminal$/i })).toHaveAttribute('title', expect.stringContaining('Miguel:atlas, Miguel:kratos'));
  await user.click(screen.getByRole('button', { name: /^Terminal$/i }));

  const warning = await screen.findByRole('alert');
  expect(warning).toHaveTextContent(/Este contenedor lo comparten Miguel:atlas, Miguel:kratos/);
  expect(warning).toHaveTextContent(/no es .la terminal de jarvis./i);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  await waitFor(() => { expect(StubWebSocket.instances).toHaveLength(1); });
});

it('sends attach as the first frame and renders binary PTY output', async () => {
  const user = userEvent.setup();
  enableCapability();
  serveTargets([target({ tenant_id: 'Steven', alias: 'jarvis' })]);
  serveGrant();
  renderAgent('jarvis');

  const socket = await openPtyChannel(user);

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
  expect(screen.getByRole('button', { name: /^Terminal$/i })).toHaveAttribute('aria-pressed', 'true');
});

it('fences two clicks in the same render to one PTY reservation POST', async () => {
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
  renderAgent('jarvis');

  const terminal = await screen.findByRole('button', { name: /^Terminal$/i });
  await waitFor(() => { expect(terminal).toBeEnabled(); });
  expect(user).toBeDefined();

  // Both handlers run before React can render `requesting=true`; the synchronous attempt ref is
  // the authority that prevents the second POST.
  act(() => {
    fireEvent.click(terminal);
    fireEvent.click(terminal);
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
  renderAgent('jarvis');

  const socket = await openPtyChannel(user);
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

/** The menu is the only place that closes the session. */
async function closeSessionFromMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Más acciones' }));
  await user.click(await screen.findByRole('menuitem', { name: /cerrar sesión pty/i }));
}

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
  renderAgent('jarvis');

  const socket = await openPtyChannel(user);
  act(() => {
    socket.acceptOpen();
    socket.emitControl({
      type: 'ready', claim_token: '12345678-1234-4234-8234-123456789abc',
      claim_epoch: '1', claim_lease_ms: 45_000,
    });
  });

  await closeSessionFromMenu(user);

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
  renderAgent('jarvis');

  const socket = await openPtyChannel(user);
  act(() => {
    socket.acceptOpen();
    socket.emitControl({
      type: 'ready', claim_token: '12345678-1234-4234-8234-123456789abc',
      claim_epoch: '1', claim_lease_ms: 45_000,
    });
  });

  await closeSessionFromMenu(user);
  const alert = await screen.findByText(/No se confirmó la revocación/i);
  expect(socket.closeCode).toBe(1000);
  expect(attempts).toBe(1);

  await user.click(within(must(alert.closest<HTMLElement>('[role="alert"]'), 'the alert container')).getByRole('button', { name: 'Reintentar revocación' }));
  await waitFor(() => { expect(attempts).toBe(2); });
  await waitFor(() => { expect(screen.queryByText(/No se confirmó la revocación/i)).not.toBeInTheDocument(); });
}, 20_000);

it('surfaces a 409 conflict from the gateway inline, without a modal and without opening any socket', async () => {
  const user = userEvent.setup();
  enableCapability();
  serveTargets([target({ tenant_id: 'Steven', alias: 'jarvis' })]);
  server.use(http.post('*/v3/console/terminal/sessions', () => HttpResponse.json({ error: 'conflict', reason: 'agent_offline' }, { status: 409 })));
  renderAgent('jarvis');

  await waitFor(() => { expect(screen.getByRole('button', { name: /^Terminal$/i })).toBeEnabled(); });
  await user.click(screen.getByRole('button', { name: /^Terminal$/i }));

  // The 409 is explained: what happened, why, and who can lift it.
  expect(await screen.findByText(/El agente PTY del contenedor no está conectado/i)).toBeInTheDocument();
  expect(screen.getByText(/HTTP 409/)).toBeInTheDocument();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(document.body.textContent).not.toContain('agent_offline');
  expect(StubWebSocket.instances).toHaveLength(0);
});

it('el Feed lista los mensajes del agente sin escribir nada', async () => {
  const user = userEvent.setup();
  server.use(http.get('*/v3/console/messages', () => HttpResponse.json({
    items: [{
      message_id: 'm-1', tenant_id: 'Steven', room_id: 'grp.steven', actor_alias: 'kant',
      body_preview: 'Terminé la migración', created_at: new Date().toISOString(), deliveries: [],
    }],
  })));
  renderAgent('kant');

  await user.click(await screen.findByRole('button', { name: 'Feed' }));
  expect(await screen.findByText('Terminé la migración')).toBeInTheDocument();
  expect(screen.getByRole('list', { name: /mensajes recientes de kant/i })).toBeInTheDocument();
});

it('el Feed muestra el perfil humano autenticado y no el alias técnico de ruteo', async () => {
  const user = userEvent.setup();
  server.use(http.get('*/v3/console/messages', () => HttpResponse.json({
    items: [{
      message_id: 'm-2', tenant_id: 'Steven', room_id: 'grp.steven', actor_alias: 'kant',
      author: { kind: 'human', subject_id: `human:${'a'.repeat(64)}`, display_name: 'Marta' },
      body_preview: 'Revisá el deploy', created_at: new Date().toISOString(),
      deliveries: [{ delivery_id: 'd-1', recipient_tenant: 'Steven', recipient_alias: 'kant', status: 'started' }],
    }],
  })));
  renderAgent('kant');

  await user.click(await screen.findByRole('button', { name: 'Feed' }));
  expect(await screen.findByText('Marta')).toBeInTheDocument();
  expect(screen.getByText('Revisá el deploy')).toBeInTheDocument();
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

it('el agente que el servidor no observa lo dice y ofrece volver al selector', async () => {
  renderWithApi(<TerminalPage params={['Steven', 'fantasma']} />);

  expect(await screen.findByText(/El servidor no observa al agente Steven:fantasma/)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Elegir otro agente' })).toHaveAttribute('href', '/terminal');
});
