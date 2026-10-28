import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, expect, it, vi } from 'vitest';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import type { BillingOverview, BillingSubscription } from '../../api/client/billing-client';
import { BillingSection } from './BillingSection';
import { chargedLocal, clampQuantity, formatLocal, totalUsd } from './billing-model';

const PLANS: BillingOverview['plans'] = [
  { plan: 'gestionado', price_usd: 100, unit: 'agent', agent_limit_per_unit: 1, recommended_quantity: 3 },
  { plan: 'hotel_20', price_usd: 150, unit: 'company', agent_limit_per_unit: 20 },
  { plan: 'hotel_50', price_usd: 300, unit: 'company', agent_limit_per_unit: 50 },
  { plan: 'espacio', price_usd: 40, unit: 'space', agent_limit_per_unit: 5 },
];

function overview(overrides: Partial<BillingOverview> = {}): BillingOverview {
  return { configured: true, exempt: false, plans: PLANS, currency: 'COP', usd_rate: 4000, subscription: null,
    allowance: { limit: 0, used: 0 }, ...overrides };
}

function subscription(overrides: Partial<BillingSubscription> = {}): BillingSubscription {
  return { id: 's1', plan: 'gestionado', quantity: 3, agent_limit: 3, amount_usd: 300, currency: 'COP',
    amount_local: 1200000, status: 'authorized', checkout_url: null, ...overrides };
}

interface Call { method: string; path: string; body?: unknown }

function billing(state: () => BillingOverview): Call[] {
  const calls: Call[] = [];
  server.use(
    http.get('*/v3/console/billing', () => HttpResponse.json(state())),
    http.post('*/v3/console/billing/checkout', async ({ request }) => {
      calls.push({ method: 'POST', path: 'checkout', body: await request.json() });
      return HttpResponse.json({ checkout_url: 'https://mp.test/pay/1' });
    }),
    http.post('*/v3/console/billing/cancel', () => { calls.push({ method: 'POST', path: 'cancel' }); return HttpResponse.json({}); }),
    http.post('*/v3/console/billing/refresh', () => { calls.push({ method: 'POST', path: 'refresh' }); return HttpResponse.json({}); }),
  );
  return calls;
}

afterEach(() => { vi.unstubAllGlobals(); window.history.replaceState(null, '', '/'); });

function stubAssign() {
  const assign = vi.fn();
  vi.stubGlobal('location', { href: window.location.href, pathname: window.location.pathname, assign, search: window.location.search });
  return assign;
}

it('muestra los cuatro planes con precio en dólares y su equivalente local', async () => {
  billing(() => overview());
  renderWithApi(<BillingSection />);
  const gestionado = await screen.findByRole('article', { name: 'Gestionado' });
  expect(within(gestionado).getByText('Recomendado')).toBeInTheDocument();
  expect(within(gestionado).getByRole('spinbutton')).toHaveValue(3);
  expect(within(gestionado).getByText(/US\$\s?300/)).toBeInTheDocument();
  expect(within(gestionado).getByText(/1\.200\.000/)).toBeInTheDocument();
  expect(screen.getByRole('article', { name: 'Hotel 20' })).toHaveTextContent(/150/);
  expect(screen.getByRole('article', { name: 'Hotel 50' })).toHaveTextContent(/300/);
  expect(screen.getByRole('article', { name: 'Por espacio' })).toHaveTextContent(/Hasta 5 agentes/);
});

it('el sello Recomendado solo está en 3 agentes y el selector se acota a 1–50', async () => {
  const user = userEvent.setup();
  billing(() => overview());
  renderWithApi(<BillingSection />);
  const gestionado = await screen.findByRole('article', { name: 'Gestionado' });
  const cantidad = within(gestionado).getByRole('spinbutton');
  await user.clear(cantidad);
  await user.type(cantidad, '7');
  expect(within(gestionado).queryByText('Recomendado')).not.toBeInTheDocument();
  expect(within(gestionado).getByText(/Hasta 7 agentes/)).toBeInTheDocument();
  await user.clear(cantidad);
  await user.type(cantidad, '99');
  expect(within(gestionado).getByText(/Hasta 50 agentes/)).toBeInTheDocument();
  await user.tab();
  expect(cantidad).toHaveValue(50);
});

it('paga con Mercado Pago: pide el checkout y redirige', async () => {
  const user = userEvent.setup();
  const assign = stubAssign();
  const calls = billing(() => overview());
  renderWithApi(<BillingSection />);
  const espacio = await screen.findByRole('article', { name: 'Por espacio' });
  const cantidad = within(espacio).getByRole('spinbutton');
  await user.clear(cantidad);
  await user.type(cantidad, '2');
  await user.click(within(espacio).getByRole('button', { name: 'Pagar con Mercado Pago' }));
  await waitFor(() => { expect(assign).toHaveBeenCalledWith('https://mp.test/pay/1'); });
  expect(calls).toEqual([{ method: 'POST', path: 'checkout', body: { plan: 'espacio', quantity: 2 } }]);
});

it('envía el correo de la cuenta de Mercado Pago cuando se escribe', async () => {
  const user = userEvent.setup();
  stubAssign();
  const calls = billing(() => overview());
  renderWithApi(<BillingSection />);
  await user.type(await screen.findByLabelText(/Correo de tu cuenta de Mercado Pago/), 'pagador@correo.test');
  await user.click(within(await screen.findByRole('article', { name: 'Hotel 50' })).getByRole('button', { name: 'Pagar con Mercado Pago' }));
  await waitFor(() => { expect(calls).toEqual([{ method: 'POST', path: 'checkout', body: { plan: 'hotel_50', quantity: 1, payer_email: 'pagador@correo.test' } }]); });
});

