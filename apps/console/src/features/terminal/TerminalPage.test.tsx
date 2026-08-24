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
  // El encabezado tiene que contar lo MISMO que la lista que se ve debajo. El número exacto es del
  // fixture y cambia cada vez que la topología de demostración se parece más a la flota real;
  // clavarlo acá solo compraba un test que se rompe sin que se rompa nada. Lo que sí importa —y no
  // depende del fixture— es que el contador no afirme un tamaño de flota distinto al que muestra.
  const listed = await screen.findAllByRole('button', { name: /abrir sesión con/i });
  expect(listed.length).toBeGreaterThan(1);
  expect(await screen.findByText(`${listed.length} agentes`)).toBeInTheDocument();
  await user.click(await screen.findByRole('button', { name: /abrir sesión con kant/i }));

  const input = await screen.findByRole('textbox', { name: /entrada para kant/i });
  await user.type(input, 'Verificá el estado operativo');
  await user.click(screen.getByRole('button', { name: /^enviar$/i }));

  expect(await screen.findByText(/Aceptado por el control plane/i)).toBeInTheDocument();
  expect(screen.getByRole('tab', { name: /kant/i })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByText(/no crea workers remotos/i)).toBeInTheDocument();
  // Timeout explícito, y no por lentitud tolerada: este caso renderiza la barra lateral entera —15
  // alias, cada uno resolviendo su estado de PTY— y encima escribe un mensaje carácter por carácter
  // con userEvent. Aislado tarda ~2,7 s; corriendo detrás de los otros 31 archivos, con la máquina
  // caliente, pasaba los 5 s por defecto y fallaba por reloj, no por conducta. Un test que falla
  // según con quién comparta la corrida no está midiendo la aplicación.
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
  await waitFor(() => expect(input).toBeEnabled());
  expect(screen.getByRole('button', { name: /^PTY$/i })).toBeDisabled();
  expect(screen.getByRole('button', { name: /^Feed$/i })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByText(/4 ACK/i)).toBeInTheDocument();

  await user.type(input, 'El feed no depende del PTY');
  await user.click(screen.getByRole('button', { name: /^enviar$/i }));
  expect(await screen.findByText(/Aceptado por el control plane/i)).toBeInTheDocument();
  // El rótulo de la tarjeta «Tu permiso de terminal», en castellano: era `connectState` en
  // mayúsculas, o sea el valor crudo del RBAC.
  expect(screen.getByText('DENEGADO')).toBeInTheDocument();
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
  // Los dos KPI cuentan 1 de 3: uno con PTY online y —al publicar jarvis su `harness`— uno que
  // además emite su TUI.
  expect(await screen.findAllByText('1 / 3')).toHaveLength(2);
});

/**
 * 🔴 **La vista rompía su propia promesa. Medido el 2026-08-23 contra producción.**
 *
 * `/v3/console/terminal/targets` publicaba `modes:["shell"]` y `reason:"ok"` para argos, hegel,
 * iza, janus y jarvis. Los cinco se pintaban con el MISMO chip verde «PTY online» que los ocho
 * que sí traen `harness`, y sin motivo, mientras la cabecera prometía que «el resto queda con su
 * motivo escrito, nunca en verde» y el KPI decía «8/14». El operador no tenía forma de saber
 * cuáles seis de los catorce le iban a fallar antes de hacer clic.
 */
it('un alias con PTY pero SIN modo harness no se pinta en verde: lleva su motivo, como gaia', async () => {
  enableCapability();
  serveTargets([
    target({ tenant_id: 'Steven', alias: 'zeus', modes: ['shell', 'harness'] }),
    target({ tenant_id: 'Steven', alias: 'jarvis', modes: ['shell'], reason: 'ok' }),
  ]);
  renderWithApi(<TerminalPage />);

  const conTui = await screen.findByRole('button', { name: /abrir sesión con zeus/i });
  const sinTui = screen.getByRole('button', { name: /abrir sesión con jarvis/i });

  // El que emite: verde, con el estado que el servidor sí publica.
  expect(within(conTui).getByText('TUI en vivo')).toHaveAttribute('data-status', 'allowed');
  // El que no: gris (`no_tui`, la misma familia que `unknown`/`not_installed`) y con el motivo
  // del servidor en el chip, no escondido detrás de un clic.
  const chip = within(sinTui).getByText('Sin TUI que emitir');
  expect(chip).toHaveAttribute('data-status', 'no_tui');
  expect(chip).toHaveAttribute('title', expect.stringContaining('no publica el modo harness'));
  // Y NO comparte el estado verde con el que sí emite.
  expect(chip.getAttribute('data-status')).not.toBe('allowed');
  // El KPI que ya contaba bien (8/14 en producción) sigue contando lo mismo: 1 de 2 acá.
  expect(await screen.findByText('1 / 2')).toBeInTheDocument();
});

