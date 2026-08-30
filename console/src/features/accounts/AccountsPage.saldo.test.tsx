import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { AccountsPage } from './AccountsPage';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import type { QuotaSnapshot } from '../../api/types';
import type { QuotaSeverity } from '../../api/types/quotas';

/**
 * The balance, read across the two tabs that show it.
 *
 * "Cuentas y cuotas" prints the same number in two places —the Consumption table and the Inventory column— and
 * they used to disagree: different criteria for the color at the exact threshold, the header metric measuring
 * something else than its own label said, and raw ratios printed with fourteen decimals. These tests mount the
 * whole page, like the operator sees it, and compare the two tabs against each other.
 */

const QUOTAS_URL = 'http://localhost/v3/console/quotas';
const CONFIG_URL = 'http://localhost/v3/console/config';

const THRESHOLDS = {
  stale_after_seconds: 900,
  warn_remaining_percent: 25,
  critical_remaining_percent: 10,
};

/** A fresh collector: without it every percentage below turns into `?` and nothing can be compared. */
const COLLECTORS = [
  { host: 'kratos', collector_tenant: 'Steven', collector_alias: 'quota-collector', received_at: '2026-08-22T09:59:30.000Z', age_seconds: 30, stale: false },
];

/**
 * One provider, one account, one window: the grain the two tabs share.
 *
 * `severity` travels separately from the percentage because that is how the sample comes: the server decides it
 * and the console does not recompute it. `null` is the case where the console has to fall back to the number.
 */
function provider(accountId: string, remaining: number, severity: QuotaSeverity | null, overrides: Record<string, unknown> = {}) {
  return {
    host: 'kratos', provider: `prov-${accountId}`, ok: true, available: true, plan: null,
    observed_at: '2026-08-22T09:59:30.000Z', age_seconds: 30, severity,
    groups: [{
      group_key: `grupo-${accountId}`, account_id: accountId, account_label: `Grupo ${accountId}`,
      min_remaining_percent: remaining, severity,
      windows: [{
        window_key: 'semana', label: 'semana', used_percent: 100 - remaining, remaining_percent: remaining,
        reset_at: '2026-08-29T10:00:00.000Z', reset_in_seconds: 600_000, severity,
      }],
    }],
    ...overrides,
  };
}

function account(id: string) {
  return {
    id, provider: `prov-${id}`, payer_tenant_id: 'Steven', label: `Cuenta ${id}`, shared_with_pool: false,
    enabled: true, external_account_id: `${id}@ext`, credential_ref_kind: 'file',
    updated_at: '2026-08-22T10:00:00.000Z',
  };
}

function mock(quotas: Partial<QuotaSnapshot>, config: Record<string, unknown> = {}) {
  server.use(
    http.get(QUOTAS_URL, () => HttpResponse.json({
      observed_at: '2026-08-22T10:00:00.000Z', thresholds: THRESHOLDS, collectors: COLLECTORS,
      providers: [], unbound_groups: [], paused_accounts: [], ...quotas,
    })),
    http.get(CONFIG_URL, () => HttpResponse.json({
      revision: 7, observed_at: '2026-08-22T10:00:00.000Z', tenants: [{ id: 'Steven' }, { id: 'Miguel' }],
      provider_accounts: [], agents: [], agent_account_bindings: [], alias_routing_ceiling: [], ...config,
    })),
  );
}

/** The metrics strip of the tab that is open: both are mounted at once, the hidden one included. */
function metrics(): HTMLElement {
  const visible = Array.from(document.querySelectorAll('.view-tab-panel')).find((panel) => !panel.hasAttribute('hidden'));
  const grid = (visible ?? document).querySelector('.metrics-grid');
  if (!grid) throw new Error('metrics-grid not found');
  return grid as HTMLElement;
}

function metric(label: string): HTMLElement {
  const article = within(metrics()).getByText(label).closest('article');
  if (!article) throw new Error(`metric ${label} not found`);
  return article;
}

async function openTab(user: ReturnType<typeof userEvent.setup>, label: string) {
  await user.click(screen.getByRole('tab', { name: label }));
}

/** The balance badge of an account's row in the Inventory. */
function balanceBadge(accountId: string): HTMLElement {
  const row = screen.getByRole('row', { name: new RegExp(`^${accountId} `) });
  const balance = Array.from(row.querySelectorAll<HTMLElement>('.badge')).find((node) => node.textContent.includes('libre'));
  if (!balance) throw new Error(`${accountId} sin badge de saldo: ${row.textContent}`);
  return balance;
}

