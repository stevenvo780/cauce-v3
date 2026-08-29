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
  await user.click(await screen.findByRole('button', { name: new RegExp(`abrir sesión con ${alias}`, 'i') }));
  await waitFor(() => { expect(screen.getByRole('button', { name: /^PTY$/i })).toBeEnabled(); });
  await user.click(screen.getByRole('button', { name: /^PTY$/i }));

  const dialog = await screen.findByRole('dialog');
  await user.type(within(dialog).getByRole('textbox'), reason);
  await user.click(within(dialog).getByRole('button', { name: /abrir sesión pty/i }));

  await waitFor(() => { expect(StubWebSocket.instances).toHaveLength(1); });
  return StubWebSocket.last();
}

it('opens simultaneous-capable agent sessions and publishes through the durable feed', async () => {
  const user = userEvent.setup();
  renderWithApi(<TerminalPage />);

  expect(await screen.findByRole('heading', { level: 1, name: 'Terminal de agentes' })).toBeInTheDocument();
  expect(screen.getByText('Flota en vivo')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /plano de control/i })).toBeInTheDocument();
  expect(await screen.findByText('Aquí no se puede espejar ninguna TUI')).toBeInTheDocument();
  for (const textoIngles of ['Ultimate Terminal', 'Fleet live', 'Capability gates', 'Adapters', 'No active target']) {
    expect(screen.queryByText(textoIngles), `rótulo visible sin traducir: ${textoIngles}`).not.toBeInTheDocument();
  }
  // The header must count the SAME as the list shown below. The exact number comes from the
  // fixture and changes each time the demo topology looks more like the real fleet; pinning it
  // here only bought a test that breaks without anything breaking. What does matter — and does
  // not depend on the fixture — is that the counter does not claim a fleet size different from
  // what it shows.
  const listed = await screen.findAllByRole('button', { name: /abrir sesión con/i });
  expect(listed.length).toBeGreaterThan(1);
  expect(await screen.findByText(`${String(listed.length)} agentes`)).toBeInTheDocument();
  await user.click(await screen.findByRole('button', { name: /abrir sesión con kant/i }));

  const input = await screen.findByRole('textbox', { name: /entrada para kant/i });
  await user.type(input, 'Verificá el estado operativo');
  await user.click(screen.getByRole('button', { name: /^enviar$/i }));

  expect(await screen.findByText(/Aceptado por el control plane/i)).toBeInTheDocument();
  expect(screen.getByRole('tab', { name: /kant/i })).toHaveAttribute('aria-selected', 'true');
  // `getAllByText` and not `getByText`: since the doctrine footer folds in observation mode, the
  // same sentence is ALSO written in the "Fleet status" dropdown of the header — from a single
  // constant, `doctrina.ts` — so folding it does not make it disappear from view. What this
  // case asserts is still the same: the doctrine is written on the page.
  expect(screen.getAllByText(/no crea workers remotos/i).length).toBeGreaterThan(0);
  // Explicit timeout, not for tolerated slowness: this case renders the entire sidebar — 15
  // aliases, each one resolving its PTY state — and also types a message character by character
  // with userEvent. In isolation it takes ~2.7 s; running behind the other 31 files, with the
  // machine warm, it passed the default 5 s and failed by clock, not by behavior. A test that
  // fails depending on who shares its run is not measuring the application.
}, 20_000);

