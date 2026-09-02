import { screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { renderRouted } from '../../test/render';
import { MessagesPage } from './MessagesPage';

/* The vertical gate (console/qa/layout-gate.mjs) measures the thread through this same deep link:
   the bare /messages shows the roster and declares no primary object at all. */

beforeEach(() => {
  window.history.pushState({}, '', '/messages/Steven/argos');
});

afterEach(() => {
  window.history.pushState({}, '', '/');
});

it('el hilo abierto se declara como objeto principal de /messages', async () => {
  const { container } = renderRouted(MessagesPage);

  const hilo = await screen.findByRole('region', { name: /conversación con argos/i });
  expect(hilo).toHaveAttribute('data-objeto-principal', 'hilo');
  expect(container.querySelectorAll('[data-objeto-principal]')).toHaveLength(1);
}, 25_000);
