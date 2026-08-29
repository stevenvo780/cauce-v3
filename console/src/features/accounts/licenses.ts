/**
 * Reads of the license inventory (`GET /v3/console/config`) cross-referenced with the quota
 * collector sample: extractors, freshness, per-account consumption, bindings, and orphans.
 */
import { formatDurationSeconds, UNKNOWN } from '../../lib';
import type {
  ConfigurationSnapshot, QuotaCollector, QuotaSnapshot,
  QuotaThresholds,
} from '../../api/types';

// ─────────────────────────────────────────────────────────────────────────────────────
// Internal types

export interface Collector {
  host: string | null;
  captured_at: string | null;
  received_at: string | null;
  age_seconds: number | null;
  stale: boolean | null;
  provider_count: number | null;
  window_count: number | null;
}

export interface ProviderAccount {
  id: string;
  provider: string | null;
  payer_tenant_id: string | null;
  label: string | null;
  shared_with_pool: boolean | null;
  enabled: boolean | null;
  external_account_id: string | null;
  credential_ref_kind: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface Agent {
  tenant_id: string | null;
  alias: string | null;
  harness_id: string | null;
  display_name: string | null;
  enabled: boolean | null;
  container_name: string | null;
}

export interface AgentAccountBinding {
  tenant_id: string | null;
  agent_alias: string | null;
  account_id: string | null;
  priority: number | null;
  enabled: boolean | null;
}

export interface AliasRoutingCeiling {
  tenant_id: string | null;
  alias: string | null;
  account_id: string | null;
  account_payer_tenant: string | null;
  created_by_tenant: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────────────
// Freshness: is the probe stale?

export type FreshnessState = 'fresh' | 'stale' | 'absent';

export interface Freshness {
  state: FreshnessState;
  ageSeconds: number | null;
  label: string;
}

/**
 * Determines whether a collector is fresh, stale, or absent.
 * Freshness is measured against `received_at` (server clock), not `captured_at`.
 * The `now` parameter is reserved for testing and lets you inject a specific timestamp.
 */
export function freshness(
  collector: (Collector | QuotaCollector) | null | undefined,
  thresholds: QuotaThresholds | null | undefined,
  now?: number,
): Freshness {
  void now;
  if (!collector) {
    return {
      state: 'absent',
      ageSeconds: null,
      label: 'No reportó',
    };
  }

  if (collector.stale === true) {
    const ageSeconds = collector.age_seconds ?? null;
    /*
     * `age_seconds` is already the sample's age: negating it printed "stale for -1h 29m", a
     * negative time into the past that means nothing. Seen on screen against the "Age" column
     * of the same row, which said 1h 29m.
     */
    const ageLabel = ageSeconds !== null
      ? `caduco hace ${formatDurationSeconds(Math.abs(ageSeconds))}`
      : 'caduco';
    return {
      state: 'stale',
      ageSeconds,
      label: ageLabel,
    };
  }

  const staleThresholdSeconds = thresholds?.stale_after_seconds ?? 300;
  const ageSecondsValue = collector.age_seconds ?? null;
  if (ageSecondsValue !== null && ageSecondsValue > staleThresholdSeconds) {
    const ageLabel = `sin datos hace ${formatDurationSeconds(ageSecondsValue)}`;
    return {
      state: 'stale',
      ageSeconds: ageSecondsValue,
      label: ageLabel,
    };
  }

  const ageLabel = ageSecondsValue !== null
    ? `hace ${formatDurationSeconds(ageSecondsValue)}`
    : 'hace desconocido';
  return {
    state: 'fresh',
    ageSeconds: ageSecondsValue,
    label: ageLabel,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────
// Per-account consumption: mandatory honesty

export interface WindowSummary {
  window_key: string | null;
  label: string | null;
  used_percent: number | string; // string = "?" for stale/missing data
  remaining_percent: number | string; // string = "?" for stale/missing data
  reset_in: string;
  reset_at: string | null;
  severity: string | null;
}

/**
 * Scope of an unavailability reason.
 *
 * `global`: the cause is the whole sample —there is no snapshot, or no collector has ever
 * published one. It is identical for ALL accounts, so the view declares it once at the top:
 * repeating the same banner on every card adds no information, clutters, and gets read less.
 *
 * `account`: the cause is this account or its provider —the collector did not bring it, its probe
 * died, it has no windows. It cannot be read anywhere else on the page, so it goes on the card,
 * where it explains the gap the operator is looking at.
 */
export type ConsumptionScope = 'global' | 'account';

export interface AccountConsumption {
  available: boolean;
  reason?: string; // if available=false, why there is no data
  /** Present only when `available` is false. See `ConsumptionScope`. */
  scope?: ConsumptionScope;
  probeDown?: boolean;
  plan: string | null;
  windows: WindowSummary[];
}

/**
 * Extracts the consumption of an account. If the data is not trustworthy (stale probe, >= null),
 * returns `available: false` without numbers. NEVER returns numbers in that case.
 */
export function accountConsumption(
  accountId: string,
  quotas: QuotaSnapshot | null | undefined,
  thresholds: QuotaThresholds | null | undefined,
  now: number = Date.now(),
): AccountConsumption {
  if (!quotas || !thresholds) {
    return {
      available: false,
      reason: 'Cuotas no disponibles',
      scope: 'global',
      plan: null,
      windows: [],
    };
  }

  // If there are no collectors at all, everything is unavailable
  if (!quotas.collectors || quotas.collectors.length === 0) {
    return {
      available: false,
      reason: 'Ningún recolector reportó. Todos los porcentajes son ?.',
      scope: 'global',
      plan: null,
      windows: [],
    };
  }

  // Look for the provider(s) that know this account
  const relevantProviders = (quotas.providers ?? []).filter((p) => {
    if (!p.groups) return false;
    return p.groups.some((g) => g.account_id === accountId);
  });

  if (relevantProviders.length === 0) {
    return {
      available: false,
      reason: 'El recolector no reportó esta cuenta',
      scope: 'account',
      plan: null,
      windows: [],
    };
  }

  /*
   * Probe down. `ok: false` is INFORMATION ("the CLI stopped responding"), not a data absence,
   * and it is the exact trap to avoid: without this split, a provider with a dead probe falls
   * further down into "no quota windows for this account", which reads as a benign absence
   * instead of what it is. Down providers are discarded; if no live provider knows the account,
   * no number is returned.
   */
  const liveProviders = relevantProviders.filter((provider) => provider.ok !== false);
  if (liveProviders.length === 0) {
    const note = relevantProviders.map((provider) => provider.note).find((value) => typeof value === 'string' && value.length > 0);
    return {
      available: false,
      reason: note
        ? `Sonda caída: ${note}. No se muestra ningún porcentaje.`
        : 'Sonda caída: el recolector reportó ok=false para este proveedor. No se muestra ningún porcentaje.',
      scope: 'account',
      probeDown: true,
      plan: relevantProviders[0]?.plan ?? null,
      windows: [],
    };
  }

  // Extracts the plan from the first live provider
  const plan = liveProviders[0]?.plan ?? null;

  // Aggregate every window from every group of every live provider
  const allGroups = liveProviders.flatMap((p) => p.groups ?? []).filter((g) => g.account_id === accountId);
  const allWindows = allGroups.flatMap((g) => g.windows ?? []);

  if (allWindows.length === 0) {
    return {
      available: false,
      reason: 'Sin ventanas de cuota para esta cuenta',
      scope: 'account',
      plan,
      windows: [],
    };
  }

  // Check the freshness of ALL collectors
  const staleCollectors = (quotas.collectors ?? []).filter((c) => {
    const f = freshness(c, thresholds, now);
    return f.state === 'stale' || f.state === 'absent';
  });

  // If ANY collector is stale, every percentage becomes "?"
  const allStale = staleCollectors.length > 0;

  const windows: WindowSummary[] = allWindows.map((w): WindowSummary => {
    const used = w.used_percent;
    const remaining = w.remaining_percent;
    const resetInSeconds = w.reset_in_seconds;
    const resetAt = w.reset_at;

    // Honesty: if the probe is stale or the numbers are null, show "?"
    const usedDisplay = allStale || used === null || used === undefined ? '?' : used;
    const remainingDisplay = allStale || remaining === null || remaining === undefined ? '?' : remaining;
    const resetInDisplay = resetInSeconds !== null && resetInSeconds !== undefined
      ? formatDurationSeconds(resetInSeconds)
      : 'en ?';

    return {
      window_key: w.window_key ?? null,
      label: w.label ?? null,
      used_percent: usedDisplay,
      remaining_percent: remainingDisplay,
      reset_in: allStale ? '?' : resetInDisplay,
      reset_at: resetAt ?? null,
      severity: w.severity ?? null,
    };
  });

  return {
    available: true,
    plan,
    windows,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────
// Per-account bindings: who has it?

export interface AssignedAgent {
  alias: string | null;
  display_name: string | null;
  container_name: string | null;
  priority: number | null;
  enabled: boolean | null;
  isPrimary: boolean;
}

/**
 * Lists the agents bound to an account, sorted by priority.
 * Priority 0 = primary, 1+ = fallbacks.
 */
export function accountAssignments(
  accountId: string,
  bindings: AgentAccountBinding[],
  agents: Agent[],
): AssignedAgent[] {
  const agentsMap = new Map<string | null, Agent>();
  agents.forEach((a) => {
    agentsMap.set(a.alias, a);
  });

  const relevant = bindings.filter((b) => b.account_id === accountId);
  const sorted = relevant.sort((a, b) => {
    const aPrio = a.priority ?? Infinity;
    const bPrio = b.priority ?? Infinity;
    return aPrio - bPrio;
  });

  return sorted.map((b) => {
    const agent = agentsMap.get(b.agent_alias);
    return {
      alias: b.agent_alias,
      display_name: agent?.display_name ?? null,
      container_name: agent?.container_name ?? null,
      priority: b.priority,
      enabled: b.enabled,
      isPrimary: b.priority === 0,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────────────
// Orphans: the three directions

export interface Orphans {
  accountsWithoutQuotas: ProviderAccount[];
  unboundGroups: {
    host: string | null;
    provider: string | null;
    group_key: string | null;
    reason: string | null;
    detail: string | null;
  }[];
  agentsWithoutBindings: Agent[];
}

/**
 * Finds orphans in three directions:
 * 1. Registered accounts with no quota data (the collector does not know them)
 * 2. Quota groups with no registry account (unbound_groups)
 * 3. Agents with no binding
 */
export function orphans(
  accounts: ProviderAccount[],
  quotas: QuotaSnapshot | null | undefined,
  bindings: AgentAccountBinding[],
  agents: Agent[],
): Orphans {
  const quotaAccountIds = new Set<string>();
  if (quotas?.providers) {
    quotas.providers.forEach((p) => {
      if (p.groups) {
        p.groups.forEach((g) => {
          if (g.account_id) {
            quotaAccountIds.add(g.account_id);
          }
        });
      }
    });
  }

  const accountsWithoutQuotas = accounts.filter((a) => !quotaAccountIds.has(a.id));

  const unboundGroups = (quotas?.unbound_groups ?? []).map((ug) => ({
    host: ug.host ?? null,
    provider: ug.provider ?? null,
    group_key: ug.group_key ?? null,
    reason: ug.reason ?? null,
    detail: ug.detail ?? null,
  }));

  const bindingAliases = new Set<string | null>(
    bindings.map((b) => b.agent_alias),
  );
  const agentsWithoutBindings = agents.filter((a) => !bindingAliases.has(a.alias));

  return {
    accountsWithoutQuotas,
    unboundGroups,
    agentsWithoutBindings,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────
// UI formatters

/**
 * Formats "seconds until reset" as "in 2 h 51 min", "in 12 min", etc.
 * If null, returns UNKNOWN. If <= 0, prepends "ago".
 */
export function formatResetIn(seconds: unknown): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) {
    return UNKNOWN;
  }
  if (seconds <= 0) {
    return `hace ${formatDurationSeconds(Math.abs(seconds))}`;
  }
  return `en ${formatDurationSeconds(seconds)}`;
}

// ─────────────────────────────────────────────────────────────────────────────────────
// Configuration extractors

export function extractProviderAccounts(config: ConfigurationSnapshot | null | undefined): ProviderAccount[] {
  if (!config?.provider_accounts) return [];
  return config.provider_accounts.map((raw) => ({
    id: (raw.id ?? '') as string,
    provider: (raw.provider ?? null) as string | null,
    payer_tenant_id: (raw.payer_tenant_id ?? null) as string | null,
    label: (raw.label ?? null) as string | null,
    shared_with_pool: (raw.shared_with_pool ?? null) as boolean | null,
    enabled: (raw.enabled ?? null) as boolean | null,
    external_account_id: (raw.external_account_id ?? null) as string | null,
    credential_ref_kind: (raw.credential_ref_kind ?? null) as string | null,
    created_at: (raw.created_at ?? null) as string | null,
    updated_at: (raw.updated_at ?? null) as string | null,
  }));
}

export function extractAgents(config: ConfigurationSnapshot | null | undefined): Agent[] {
  if (!config?.agents) return [];
  return config.agents.map((raw) => ({
    tenant_id: (raw.tenant_id ?? null) as string | null,
    alias: (raw.alias ?? null) as string | null,
    harness_id: (raw.harness_id ?? null) as string | null,
    display_name: (raw.display_name ?? null) as string | null,
    enabled: (raw.enabled ?? null) as boolean | null,
    container_name: (raw.container_name ?? null) as string | null,
  }));
}

export function extractBindings(config: ConfigurationSnapshot | null | undefined): AgentAccountBinding[] {
  if (!config?.agent_account_bindings) return [];
  return config.agent_account_bindings.map((raw) => ({
    tenant_id: (raw.tenant_id ?? null) as string | null,
    agent_alias: (raw.agent_alias ?? null) as string | null,
    account_id: (raw.account_id ?? null) as string | null,
    priority: (raw.priority ?? null) as number | null,
    enabled: (raw.enabled ?? null) as boolean | null,
  }));
}

export function extractCeiling(config: ConfigurationSnapshot | null | undefined): AliasRoutingCeiling[] {
  if (!config?.alias_routing_ceiling) return [];
  return config.alias_routing_ceiling.map((raw) => ({
    tenant_id: (raw.tenant_id ?? null) as string | null,
    alias: (raw.alias ?? null) as string | null,
    account_id: (raw.account_id ?? null) as string | null,
    account_payer_tenant: (raw.account_payer_tenant ?? null) as string | null,
    created_by_tenant: (raw.created_by_tenant ?? null) as string | null,
  }));
}