it('un plan de hotel envía cantidad 1', async () => {
  const user = userEvent.setup();
  stubAssign();
  const calls = billing(() => overview());
  renderWithApi(<BillingSection />);
  await user.click(within(await screen.findByRole('article', { name: 'Hotel 50' })).getByRole('button', { name: 'Pagar con Mercado Pago' }));
  await waitFor(() => { expect(calls).toHaveLength(1); });
  expect(calls[0].body).toEqual({ plan: 'hotel_50', quantity: 1 });
});

it('muestra el plan vigente con agentes usados y límite, y bloquea comprar otro', async () => {
  billing(() => overview({ subscription: subscription(), allowance: { limit: 3, used: 2 } }));
  renderWithApi(<BillingSection />);
  const actual = await screen.findByRole('region', { name: 'Plan actual' });
  expect(within(actual).getByText('Activo')).toBeInTheDocument();
  expect(screen.getByLabelText('Agentes usados')).toHaveTextContent('Agentes: 2 de 3');
  for (const boton of screen.getAllByRole('button', { name: 'Pagar con Mercado Pago' })) expect(boton).toBeDisabled();
});

it('cancela con confirmación en la página, sin window.confirm', async () => {
  const user = userEvent.setup();
  const confirmar = vi.spyOn(window, 'confirm');
  let actual = overview({ subscription: subscription() });
  const calls = billing(() => actual);
  renderWithApi(<BillingSection />);
  await user.click(await screen.findByRole('button', { name: 'Cancelar suscripción' }));
  expect(calls).toEqual([]);
  await user.click(screen.getByRole('button', { name: 'No cancelar' }));
  expect(calls).toEqual([]);
  await user.click(screen.getByRole('button', { name: 'Cancelar suscripción' }));
  actual = overview({ subscription: subscription({ status: 'cancelled' }) });
  await user.click(screen.getByRole('button', { name: 'Sí, cancelar suscripción' }));
  await waitFor(() => { expect(calls).toEqual([{ method: 'POST', path: 'cancel' }]); });
  expect(await screen.findByText('Cancelado')).toBeInTheDocument();
  expect(confirmar).not.toHaveBeenCalled();
});

it('al volver del pago relee el estado con refresh', async () => {
  window.history.replaceState(null, '', '/config?seccion=plan&pago=vuelta');
  let actual = overview({ subscription: subscription({ status: 'pending' }) });
  const calls = billing(() => actual);
  actual = overview({ subscription: subscription({ status: 'authorized' }), allowance: { limit: 3, used: 0 } });
  renderWithApi(<BillingSection />);
  expect(await screen.findByText('Activo')).toBeInTheDocument();
  expect(calls).toEqual([{ method: 'POST', path: 'refresh' }]);
  expect(screen.getByRole('status')).toHaveTextContent(/Pago recibido/);
});

it('sin la marca de vuelta no llama a refresh', async () => {
  const calls = billing(() => overview());
  renderWithApi(<BillingSection />);
  await screen.findByRole('article', { name: 'Hotel 20' });
  expect(calls).toEqual([]);
});

it('una empresa exenta lo dice y enseña los planes sin dejar pagar', async () => {
  billing(() => overview({ exempt: true, allowance: { limit: 0, used: 8 } }));
  renderWithApi(<BillingSection />);
  expect(await screen.findByText('Esta empresa no paga plan')).toBeInTheDocument();
  expect(await screen.findByRole('article', { name: 'Hotel 50' })).toBeInTheDocument();
  for (const boton of screen.getAllByRole('button', { name: 'Pagar con Mercado Pago' })) expect(boton).toBeDisabled();
  expect(screen.queryByLabelText(/Correo de tu cuenta de Mercado Pago/)).not.toBeInTheDocument();
});

it('sin configurar lo dice y no ofrece pagar', async () => {
  billing(() => overview({ configured: false }));
  renderWithApi(<BillingSection />);
  expect(await screen.findByText('Pagos sin configurar')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Pagar con Mercado Pago' })).not.toBeInTheDocument();
});

it('un 503 billing_unconfigured se muestra como pagos sin configurar', async () => {
  server.use(http.get('*/v3/console/billing', () => HttpResponse.json({ error: 'billing_unconfigured' }, { status: 503 })));
  renderWithApi(<BillingSection />);
  expect(await screen.findByText('Pagos sin configurar')).toBeInTheDocument();
});

it('un 409 en el checkout explica que ya hay una suscripción', async () => {
  const user = userEvent.setup();
  stubAssign();
  billing(() => overview());
  server.use(http.post('*/v3/console/billing/checkout', () => HttpResponse.json({ error: 'subscription_exists' }, { status: 409 })));
  renderWithApi(<BillingSection />);
  await user.click(within(await screen.findByRole('article', { name: 'Hotel 20' })).getByRole('button', { name: 'Pagar con Mercado Pago' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/ya tiene una suscripción/);
});

it('el modelo de precios acota cantidades y calcula totales y equivalente local', () => {
  expect(clampQuantity('gestionado', 0)).toBe(1);
  expect(clampQuantity('gestionado', 80)).toBe(50);
  expect(clampQuantity('espacio', 11)).toBe(10);
  expect(totalUsd(PLANS[0], 3)).toBe(300);
  expect(totalUsd(PLANS[1], 9)).toBe(150);
  expect(formatLocal(300, 'USD', 1)).toBeUndefined();
  expect(formatLocal(300, 'COP', 4000)).toMatch(/1\.200\.000/);
  expect(chargedLocal(300, 3200, { percent: 3.29, fixed: 800, vat: 19 })).toBe(1000108);
});