it('keeps the terminal draft and reports uncertainty when publish returns a malformed 202', async () => {
  const user = userEvent.setup();
  server.use(http.post('*/v3/console/messages', () => HttpResponse.json({
    message_id: '10000000-0000-4000-8000-000000000001',
  }, { status: 202 })));
  renderWithApi(<TerminalPage />);

  await user.click(await screen.findByRole('button', { name: /abrir sesión con kant/i }));
  const input = await screen.findByRole('textbox', { name: /entrada para kant/i });
  await user.type(input, 'conservar hasta conciliar');
  await user.click(screen.getByRole('button', { name: /^enviar$/i }));

  expect(await screen.findByText(/no devolvió un recibo durable exacto/i)).toBeInTheDocument();
  expect(input).toHaveValue('conservar hasta conciliar');
  expect(screen.queryByText(/Aceptado por el control plane/i)).not.toBeInTheDocument();
}, 20_000);

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
  await waitFor(() => { expect(input).toBeEnabled(); });
  expect(screen.getByRole('button', { name: /^PTY$/i })).toBeDisabled();
  expect(screen.getByRole('button', { name: /^Feed$/i })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByText(/4 ACK/i)).toBeInTheDocument();

  await user.type(input, 'El feed no depende del PTY');
  await user.click(screen.getByRole('button', { name: /^enviar$/i }));
  expect(await screen.findByText(/Aceptado por el control plane/i)).toBeInTheDocument();
  // The label of the "Your terminal permission" card, in Spanish: it used to be `connectState`
  // in capitals, i.e. the raw RBAC value.
  expect(screen.getByText('DENEGADO')).toBeInTheDocument();
});

it('publishes cross-tenant from the operator source room and blocks destinations without ACL', async () => {
  const user = userEvent.setup();
  let published: Record<string, unknown> | undefined;
  server.use(http.post('http://localhost/v3/console/messages', async ({ request }) => {
    published = await request.json() as Record<string, unknown>;
    return HttpResponse.json({
      message_id: '10000000-0000-4000-8000-000000000002',
      delivery_ids: ['20000000-0000-4000-8000-000000000002'],
      duplicate: false,
      request_id: '30000000-0000-4000-8000-000000000002',
      trace_id: 'trace-cross-tenant-test',
      idempotency_key: published.idempotency_key,
      tenant_id: 'Steven',
      actor_alias: 'kant',
      request_hash: 'a'.repeat(64),
      causal_hash: 'b'.repeat(64),
    }, { status: 202 });
  }));
  renderWithApi(<TerminalPage />);

  await user.click(await screen.findByRole('button', { name: /abrir sesión con kratos/i }));
  const allowedInput = await screen.findByRole('textbox', { name: /entrada para kratos/i });
  await waitFor(() => { expect(allowedInput).toBeEnabled(); });
  await user.type(allowedInput, 'Diagnóstico remoto');
  await user.click(screen.getByRole('button', { name: /^enviar$/i }));
  await waitFor(() => { expect(published).toMatchObject({
    room_id: 'grp.steven',
    recipients: [{ tenant_id: 'Miguel', alias: 'kratos' }],
  }); });

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
  await waitFor(() => { expect(input).toBeEnabled(); });
  expect(phantomCalls).toBe(0);
  expect(screen.queryByText(/Topología de acceso del tenant operador UNKNOWN/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/ACL del operador/i)).not.toBeInTheDocument();
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

  expect(await screen.findByRole('button', { name: /abrir sesión con jarvis.*PTY: TUI en vivo/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /abrir sesión con argos.*PTY: Agente PTY no instalado/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /abrir sesión con salva.*PTY: Sin autoridad/i })).toBeInTheDocument();
  // An alias the inventory never mentioned is UNKNOWN, never silently "available".
  expect(screen.getByRole('button', { name: /abrir sesión con kant.*PTY: PTY desconocido/i })).toBeInTheDocument();
  // The two KPIs count 1 of 3: one with PTY online and — once jarvis publishes its `harness` —
  // one that also emits its TUI.
  expect(await screen.findAllByText('1 / 3')).toHaveLength(2);
});

