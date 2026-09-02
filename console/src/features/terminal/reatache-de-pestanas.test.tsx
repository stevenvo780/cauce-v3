/**
 * Switching tabs and coming back: the half of the terminal view that only breaks on the SECOND
 * visit.
 *
 * The grid mounts ONE stage at a time (`GridContainer` keys the panel by the visible session),
 * so every return to a tab is a fresh mount: the per-mount guards (`autoOpenedRef`, the request
 * fence, the local error) are born empty again. What must survive is what lives outside that
 * mount — the durable `liveSession.liveTuiAttempted`, the workspace grants and the PTY session
 * manager. Each case here is written so it goes RED if that survival is undone:
 *
 *  · if the auto-open guard went back to being only per-mount, closing the TUI and returning to
 *    the tab would reopen it by itself —the exact bug that was fixed—;
 *  · if a refused auto-open did not mark the tab, coming back would POST again against a gateway
 *    that already said no;
 *  · if the terminal were React state, returning would open a second socket and lose the
 *    scrollback.
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
const READY = {
  type: 'ready',
  claim_token: '12345678-1234-4234-8234-123456789abc',
  claim_epoch: '1',
  claim_lease_ms: 45_000,
};
/** A frame of the agent's TUI, to prove the scrollback is the same one after coming back. */
const TUI_FRAME = 'zeus corriendo pnpm test --run\r\n';

function target(overrides: Partial<TerminalTarget> & Pick<TerminalTarget, 'tenant_id' | 'alias'>): TerminalTarget {
  return {
    container: 'ws-zeus', runtime_user: 'dev', harness: 'claude-code', shares_container_with: [],
    modes: ['shell', 'harness'], pty_state: 'online', last_seen: null, authorized: true,
    reason: 'Autorizado por el servidor.',
    ...overrides,
  };
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

function serveTargets(items: TerminalTarget[] | null) {
  server.use(http.get('*/v3/console/terminal/targets', () => HttpResponse.json({
    observed_at: new Date().toISOString(), websocket_path: WS_PATH, ...(items ? { items } : {}),
  })));
}

/** Records every reservation POST and every server-side release, keyed by alias. */
function serveSessions(posts: string[], deletes: string[]) {
  server.use(
    http.post('*/v3/console/terminal/sessions', async ({ request }) => {
      const body = await request.json() as Record<string, unknown>;
      const alias = String(body.alias);
      posts.push(alias);
      return HttpResponse.json(mockTerminalGrant({
        sessionId: `sid-${alias}`,
        tenantId: String(body.tenant_id),
        alias,
        container: `ws-${alias}`,
        runtimeUser: 'dev',
        mode: String(body.mode),
        requestId: String(body.request_id),
      }), { status: 201 });
    }),
    http.delete('*/v3/console/terminal/sessions/:sid', ({ params }) => {
      deletes.push(String(params.sid));
      return new HttpResponse(null, { status: 204 });
    }),
  );
}

/** Two aliases: one that emits its TUI and one that only offers a shell, so it never auto-opens. */
function serveTwoAgents() {
  enableCapability();
  serveTargets([
    target({ tenant_id: 'Steven', alias: 'zeus' }),
    target({ tenant_id: 'Isa', alias: 'salva', container: 'ws-salva', modes: ['shell'] }),
  ]);
}

let restoreSocket: () => void;

beforeEach(() => {
  serveTargets(null);
  restoreSocket = installStubWebSocket();
});
afterEach(() => {
  closePtySession('sid-zeus');
  closePtySession('sid-salva');
  restoreSocket();
});

async function openTui(user: ReturnType<typeof userEvent.setup>): Promise<StubWebSocket> {
  await user.click(await screen.findByRole('button', { name: /abrir sesión con zeus/i }));
  await waitFor(() => { expect(StubWebSocket.instances).toHaveLength(1); });
  const socket = StubWebSocket.last();
  act(() => {
    socket.acceptOpen();
    socket.emitControl(READY);
    socket.emitOutput(TUI_FRAME);
  });
  await waitFor(() => { expect(ptySessionText('sid-zeus')).toContain('zeus corriendo'); });
  return socket;
}

describe('volver a una pestaña de terminal', () => {
  it('reengancha la MISMA sesión: ni socket nuevo, ni POST nuevo, ni scrollback perdido', async () => {
    const user = userEvent.setup();
    const posts: string[] = [];
    const deletes: string[] = [];
    serveTwoAgents();
    serveSessions(posts, deletes);
    renderWithApi(<TerminalPage />);

    await openTui(user);
    expect(posts).toEqual(['zeus']);

    await user.click(screen.getByRole('button', { name: /abrir sesión con salva/i }));
    await screen.findByRole('link', { name: /escribir a salva en mensajes/i });
    // While the other tab is on screen, the live terminal is not mounted anywhere...
    expect(document.querySelector('.pty-mount')).toBeNull();

    await user.click(screen.getByRole('tab', { name: /zeus/i }));

    // ...and coming back reattaches the very same node, with the very same output inside.
    const bar = await screen.findByLabelText('Sesión PTY activa');
    expect(bar).toHaveTextContent('zeus');
    expect(bar).toHaveTextContent('harness');
    expect(ptySessionText('sid-zeus')).toContain('zeus corriendo');
    // The socket was never reopened and the single-use ticket was never spent twice.
    expect(StubWebSocket.instances).toHaveLength(1);
    expect(posts).toEqual(['zeus']);
    expect(deletes).toEqual([]);
  }, 20_000);

  /**
   * The regression this view already paid for once: the TUI reopened by itself after the operator
   * had closed it, because the only guard was a ref that died with the panel. The durable field on
   * the session is what survives the remount.
   */
  it('con la TUI cerrada a mano, ir a otra pestaña y volver NO la reabre sola', async () => {
    const user = userEvent.setup();
    const posts: string[] = [];
    const deletes: string[] = [];
    serveTwoAgents();
    serveSessions(posts, deletes);
    renderWithApi(<TerminalPage />);

    await openTui(user);
    await user.click(within(await screen.findByLabelText('Sesión PTY activa'))
      .getByRole('button', { name: /cerrar la terminal/i }));
    await waitFor(() => { expect(deletes).toEqual(['sid-zeus']); });
    await waitFor(() => { expect(screen.getByRole('button', { name: /^Feed$/i })).toHaveAttribute('aria-pressed', 'true'); });

    await user.click(screen.getByRole('button', { name: /abrir sesión con salva/i }));
    await screen.findByRole('link', { name: /escribir a salva en mensajes/i });
    await user.click(screen.getByRole('tab', { name: /zeus/i }));
    await screen.findByRole('link', { name: /escribir a zeus en mensajes/i });

    // The panel is alive and keeps refreshing; what it does NOT do is ask for the channel again.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
    expect(posts).toEqual(['zeus']);
    expect(StubWebSocket.instances).toHaveLength(1);
    expect(screen.getByRole('button', { name: /^Feed$/i })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByLabelText('Sesión PTY activa')).not.toBeInTheDocument();
  }, 20_000);

  it('un 403 en la apertura automática tampoco se reintenta al alternar de pestaña', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    serveTwoAgents();
    server.use(http.post('*/v3/console/terminal/sessions', () => {
      attempts += 1;
      return HttpResponse.json({ error: 'forbidden', reason: 'no_grant' }, { status: 403 });
    }));
    renderWithApi(<TerminalPage />);

    await user.click(await screen.findByRole('button', { name: /abrir sesión con zeus/i }));
    await waitFor(() => { expect(attempts).toBe(1); });
    expect(await screen.findByRole('alert')).toHaveAttribute('data-codigo', 'no_grant');

    await user.click(screen.getByRole('button', { name: /abrir sesión con salva/i }));
    await screen.findByRole('link', { name: /escribir a salva en mensajes/i });
    await user.click(screen.getByRole('tab', { name: /zeus/i }));
    await screen.findByRole('link', { name: /escribir a zeus en mensajes/i });

    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
    expect(attempts).toBe(1);
    expect(StubWebSocket.instances).toHaveLength(0);
  }, 20_000);
});

