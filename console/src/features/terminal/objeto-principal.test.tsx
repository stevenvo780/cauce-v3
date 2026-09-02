import { screen, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { renderWithApi } from '../../test/render';
import { TerminalPage } from './TerminalPage';

/* /terminal is the one route that meets the fold objective today, and the vertical gate
   (console/qa/layout-gate.mjs) would keep saying so with `[data-objeto-principal]` deleted. */

it('el escenario de la terminal se declara como objeto principal de /terminal', async () => {
  const { container } = renderWithApi(<TerminalPage />);

  await screen.findByRole('heading', { level: 1, name: 'Terminal de agentes' });
  const escenario = await waitFor(() => {
    const nodo = container.querySelector('.ultimate-terminal-shell');
    if (!nodo) throw new Error('Missing .ultimate-terminal-shell');
    return nodo;
  });
  expect(escenario).toHaveAttribute('data-objeto-principal', 'escenario');
  expect(container.querySelectorAll('[data-objeto-principal]')).toHaveLength(1);
}, 25_000);
