import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { QuotasPage } from './QuotasPage';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import type { QuotaSnapshot } from '../../api/types';

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

function mockQuotasOnce(snapshot: QuotaSnapshot) {
  server.use(http.get('http://localhost/v3/console/quotas', () => HttpResponse.json(snapshot)));
}

it('renders providers, accounts and windows from GET /v3/console/quotas, worst-first', async () => {
  mockQuotasOnce(BASE);
  renderWithApi(<QuotasPage />);

  const providersPanel = (await screen.findByRole('heading', { level: 2, name: 'Proveedores' })).closest('section')!;
  const cards = within(providersPanel).getAllByRole('heading', { level: 3 });
  // codex está exhausted y opencode ok: el exhausted tiene que aparecer primero.
  expect(cards[0]).toHaveTextContent(/codex/i);

  expect(screen.getByRole('heading', { level: 2, name: 'Suscripciones pausadas' }).closest('section')).toHaveTextContent('Codex Pro (principal)');
  expect(screen.getByRole('heading', { level: 2, name: 'Grupos sin cuenta atada' }).closest('section')).toHaveTextContent('codex_bengalfox');
});

it('shows an error state with a working retry button when the request fails', async () => {
  server.use(http.get('http://localhost/v3/console/quotas', () => HttpResponse.json({ error: 'boom', message: 'cuotas caídas' }, { status: 500 })));
  renderWithApi(<QuotasPage />);

  expect(await screen.findByRole('alert')).toHaveTextContent(/cuotas caídas/i);
  expect(screen.getByRole('button', { name: /reintentar/i })).toBeInTheDocument();
});

it('makes the exhausted/paused account stand out visually, distinct from a healthy one', async () => {
  mockQuotasOnce(BASE);
  renderWithApi(<QuotasPage />);

  const providersPanel = (await screen.findByRole('heading', { level: 2, name: 'Proveedores' })).closest('section')!;
  const codexRow = within(providersPanel).getByRole('row', { name: /codex pro/i });
  expect(within(codexRow).getByText('AGOTADO')).toBeInTheDocument();
  expect(within(codexRow).getByText('PAUSADA')).toBeInTheDocument();
  expect(codexRow.className).toContain('row-critical');

  const opencodeRow = within(providersPanel).getByRole('row', { name: /minimax/i });
  expect(opencodeRow.className).not.toContain('row-critical');
  expect(opencodeRow.className).not.toContain('row-warning');
});

it('never lets a single number stand in for a provider with more than one account: codex shows both groups', async () => {
  mockQuotasOnce(BASE);
  renderWithApi(<QuotasPage />);

  const providersPanel = (await screen.findByRole('heading', { level: 2, name: 'Proveedores' })).closest('section')!;
  // 'codex' (agotado) y 'codex_bengalfox' (libre, sin cuenta) tienen que aparecer como filas
  // separadas, no aplastadas en un solo effective_remaining_percent.
  expect(within(providersPanel).getByRole('row', { name: /codex pro/i })).toBeInTheDocument();
  expect(within(providersPanel).getByRole('row', { name: /sin cuenta/i })).toBeInTheDocument();
});

it('shows collector freshness and flags a stale one distinctly from a fresh one', async () => {
  mockQuotasOnce({
    ...BASE,
    collectors: [
      ...BASE.collectors!,
      { host: 'ws-midas', collector_tenant: 'Pablo', collector_alias: 'quota-collector', captured_at: '2026-07-27T13:00:00.000Z', received_at: '2026-07-27T13:00:01.000Z', age_seconds: 5_400, stale: true, schema_version: 2, app_version: '0.11.4', provider_count: 1, window_count: 1 },
    ],
  });
  renderWithApi(<QuotasPage />);

  const collectorsPanel = (await screen.findByRole('heading', { level: 2, name: 'Recolectores' })).closest('section')!;
  const freshRow = within(collectorsPanel).getByRole('row', { name: /kratos/i });
  expect(within(freshRow).getByText('FRESCO')).toBeInTheDocument();
  const staleRow = within(collectorsPanel).getByRole('row', { name: /ws-midas/i });
  expect(within(staleRow).getByText('DESACTUALIZADO')).toBeInTheDocument();
});