it('un alias con PTY pero SIN modo harness no se pinta en verde: lleva su motivo, como gaia', async () => {
  enableCapability();
  serveTargets([
    target({ tenant_id: 'Steven', alias: 'zeus', modes: ['shell', 'harness'] }),
    target({ tenant_id: 'Steven', alias: 'jarvis', modes: ['shell'], reason: 'ok' }),
  ]);
  renderWithApi(<TerminalPage />);

  const conTui = await screen.findByRole('button', { name: /abrir sesión con zeus/i });
  const sinTui = screen.getByRole('button', { name: /abrir sesión con jarvis/i });

  // The one that emits: green, with the state the server does publish.
  expect(within(conTui).getByText('TUI en vivo')).toHaveAttribute('data-status', 'allowed');
  // The one that does not: gray (`no_tui`, the same family as `unknown`/`not_installed`) and with
  // the server's reason on the chip, not hidden behind a click.
  const chip = within(sinTui).getByText('Sin TUI que emitir');
  expect(chip).toHaveAttribute('data-status', 'no_tui');
  expect(chip).toHaveAttribute('title', expect.stringContaining('no publica el modo harness'));
  // And it does NOT share the green state with the one that does emit.
  expect(chip.getAttribute('data-status')).not.toBe('allowed');
  // The KPI that already counted right (8/14 in production) keeps counting the same: 1 of 2 here.
  expect(await screen.findByText('1 / 2')).toBeInTheDocument();
});

it('disables PTY for a denied destination and shows the server motive, not an empty tooltip', async () => {
  const user = userEvent.setup();
  enableCapability();
  serveTargets([target({ tenant_id: 'Isa', alias: 'salva', authorized: false, reason: 'attribution_required: falta identidad por persona.' })]);
  renderWithApi(<TerminalPage />);

  await user.click(await screen.findByRole('button', { name: /abrir sesión con salva/i }));

  const ptyButton = await screen.findByRole('button', { name: /^PTY$/i });
  await waitFor(() => { expect(ptyButton).toBeDisabled(); });
  // The server's reason brings the code INSIDE the prose. It is translated, and what the
  // server did say in Spanish is preserved. See `denegaciones.ts`.
  expect(ptyButton).toHaveAttribute('title', expect.stringContaining('Falta decir qué persona está entrando'));
  expect(screen.getByText(/falta identidad por persona/i)).toBeInTheDocument();
  expect(screen.getByText(/Lo levanta:/i)).toBeInTheDocument();
  expect(document.body.textContent).not.toContain('attribution_required');
  // The motive is stated twice on purpose: in the fleet list and over the open session.
  expect(screen.getAllByText('Sin autoridad')).toHaveLength(2);
});

