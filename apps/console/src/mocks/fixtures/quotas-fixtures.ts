import type { QuotaSnapshot } from '../../api/types';

const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const secondsAgo = (seconds: number) => iso(-seconds * 1_000);

/**
 * GET /v3/console/quotas.
 */
export function mockQuotas(): QuotaSnapshot {
  const bucket = (values: number[]) => ({
    bucket_seconds: 1_800,
    points: values.map((used_percent, index) => ({ at: iso((index - values.length) * 1_800_000), used_percent })),
  });
  return {
    observed_at: iso(0),
    thresholds: {
      stale_after_seconds: 900,
      warn_remaining_percent: 25,
      critical_remaining_percent: 10,
      history_window_seconds: 86_400,
      history_bucket_seconds: 1_800,
      history_max_points: 48,
    },
    collectors: [
      { host: 'kratos', collector_tenant: 'Steven', collector_alias: 'quota-collector', captured_at: secondsAgo(702), received_at: secondsAgo(701), age_seconds: 701, stale: false, schema_version: 2, app_version: '0.12.0', provider_count: 4, window_count: 15 },
      { host: 'ws-midas', collector_tenant: 'Pablo', collector_alias: 'quota-collector', captured_at: secondsAgo(5_400), received_at: secondsAgo(5_398), age_seconds: 5_398, stale: true, schema_version: 2, app_version: '0.11.4', provider_count: 2, window_count: 4 },
    ],
    providers: [
      {
        host: 'kratos', provider: 'claude', ok: true, available: true, kind: 'detected-percent', source: 'claude-cli', plan: null,
        note: 'Claude /usage detectado desde el CLI.', effective_remaining_percent: 14, observed_at: secondsAgo(741), age_seconds: 741,
        available_groups: [], limiting_groups: [], severity: 'warn',
        groups: [{
          group_key: 'default', limit_id: null, account_id: 'claude-steven-max', account_label: 'Claude Max (Steven)',
          account_provider: 'claude', payer_tenant_id: 'Steven', paused_until: null, paused_reason: null,
          min_remaining_percent: 14, severity: 'warn',
          windows: [
            { window_key: 'session', label: 'sesión', used_percent: 45, remaining_percent: 55, used_units: null, limit_units: null, window_minutes: null, reset_at: iso(3_469_000), reset_in_seconds: 3_469, status: null, family: null, model: null, severity: 'ok', history: bucket([0, 12, 29, 45]) },
            { window_key: 'week_all', label: 'semana', used_percent: 86, remaining_percent: 14, used_units: null, limit_units: null, window_minutes: null, reset_at: iso(83_209_000), reset_in_seconds: 83_209, status: null, family: null, model: null, severity: 'warn', history: bucket([78, 80, 83, 86]) },
            { window_key: 'week_fable', label: 'Fable', used_percent: 0, remaining_percent: 100, used_units: null, limit_units: null, window_minutes: null, reset_at: iso(83_269_000), reset_in_seconds: 83_269, status: null, family: null, model: null, severity: 'ok', history: bucket([0, 0]) },
          ],
        }],
      },
      {
        host: 'kratos', provider: 'codex', ok: true, available: true, kind: 'detected-percent', source: 'codex-app-server', plan: 'pro',
        note: 'Codex app-server (consulta oficial).', effective_remaining_percent: 100, observed_at: secondsAgo(703), age_seconds: 703,
        available_groups: ['codex_bengalfox'], limiting_groups: ['codex'], severity: 'exhausted',
        groups: [
          {
            group_key: 'codex', limit_id: 'codex', account_id: 'codex-pro-steven', account_label: 'Codex Pro (principal)',
            account_provider: 'codex', payer_tenant_id: 'Steven', paused_until: iso(447_970_000), paused_reason: 'quota_exhausted:codex/codex/codex_primary_10080',
            min_remaining_percent: 0, severity: 'exhausted',
            windows: [
              { window_key: 'codex_primary_10080', label: 'semana', used_percent: 100, remaining_percent: 0, used_units: null, limit_units: null, window_minutes: 10_080, reset_at: iso(447_970_000), reset_in_seconds: 447_970, status: 'rate-limited', family: null, model: null, severity: 'exhausted', history: bucket([94, 97, 100, 100]) },
            ],
          },
          {
            group_key: 'codex_bengalfox', limit_id: 'codex_bengalfox', account_id: null, account_label: null,
            account_provider: null, payer_tenant_id: null, paused_until: null, paused_reason: null,
            min_remaining_percent: 100, severity: 'ok',
            windows: [
              { window_key: 'codex_bengalfox_primary_10080', label: 'semana', used_percent: 0, remaining_percent: 100, used_units: null, limit_units: null, window_minutes: 10_080, reset_at: iso(603_353_000), reset_in_seconds: 603_353, status: null, family: null, model: null, severity: 'ok', history: bucket([0, 0]) },
            ],
          },
        ],
      },
      {
        host: 'kratos', provider: 'antigravity', ok: true, available: true, kind: 'detected-percent', source: 'antigravity-api', plan: null,
        note: 'Antigravity (API real). 8 ventanas con cuota, 3 Claude/GPT ofrecidas con cuota desconocida.', effective_remaining_percent: 100,
        observed_at: secondsAgo(707), age_seconds: 707, available_groups: ['gemini-3.1-pro-preview', 'gemini-3-flash-preview'], limiting_groups: [], severity: 'ok',
        groups: [{
          group_key: 'default', limit_id: null, account_id: 'antigravity-steven', account_label: 'Antigravity (Steven)',
          account_provider: 'antigravity', payer_tenant_id: 'Steven', paused_until: null, paused_reason: null,
          min_remaining_percent: 62, severity: 'warn',
          windows: [
            { window_key: 'gemini-3.1-pro-preview', label: 'gemini-3.1-pro', used_percent: 0, remaining_percent: 100, used_units: null, limit_units: null, window_minutes: 1_440, reset_at: iso(85_693_000), reset_in_seconds: 85_693, status: null, family: 'gemini', model: 'gemini-3.1-pro-preview', severity: 'ok', history: bucket([0, 0]) },
            { window_key: 'gemini-3-flash-preview', label: 'gemini-3-flash', used_percent: 38, remaining_percent: 62, used_units: null, limit_units: null, window_minutes: 1_440, reset_at: iso(85_693_000), reset_in_seconds: 85_693, status: null, family: 'gemini', model: 'gemini-3-flash-preview', severity: 'warn', history: bucket([10, 20, 30, 38]) },
          ],
        }],
      },
      {
        host: 'kratos', provider: 'opencode', ok: true, available: true, kind: 'detected-percent', source: 'opencode-db', plan: null,
        note: 'Estimado local (opencode.db). Para valores exactos ve a opencode.ai/auth.', effective_remaining_percent: 100,
        observed_at: secondsAgo(717), age_seconds: 717, available_groups: [], limiting_groups: [], severity: 'ok',
        groups: [{
          group_key: 'default', limit_id: null, account_id: 'minimax-pool', account_label: 'MiniMax / OpenCode',
          account_provider: 'opencode', payer_tenant_id: 'Steven', paused_until: null, paused_reason: null,
          min_remaining_percent: 100, severity: 'ok',
          windows: [
            { window_key: '5h', label: '5 horas', used_percent: 0, remaining_percent: 100, used_units: 0, limit_units: 12, window_minutes: 300, reset_at: iso(17_283_000), reset_in_seconds: 17_283, status: null, family: null, model: null, severity: 'ok', history: bucket([0, 0]) },
            { window_key: 'week', label: 'semanal', used_percent: 0, remaining_percent: 100, used_units: 0, limit_units: 30, window_minutes: 10_080, reset_at: iso(551_269_000), reset_in_seconds: 551_269, status: null, family: null, model: null, severity: 'ok', history: { bucket_seconds: 1_800, points: [] } },
            { window_key: 'month', label: 'mensual', used_percent: 0, remaining_percent: 100, used_units: 0, limit_units: 60, window_minutes: 43_200, reset_at: iso(378_469_000), reset_in_seconds: 378_469, status: null, family: null, model: null, severity: 'ok', history: { bucket_seconds: 1_800, points: [] } },
          ],
        }],
      },
    ],
    unbound_groups: [
      { host: 'kratos', provider: 'codex', group_key: 'codex_bengalfox', window_count: 1, reason: 'no_account_id_supplied', detail: 'El recolector no mandó account_id para este grupo: la muestra se guarda pero no puede pausar ninguna suscripción.' },
    ],
    paused_accounts: [
      { account_id: 'codex-pro-steven', provider: 'codex', label: 'Codex Pro (principal)', payer_tenant_id: 'Steven', paused_until: iso(447_970_000), paused_reason: 'quota_exhausted:codex/codex/codex_primary_10080', automatic: true },
    ],
  };
}
