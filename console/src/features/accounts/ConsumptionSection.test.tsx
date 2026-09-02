import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { AccountsPage } from './AccountsPage';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import type { QuotaSnapshot } from '../../api/types';

/**
 * "Accounts and quotas" is ONE view with two sources: `/v3/console/quotas` (consumption) and `/v3/console/config`
 * (inventory and routing). These tests exist above all so it does not get split in two again: each half has an
 * assertion here that fails if someone moves it to another route or deletes it "because it was already on the other
 * screen".
 *
 * They are mounted against `AccountsPage` —the real container, with its tabs— and NOT against `ConsumptionSection`
 * alone: a test that renders the section on its own would keep passing the day someone took it out of the page.
 */

const ACCOUNTS_HEADING = 'Cuentas y cuotas';

/** Opens a tab by its label and waits for its panel to be mounted. */
async function openTab(user: ReturnType<typeof userEvent.setup>, label: string) {
  await user.click(screen.getByRole('tab', { name: label }));
}

const QUOTAS_URL = 'http://localhost/v3/console/quotas';
const CONFIG_URL = 'http://localhost/v3/console/config';

const BASE: QuotaSnapshot = {
  observed_at: '2026-07-27T14:52:11.000Z',
  thresholds: {
    stale_after_seconds: 900,
    warn_remaining_percent: 25,
    critical_remaining_percent: 10,
    history_window_seconds: 86_400,
    history_bucket_seconds: 1_800,
    history_max_points: 48,
  },
  collectors: [
    { host: 'kratos', collector_tenant: 'Steven', collector_alias: 'quota-collector', captured_at: '2026-07-27T14:40:28.000Z', received_at: '2026-07-27T14:40:29.000Z', age_seconds: 702, stale: false, schema_version: 2, app_version: '0.12.0', provider_count: 2, window_count: 4 },
  ],
  providers: [
    {
      host: 'kratos', provider: 'opencode', ok: true, available: true, kind: 'detected-percent', source: 'opencode-db', plan: null,
      note: 'Estimado local.', effective_remaining_percent: 100, observed_at: '2026-07-27T14:40:14.000Z', age_seconds: 717,
      available_groups: [], limiting_groups: [], severity: 'ok',
      groups: [{
        group_key: 'default', limit_id: null, account_id: 'minimax-pool', account_label: 'MiniMax / OpenCode',
        account_provider: 'opencode', payer_tenant_id: 'Steven', paused_until: null, paused_reason: null,
        min_remaining_percent: 100, severity: 'ok',
        windows: [
          { window_key: '5h', label: '5 horas', used_percent: 0, remaining_percent: 100, used_units: 0, limit_units: 12, window_minutes: 300, reset_at: '2026-07-27T19:40:14.000Z', reset_in_seconds: 17_283, status: null, family: null, model: null, severity: 'ok', history: { bucket_seconds: 1_800, points: [{ at: 'a', used_percent: 0 }, { at: 'b', used_percent: 0 }] } },
        ],
      }],
    },
    {
      host: 'kratos', provider: 'codex', ok: true, available: true, kind: 'detected-percent', source: 'codex-app-server', plan: 'pro',
      note: 'Codex app-server (consulta oficial).', effective_remaining_percent: 100, observed_at: '2026-07-27T14:40:28.000Z', age_seconds: 703,
      available_groups: ['codex_bengalfox'], limiting_groups: ['codex'], severity: 'exhausted',
      groups: [
        {
          group_key: 'codex', limit_id: 'codex', account_id: 'codex-pro-steven', account_label: 'Codex Pro (principal)',
          account_provider: 'codex', payer_tenant_id: 'Steven', paused_until: '2026-08-01T19:18:21.000Z', paused_reason: 'quota_exhausted:codex/codex/codex_primary_10080',
          min_remaining_percent: 0, severity: 'exhausted',
          windows: [
            { window_key: 'codex_primary_10080', label: 'semana', used_percent: 100, remaining_percent: 0, used_units: null, limit_units: null, window_minutes: 10_080, reset_at: '2026-08-01T19:18:21.000Z', reset_in_seconds: 447_970, status: 'rate-limited', family: null, model: null, severity: 'exhausted', history: { bucket_seconds: 1_800, points: [{ at: 'a', used_percent: 94 }, { at: 'b', used_percent: 100 }] } },
          ],
        },
        {
          group_key: 'codex_bengalfox', limit_id: 'codex_bengalfox', account_id: null, account_label: null,
          account_provider: null, payer_tenant_id: null, paused_until: null, paused_reason: null,
          min_remaining_percent: 100, severity: 'ok',
          windows: [
            { window_key: 'codex_bengalfox_primary_10080', label: 'semana', used_percent: 0, remaining_percent: 100, used_units: null, limit_units: null, window_minutes: 10_080, reset_at: '2026-08-03T14:28:04.000Z', reset_in_seconds: 603_353, status: null, family: null, model: null, severity: 'ok', history: { bucket_seconds: 1_800, points: [{ at: 'a', used_percent: 0 }, { at: 'b', used_percent: 0 }] } },
          ],
        },
      ],
    },
  ],
  unbound_groups: [
    { host: 'kratos', provider: 'codex', group_key: 'codex_bengalfox', window_count: 1, reason: 'no_account_id_supplied', detail: 'Sin account_id: no puede pausar nada.' },
  ],
  paused_accounts: [
    { account_id: 'codex-pro-steven', provider: 'codex', label: 'Codex Pro (principal)', payer_tenant_id: 'Steven', paused_until: '2026-08-01T19:18:21.000Z', paused_reason: 'quota_exhausted:codex/codex/codex_primary_10080', automatic: true },
  ],
};

