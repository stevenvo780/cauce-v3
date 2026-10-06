import { screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { renderChat } from './chat-test-utils';

/* The vertical gate (console/qa/layout-gate.mjs) measures the thread through this same deep link:
   the bare /messages shows the roster and declares no primary object at all. */

afterEach(() => {
  window.history.pushState({}, '', '/');
});

it('el hilo abierto se declara como objeto principal de /messages', async () => {
  const { container } = renderChat('/messages/Steven/argos');

  const hilo = await screen.findByRole('region', { name: /conversación con argos/i });
  expect(hilo).toHaveAttribute('data-objeto-principal', 'hilo');
  expect(container.querySelectorAll('[data-objeto-principal]')).toHaveLength(1);
}, 25_000);