it('states not_installed explicitly rather than leaving the operator on a spinner', async () => {
  const user = userEvent.setup();
  enableCapability();
  serveTargets([target({ tenant_id: 'Steven', alias: 'argos', pty_state: 'not_installed', container: 'ctrl-infra', reason: 'El agente PTY no está instalado en ctrl-infra.' })]);
  renderWithApi(<TerminalPage />);

  await user.click(await screen.findByRole('button', { name: /abrir sesión con argos/i }));

  await waitFor(() => { expect(screen.getByRole('button', { name: /^PTY$/i })).toBeDisabled(); });
  expect(screen.getAllByText('Agente PTY no instalado')).toHaveLength(2);
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

  await user.click(await screen.findByRole('button', { name: /abrir sesión con jarvis/i }));
  await waitFor(() => { expect(screen.getByRole('button', { name: /^PTY$/i })).toBeEnabled(); });
  await user.click(screen.getByRole('button', { name: /^PTY$/i }));

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
  expect(screen.getByLabelText('Sesión PTY activa')).toHaveTextContent(/Ticket vence en \d+:\d\d/);

  act(() => {
    socket.emitControl({
      type: 'ready', claim_token: '12345678-1234-4234-8234-123456789abc',
      claim_epoch: '1', claim_lease_ms: 45_000,
    });
    socket.emitOutput('claw@claw:~$ id -un\r\nclaw\r\n');
  });
  await waitFor(() => { expect(ptySessionText(PTY_SESSION_ID)).toContain('claw@claw:~$ id -un'); });

  // The permanent bar states who, where, as whom and how long is left.
  const bar = screen.getByLabelText('Sesión PTY activa');
  expect(bar).toHaveTextContent('jarvis');
  expect(bar).toHaveTextContent('claw');
  expect(bar).toHaveTextContent('shell');
  // The ticket is spent once the relay is ready; the bar says so instead of freezing at 0:00.
  expect(bar).toHaveTextContent(/Ticket consumido · sesión activa/);
  /*
   * The button is called "Cerrar la terminal" and NOT "Cerrar sesion": at the top right, in the
   * console bar, there is another "Cerrar sesion" that logs you out of the application. The
   * check is double on purpose — the right label AND the absence of the ambiguous one inside
   * the bar — because without the second half this case would pass green again the day someone
   * undoes the change.
   */
  expect(within(bar).getByRole('button', { name: /cerrar la terminal/i })).toBeInTheDocument();
  expect(within(bar).queryByRole('button', { name: /^cerrar sesión$/i })).not.toBeInTheDocument();
  // An open PTY is the live source, so the redundant 2.5 s feed polling stands down.
  expect(within(bar).getByText('POLLING EN PAUSA')).toBeInTheDocument();
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

  await user.click(await screen.findByRole('button', { name: /abrir sesión con jarvis/i }));
  await user.click(await screen.findByRole('button', { name: /^PTY$/i }));
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
  act(() => {
    socket.acceptOpen();
    socket.emitControl({
      type: 'ready', claim_token: '12345678-1234-4234-8234-123456789abc',
      claim_epoch: '1', claim_lease_ms: 45_000,
    });
  });

  await user.click(within(screen.getByLabelText('Sesión PTY activa')).getByRole('button', { name: /cerrar la terminal/i }));

  await waitFor(() => { expect(deleted).toBe(PTY_SESSION_ID); });
  await waitFor(() => { expect(screen.getByRole('button', { name: /^Feed$/i })).toHaveAttribute('aria-pressed', 'true'); });
  expect(socket.closeCode).toBe(1000);
}, 20_000);

it('surfaces a 409 conflict from the gateway without opening any socket', async () => {
  const user = userEvent.setup();
  enableCapability();
  serveTargets([target({ tenant_id: 'Steven', alias: 'jarvis' })]);
  server.use(http.post('*/v3/console/terminal/sessions', () => HttpResponse.json({ error: 'conflict', reason: 'agent_offline' }, { status: 409 })));
  renderWithApi(<TerminalPage />);

  await user.click(await screen.findByRole('button', { name: /abrir sesión con jarvis/i }));
  await waitFor(() => { expect(screen.getByRole('button', { name: /^PTY$/i })).toBeEnabled(); });
  await user.click(screen.getByRole('button', { name: /^PTY$/i }));
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

describe('los adaptadores se dicen en palabras, no en pseudo-etiquetas', () => {
  it('pinta el estado de cada adaptador y NUNCA un tag sin renderizar', async () => {
    const user = userEvent.setup();
    renderWithApi(<TerminalPage />);

    // The inspector is mounted once now, and only while its dialog is open.
    await user.click(await screen.findByRole('button', { name: /plano de control/i }));
    const inspector = await screen.findByRole('dialog', { name: /plano de control/i });
    expect(within(inspector).getAllByText('Disponible')).not.toHaveLength(0);
    expect(within(inspector).getAllByText('Degradado')).not.toHaveLength(0);
    expect(within(inspector).getAllByText('Sin reportar')).not.toHaveLength(0);
    // The exact bug, in case someone lets the JSX escape again.
    expect(screen.queryByText(/UNKNOWN VALUE=/i)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/<Unknown value/i);
  });

  it('cuenta disponibles, con fallo y sin reportar en vez de una fracción que sugiere avería', async () => {
    renderWithApi(<TerminalPage />);

    // The fixture has 2 available, 1 degraded and 1 unknown.
    // Twice: the KPI at the top and the health strip of the fleet list. Both count the same.
    expect(await screen.findAllByText('2 disponibles · 1 con fallo · 1 sin reportar')).toHaveLength(2);
    expect(screen.queryByText('2 / 4')).not.toBeInTheDocument();
  });
});