/** Inventory that plugs into BASE: two accounts the collector knows and one it does not. */
const CONFIG = {
  revision: 42,
  observed_at: '2026-08-06T02:55:00.000Z',
  agents: [
    { tenant_id: 'Steven', alias: 'zeus', harness_id: 'codex', display_name: 'Zeus', enabled: true, container_name: 'claw-zeus' },
    { tenant_id: 'Steven', alias: 'kant', harness_id: 'claude', display_name: 'Kant', enabled: true, container_name: 'claw-kant' },
  ],
  provider_accounts: [
    { id: 'codex-pro-steven', provider: 'codex', payer_tenant_id: 'Steven', label: 'Codex Pro (principal)', shared_with_pool: true, enabled: true, external_account_id: 'bengalfox@openai', credential_ref_kind: 'file' },
    { id: 'minimax-pool', provider: 'opencode', payer_tenant_id: 'Miguel', label: 'MiniMax / OpenCode', shared_with_pool: false, enabled: true, external_account_id: null, credential_ref_kind: 'file' },
    { id: 'claude-max-saldantia', provider: 'claude', payer_tenant_id: 'Steven', label: 'Claude Max — saldantia.sas', shared_with_pool: true, enabled: true, external_account_id: 'saldantia.sas@gmail.com', credential_ref_kind: 'file' },
  ],
  agent_account_bindings: [
    { tenant_id: 'Steven', agent_alias: 'zeus', account_id: 'codex-pro-steven', priority: 0, enabled: true },
    { tenant_id: 'Steven', agent_alias: 'zeus', account_id: 'minimax-pool', priority: 1, enabled: true },
  ],
  alias_routing_ceiling: [
    { tenant_id: 'Steven', alias: 'zeus', account_id: 'codex-pro-steven', account_payer_tenant: 'Steven', created_by_tenant: 'Steven' },
  ],
};

function mockBoth(snapshot: QuotaSnapshot = BASE, config: Record<string, unknown> = CONFIG) {
  server.use(
    http.get(QUOTAS_URL, () => HttpResponse.json(snapshot)),
    http.get(CONFIG_URL, () => HttpResponse.json(config)),
  );
}

function panel(name: string): HTMLElement {
  const el = screen.getByRole('heading', { level: 2, name }).closest('section');
  if (!el) throw new Error(`Panel ${name} not found`);
  return el;
}

/**
 * Metric labels repeat panel titles ("Proveedores"): the search must be scoped.
 *
 * And since the view has tabs, TWO strips of metrics are mounted at once —consumption and inventory— with the
 * inactive one in `hidden`. Searching for the first one in the document would always read the same one: the search
 * runs inside the open panel.
 */
function metrics(): HTMLElement {
  const visible = Array.from(document.querySelectorAll('.view-tab-panel'))
    .find((p) => !p.hasAttribute('hidden'));
  const el = (visible ?? document).querySelector('.metrics-grid');
  if (!el) throw new Error('metrics-grid not found');
  return el as HTMLElement;
}

