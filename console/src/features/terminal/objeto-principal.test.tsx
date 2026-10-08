import { screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { renderWithApi } from '../../test/render';
import { TerminalPage } from './TerminalPage';

/* /terminal is the one route that meets the fold objective today, and the vertical gate
   (console/qa/layout-gate.mjs) would keep saying so with `[data-objeto-principal]` deleted. */

it('el escenario de la terminal se declara como único objeto principal, con o sin agente', async () => {
  const { container, unmount } = renderWithApi(<TerminalPage />);
  await screen.findByRole('heading', { level: 1, name: 'Terminal de agentes' });
  expect(container.querySelectorAll('[data-objeto-principal="escenario"]')).toHaveLength(1);
  unmount();

  const abierto = renderWithApi(<TerminalPage params={['Steven', 'kant']} />);
  await screen.findByRole('heading', { level: 2, name: /kant/ });
  expect(abierto.container.querySelectorAll('[data-objeto-principal="escenario"]')).toHaveLength(1);
}, 25_000);
