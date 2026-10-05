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
  await user.selectOptions(await screen.findByRole('combobox', { name: 'Agente' }), await screen.findByRole('option', { name: /^zeus ·/ }));
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

async function select(user: ReturnType<typeof userEvent.setup>, alias: string) {
  await user.selectOptions(screen.getByRole('combobox', { name: 'Agente' }),
    screen.getByRole('option', { name: new RegExp(`^${alias} ·`) }));
}

describe('cambiar el agente seleccionado', () => {
  it('seleccionar el mismo agente conserva socket, ticket y salida', async () => {
    const user = userEvent.setup();
    const posts: string[] = [], deletes: string[] = [];
    serveTwoAgents(); serveSessions(posts, deletes);
    renderWithApi(<TerminalPage />);
    await openTui(user);
    await select(user, 'zeus');
    expect(ptySessionText('sid-zeus')).toContain('zeus corriendo');
    expect(StubWebSocket.instances).toHaveLength(1);
    expect(posts).toEqual(['zeus']);
    expect(deletes).toEqual([]);
  });

  it('devuelve el canal anterior y al regresar abre una intención nueva', async () => {
    const user = userEvent.setup();
    const posts: string[] = [], deletes: string[] = [];
    serveTwoAgents(); serveSessions(posts, deletes);
    renderWithApi(<TerminalPage />);
    const old = await openTui(user);
    await select(user, 'salva');
    await screen.findByRole('link', { name: /escribir a salva en mensajes/i });
    expect(deletes).toEqual(['sid-zeus']);
    expect(old.readyState).toBe(StubWebSocket.CLOSED);
    await select(user, 'zeus');
    await waitFor(() => { expect(posts).toEqual(['zeus', 'zeus']); });
    expect(StubWebSocket.instances).toHaveLength(2);
    expect(StubWebSocket.last()).not.toBe(old);
  });

  it('cerrar la TUI no la reabre al volver a elegir el mismo agente', async () => {
    const user = userEvent.setup();
    const posts: string[] = [], deletes: string[] = [];
    serveTwoAgents(); serveSessions(posts, deletes);
    renderWithApi(<TerminalPage />);
    await openTui(user);
    await user.click(within(await screen.findByLabelText('Sesión PTY activa'))
      .getByRole('button', { name: /cerrar la terminal/i }));
    await waitFor(() => { expect(deletes).toEqual(['sid-zeus']); });
    await select(user, 'zeus');
    expect(posts).toEqual(['zeus']);
    expect(screen.queryByLabelText('Sesión PTY activa')).not.toBeInTheDocument();
  });

  it('una negativa permanente no se reintenta por elegir el agente ya visible', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    serveTwoAgents();
    server.use(http.post('*/v3/console/terminal/sessions', () => {
      attempts += 1;
      return HttpResponse.json({ reason: 'no_grant' }, { status: 403 });
    }));
    renderWithApi(<TerminalPage />);
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Agente' }),
      await screen.findByRole('option', { name: /^zeus ·/ }));
    expect(await screen.findByRole('alert')).toHaveAttribute('data-codigo', 'no_grant');
    await select(user, 'zeus');
    expect(attempts).toBe(1);
    expect(StubWebSocket.instances).toHaveLength(0);
  });

  it('si falla la devolución conserva el agente anterior y no abre otra reserva', async () => {
    const user = userEvent.setup();
    const posts: string[] = [], deletes: string[] = [];
    serveTwoAgents(); serveSessions(posts, deletes);
    server.use(http.delete('*/v3/console/terminal/sessions/:sid', () =>
      HttpResponse.json({ reason: 'temporary_failure' }, { status: 503 })));
    renderWithApi(<TerminalPage />);
    await openTui(user);
    await select(user, 'salva');
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Agente' })).toHaveValue('Steven:zeus');
    expect(posts).toEqual(['zeus']);
    expect(screen.queryByRole('link', { name: /escribir a salva en mensajes/i })).not.toBeInTheDocument();
  });

  it('cada selección conserva su enlace canónico y solo un escenario', async () => {
    const user = userEvent.setup();
    serveTwoAgents(); serveSessions([], []);
    renderWithApi(<TerminalPage />);
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Agente' }),
      await screen.findByRole('option', { name: /^salva ·/ }));
    expect(await screen.findByRole('link', { name: /escribir a salva en mensajes/i }))
      .toHaveAttribute('href', '/messages/Isa/salva');
    await select(user, 'kant');
    expect(await screen.findByRole('link', { name: /escribir a kant en mensajes/i }))
      .toHaveAttribute('href', '/messages/Steven/kant');
    expect(screen.queryByRole('link', { name: /escribir a salva en mensajes/i })).not.toBeInTheDocument();
    expect(document.querySelectorAll('.terminal-session-head')).toHaveLength(1);
    expect(screen.getAllByRole('tab')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: /cerrar sesión kant/i }));
    expect(await screen.findByText('Ningún agente seleccionado')).toBeInTheDocument();
  });
});