it('es UNA sola vista con las tres mitades: consumo, inventario y asignaciones', async () => {
  mockBoth();
  const user = userEvent.setup();
  renderWithApi(<AccountsPage />);

  await screen.findByRole('heading', { level: 1, name: ACCOUNTS_HEADING });

  // A single page heading: if someone splits this back into separate routes, the half that leaves takes its panel with it and some of these searches stop finding it.
  expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  expect(panel('Proveedores')).toBeInTheDocument();

  // The six top-level counts from the quota views coexist: none got lost in the merge.
  for (const label of [
    'Cuentas registradas', 'Con datos de cuota', 'Agentes', 'Recolectores conectados',
    'Proveedores', 'Peor remanente',
  ]) {
    expect(within(metrics()).getByText(label)).toBeInTheDocument();
  }
  // Paused subscriptions and unbound groups already own the panel that lists them, not a card.
  for (const label of ['Suscripciones pausadas', 'Grupos sin cuenta atada']) {
    expect(within(metrics()).queryByText(label)).not.toBeInTheDocument();
  }
  expect(panel('Suscripciones pausadas')).toHaveTextContent('Codex Pro (principal)');
  expect(within(panel('Hallazgos')).getByText('Grupos sin cuenta atada')).toBeInTheDocument();

  await openTab(user, 'Inventario');
  expect(panel('Inventario de cuentas')).toBeInTheDocument();
  // And the four that only "AI accounts" used to bring.
  for (const label of [
    'Cuentas visibles', 'Publicadas al pool', 'Habilitadas', 'Pagadas por otro tenant',
  ]) {
    expect(within(metrics()).getByText(label)).toBeInTheDocument();
  }

  await openTab(user, 'Asignaciones');
  expect(screen.getByRole('heading', { level: 2, name: /techo por alias/i })).toBeInTheDocument();
});

it('conserva entero el inventario de licencias: identidad, pagador, asignaciones y techo de ruteo', async () => {
  mockBoth();
  const user = userEvent.setup();
  renderWithApi(<AccountsPage />);

  await screen.findByRole('heading', { level: 1, name: ACCOUNTS_HEADING });
  await openTab(user, 'Inventario');
  const inventory = panel('Inventario de cuentas');
  const text = inventory.textContent;

  expect(text).toContain('codex-pro-steven');
  expect(text).toContain('bengalfox@openai');
  // An account paid by another tenant does not expose its external id, and that is stated in full.
  expect(text).toMatch(/No visible: la paga Miguel/i);
  expect(within(inventory).getAllByText('PUBLICADA').length).toBeGreaterThan(0);
  // The plan comes from the quota sample, on the consumption side: the merge is what makes it possible to read it in the SAME row as the account that has it.
  expect(within(inventory).getByRole('row', { name: /codex-pro-steven/ })).toHaveTextContent('pro');

    // Who uses the account and with what priority, and the routing ceiling: they do not exist anywhere else in the
    // console together with the balance, and they are the reason for the merge. They live in the row detail.
  await user.click(within(inventory).getByRole('button', { name: /Detalle de ruteo de codex-pro-steven/ }));
  const detail = panel('Inventario de cuentas').querySelector('.account-detail-row');
  expect(detail).not.toBeNull();
  if (detail instanceof HTMLElement) {
    const detailText = detail.textContent;
    expect(detailText).toContain('zeus');
    expect(detailText).toContain('claw-zeus');
    expect(within(detail).getByText('FALLBACK #1')).toBeInTheDocument();
    expect(detailText).not.toContain('PRIMARIA');
    expect(detailText).toMatch(/Techo de ruteo/);
    expect(detailText).toMatch(/puede alcanzar esta cuenta/);
  }
});

it('conserva entero el consumo: peor primero, una fila por grupo y el histórico de 24 h', async () => {
  mockBoth();
  renderWithApi(<AccountsPage />);

  const heading = await screen.findByRole('heading', { level: 2, name: 'Proveedores' });
  const providers = heading.closest('section');
  expect(providers).not.toBeNull();
  if (providers) {
    const cards = within(providers).getAllByRole('heading', { level: 3 });
    // codex is exhausted and opencode ok: the exhausted one must come first.
    expect(cards[0]).toHaveTextContent(/codex/i);

    const codexRow = within(providers).getByRole('row', { name: /codex pro/i });
    expect(within(codexRow).getByText('AGOTADO')).toBeInTheDocument();
    expect(within(codexRow).getByText('PAUSADA')).toBeInTheDocument();
    expect(codexRow.className).toContain('row-critical');
    // 'codex' (exhausted) and 'codex_bengalfox' (free, without account) are separate rows: a single number per provider
    // would make it look like the account that does not have a balance has one.
    expect(within(providers).getByRole('row', { name: /sin cuenta/i })).toBeInTheDocument();

    const healthy = within(providers).getByRole('row', { name: /minimax/i });
    expect(healthy.className).not.toContain('row-critical');
    expect(healthy).toHaveTextContent('0 / 12');
    expect(within(providers).getAllByRole('img', { name: /consumo/i }).length).toBeGreaterThan(0);
  }

  expect(panel('Suscripciones pausadas')).toHaveTextContent('Codex Pro (principal)');
});