it('«Peor remanente» mide la peor VENTANA, no el porcentaje efectivo que la propia página desaconseja', async () => {
  // The exact shape this page describes further down: codex publishes an effective 100 % while one of its
  // groups is exhausted. The card called itself "peor remanente" and showed the 100 %.
  mock({
    providers: [{
      ...provider('codex-steven', 0, 'exhausted', { effective_remaining_percent: 100 }),
      groups: [
        {
          group_key: 'codex', account_id: 'codex-steven', account_label: 'Codex', min_remaining_percent: 0, severity: 'exhausted',
          windows: [{ window_key: 'semana', label: 'semana', used_percent: 100, remaining_percent: 0, reset_in_seconds: 600, severity: 'exhausted' }],
        },
        {
          group_key: 'codex_bengalfox', account_id: null, account_label: null, min_remaining_percent: 100, severity: 'ok',
          windows: [{ window_key: 'semana', label: 'semana', used_percent: 0, remaining_percent: 100, reset_in_seconds: 600, severity: 'ok' }],
        },
      ],
    }],
  });
  renderWithApi(<AccountsPage />);

  await screen.findByRole('heading', { level: 1, name: /cuentas y cuotas/i });
  const peor = metric('Peor remanente');
  expect(within(peor).getByText('0%')).toBeInTheDocument();
  // NEGATIVE CONTROL: the effective percentage must not be what is read here. Without this line, a card that
  // kept using `effective_remaining_percent` would still pass the assertion above the day both numbers agree.
  expect(peor.textContent).not.toContain('100%');
  expect(peor.className).toContain('metric-danger');
});

it('en el borde exacto del umbral el Inventario dice lo mismo que Consumo', async () => {
  // 25 % is exactly the warning threshold and the server calls it OK (it compares with `<`). The Inventory
  // compared with `<=` and painted it amber: the same account, two colors, depending on the tab.
  mock(
    { providers: [provider('borde', 25, 'ok'), provider('critico', 10, 'warn')] },
    { provider_accounts: [account('borde'), account('critico')] },
  );
  const user = userEvent.setup();
  renderWithApi(<AccountsPage />);

  await screen.findByRole('heading', { level: 1, name: /cuentas y cuotas/i });
  const providers = screen.getByRole('heading', { level: 2, name: 'Proveedores' }).closest('section');
  if (!providers) throw new Error('section not found');
  expect(within(within(providers).getByRole('row', { name: /Grupo borde/ })).getByText('OK')).toBeInTheDocument();
  expect(within(within(providers).getByRole('row', { name: /Grupo critico/ })).getByText('ATENCIÓN')).toBeInTheDocument();

  await openTab(user, 'Inventario');
  expect(balanceBadge('borde').className).toContain('badge-done');
  expect(balanceBadge('borde').className).not.toContain('badge-warning');
  expect(balanceBadge('critico').className).toContain('badge-warning');
  expect(balanceBadge('critico').className).not.toContain('badge-danger');
});

it('sin severidad del servidor el Inventario compara con `<`, como la migración', async () => {
  // An old sample, or a provider whose severity did not travel: the color still has to come out, and it comes
  // out with the SAME rule, not with a hardcoded `<=` that moves the border by one whole account.
  mock(
    { providers: [provider('borde', 25, null), provider('critico', 10, null)] },
    { provider_accounts: [account('borde'), account('critico')] },
  );
  const user = userEvent.setup();
  renderWithApi(<AccountsPage />);

  await screen.findByRole('heading', { level: 1, name: /cuentas y cuotas/i });
  await openTab(user, 'Inventario');
  expect(balanceBadge('borde').className).toContain('badge-done');
  expect(balanceBadge('critico').className).toContain('badge-warning');
});

it('respeta la severidad que informa el servidor aunque el porcentaje sugiera otra cosa', async () => {
  // A rate-limited window reports 100 % free and `exhausted`: recomputing the color from the number would
  // paint green an account that cannot take a turn.
  mock(
    {
      providers: [{
        ...provider('bloqueada', 100, 'exhausted'),
        groups: [{
          group_key: 'grupo-bloqueada', account_id: 'bloqueada', account_label: 'Grupo bloqueada',
          min_remaining_percent: 100, severity: 'exhausted',
          windows: [{ window_key: 'semana', label: 'semana', used_percent: 0, remaining_percent: 100, status: 'rate-limited', reset_in_seconds: 600, severity: 'exhausted' }],
        }],
      }],
    },
    { provider_accounts: [account('bloqueada')] },
  );
  const user = userEvent.setup();
  renderWithApi(<AccountsPage />);

  await screen.findByRole('heading', { level: 1, name: /cuentas y cuotas/i });
  await openTab(user, 'Inventario');
  expect(balanceBadge('bloqueada').className).toContain('badge-danger');
  expect(balanceBadge('bloqueada').textContent).toContain('100% libre');
});

