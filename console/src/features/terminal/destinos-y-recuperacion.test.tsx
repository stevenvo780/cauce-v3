/**
 * The two ends of the inventory: what a destination that is NOT plainly usable does to the
 * controls, and what the view does when the control plane answers badly and then recovers. Both
 * are everyday paths —half the fleet publishes only its TUI, and presence is the first read to
 * wobble— and both end in a grey control with nothing written on it when they are not checked.
 */
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import type { TerminalTarget } from './api';
import { installStubWebSocket, StubWebSocket } from './pty-socket-stub';
import { TerminalPage } from './TerminalPage';

const WS_PATH = '/v3/console/terminal/ws';

function target(overrides: Partial<TerminalTarget> & Pick<TerminalTarget, 'tenant_id' | 'alias'>): TerminalTarget {
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

let restoreSocket: () => void;

beforeEach(() => {
  serveTargets(null);
  restoreSocket = installStubWebSocket();
});
afterEach(() => { restoreSocket(); });

describe('destinos que el servidor publica a medias', () => {
  /**
   * The everyday shape of the fleet: the agent lends its TUI and does not offer a new shell. The
   * console must not turn a read-only mirror into an interactive terminal, and it must say so
   * where the shell is refused — not leave a grey button with an empty tooltip.
   */
  it('sólo con modo harness: la TUI se abre y la shell queda cerrada con el motivo escrito', async () => {
    const user = userEvent.setup();
    let posts = 0;
    enableCapability();
    serveTargets([target({ tenant_id: 'Steven', alias: 'zeus', modes: ['harness'] })]);
    server.use(http.post('*/v3/console/terminal/sessions', () => {
      posts += 1;
      return HttpResponse.json({ error: 'conflict', reason: 'agent_offline' }, { status: 409 });
    }));
    renderWithApi(<TerminalPage />);

    await user.click(await screen.findByRole('button', { name: /abrir sesión con zeus/i }));

    // The TUI is offered —the server publishes `harness`— and it is what got asked for.
    await waitFor(() => { expect(posts).toBe(1); });
    const pty = screen.getByRole('button', { name: /^PTY$/i });
    expect(pty).toBeDisabled();
    expect(pty).toHaveAttribute('title', expect.stringContaining('no publica el modo shell'));
    expect(screen.getByText(/no convierte una TUI de solo lectura en una terminal interactiva/i)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  }, 20_000);

  /**
   * An old gateway answered `ok` for every authorized row, including the ones whose PTY state it
   * had not measured. That placeholder must never reach the operator as the explanation.
   */
  it('un estado PTY sin medir no se pinta como disponible ni se explica con el «ok» del servidor', async () => {
    const user = userEvent.setup();
    let posts = 0;
    enableCapability();
    serveTargets([target({ tenant_id: 'Steven', alias: 'zeus', pty_state: 'unknown', reason: 'ok' })]);
    server.use(http.post('*/v3/console/terminal/sessions', () => {
      posts += 1;
      return new HttpResponse(null, { status: 500 });
    }));
    renderWithApi(<TerminalPage />);

    await user.click(await screen.findByRole('button', { name: /abrir sesión con zeus.*PTY: PTY desconocido/i }));
    await screen.findByRole('link', { name: /escribir a zeus en mensajes/i });

    await waitFor(() => { expect(screen.getByRole('button', { name: /^PTY$/i })).toBeDisabled(); });
    expect(screen.getByRole('button', { name: /^TUI$/i })).toBeDisabled();
    expect(screen.getAllByText(/no publicó una medición verificable/i).length).toBeGreaterThan(0);
    // Nothing was asked of the gateway and no socket opened on an unmeasured destination.
    expect(posts).toBe(0);
    expect(StubWebSocket.instances).toHaveLength(0);
  }, 20_000);
});

describe('el plano de control que contesta a medias y luego se recupera', () => {
  it('nombra el endpoint caído y el aviso se va cuando «Reintentar» consigue leerlo', async () => {
    const user = userEvent.setup();
    let caido = true;
    server.use(http.get('*/v3/status', () => (caido
      ? HttpResponse.json({ error: 'unavailable' }, { status: 503 })
      : HttpResponse.json({ presence: [], queues: [], rooms: [] }))));
    renderWithApi(<TerminalPage />);

    const aviso = await screen.findByRole('alert');
    expect(aviso).toHaveTextContent('El plano de control contestó a medias');
    // The failing read is named: "Presencia", not a bare technical error with no owner.
    expect(aviso).toHaveTextContent(/Presencia:/);
    // The fleet still came from topology, so the view is degraded and not empty.
    expect(await screen.findByRole('button', { name: /abrir sesión con kant/i })).toBeInTheDocument();

    caido = false;
    await user.click(within(aviso).getByRole('button', { name: /reintentar/i }));

    await waitFor(() => {
      expect(screen.queryByText('El plano de control contestó a medias')).not.toBeInTheDocument();
    });
  }, 20_000);
});
