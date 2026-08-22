import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { ApiError } from '../../api/client';
import {
  CHECKING_RELAY_STATE,
  deriveTerminalRelayState,
  TERMINAL_RELAY_NOT_DEPLOYED_REASON,
  TERMINAL_RELAY_SIN_PERMISO_REASON,
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
      .toEqual({ status: 'unavailable', cause: 'no-desplegado', reason: 'Backend PTY no instalado en este entorno' });
  });

  it('falls back to the doctrine phrase when the server declares available:false with no reason', () => {
    expect(deriveTerminalRelayState({ available: false }, undefined))
      .toEqual({ status: 'unavailable', cause: 'no-desplegado', reason: TERMINAL_RELAY_NOT_DEPLOYED_REASON });
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

  /**
   * El defecto medido el 2026-08-22: con una cuenta sin `control`, la ruta contesta 403 —el gate
   * corre ANTES de mirar el backend PTY— y la consola lo contaba como «no está desplegado».
   */
  describe('un 403 es una falta de permiso, NUNCA una ausencia de relay', () => {
    it('lo clasifica como sin-permiso y no dice que el relay no está desplegado', () => {
      const state = deriveTerminalRelayState(undefined, new ApiError('control permission is required', 403, 'forbidden'));
      expect(state.status).toBe('unavailable');
      expect(state.cause).toBe('sin-permiso');
      expect(state.reason).toBe(TERMINAL_RELAY_SIN_PERMISO_REASON);
      expect(state.reason).not.toContain(TERMINAL_RELAY_NOT_DEPLOYED_REASON);
      expect(state.reason).not.toContain('HTTP 403');
    });

    it('dice, con esas palabras, que el relay puede estar desplegado y que lo que falta es el permiso', () => {
      const state = deriveTerminalRelayState(undefined, new ApiError('forbidden', 403));
      expect(state.reason).toContain('no tiene permiso de control');
      expect(state.reason).toContain('lo que falta es el permiso');
    });

    it('sigue diciendo «no desplegado» para el 501 que sí lo significa, ya normalizado a available:false', () => {
      const state = deriveTerminalRelayState({ available: false, reason: 'Backend PTY no disponible' }, undefined);
      expect(state.cause).toBe('no-desplegado');
    });

    it('un 404 y un 501 nunca se confunden con una falta de permiso', () => {
      expect(deriveTerminalRelayState(undefined, new ApiError('not found', 404)).cause).toBe('no-desplegado');
      expect(deriveTerminalRelayState(undefined, new ApiError('not implemented', 501)).cause).toBe('no-desplegado');
    });

    it('no declara causa cuando el relay está disponible ni mientras se está comprobando', () => {
      expect(deriveTerminalRelayState({ available: true }, undefined).cause).toBeUndefined();
      expect(deriveTerminalRelayState(undefined, undefined).cause).toBeUndefined();
    });
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