it('disables PTY for a denied destination and shows the server motive, not an empty tooltip', async () => {
  const user = userEvent.setup();
  enableCapability();
  serveTargets([target({ tenant_id: 'Isa', alias: 'salva', authorized: false, reason: 'attribution_required: falta identidad por persona.' })]);
  renderWithApi(<TerminalPage />);

  await user.click(await screen.findByRole('button', { name: /abrir sesión con salva/i }));

  const ptyButton = await screen.findByRole('button', { name: /^PTY$/i });
  await waitFor(() => expect(ptyButton).toBeDisabled());
  // 🔴 El motivo del servidor trae el código DENTRO de la prosa. Se traduce, y se conserva lo
  // que el servidor sí dijo en castellano. Ver `denegaciones.ts`.
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
  /*
   * El botón se llama «Cerrar la terminal» y NO «Cerrar sesión»: arriba a la derecha, en la barra
   * de la consola, hay otro «Cerrar sesión» que te echa de la aplicación. La comprobación es doble
   * a propósito —el rótulo correcto Y la ausencia del ambiguo dentro de la barra— porque sin la
   * segunda mitad este caso volvería a pasar en verde el día que alguien deshaga el cambio.
   */
  expect(within(bar).getByRole('button', { name: /cerrar la terminal/i })).toBeInTheDocument();
  expect(within(bar).queryByRole('button', { name: /^cerrar sesión$/i })).not.toBeInTheDocument();
  // An open PTY is the live source, so the redundant 2.5 s feed polling stands down.
  expect(within(bar).getByText('POLLING EN PAUSA')).toBeInTheDocument();
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

  await user.click(within(screen.getByLabelText('Sesión PTY activa')).getByRole('button', { name: /cerrar la terminal/i }));

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

  // El 409 se explica: qué pasó, por qué, y quién puede levantarlo. Antes el `[role=alert]`
  // contenía exactamente la palabra `agent_offline` y nada más.
  expect(await within(dialog).findByText(/El agente PTY del contenedor no está conectado/i)).toBeInTheDocument();
  expect(within(dialog).getByText(/HTTP 409/)).toBeInTheDocument();
  expect(document.body.textContent).not.toContain('agent_offline');
  expect(StubWebSocket.instances).toHaveLength(0);
});

/**
 * 🔴 **La peor de las tres mentiras del 2026-08-22.** Con una cuenta sin permiso `control`,
 * `GET /v3/console/terminal/capability` responde 403 —el gate corre antes de mirar el backend— y
 * la pantalla decía «El relay de terminales no está desplegado en este stack. (HTTP 403 al
 * consultarlo.)» con el relay desplegado y sano. Se mide el aviso que el operador lee, no la
 * función pura: el título del cartel contaba la misma mentira que el cuerpo.
 */
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

  expect(await screen.findByText('Ultimate Terminal necesita permiso de control')).toBeInTheDocument();
  expect(screen.getByText(/no tiene permiso de control sobre esta flota/)).toBeInTheDocument();
  expect(screen.getByText(/lo que falta es el permiso/)).toBeInTheDocument();
  expect(screen.queryByText(/no está desplegado en este stack/)).not.toBeInTheDocument();
  expect(screen.queryByText(/HTTP 403 al consultarlo/)).not.toBeInTheDocument();
  expect(screen.queryByText('Canal PTY no disponible en este stack')).not.toBeInTheDocument();
}, 20_000);

/** El control positivo del caso anterior: un 501 SÍ significa que no está desplegado. */
it('con un 501 sigue diciendo, con el título de siempre, que el canal no está en este stack', async () => {
  server.use(http.get('http://localhost/v3/console/terminal/capability', () => new HttpResponse(null, { status: 501 })));
  renderWithApi(<TerminalPage />);

  expect(await screen.findByText('Canal PTY no disponible en este stack')).toBeInTheDocument();
  expect(screen.queryByText('Ultimate Terminal necesita permiso de control')).not.toBeInTheDocument();
}, 20_000);

/**
 * 🔴 **Jerga cruda en la cara del operador, y un contador que sugería una avería.**
 *
 * Medido el 2026-08-23 en producción: seis badges del panel de adaptadores imprimían, literal,
 * `<UNKNOWN VALUE=AVAILABLE />` y `<UNKNOWN VALUE=UNKNOWN />` —un `&lt;Unknown value={...} /&gt;`
 * escapado que el navegador pintaba como texto—. «UNKNOWN VALUE=AVAILABLE» no contesta si el
 * adaptador está o no. Encima el KPI decía «ADAPTERS AVAILABLE 3/6», que se lee como «3 rotos»
 * cuando eran 3 disponibles y 3 sin reportar.
 */
describe('los adaptadores se dicen en palabras, no en pseudo-etiquetas', () => {
  it('pinta el estado de cada adaptador y NUNCA un tag sin renderizar', async () => {
    renderWithApi(<TerminalPage />);

    // El inspector se pinta dos veces (columna derecha y tira de abajo); CSS decide cuál se ve.
    expect(await screen.findAllByText('Disponible')).not.toHaveLength(0);
    expect(screen.getAllByText('Degradado')).not.toHaveLength(0);
    expect(screen.getAllByText('Sin reportar')).not.toHaveLength(0);
    // El defecto exacto, por si alguien vuelve a escapar el JSX.
    expect(screen.queryByText(/UNKNOWN VALUE=/i)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/<Unknown value/i);
  });

  it('cuenta disponibles, con fallo y sin reportar en vez de una fracción que sugiere avería', async () => {
    renderWithApi(<TerminalPage />);

    // El fixture trae 2 available, 1 degraded y 1 unknown.
    // Dos veces: el KPI de arriba y la tira de salud de la lista de flota. Las dos cuentan igual.
    expect(await screen.findAllByText('2 disponibles · 1 con fallo · 1 sin reportar')).toHaveLength(2);
    expect(screen.queryByText('2 / 4')).not.toBeInTheDocument();
  });
});
