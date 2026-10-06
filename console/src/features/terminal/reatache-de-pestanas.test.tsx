import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { server } from '../../mocks/server';
import { mockTerminalGrant } from '../../mocks/terminal-ticket';
import { navigate } from '../../router';
import { renderRouted } from '../../test/render';
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

/** Opening an agent is a route change; the sidebar links do exactly this. */
function renderAt(path: string) {
  window.history.pushState({}, '', path);
  return renderRouted(TerminalPage);
}

function go(path: string) {
  act(() => { navigate(path); });
}

async function waitForTui(): Promise<StubWebSocket> {
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

describe('cambiar el agente de la dirección', () => {
  it('volver a pedir el mismo agente conserva socket, ticket y salida', async () => {
    const posts: string[] = [], deletes: string[] = [];
    serveTwoAgents(); serveSessions(posts, deletes);
    renderAt('/terminal/Steven/zeus');
    await waitForTui();
    go('/terminal/Steven/zeus');
    expect(ptySessionText('sid-zeus')).toContain('zeus corriendo');
    expect(StubWebSocket.instances).toHaveLength(1);
    expect(posts).toEqual(['zeus']);
    expect(deletes).toEqual([]);
  });

  it('devuelve el canal anterior y al regresar abre una intención nueva', async () => {
    const posts: string[] = [], deletes: string[] = [];
    serveTwoAgents(); serveSessions(posts, deletes);
    renderAt('/terminal/Steven/zeus');
    const old = await waitForTui();
    go('/terminal/Isa/salva');
    await screen.findByRole('heading', { level: 2, name: /salva/ });
    await waitFor(() => { expect(deletes).toEqual(['sid-zeus']); });
    expect(old.readyState).toBe(StubWebSocket.CLOSED);
    go('/terminal/Steven/zeus');
    await waitFor(() => { expect(posts).toEqual(['zeus', 'zeus']); });
    expect(StubWebSocket.instances).toHaveLength(2);
    expect(StubWebSocket.last()).not.toBe(old);
  });

  it('cerrar la sesión revoca el canal y no la reabre sola', async () => {
    const user = userEvent.setup();
    const posts: string[] = [], deletes: string[] = [];
    serveTwoAgents(); serveSessions(posts, deletes);
    renderAt('/terminal/Steven/zeus');
    await waitForTui();
    await user.click(screen.getByRole('button', { name: 'Más acciones' }));
    await user.click(await screen.findByRole('menuitem', { name: /cerrar sesión pty/i }));
    await waitFor(() => { expect(deletes).toEqual(['sid-zeus']); });
    expect(screen.queryByLabelText('Sesión PTY activa')).not.toBeInTheDocument();
    expect(posts).toEqual(['zeus']);
    await user.click(screen.getByRole('button', { name: /^TUI$/i }));
    await waitFor(() => { expect(posts).toEqual(['zeus', 'zeus']); });
  });

  it('una negativa permanente no se reintenta sola', async () => {
    let attempts = 0;
    serveTwoAgents();
    server.use(http.post('*/v3/console/terminal/sessions', () => {
      attempts += 1;
      return HttpResponse.json({ reason: 'no_grant' }, { status: 403 });
    }));
    renderAt('/terminal/Steven/zeus');
    expect(await screen.findByRole('alert')).toHaveAttribute('data-codigo', 'no_grant');
    go('/terminal/Steven/zeus');
    expect(attempts).toBe(1);
    expect(StubWebSocket.instances).toHaveLength(0);
  });

  it('si falla la devolución al salir, el aviso queda con su reintento y no se abre otra reserva', async () => {
    const posts: string[] = [], deletes: string[] = [];
    serveTwoAgents(); serveSessions(posts, deletes);
    server.use(http.delete('*/v3/console/terminal/sessions/:sid', () =>
      HttpResponse.json({ reason: 'temporary_failure' }, { status: 503 })));
    renderAt('/terminal/Steven/zeus');
    await waitForTui();
    go('/terminal/Isa/salva');
    const alert = await screen.findByText(/No se confirmó la revocación/i);
    expect(within(alert.closest('[role="alert"]') as HTMLElement).getByRole('button', { name: 'Reintentar revocación' })).toBeInTheDocument();
    expect(posts).toEqual(['zeus']);
  });

  it('cada dirección muestra un único escenario con el tenant y el alias pedidos', async () => {
    serveTwoAgents(); serveSessions([], []);
    renderAt('/terminal/Isa/salva');
    expect(await screen.findByRole('heading', { level: 2, name: /salva/ })).toHaveTextContent('Isa');
    go('/terminal/Steven/kant');
    expect(await screen.findByRole('heading', { level: 2, name: /kant/ })).toHaveTextContent('Steven');
    expect(document.querySelectorAll('[data-objeto-principal]')).toHaveLength(1);
    expect(document.querySelectorAll('header')).toHaveLength(1);
    go('/terminal');
    expect(await screen.findByText('Elegí un agente')).toBeInTheDocument();
  });
});
