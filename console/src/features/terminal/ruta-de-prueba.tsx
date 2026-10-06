import { act } from '@testing-library/react';
import { StrictMode } from 'react';
import { navigate } from '../../router';
import { renderRouted } from '../../test/render';
import { TerminalPage } from './TerminalPage';

/** Opening an agent is a route change: the sidebar links and the picker cards do exactly this. */
export function renderAt(path: string, { strict = false }: { strict?: boolean } = {}) {
  window.history.pushState({}, '', path);
  return renderRouted(strict
    ? (props) => <StrictMode><TerminalPage {...props} /></StrictMode>
    : TerminalPage);
}

export function go(path: string) {
  act(() => { navigate(path); });
}
