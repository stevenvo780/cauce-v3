import { StrictMode } from 'react';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { server } from '../../mocks/server';
import { mockTerminalGrant } from '../../mocks/terminal-ticket';
import { renderWithApi } from '../../test/render';
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

  expect(await screen.findByRole('tab', { name: /kant/i })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('combobox', { name: 'Agente' })).toHaveValue('Steven:kant');
  await waitFor(() => { expect(requests).toHaveLength(1); });
  expect(requests[0]).toMatchObject({ tenant_id: 'Steven', alias: 'kant', mode: 'harness_rw' });
  expect(screen.queryByRole('alert', { name: /pestaña/i })).not.toBeInTheDocument();
});

it('CONTROL: StrictMode manual selector also requests one writable session', async () => {
  const user = userEvent.setup();
  const requests: Record<string, unknown>[] = [];
  server.use(http.post('*/v3/console/terminal/sessions', async ({ request }) => {
    requests.push(await request.json() as Record<string, unknown>);
    return HttpResponse.json(mockTerminalGrant({
      sessionId, tenantId: 'Steven', alias: 'kant', mode: 'harness_rw', container: 'claw', runtimeUser: 'claw',
    }), { status: 201 });
  }));

  renderWithApi(<StrictMode><TerminalPage /></StrictMode>);
  await user.selectOptions(await screen.findByRole('combobox', { name: 'Agente' }),
    await screen.findByRole('option', { name: /^kant ·/ }));

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
    initialAgentId="Steven:kant"
    agents={[{ id: 'Steven:kant', tenantId: 'Steven', alias: 'kant', roomIds: [], roomMembership: {}, leaseState: 'online' }]}
    adapters={[]} fleetLoading={false}
    access={{ subject: 'Steven:kant', roles: ['operator'], permissions: ['ultimate-terminal.connect'] }}
    terminalCapability={{ available: true, plugin_id: 'ultimate-terminal.client', capabilities: ['terminal.pty.client'], websocket_path: '/v3/console/terminal/ws' }}
    terminalTargets={{ observed_at: new Date().toISOString(), websocket_path: '/v3/console/terminal/ws', items: [target] }}
  /></StrictMode>);
  expect(await screen.findByRole('tab', { name: /kant/i })).toHaveAttribute('aria-selected', 'true');
  await waitFor(() => { expect(requests).toHaveLength(1); });
  expect(requests[0]).toMatchObject({ tenant_id: 'Steven', alias: 'kant', mode: 'harness_rw' });
});
