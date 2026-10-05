import { screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { renderWithApi } from '../../test/render';
import { LiveFleetPage } from './LiveFleetPage';

/* The vertical gate (console/qa/layout-gate.mjs) finds the view's primary object by
   `[data-objeto-principal]`, and reads the FIRST match: without it there is nothing to measure. */

it('el grafo precede a la tabla como objeto principal de /live', async () => {
  const { container } = renderWithApi(<LiveFleetPage />);

  const tabla = await screen.findByRole('table', { name: /actividad en vuelo por agente/i });
  const mapa = screen.getByRole('region', { name: 'Mapa de la flota' });
  expect(mapa).toHaveAttribute('data-objeto-principal', 'mapa-de-flota');
  expect(tabla).toHaveAttribute('data-objeto-principal', 'tabla-de-flota');
  expect([...container.querySelectorAll('[data-objeto-principal]')]).toEqual([mapa, tabla]);
});
