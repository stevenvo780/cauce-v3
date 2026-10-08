import { StrictMode } from 'react';
import { cleanup, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { server } from '../../mocks/server';
import { mockTerminalGrant } from '../../mocks/terminal-ticket';
import { renderWithApi } from '../../test/render';
import { closePtySession } from './pty-session';
import { installStubWebSocket } from './pty-socket-stub';
import { TerminalPage } from './TerminalPage';
import type { TerminalTarget } from './api';

const sessionId = 'modo-en-la-url';
const target: TerminalTarget = {
  tenant_id: 'Steven', alias: 'kant', container: 'claw', runtime_user: 'claw',
  harness: 'claude-code', shares_container_with: [], modes: ['shell', 'harness', 'harness_rw'],
  writable_modes: ['harness_rw'], pty_state: 'online', last_seen: null, authorized: true,
  reason: 'Autorizado por el servidor.',
};

let restoreSocket: () => void;
let requests: Record<string, unknown>[];

beforeEach(() => {
  requests = [];
  restoreSocket = installStubWebSocket();
  server.use(
    http.get('*/v3/console/terminal/capability', () => HttpResponse.json({
      available: true, plugin_id: 'ultimate-terminal.client',
      capabilities: ['terminal.pty.client'], websocket_path: '/v3/console/terminal/ws',
    })),
    http.get('*/v3/console/terminal/targets', () => HttpResponse.json({
      observed_at: new Date().toISOString(), websocket_path: '/v3/console/terminal/ws', items: [target],
    })),
    http.post('*/v3/console/terminal/sessions', async ({ request }) => {
      const body = await request.json() as Record<string, unknown>;
      requests.push(body);
      return HttpResponse.json(mockTerminalGrant({
        sessionId, tenantId: 'Steven', alias: 'kant', mode: String(body.mode), container: 'claw', runtimeUser: 'claw',
        requestId: String(body.request_id),
      }), { status: 201 });
    }),
  );
});

afterEach(() => {
  cleanup();
  closePtySession(sessionId);
  restoreSocket();
  window.history.pushState({}, '', '/');
});

it.each([
  ['terminal', 'shell'],
  ['tui', 'harness_rw'],
])('?modo=%s opens the agent straight into a %s channel, once', async (modo, mode) => {
  window.history.pushState({}, '', `/terminal/Steven/kant?modo=${modo}`);
  renderWithApi(<StrictMode><TerminalPage params={['Steven', 'kant']} /></StrictMode>);

  expect(await screen.findByRole('heading', { level: 2, name: /kant/i })).toBeInTheDocument();
  await waitFor(() => { expect(requests).toHaveLength(1); });
  expect(requests[0]).toMatchObject({ tenant_id: 'Steven', alias: 'kant', mode });
  expect(screen.getByRole('button', { name: modo === 'tui' ? /TUI/ : /Terminal/ })).toHaveAttribute('aria-pressed', 'true');
});
