import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ApiProvider } from '../../api/context';
import { server } from '../../mocks/server';
import { mockTerminalGrant } from '../../mocks/terminal-ticket';
import { renderWithApi, testApi } from '../../test/render';
import type { TerminalSessionGrant } from './api';
import { ControlDeTui } from './ControlDeTui';
import { LIVE_TUI_MODE, SHELL_MODE, WRITABLE_TUI_MODE } from './fleet';
import { closePtySession } from './pty-session';
import { installStubWebSocket, StubWebSocket } from './pty-socket-stub';
import { TerminalPage } from './TerminalPage';

const READONLY_SESSION = 'lifecycle-readonly';
const WRITABLE_SESSION = 'lifecycle-writable';
const READY = { type: 'ready', claim_token: '12345678-1234-4234-8234-123456789abc', claim_epoch: '1', claim_lease_ms: 45_000 };
interface ControlCall { sid: string; body: Record<string, unknown> }
let restoreSocket: () => void;

beforeEach(() => { restoreSocket = installStubWebSocket(); });
afterEach(async () => {
  cleanup();
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  closePtySession(READONLY_SESSION);
  closePtySession(WRITABLE_SESSION);
  restoreSocket();
});

function arrange(delayedOwner?: string) {
  const controls: ControlCall[] = [];
  let resolveTake!: () => void;
  const delayed = new Promise<void>(resolve => { resolveTake = resolve; });
  server.use(
    http.get('*/v3/console/terminal/capability', () => HttpResponse.json({
      available: true, plugin_id: 'ultimate-terminal.client', capabilities: ['terminal.pty.client'],
      websocket_path: '/v3/console/terminal/ws',
    })),
    http.get('*/v3/console/terminal/targets', () => HttpResponse.json({
      observed_at: new Date().toISOString(), websocket_path: '/v3/console/terminal/ws',
      items: [{ tenant_id: 'Steven', alias: 'zeus', container: 'ws-zeus', runtime_user: 'dev',
        harness: 'claude-code', shares_container_with: [], modes: [SHELL_MODE, LIVE_TUI_MODE, WRITABLE_TUI_MODE],
        writable_modes: [WRITABLE_TUI_MODE], pty_state: 'online', last_seen: null, authorized: true, reason: 'Synthetic fixture' }],
    })),
    http.post('*/v3/console/terminal/sessions', async ({ request }) => {
      const body = await request.json() as Record<string, unknown>;
      return HttpResponse.json(mockTerminalGrant({
        sessionId: body.mode === WRITABLE_TUI_MODE ? WRITABLE_SESSION : READONLY_SESSION,
        tenantId: 'Steven', alias: 'zeus', container: 'ws-zeus', runtimeUser: 'dev', mode: String(body.mode), requestId: String(body.request_id),
      }), { status: 201 });
    }),
    http.delete('*/v3/console/terminal/sessions/:sid', () => new HttpResponse(null, { status: 204 })),
    http.post('*/v3/console/terminal/sessions/:sid/control', async ({ request, params }) => {
      const body = await request.json() as Record<string, unknown>;
      const sid = String(params.sid);
      controls.push({ sid, body });
      if (body.action === 'take') {
        if (delayedOwner === undefined || body.owner_token === delayedOwner) await delayed;
        return HttpResponse.json({ session_id: sid, hold_id: 'synthetic-hold', held_by: 'test-operator', expires_at: new Date(Date.now() + 60_000).toISOString() });
      }
      return HttpResponse.json({ session_id: sid, hold_id: 'synthetic-hold', released: true });
    }),
  );
  const completeTake = async () => {
    await act(async () => {
      resolveTake();
      await delayed;
      await new Promise(resolve => setTimeout(resolve, 100));
    });
  };
  return { controls, completeTake };
}

function attach(socket: StubWebSocket) {
  act(() => { socket.acceptOpen(); socket.emitControl(READY); });
  return socket;
}

async function requestTake() {
  const user = userEvent.setup({ delay: null });
  return user;
}

async function openPageAndTake(controls: ControlCall[]) {
  const user = userEvent.setup({ delay: null });
  renderWithApi(<TerminalPage />);
  await user.selectOptions(await screen.findByRole('combobox', { name: 'Agente' }), await screen.findByRole('option', { name: /^zeus ·/ }));
  await waitFor(() => { expect(StubWebSocket.instances).toHaveLength(1); });
  const socket = attach(StubWebSocket.last());
  await waitFor(() => { expect(controls.filter(call => call.body.action === 'take')).toHaveLength(1); });
  return { user, socket };
}

