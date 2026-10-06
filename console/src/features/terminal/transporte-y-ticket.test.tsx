/**
 * What the panel SAYS while the channel changes underneath it.
 *
 * The bar, the status line and the inspector are the only things the operator has to tell a live
 * session from a dead one, so each of them is checked against the state of the transport that
 * produced it: a spent ticket does not go back to counting down because the network blinked, a
 * released channel does not keep claiming "PTY online", and asking for a new session after a
 * read-only TUI died does not silently hand out a writable shell.
 */
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { server } from '../../mocks/server';
import { mockTerminalGrant } from '../../mocks/terminal-ticket';
import { renderWithApi } from '../../test/render';
import type { TerminalTarget } from './api';
import { closePtySession, ptySessionText } from './pty-session';
import { installStubWebSocket, StubWebSocket } from './pty-socket-stub';
import { TerminalPage } from './TerminalPage';

const WS_PATH = '/v3/console/terminal/ws';
const SID = 'sid-zeus';
const READY = {
  type: 'ready',
  claim_token: '12345678-1234-4234-8234-123456789abc',
  claim_epoch: '1',
  claim_lease_ms: 45_000,
};
let authorityProof = '';

function resumeForProof(proof: string): string {
  const payload = JSON.stringify({ v: 1, sid: SID, op: 'fixture-operator', iat: 1_750_000_000,
    exp: 1_750_003_600, nonce: 'A'.repeat(22) });
  const encoded = (value: string) => globalThis.btoa(String.fromCharCode(...new TextEncoder().encode(value)))
    .replace(/=+$/u, '').replaceAll('+', '-').replaceAll('/', '_');
  const legacy = `r1.${encoded(payload)}.${'A'.repeat(43)}`;
  return `r2.${encoded(JSON.stringify([legacy, proof]))}`;
}