it('la única representación gráfica es el sparkline: las barras duplicadas de licencias no volvieron', async () => {
  mockBoth();
  renderWithApi(<AccountsPage />);
  await screen.findByRole('heading', { level: 1, name: ACCOUNTS_HEADING });

    // The account cards used to draw their own percentage bar with less data than the Proveedores table: two drawings
    // of the same number on the same page.
  expect(document.querySelectorAll('.windows-grid, .bar-container, .bar-fill')).toHaveLength(0);
  expect(document.querySelectorAll('.sparkline svg').length).toBeGreaterThan(0);
});

it('junta las tres direcciones de huérfano en un solo panel de hallazgos', async () => {
  mockBoth();
  renderWithApi(<AccountsPage />);

  const heading = await screen.findByRole('heading', { level: 2, name: 'Hallazgos' });
  const findings = heading.closest('section');
  expect(findings).not.toBeNull();
  if (findings) {
    const text = findings.textContent;
    // 1) registered account the collector does not know, 2) observed group with no bound account —with its window_count,
    // which the leaner list from the other view did not bring—, 3) agent with no binding.
    expect(text).toContain('claude-max-saldantia');
    const unboundRow = within(findings).getByRole('row', { name: /codex_bengalfox/i });
    expect(unboundRow).toHaveTextContent('Sin account_id');
    // window_count: the leaner list from the licenses view did not bring it and the quotas table did.
    expect(within(unboundRow).getAllByRole('cell')[3]).toHaveTextContent('1');
    expect(text).toContain('kant');
  }
});

it('marca desactualizado a un recolector viejo aunque el servidor lo declare fresco', async () => {
  mockBoth({
    ...BASE,
    collectors: [
      ...(BASE.collectors ?? []),
      // stale:false but 5,400 s old against a 900 s threshold: the licenses view applied this rule and the quotas view
      // did not. The stricter one wins.
      { host: 'ws-midas', collector_tenant: 'Pablo', collector_alias: 'quota-collector', captured_at: '2026-07-27T13:00:00.000Z', received_at: '2026-07-27T13:00:01.000Z', age_seconds: 5_400, stale: false, schema_version: 2, app_version: '0.11.4', provider_count: 1, window_count: 1 },
    ],
  });
  renderWithApi(<AccountsPage />);

  const heading = await screen.findByRole('heading', { level: 2, name: 'Recolectores' });
  const collectors = heading.closest('section');
  expect(collectors).not.toBeNull();
  if (collectors) {
    expect(within(within(collectors).getByRole('row', { name: /kratos/i })).getByText('FRESCO')).toBeInTheDocument();
    expect(within(within(collectors).getByRole('row', { name: /ws-midas/i })).getByText('DESACTUALIZADO')).toBeInTheDocument();
  }
  // And it is said above, once, which sample the numbers below come from.
  expect(screen.getByText(/Muestra vieja\./)).toBeInTheDocument();
});

it('sin recolector NO inventa porcentajes: muestra el inventario y declara que no hay consumo', async () => {
  // This is the REAL production state: /v3/console/quotas returns everything empty because the kratos collector never
  // signed up for POST /v3/quotas/samples.
  mockBoth({
    observed_at: '2026-08-06T02:55:00.107Z',
    thresholds: { stale_after_seconds: 900 },
    collectors: [],
    providers: [],
    unbound_groups: [],
    paused_accounts: [],
  });
  renderWithApi(<AccountsPage />);

  await screen.findByRole('heading', { level: 1, name: ACCOUNTS_HEADING });

  // ONCE. The cause is the same for all three accounts, so repeating it on each card —which is what the global-scope
  // `reason` used to do— only makes it read less.
  expect(screen.getAllByText(/Ningún recolector reportó/)).toHaveLength(1);

  // Inventory is still useful: the account and who it is assigned to show the same.
  const user = userEvent.setup();
  await openTab(user, 'Inventario');
  const inventory = panel('Inventario de cuentas');
  expect(inventory).toHaveTextContent('codex-pro-steven');
  expect(inventory.textContent).not.toContain('Ningún recolector reportó');
  await user.click(within(inventory).getByRole('button', { name: /Detalle de ruteo de codex-pro-steven/ }));
  expect(panel('Inventario de cuentas')).toHaveTextContent('claw-zeus');
  // The GLOBAL reason is not repeated in the detail: it was already declared once above.
  expect(document.querySelectorAll('.account-notice')).toHaveLength(0);
  // And consumption is declared as absent, not as zero.
  expect(panel('Inventario de cuentas').textContent).not.toMatch(/\d+\s*%/);
});