it('no imprime el 33.333333333333336 crudo del recolector: un decimal como mucho', async () => {
  mock(
    { providers: [provider('tercios', 100 / 3, 'ok')] },
    { provider_accounts: [account('tercios')] },
  );
  const user = userEvent.setup();
  renderWithApi(<AccountsPage />);

  await screen.findByRole('heading', { level: 1, name: /cuentas y cuotas/i });
  const providers = screen.getByRole('heading', { level: 2, name: 'Proveedores' }).closest('section');
  if (!providers) throw new Error('section not found');
  expect(within(providers).getByText('33.3% libre')).toBeInTheDocument();
  expect(within(metrics()).getByText('33.3%')).toBeInTheDocument();

  await openTab(user, 'Inventario');
  expect(balanceBadge('tercios').textContent).toBe('33.3% libre');
  // Nowhere on the page: a number with more than one decimal is unreadable and nobody can act on it.
  expect(document.body.textContent).not.toMatch(/\d+\.\d{2,}\s*%/);
});

/** Two clients with an agent named the same: the real fleet has more than one `claude`. */
const HOMONIMOS = {
  provider_accounts: [account('claude-max')],
  agents: [
    { tenant_id: 'Steven', alias: 'claude', harness_id: 'claude', display_name: 'Claude de Steven', enabled: true, container_name: 'claw-steven-claude' },
    { tenant_id: 'Miguel', alias: 'claude', harness_id: 'claude', display_name: 'Claude de Miguel', enabled: true, container_name: 'claw-miguel-claude' },
  ],
  // The binding belongs to the FIRST agent on the list: crossing by alias alone —last one wins— brings back the
  // other client's homonym, which is exactly the defect this pair of tests guards.
  agent_account_bindings: [
    { tenant_id: 'Steven', agent_alias: 'claude', account_id: 'claude-max', priority: 0, enabled: true },
  ],
  alias_routing_ceiling: [
    { tenant_id: 'Steven', alias: 'claude', account_id: 'claude-max', account_payer_tenant: 'Steven', created_by_tenant: 'Steven' },
  ],
};

it('«Asignada a» nombra al agente del cliente que TIENE el binding, no a su homónimo', async () => {
  mock({ providers: [provider('claude-max', 60, 'ok')] }, HOMONIMOS);
  const user = userEvent.setup();
  renderWithApi(<AccountsPage />);

  await screen.findByRole('heading', { level: 1, name: /cuentas y cuotas/i });
  await openTab(user, 'Inventario');
  await user.click(screen.getByRole('button', { name: /Detalle de ruteo de claude-max/ }));

  const detail = document.querySelector('.account-detail-row');
  if (!(detail instanceof HTMLElement)) throw new Error('detalle no abierto');
  expect(detail).toHaveTextContent('Steven/claude');
  expect(detail).toHaveTextContent('Claude de Steven');
  expect(detail).toHaveTextContent('claw-steven-claude');
  // The homonym of the other client has nothing to do with this account.
  expect(detail.textContent).not.toContain('claw-miguel-claude');
  expect(detail.textContent).not.toContain('Claude de Miguel');
});

it('el binding de un cliente no tapa al homónimo del otro en «Agentes sin bindings»', async () => {
  mock({ providers: [provider('claude-max', 60, 'ok')] }, HOMONIMOS);
  renderWithApi(<AccountsPage />);

  const findings = (await screen.findByRole('heading', { level: 2, name: 'Hallazgos' })).closest('section');
  if (!findings) throw new Error('section not found');
  const orphans = within(findings).getByRole('heading', { name: /agentes sin bindings/i }).closest('div');
  if (!orphans) throw new Error('finding-section not found');
  // Qualified by client, because the bare alias does not identify anyone: Steven's is the orphan one.
  expect(orphans).toHaveTextContent('Miguel/claude');
  expect(orphans.textContent).not.toContain('Steven/claude');
  expect(within(orphans).getAllByRole('listitem')).toHaveLength(1);
});