function target(overrides: Partial<TerminalTarget> & Pick<TerminalTarget, 'tenant_id' | 'alias'> = {
  tenant_id: 'Steven', alias: 'zeus',
}): TerminalTarget {
  return {
    container: 'ws-zeus', runtime_user: 'dev', harness: 'claude-code', shares_container_with: [],
    modes: ['shell', 'harness'], pty_state: 'online', last_seen: null, authorized: true,
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

function serveSessions(record: { mode: string }[], options: { expiresAt?: string } = {}) {
  server.use(
    http.post('*/v3/console/terminal/sessions', async ({ request }) => {
      const body = await request.json() as Record<string, unknown>;
      record.push({ mode: String(body.mode) });
      const grant = mockTerminalGrant({
        sessionId: SID,
        tenantId: String(body.tenant_id),
        alias: String(body.alias),
        container: 'ws-zeus',
        runtimeUser: 'dev',
        mode: String(body.mode),
        requestId: String(body.request_id),
        ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
      });
      authorityProof = String(grant.authority_proof);
      return HttpResponse.json(grant, { status: 201 });
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
  closePtySession(SID);
  restoreSocket();
});

/** Opens the alias, whose TUI opens on its own, and takes the relay to `ready`. */
async function abrirTui(user: ReturnType<typeof userEvent.setup>, ready?: Record<string, unknown>) {
  await user.selectOptions(await screen.findByRole('combobox', { name: 'Agente' }), await screen.findByRole('option', { name: /^zeus ·/ }));
  await waitFor(() => { expect(StubWebSocket.instances).toHaveLength(1); });
  const socket = StubWebSocket.last();
  act(() => {
    socket.acceptOpen();
    socket.emitControl(ready ?? { ...READY, resume_token: resumeForProof(authorityProof) });
    socket.emitOutput('zeus corriendo pnpm test\r\n');
  });
  await waitFor(() => { expect(ptySessionText(SID)).toContain('zeus corriendo'); });
  return socket;
}

describe('el ticket de un solo uso, contado sin mentir', () => {
  it('un ticket ya vencido cuenta 0:00 y se marca, en vez de decir que la sesión está activa', async () => {
    const user = userEvent.setup();
    enableCapability();
    serveTargets([target()]);
    serveSessions([], { expiresAt: new Date(Date.now() - 5_000).toISOString() });
    renderWithApi(<TerminalPage />);

    await user.selectOptions(await screen.findByRole('combobox', { name: 'Agente' }), await screen.findByRole('option', { name: /^zeus ·/ }));
    await waitFor(() => { expect(StubWebSocket.instances).toHaveLength(1); });
    // The socket is up but the relay has not authorised: the ticket window is what is ticking.
    act(() => { StubWebSocket.last().acceptOpen(); });

    const bar = await screen.findByLabelText('Sesión PTY activa');
    expect(bar).toHaveTextContent('Ticket vence en 0:00');
    expect(bar).not.toHaveTextContent(/Ticket consumido/);
    expect(within(bar).getByLabelText('Ticket vence en 0:00')).toHaveAttribute('data-expiring', 'true');
  }, 20_000);

  /**
   * A transport blink is not a new ticket. The relay keeps the same PTY and the console resumes it
   * with its resume token; the ticket was spent at the first `ready` and can never be replayed, so
   * putting its countdown back on screen tells the operator to hurry over something that no longer
   * exists.
   */
  it('una caída de transporte NO devuelve el ticket a la cuenta atrás: sigue consumido', async () => {
    const user = userEvent.setup();
    enableCapability();
    serveTargets([target()]);
    serveSessions([]);
    renderWithApi(<TerminalPage />);

    const socket = await abrirTui(user);
    expect(await screen.findByLabelText('Sesión PTY activa')).toHaveTextContent(/Ticket consumido · sesión activa/);

    act(() => { socket.emitClose(1006, 'network_lost'); });
    await waitFor(() => { expect(StubWebSocket.instances).toHaveLength(2); });
    const resumed = StubWebSocket.last();
    act(() => { resumed.acceptOpen(); });
    expect(resumed.frames()[0]).toMatchObject({ type: 'resume', authority_proof: authorityProof });
    expect(String(resumed.frames()[0]?.resume_token)).toMatch(/^r2\./u);

    const bar = screen.getByLabelText('Sesión PTY activa');
    expect(bar).toHaveTextContent(/Ticket consumido/);
    expect(bar).not.toHaveTextContent(/Ticket vence en/);
    // And the reconnection is stated where the transport lives, not hidden behind a fake clock.
    expect(screen.getByText(/reanudando el mismo PTY/i)).toBeInTheDocument();
  }, 20_000);
});

describe('pedir una sesión nueva después de que el relay cierre el canal', () => {
  it('sobre una TUI en vivo vuelve a pedir la TUI, y no una shell con permiso de escritura', async () => {
    const user = userEvent.setup();
    const posts: { mode: string }[] = [];
    enableCapability();
    serveTargets([target()]);
    serveSessions(posts);
    renderWithApi(<TerminalPage />);

    const socket = await abrirTui(user);
    act(() => { socket.emitClose(4408, 'idle'); });
    expect(await screen.findByText(/Sesión cerrada por inactividad/i)).toBeInTheDocument();

    await user.click(await screen.findByRole('button', { name: /pedir sesión nueva/i }));

    await waitFor(() => { expect(posts).toHaveLength(2); });
    // Same channel that died: read-only observation, with its automatic audited motive.
    expect(posts[1].mode).toBe('harness');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  }, 20_000);

  it('sobre una shell abre el diálogo, y cancelarlo NO deja un panel que diga «PTY online»', async () => {
    const user = userEvent.setup();
    const posts: { mode: string }[] = [];
    enableCapability();
    // Only `shell`: nothing opens by itself and the channel under test is the interactive one.
    serveTargets([target({ tenant_id: 'Steven', alias: 'zeus', modes: ['shell'] })]);
    serveSessions(posts);
    renderWithApi(<TerminalPage />);

    await user.selectOptions(await screen.findByRole('combobox', { name: 'Agente' }), await screen.findByRole('option', { name: /^zeus ·/ }));
    await waitFor(() => { expect(screen.getByRole('button', { name: /^Terminal$/i })).toBeEnabled(); });
    await user.click(screen.getByRole('button', { name: /^Terminal$/i }));
    const dialogo = await screen.findByRole('dialog');
    await user.click(within(dialogo).getByRole('button', { name: /abrir sesión pty/i }));
    await waitFor(() => { expect(StubWebSocket.instances).toHaveLength(1); });

    const socket = StubWebSocket.last();
    act(() => { socket.acceptOpen(); socket.emitControl(READY); });
    act(() => { socket.emitClose(4423, 'max_session'); });
    await user.click(await screen.findByRole('button', { name: /pedir sesión nueva/i }));

    const segundo = await screen.findByRole('dialog');
    await user.click(within(segundo).getByRole('button', { name: /^cancelar$/i }));

    // The channel was released: the empty stage must not keep advertising an open PTY.
    const hueco = await waitFor(() => {
      const nodo = document.querySelector('.terminal-channel-unavailable');
      if (!nodo) throw new Error('el panel sin canal no se pintó');
      return nodo as HTMLElement;
    });
    expect(within(hueco).queryByRole('heading', { name: 'PTY online' })).not.toBeInTheDocument();
    expect(hueco).toHaveTextContent(/no hay (ningún )?canal PTY abierto/i);
    expect(posts).toHaveLength(1);
  }, 20_000);
});

describe('las denegaciones que no traen código', () => {
  it('un 503 al abrir la TUI se cita con su estado y no acusa al permiso del operador', async () => {
    const user = userEvent.setup();
    enableCapability();
    serveTargets([target()]);
    server.use(http.post('*/v3/console/terminal/sessions', () => HttpResponse.json(
      { error: 'unavailable', reason: 'terminal-relay upstream timeout' }, { status: 503 },
    )));
    renderWithApi(<TerminalPage />);

    await user.selectOptions(await screen.findByRole('combobox', { name: 'Agente' }), await screen.findByRole('option', { name: /^zeus ·/ }));

    const aviso = await screen.findByRole('alert');
    expect(aviso).toHaveTextContent(/HTTP 503/);
    expect(aviso).toHaveTextContent(/terminal-relay upstream timeout/);
    expect(aviso).not.toHaveAttribute('data-codigo');
    expect(aviso).not.toHaveTextContent(/permiso de control/i);
    expect(StubWebSocket.instances).toHaveLength(0);
  }, 20_000);
});