it('releases a late successful take after leaving the terminal tab', async () => {
  const { controls, completeTake } = arrange();
  const { user } = await openPageAndTake(controls);
  await user.click(screen.getByRole('button', { name: /Cerrar sesión zeus/i }));
  expect(screen.queryByLabelText('Control de la TUI')).not.toBeInTheDocument();
  await completeTake();
  const releases = controls.filter(call => call.body.action === 'release');
  expect(releases).toHaveLength(1);
  expect(releases[0]).toMatchObject({ sid: WRITABLE_SESSION, body: {
    request_id: controls[0].body.request_id, owner_generation: controls[0].body.owner_generation,
    owner_token: controls[0].body.owner_token, authority_proof: controls[0].body.authority_proof,
  } });
});

it('does not restore ownership or send another release after relay close 4410 during take', async () => {
  const { controls, completeTake } = arrange();
  const { socket } = await openPageAndTake(controls);
  act(() => { socket.emitClose(4410, 'control_released'); });
  await screen.findByText(/Esta sesión ya no tiene el control de la TUI/);
  await completeTake();
  expect(screen.queryByText(/Tenés el teclado de esta TUI/)).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Devolver el control/i })).not.toBeInTheDocument();
  expect(document.querySelector('.pty-shell')).toHaveAttribute('data-read-only', 'true');
  expect(controls.filter(call => call.body.action === 'release')).toHaveLength(0);
});

function grant(owner: 'old' | 'new'): TerminalSessionGrant {
  return { ...mockTerminalGrant({ sessionId: WRITABLE_SESSION, tenantId: 'Steven', alias: 'zeus', mode: WRITABLE_TUI_MODE, requestId: `${owner}-request` }),
    owner_generation: owner === 'old' ? '1' : '2', owner_token: `${owner}-owner` } as unknown as TerminalSessionGrant;
}

function control(current: TerminalSessionGrant, onControlCambia = vi.fn()) {
  return <ApiProvider api={testApi}><ControlDeTui alias="zeus" grant={current} puedeEscribir
    pidiendoSesion={false} sesionEnganchada estadoDelCanal="open" onAbrirEscritura={async () => undefined}
    onControlCambia={onControlCambia} /></ApiProvider>;
}

it('does not adopt a delayed take after the same session receives a replacement owner grant', async () => {
  const old = grant('old');
  const { controls, completeTake } = arrange(old.owner_token);
  const onControlCambia = vi.fn();
  const view = render(control(old, onControlCambia));
  await requestTake();
  await waitFor(() => { expect(controls).toHaveLength(1); });
  view.rerender(control(grant('new'), onControlCambia));
  await completeTake();
  expect(screen.queryByText(/Tenés el teclado/)).not.toBeInTheDocument();
  expect(onControlCambia).not.toHaveBeenCalledWith(true);
  expect(controls.filter(call => call.body.action === 'release')).toEqual([{ sid: WRITABLE_SESSION,
    body: { action: 'release', request_id: 'old-request', owner_generation: '1', owner_token: 'old-owner',
      authority_proof: old.authority_proof } }]);
});

it('cleans the old owner without clearing or releasing a newer mounted owner hold', async () => {
  const old = grant('old');
  const { controls, completeTake } = arrange(old.owner_token);
  const oldView = render(control(old));
  await requestTake();
  await waitFor(() => { expect(controls).toHaveLength(1); });
  oldView.unmount();
  const newView = render(control(grant('new')));
  await requestTake();
  expect(await screen.findByText(/Tenés el teclado/)).toBeInTheDocument();
  await completeTake();
  const releases = controls.filter(call => call.body.action === 'release');
  expect(releases).toHaveLength(1);
  expect(releases[0].body).toMatchObject({ request_id: 'old-request', owner_generation: '1', owner_token: 'old-owner',
    authority_proof: old.authority_proof });
  expect(screen.getByText(/Tenés el teclado/)).toBeInTheDocument();
  newView.unmount();
  await waitFor(() => { expect(controls.filter(call => call.body.action === 'release')).toHaveLength(2); });
  expect(controls.at(-1)?.body).toMatchObject({ request_id: 'new-request', owner_generation: '2', owner_token: 'new-owner',
    authority_proof: grant('new').authority_proof });
});
