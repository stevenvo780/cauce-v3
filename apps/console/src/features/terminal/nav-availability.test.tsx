/**
 * Covers the navigation.ts additions from here (features/terminal/) rather than as a sibling
 * of navigation.ts itself — this task's file scope is the terminal feature plus navigation.ts,
 * and importing across that boundary keeps the new test file itself inside the granted directory.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { navigate, onNavClick, terminalNavAvailability } from '../../navigation';
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
      Ultimate Terminal
    </a>
  );
}

describe('onNavClick with disabledReason', () => {
  beforeEach(() => {
    window.history.pushState({}, '', '/fleet');
  });

  it('navigates normally when there is no disabledReason', () => {
    render(<Link />);
    fireEvent.click(screen.getByRole('link', { name: 'Ultimate Terminal' }));
    expect(window.location.pathname).toBe('/terminal');
  });

  it('blocks navigation and leaves the path untouched when disabledReason is set', () => {
    render(<Link disabledReason="El relay de terminales no está desplegado en este stack." />);
    fireEvent.click(screen.getByRole('link', { name: 'Ultimate Terminal' }));
    expect(window.location.pathname).toBe('/fleet');
  });

  it('leaves plain navigate() calls unaffected — only onNavClick gates on the reason', () => {
    navigate('/terminal');
    expect(window.location.pathname).toBe('/terminal');
  });
});
