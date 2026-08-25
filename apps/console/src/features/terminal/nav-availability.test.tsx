/**
 * Covers the navigation.ts additions from here (features/terminal/) rather than as a sibling
 * of navigation.ts itself — this task's file scope is the terminal feature plus navigation.ts,
 * and importing across that boundary keeps the new test file itself inside the granted directory.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import {
  CONFIG_SIN_CONTROL_REASON,
  configNavAvailability,
  navigate,
  onNavClick,
  terminalNavAvailability,
} from '../../navigation';
import type { TerminalRelayState } from './relay-status';

function relay(status: TerminalRelayState['status'], reason = ''): TerminalRelayState {
  return { status, reason };
}

describe('terminalNavAvailability', () => {
  it('leaves the entry enabled while checking, so the menu never flashes disabled on load', () => {
    expect(terminalNavAvailability(relay('checking'))).toEqual({ hidden: false, disabled: false });
  });

  it('leaves the entry enabled once the relay is confirmed available', () => {
    expect(terminalNavAvailability(relay('available'))).toEqual({ hidden: false, disabled: false });
  });

  it('disables — never hides — the entry when the relay is unavailable, and carries the one-line reason', () => {
    expect(terminalNavAvailability(relay('unavailable', 'El relay de terminales no está desplegado en este stack.')))
      .toEqual({ hidden: false, disabled: true, reason: 'El relay de terminales no está desplegado en este stack.' });
  });
});

function Link({ disabledReason }: { disabledReason?: string }) {
  return (
    <a href="/terminal" onClick={(event) => onNavClick(event, '/terminal', disabledReason)}>
      Terminal de agentes
    </a>
  );
}

describe('onNavClick with disabledReason', () => {
  beforeEach(() => {
    window.history.pushState({}, '', '/fleet');
  });

  it('navigates normally when there is no disabledReason', () => {
    render(<Link />);
    fireEvent.click(screen.getByRole('link', { name: 'Terminal de agentes' }));
    expect(window.location.pathname).toBe('/terminal');
  });

  it('blocks navigation and leaves the path untouched when disabledReason is set', () => {
    render(<Link disabledReason="El relay de terminales no está desplegado en este stack." />);
    fireEvent.click(screen.getByRole('link', { name: 'Terminal de agentes' }));
    expect(window.location.pathname).toBe('/fleet');
  });

  it('does not intercept ctrl+click, preserving the browser new-tab gesture', () => {
    render(<Link />);
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true });
    screen.getByRole('link', { name: 'Terminal de agentes' }).dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(window.location.pathname).toBe('/fleet');
  });

  it('leaves plain navigate() calls unaffected — only onNavClick gates on the reason', () => {
    navigate('/terminal');
    expect(window.location.pathname).toBe('/terminal');
  });
});

describe('configNavAvailability', () => {
  it('no toca la entrada cuando el permiso está concedido', () => {
    expect(configNavAvailability('allowed')).toEqual({ hidden: false, disabled: false });
  });

  it('tampoco la toca cuando el RBAC no se pudo leer: ante la duda no se le quita nada a nadie', () => {
    expect(configNavAvailability('unknown')).toEqual({ hidden: false, disabled: false });
  });

  it('la deja inerte y con motivo cuando el permiso está denegado', () => {
    expect(configNavAvailability('denied')).toEqual({
      hidden: false,
      disabled: true,
      reason: CONFIG_SIN_CONTROL_REASON,
    });
  });
});