describe('la rejilla de pestañas', () => {
  it('cambia el panel visible y mantiene cada enlace canónico asociado a su sesión', async () => {
    const user = userEvent.setup();
    serveTwoAgents();
    serveSessions([], []);
    renderWithApi(<TerminalPage />);

    await user.click(await screen.findByRole('button', { name: /abrir sesión con salva/i }));
    expect(await screen.findByRole('link', { name: /escribir a salva en mensajes/i })).toHaveAttribute(
      'href', '/messages/Isa/salva',
    );

    await user.click(screen.getByRole('button', { name: /abrir sesión con kant/i }));
    const otro = await screen.findByRole('link', { name: /escribir a kant en mensajes/i });

    expect(otro).toHaveAttribute('href', '/messages/Steven/kant');
    expect(screen.queryByRole('link', { name: /escribir a salva en mensajes/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /entrada para/i })).not.toBeInTheDocument();
    expect(document.querySelectorAll('.terminal-session-head')).toHaveLength(1);
    expect(screen.getAllByRole('tab')).toHaveLength(2);
    expect(screen.getByRole('tab', { selected: true })).toHaveTextContent('kant');
  }, 20_000);

  it('cerrar la pestaña activa suelta su plaza contra el servidor y deja la otra al mando', async () => {
    const user = userEvent.setup();
    const posts: string[] = [];
    const deletes: string[] = [];
    serveTwoAgents();
    serveSessions(posts, deletes);
    renderWithApi(<TerminalPage />);

    await user.click(await screen.findByRole('button', { name: /abrir sesión con salva/i }));
    await screen.findByRole('link', { name: /escribir a salva en mensajes/i });
    await openTui(user);
    expect(screen.getByRole('tab', { selected: true })).toHaveTextContent('zeus');

    await user.click(screen.getByRole('button', { name: /cerrar sesión zeus/i }));

    // The seat is released server-side: an orphan session would keep spending the operator's cap.
    await waitFor(() => { expect(deletes).toEqual(['sid-zeus']); });
    await waitFor(() => { expect(screen.queryByRole('tab', { name: /zeus/i })).not.toBeInTheDocument(); });
    expect(screen.getByRole('tab', { selected: true })).toHaveTextContent('salva');
    expect(await screen.findByRole('link', { name: /escribir a salva en mensajes/i })).toBeInTheDocument();
  }, 20_000);

  it('cerrar la última pestaña devuelve el escenario vacío, no un panel muerto', async () => {
    const user = userEvent.setup();
    serveTwoAgents();
    serveSessions([], []);
    renderWithApi(<TerminalPage />);

    await user.click(await screen.findByRole('button', { name: /abrir sesión con salva/i }));
    await screen.findByRole('link', { name: /escribir a salva en mensajes/i });

    await user.click(screen.getByRole('button', { name: /cerrar sesión salva/i }));

    expect(await screen.findByText('Ningún agente seleccionado')).toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    expect(document.querySelector('.ultimate-terminal-page')).not.toHaveAttribute('data-tui');
  }, 20_000);
});
