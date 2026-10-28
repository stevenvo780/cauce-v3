import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, expect, it } from 'vitest';
import { server } from '../mocks/server';
import { renderWithApi } from '../test/render';
import type { BillingOverview } from '../api/client/billing-client';
import { PlanNotice } from './PlanNotice';

const PLANS: BillingOverview['plans'] = [
  { plan: 'gestionado', price_usd: 100, unit: 'agent', agent_limit_per_unit: 1, recommended_quantity: 3 },
  { plan: 'hotel_20', price_usd: 150, unit: 'company', agent_limit_per_unit: 20 },
  { plan: 'hotel_50', price_usd: 300, unit: 'company', agent_limit_per_unit: 50 },
  { plan: 'espacio', price_usd: 40, unit: 'space', agent_limit_per_unit: 5 },
];

function serve(overrides: Partial<BillingOverview>): void {
  server.use(http.get('*/v3/console/billing', () => HttpResponse.json({ configured: true, exempt: false, plans: PLANS, currency: 'COP',
    usd_rate: 3200, fee: { percent: 3.29, fixed: 800, vat: 19 }, subscription: null, allowance: { limit: 0, used: 3 }, ...overrides })));
}

afterEach(() => { window.history.replaceState(null, '', '/'); });

it('sin plan activo avisa, enseña los cuatro planes y lleva al elegido', async () => {
  const user = userEvent.setup();
  serve({});
  renderWithApi(<PlanNotice />);
  expect(await screen.findByText(/no tiene un plan activo/)).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Ver planes' }));
  const dialog = await screen.findByRole('dialog', { name: 'Elige cómo trabaja tu equipo de agentes' });
  for (const name of ['Gestionado', 'Hotel 20', 'Hotel 50', 'Por espacio']) expect(within(dialog).getByRole('article', { name })).toBeInTheDocument();
  expect(within(dialog).getByText('Recomendado: 3 agentes')).toBeInTheDocument();
  await user.click(within(dialog).getByRole('button', { name: 'Elegir Hotel 50' }));
  await waitFor(() => { expect(window.location.pathname + window.location.search).toBe('/config?seccion=plan&plan=hotel_50'); });
});

it('una empresa exenta o con plan activo no ve el aviso', async () => {
  serve({ exempt: true });
  const { unmount } = renderWithApi(<PlanNotice />);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(screen.queryByText(/plan activo/)).not.toBeInTheDocument();
  unmount();
  serve({ subscription: { id: 's1', plan: 'gestionado', quantity: 3, agent_limit: 3, amount_usd: 300, currency: 'COP',
    amount_local: 1000108, status: 'authorized', checkout_url: null } });
  renderWithApi(<PlanNotice />);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(screen.queryByRole('button', { name: 'Ver planes' })).not.toBeInTheDocument();
});

it('con el pago pendiente lo dice y lleva a su plan', async () => {
  serve({ subscription: { id: 's1', plan: 'gestionado', quantity: 3, agent_limit: 3, amount_usd: 300, currency: 'COP',
    amount_local: 1000108, status: 'pending', checkout_url: 'https://mp.test/pay/1' } });
  renderWithApi(<PlanNotice />);
  expect(await screen.findByText(/pago en Mercado Pago está pendiente/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Ver mi plan' })).toBeInTheDocument();
});
