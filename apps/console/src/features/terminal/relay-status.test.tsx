import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import {
  CHECKING_RELAY_STATE,
  deriveTerminalRelayState,
  TERMINAL_RELAY_NOT_DEPLOYED_REASON,
  useTerminalRelayStatus,
} from './relay-status';

describe('deriveTerminalRelayState', () => {
  it('is checking while neither a capability nor an error has arrived yet', () => {
    expect(deriveTerminalRelayState(undefined, undefined)).toEqual(CHECKING_RELAY_STATE);
  });

  it('is available only on an explicit available:true, and echoes the server reason', () => {
    expect(deriveTerminalRelayState({ available: true, reason: 'Relay saludable' }, undefined))
      .toEqual({ status: 'available', reason: 'Relay saludable' });
  });

  it('falls back to a generic reason when the server declares available:true without one', () => {
    expect(deriveTerminalRelayState({ available: true }, undefined).status).toBe('available');
  });

  it('is unavailable on a clean available:false payload and keeps the server-declared reason', () => {
    expect(deriveTerminalRelayState({ available: false, reason: 'Backend PTY no instalado en este entorno' }, undefined))
      .toEqual({ status: 'unavailable', reason: 'Backend PTY no instalado en este entorno' });
  });

  it('falls back to the doctrine phrase when the server declares available:false with no reason', () => {
    expect(deriveTerminalRelayState({ available: false }, undefined))
      .toEqual({ status: 'unavailable', reason: TERMINAL_RELAY_NOT_DEPLOYED_REASON });
  });

  it('treats a malformed/ambiguous available value as unavailable, never as available', () => {
    expect(deriveTerminalRelayState({ available: undefined as never }, undefined).status).toBe('unavailable');
  });

  it('collapses any thrown error — including a raw 502 with no JSON body — into unavailable with a one-line reason', () => {
    const state = deriveTerminalRelayState(undefined, new Error('Bad Gateway'));
    expect(state.status).toBe('unavailable');
    expect(state.reason).toContain(TERMINAL_RELAY_NOT_DEPLOYED_REASON);
    expect(state.reason).toContain('Bad Gateway');
  });

  it('never reports available on an error, even if a stale capability payload is also passed', () => {
    expect(deriveTerminalRelayState({ available: true }, new Error('network down')).status).toBe('unavailable');
  });
});

describe('useTerminalRelayStatus', () => {
  function Probe() {
    const relay = useTerminalRelayStatus(50);
    return <output>{relay.status}: {relay.reason}</output>;
  }

  it('starts checking and settles to unavailable against the default opt-in-absent mock', async () => {
    renderWithApi(<Probe />);
    expect(await screen.findByText(/^unavailable:/)).toBeInTheDocument();
    expect(screen.getByText(/Backend PTY no instalado en este entorno/)).toBeInTheDocument();
  });

  it('settles to available when the gateway declares the relay up', async () => {
    server.use(http.get('*/v3/console/terminal/capability', () => HttpResponse.json({
      available: true,
      plugin_id: 'ultimate-terminal.client',
      capabilities: ['terminal.pty.client'],
      websocket_path: '/v3/console/terminal/ws',
      reason: 'Relay activo',
    })));
    renderWithApi(<Probe />);
    expect(await screen.findByText(/^available:/)).toBeInTheDocument();
  });

  it('treats a raw 502 (no JSON body) the same as an absent relay, not as a crash', async () => {
    server.use(http.get('*/v3/console/terminal/capability', () => new HttpResponse('<html>Bad Gateway</html>', {
      status: 502,
      headers: { 'content-type': 'text/html' },
    })));
    renderWithApi(<Probe />);
    await waitFor(() => expect(screen.getByText(/^unavailable:/)).toBeInTheDocument());
  });
});
