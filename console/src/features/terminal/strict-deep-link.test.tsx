import { StrictMode } from 'react';
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { server } from '../../mocks/server';
import { mockTerminalGrant } from '../../mocks/terminal-ticket';
import { navigate } from '../../router';
import { renderRouted, renderWithApi } from '../../test/render';
import { closePtySession } from './pty-session';
import { installStubWebSocket } from './pty-socket-stub';
import { TerminalPage } from './TerminalPage';
import { OperatorWorkspace } from './OperatorWorkspace';
import type { TerminalTarget } from './api';

const sessionId = 'strict-link-session';
const target: TerminalTarget = {
  tenant_id: 'Steven', alias: 'kant', container: 'claw', runtime_user: 'claw',
  harness: 'claude-code', shares_container_with: [], modes: ['shell', 'harness', 'harness_rw'],
  writable_modes: ['harness_rw'], pty_state: 'online', last_seen: null, authorized: true,
  reason: 'Autorizado por el servidor.',
};

let restoreSocket: () => void;

function RoutedTerminal() {
  const [, ...params] = window.location.pathname.split('/').filter(Boolean);
  return <TerminalPage params={params} />;
}

function installAuthority() {
  server.use(
    http.get('*/v3/console/terminal/capability', () => HttpResponse.json({
      available: true, plugin_id: 'ultimate-terminal.client',
      capabilities: ['terminal.pty.client'], websocket_path: '/v3/console/terminal/ws',
    })),
    http.get('*/v3/console/terminal/targets', () => HttpResponse.json({
      observed_at: new Date().toISOString(), websocket_path: '/v3/console/terminal/ws', items: [target],
    })),
  );
}

beforeEach(() => {
  installAuthority();
  restoreSocket = installStubWebSocket();
});

afterEach(() => {
  cleanup();
  closePtySession(sessionId);
  restoreSocket();
});

it('CONTROL: StrictMode deep-link opens exactly one writable session after the fleet loads', async () => {
  const requests: Record<string, unknown>[] = [];
  server.use(http.post('*/v3/console/terminal/sessions', async ({ request }) => {
    const body = await request.json() as Record<string, unknown>;
    requests.push(body);
    return HttpResponse.json(mockTerminalGrant({
      sessionId, tenantId: 'Steven', alias: 'kant', mode: 'harness_rw', container: 'claw', runtimeUser: 'claw',
      requestId: String(body.request_id),
    }), { status: 201 });
  }));

  renderWithApi(<StrictMode><TerminalPage params={['Steven', 'kant']} /></StrictMode>);

  expect(await screen.findByRole('heading', { level: 2, name: /kant/i })).toBeInTheDocument();
  await waitFor(() => { expect(requests).toHaveLength(1); });
  expect(requests[0]).toMatchObject({ tenant_id: 'Steven', alias: 'kant', mode: 'harness_rw' });
  expect(screen.queryByRole('alert', { name: /pestaña/i })).not.toBeInTheDocument();
});

it('CONTROL: StrictMode opening by in-app navigation from the bare route also requests one writable session', async () => {
  const requests: Record<string, unknown>[] = [];
  server.use(http.post('*/v3/console/terminal/sessions', async ({ request }) => {
    requests.push(await request.json() as Record<string, unknown>);
    return HttpResponse.json(mockTerminalGrant({
      sessionId, tenantId: 'Steven', alias: 'kant', mode: 'harness_rw', container: 'claw', runtimeUser: 'claw',
    }), { status: 201 });
  }));

  window.history.pushState({}, '', '/terminal');
  renderRouted(() => <StrictMode><RoutedTerminal /></StrictMode>);
  await screen.findByRole('heading', { level: 2, name: 'Elegí un agente en la barra lateral' });
  act(() => { navigate('/terminal/Steven/kant'); });

  await waitFor(() => { expect(requests).toHaveLength(1); });
  expect(requests[0]).toMatchObject({ tenant_id: 'Steven', alias: 'kant', mode: 'harness_rw' });
  expect(screen.queryByRole('alert', { name: /pestaña/i })).not.toBeInTheDocument();
});

it('StrictMode conserva el token de un enlace con inventario ya disponible al montar', async () => {
  const requests: Record<string, unknown>[] = [];
  server.use(http.post('*/v3/console/terminal/sessions', async ({ request }) => {
    const body = await request.json() as Record<string, unknown>;
    requests.push(body);
    return HttpResponse.json(mockTerminalGrant({
      sessionId, tenantId: 'Steven', alias: 'kant', mode: 'harness_rw', container: 'claw', runtimeUser: 'claw',
      requestId: String(body.request_id),
    }), { status: 201 });
  }));
  renderWithApi(<StrictMode><OperatorWorkspace
    agentId="Steven:kant"
    live={new Map()}
    summary=""
    onRefresh={() => undefined}
    agents={[{ id: 'Steven:kant', tenantId: 'Steven', alias: 'kant', roomIds: [], roomMembership: {}, leaseState: 'online' }]}
    fleetLoading={false}
    access={{ subject: 'Steven:kant', roles: ['operator'], permissions: ['ultimate-terminal.connect'] }}
    terminalCapability={{ available: true, plugin_id: 'ultimate-terminal.client', capabilities: ['terminal.pty.client'], websocket_path: '/v3/console/terminal/ws' }}
    terminalTargets={{ observed_at: new Date().toISOString(), websocket_path: '/v3/console/terminal/ws', items: [target] }}
  /></StrictMode>);
  expect(await screen.findByRole('heading', { level: 2, name: /kant/i })).toBeInTheDocument();
  await waitFor(() => { expect(requests).toHaveLength(1); });
  expect(requests[0]).toMatchObject({ tenant_id: 'Steven', alias: 'kant', mode: 'harness_rw' });
});