it('una sonda caída no reaparece como un número: la cuenta queda en interrogante', async () => {
  mockBoth({
    observed_at: '2026-08-06T02:55:00.107Z',
    thresholds: { stale_after_seconds: 900, warn_remaining_percent: 25, critical_remaining_percent: 10 },
    collectors: [{ host: 'kratos', received_at: '2026-08-06T02:54:00.000Z', age_seconds: 60, stale: false }],
    providers: [{
      host: 'kratos',
      provider: 'codex',
      ok: false,
      note: 'el CLI dejó de responder',
      observed_at: '2026-08-06T02:54:00.000Z',
      age_seconds: 60,
      groups: [{ group_key: 'codex', account_id: 'codex-pro-steven', min_remaining_percent: null, windows: [] }],
    }],
    unbound_groups: [],
    paused_accounts: [],
  });
  renderWithApi(<AccountsPage />);

  await screen.findByRole('heading', { level: 1, name: ACCOUNTS_HEADING });
  expect(screen.getByText(/Sonda caída\./)).toBeInTheDocument();
  // The reason shows up in the aggregated banner, in the provider card, and in the affected account: all three are
  // different reads of the same `ok:false`, none is redundant.
  expect(screen.getAllByText(/dejó de responder/).length).toBeGreaterThan(0);

  expect(panel('Proveedores').textContent).not.toMatch(/\d+\s*%\s*libre/);

  // The per-account reason DOES stay when it says something the banner above does not: that THIS account was left
  // numberless by the probe of ITS provider, and that the others the collector did not even bring. It lives in the
  // inventory row detail, where it explains the gap.
  const user = userEvent.setup();
  await openTab(user, 'Inventario');
  for (const id of ['codex-pro-steven', 'minimax-pool', 'claude-max-saldantia']) {
    await user.click(screen.getByRole('button', { name: `Detalle de ruteo de ${id}` }));
  }
  const notices = Array.from(document.querySelectorAll('.account-notice')).map((n) => n.textContent);
  expect(notices.filter((text) => text.includes('Sonda caída:'))).toHaveLength(1);
  expect(notices.filter((text) => text.includes('El recolector no reportó esta cuenta'))).toHaveLength(2);

  // The hard guarantee: no invented percentage for an account whose probe died.
  const inventory = panel('Inventario de cuentas');
  expect(inventory).toHaveTextContent('codex-pro-steven');
  expect(inventory.textContent).not.toMatch(/\d+\s*%/);
});

it('si se cae el consumo, el inventario sigue en pantalla y hay un botón para reintentar', async () => {
  server.use(
    http.get(QUOTAS_URL, () => HttpResponse.json({ error: 'boom', message: 'cuotas caídas' }, { status: 500 })),
    http.get(CONFIG_URL, () => HttpResponse.json(CONFIG)),
  );
  renderWithApi(<AccountsPage />);

  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent(/cuotas caídas/i);
  expect(within(alert).getByRole('button', { name: /reintentar/i })).toBeInTheDocument();
  // And it does not assert "ningún recolector reportó" when what happened is that the response never arrived.
  expect(screen.queryByText(/Ningún recolector reportó/)).not.toBeInTheDocument();

  // Half the console down cannot take down the other half: the inventory does not depend on
  // that endpoint.
  const user = userEvent.setup();
  await openTab(user, 'Inventario');
  expect(panel('Inventario de cuentas')).toHaveTextContent('codex-pro-steven');
});

it('si se cae el inventario, el consumo sigue en pantalla y lo dice sin listar cuentas vacías', async () => {
  server.use(
    http.get(QUOTAS_URL, () => HttpResponse.json(BASE)),
    http.get(CONFIG_URL, () => HttpResponse.json({ error: 'boom', message: 'inventario caído' }, { status: 500 })),
  );
  renderWithApi(<AccountsPage />);

  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent(/inventario caído/i);
  expect(panel('Proveedores')).toHaveTextContent(/codex/i);

  const user = userEvent.setup();
  await openTab(user, 'Inventario');
  // Without a snapshot there is no inventory to list, and that is said instead of showing an
  // empty table.
  expect(panel('Inventario de cuentas')).toHaveTextContent(/No disponible/i);
});
