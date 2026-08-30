// ---------------------------------------------------------------------------------------------
// GET /v3/console/quotas — latest quota sample by (host, provider, group, window), plus a 24h
// sparkline. See features/quotas to group by family (antigravity) and pick the worst window of a
// collapsed group.

export type QuotaSeverity = 'ok' | 'warn' | 'critical' | 'exhausted' | 'unknown';

interface QuotaHistoryPoint {
  at?: string | null;
  used_percent?: number | null;
}

export interface QuotaHistory {
  bucket_seconds?: number | null;
  points?: QuotaHistoryPoint[] | null;
}

export interface QuotaWindow {
  window_key?: string | null;
  label?: string | null;
  used_percent?: number | null;
  remaining_percent?: number | null;
  used_units?: number | null;
  limit_units?: number | null;
  window_minutes?: number | null;
  reset_at?: string | null;
  reset_in_seconds?: number | null;
  status?: string | null;
  family?: string | null;
  model?: string | null;
  severity?: QuotaSeverity | null;
  history?: QuotaHistory | null;
}

export interface QuotaGroup {
  group_key?: string | null;
  limit_id?: string | null;
  /** Neither one is sent unless the actor is the payer — same rule as getAgent(). */
  account_id?: string | null;
  account_label?: string | null;
  account_provider?: string | null;
  payer_tenant_id?: string | null;
  paused_until?: string | null;
  paused_reason?: string | null;
  min_remaining_percent?: number | null;
  severity?: QuotaSeverity | null;
  windows?: QuotaWindow[] | null;
}

export interface QuotaProviderReport {
  host?: string | null;
  provider?: string | null;
  /** ok=false with groups=[] is information ("the CLI stopped responding"), not absent data. */
  ok?: boolean | null;
  available?: boolean | null;
  kind?: string | null;
  source?: string | null;
  plan?: string | null;
  note?: string | null;
  effective_remaining_percent?: number | null;
  observed_at?: string | null;
  age_seconds?: number | null;
  available_groups?: string[] | null;
  limiting_groups?: string[] | null;
  severity?: QuotaSeverity | null;
  groups?: QuotaGroup[] | null;
}

export interface QuotaCollector {
  host?: string | null;
  collector_tenant?: string | null;
  collector_alias?: string | null;
  captured_at?: string | null;
  received_at?: string | null;
  /** Real freshness: measured against received_at (server clock), not captured_at. */
  age_seconds?: number | null;
  stale?: boolean | null;
  schema_version?: number | null;
  app_version?: string | null;
  provider_count?: number | null;
  window_count?: number | null;
}

export interface QuotaUnboundGroup {
  host?: string | null;
  provider?: string | null;
  group_key?: string | null;
  window_count?: number | null;
  reason?: string | null;
  detail?: string | null;
}

export interface QuotaPausedAccount {
  account_id?: string | null;
  provider?: string | null;
  label?: string | null;
  payer_tenant_id?: string | null;
  paused_until?: string | null;
  paused_reason?: string | null;
  /** false: paused manually by an operator; the collector must never overwrite that pause. */
  automatic?: boolean | null;
}

export interface QuotaThresholds {
  stale_after_seconds?: number | null;
  warn_remaining_percent?: number | null;
  critical_remaining_percent?: number | null;
  history_window_seconds?: number | null;
  history_bucket_seconds?: number | null;
  history_max_points?: number | null;
}

export interface QuotaSnapshot {
  observed_at?: string | null;
  thresholds?: QuotaThresholds | null;
  collectors?: QuotaCollector[] | null;
  providers?: QuotaProviderReport[] | null;
  unbound_groups?: QuotaUnboundGroup[] | null;
  paused_accounts?: QuotaPausedAccount[] | null;
}
