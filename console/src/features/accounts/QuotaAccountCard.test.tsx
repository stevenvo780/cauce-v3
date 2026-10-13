import { act, render, screen, waitFor, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { HttpResponse, http } from 'msw';
import type { QuotaAccount } from '../../api/client/my-quotas-client';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { AgentQuotaDetail } from './AgentQuotaDetail';
import { QuotaAccountCard } from './QuotaAccountCard';

const account: QuotaAccount = { id: 'subscription', provider: 'codex', label: 'Cuenta', enabled: true, version: 1,
  payer_tenant_id: 'One', shared: false, agent_count: 0, agents: [], paused_until: null, paused_reason: null,
  observation_status: 'stale', remaining_percent: 56, note: null, windows: [] };

it('muestra la actualización automática sin acreditar disponibilidad con una lectura antigua', () => {
  const view = render(<QuotaAccountCard account={{ ...account, refresh_status: 'updating' }} pinned={false} />);
  const card = within(screen.getByRole('article', { name: 'Cuotas de Cuenta' }));
  expect(card.getByRole('status')).toHaveTextContent('Actualizando…');
  expect(card.getAllByText(/Datos antiguos/u).length).toBeGreaterThan(0);
  expect(card.queryByText('Disponible')).not.toBeInTheDocument();
  view.rerender(<QuotaAccountCard account={{ ...account, refresh_status: 'fresh' }} pinned={false} />);
  expect(card.queryByText('Actualizando…')).not.toBeInTheDocument();
});

it.each([
  ['executor_unavailable', 'No hay un ejecutor disponible para actualizar esta cuenta.'],
  ['not_authenticated', 'Cuenta sin autenticar: autentícala desde su entorno.'],
  ['read_only', 'La consulta automática requiere permiso para operar el entorno.'],
  ['failed', 'La consulta automática falló. Relee el entorno para revisar su resultado.'],
  ['stale', 'La consulta terminó y la captura sigue antigua. Se consultará de nuevo en la próxima ventana.'],
] as const)('muestra %s sin presentarlo como una actualización en curso', (refresh_status, message) => {
  render(<QuotaAccountCard account={{ ...account, refresh_status }} pinned={false} />);
  expect(screen.getByText(message)).toBeVisible();
  expect(screen.queryByText('Actualizando…')).not.toBeInTheDocument();
});

it('la ficha muestra la actualización y relee la tarjeta con su poller existente', async () => {
  let completed = false; const reads = vi.fn(); const date = '2026-10-13T00:00:00Z';
  server.use(http.get('*/v3/console/quota-accounts', () => {
    reads(); return HttpResponse.json({ company_id: 'one', observed_at: date, accounts: [{ ...account,
      refresh_status: completed ? 'fresh' : 'updating', observation_status: completed ? 'ok' : 'stale',
      agents: [{ tenant_id: 'One', alias: 'janus', enabled: true }], agent_count: 1, remaining_percent: completed ? 81 : 56,
      windows: [{ group_key: 'primary', window_key: 'weekly', model: null, label: 'Semanal', host: 'host', used_percent: completed ? 19 : 44,
        remaining_percent: completed ? 81 : 56, window_minutes: 10_080, captured_at: date, received_at: date, reset_at: null,
        observation_status: completed ? 'ok' : 'stale' }] }] });
  }));
  const intervals = vi.spyOn(window, 'setInterval'); renderWithApi(<AgentQuotaDetail tenant="One" alias="janus" />);
  const card = within(await screen.findByRole('article', { name: 'Cuotas de Cuenta' }));
  expect(card.getByRole('status')).toHaveTextContent('Actualizando…');
  expect(card.queryByRole('meter')).not.toBeInTheDocument();
  const tick = intervals.mock.calls.filter(([, period]) => period === 30_000).at(-1)?.[0];
  if (typeof tick !== 'function') throw new Error('No se registró el poller existente de la ficha.');
  completed = true; act(() => { tick(); });
  await waitFor(() => { expect(card.getByRole('meter')).toHaveAttribute('value', '81'); });
  expect(card.queryByText('Actualizando…')).not.toBeInTheDocument(); expect(reads).toHaveBeenCalledTimes(2);
});
