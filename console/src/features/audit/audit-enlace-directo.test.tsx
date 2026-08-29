import { screen, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { App } from '../../App';
import { renderWithApi } from '../../test/render';

/** A bookmark to `/audit` must open the AUDIT tab: the rewrite to `/observability` used to lose it. */

it('/audit abre la pestaña de auditoría, no «Señales»', async () => {
  window.history.pushState({}, '', '/audit');
  renderWithApi(<App />);

  const auditoria = await screen.findByRole('tab', { name: /auditoría/i }, { timeout: 10_000 });
  expect(auditoria).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('tab', { name: /señales y relays/i })).toHaveAttribute('aria-selected', 'false');
  // The audit book is there, with its own search, and the relay table is not.
  expect(await screen.findByRole('searchbox', { name: /filtrar auditoría/i })).toBeInTheDocument();
  await waitFor(() => { expect(window.location.pathname).toBe('/observability'); });
});

it('/observability sigue abriendo en «Señales»: el destino lo decide la dirección', async () => {
  window.history.pushState({}, '', '/observability');
  renderWithApi(<App />);

  const senales = await screen.findByRole('tab', { name: /señales y relays/i }, { timeout: 10_000 });
  expect(senales).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('tab', { name: /auditoría/i })).toHaveAttribute('aria-selected', 'false');
});
