import { formatDurationSeconds, UNKNOWN } from '../../lib';
import type {
  ConfigurationSnapshot, QuotaCollector, QuotaSnapshot,
  QuotaThresholds,
} from '../../api/types';

// ─────────────────────────────────────────────────────────────────────────────────────
// Tipos internos

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
// Freshness: ¿está caduca la sonda?

export type FreshnessState = 'fresh' | 'stale' | 'absent';

export interface Freshness {
  state: FreshnessState;
  ageSeconds: number | null;
  label: string;
}

/**
 * Determina si un collector está fresco, caduco o ausente.
 * La frescura se mide contra `received_at` (reloj del servidor), no `captured_at`.
 * El parámetro `now` se reserva para testing y permite inyectar un timestamp específico.
 */
export function freshness(
  collector: (Collector | QuotaCollector) | null | undefined,
  thresholds: QuotaThresholds | null | undefined,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _now?: number,
): Freshness {
  if (!collector) {
    return {
      state: 'absent',
      ageSeconds: null,
      label: 'No reportó',
    };
  }

  if (collector.stale === true) {
    const ageSeconds = (collector.age_seconds ?? null) as number | null;
    const ageLabel = ageSeconds !== null
      ? `caduco hace ${formatDurationSeconds(-ageSeconds)}`
      : 'caduco';
    return {
      state: 'stale',
      ageSeconds,
      label: ageLabel,
    };
  }

  const staleThresholdSeconds = thresholds?.stale_after_seconds ?? 300;
  const ageSecondsValue = (collector.age_seconds ?? null) as number | null;
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
// Consumo por cuenta: honestidad obligatoria

export interface WindowSummary {
  window_key: string | null;
  label: string | null;
  used_percent: number | string; // string = "?" para datos caduc/ausentes
  remaining_percent: number | string; // string = "?" para datos caduc/ausentes
  reset_in: string;
  reset_at: string | null;
  severity: string | null;
}

export interface AccountConsumption {
  available: boolean;
  reason?: string; // si available=false, por qué no hay dato
  plan: string | null;
  windows: WindowSummary[];
}

/**
 * Extrae el consumo de una cuenta. Si los datos no son confiables (sonda caduca, ≥ null),
 * devuelve `available: false` sin números. NUNCA devuelve números en ese caso.
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
      plan: null,
      windows: [],
    };
  }

  // Si no hay collectors en absoluto, todo está indisponible
  if (!quotas.collectors || quotas.collectors.length === 0) {
    return {
      available: false,
      reason: 'Ningún recolector reportó. Todos los porcentajes son ?.',
      plan: null,
      windows: [],
    };
  }

  // Busca el proveedor(es) que conozca esta cuenta
  const relevantProviders = (quotas.providers ?? []).filter((p) => {
    if (!p.groups) return false;
    return p.groups.some((g) => g.account_id === accountId);
  });

  if (relevantProviders.length === 0) {
    return {
      available: false,
      reason: 'El recolector no reportó esta cuenta',
      plan: null,
      windows: [],
    };
  }

  /*
   * Sonda caída. `ok: false` es INFORMACIÓN ("el CLI dejó de responder"), no ausencia de dato, y
   * es la trampa exacta que hay que evitar: sin este corte, un proveedor con la sonda muerta cae
   * más abajo en "sin ventanas de cuota para esta cuenta", que se lee como una ausencia benigna
   * y no como lo que es. Los proveedores caídos se descartan; si no queda ninguno vivo que
   * conozca la cuenta, no se devuelve ningún número.
   */
  const liveProviders = relevantProviders.filter((provider) => provider.ok !== false);
  if (liveProviders.length === 0) {
    const note = relevantProviders.map((provider) => provider.note).find((value) => typeof value === 'string' && value.length > 0);
    return {
      available: false,
      reason: note
        ? `Sonda caída: ${note}. No se muestra ningún porcentaje.`
        : 'Sonda caída: el recolector reportó ok=false para este proveedor. No se muestra ningún porcentaje.',
      plan: relevantProviders[0]?.plan ?? null,
      windows: [],
    };
  }

  // Extrae el plan del primer proveedor vivo
  const plan = liveProviders[0]?.plan ?? null;

  // Agrupa todas las windows de todas las groups de todos los proveedores vivos
  const allGroups = liveProviders.flatMap((p) => p.groups ?? []).filter((g) => g.account_id === accountId);
  const allWindows = allGroups.flatMap((g) => g.windows ?? []);

  if (allWindows.length === 0) {
    return {
      available: false,
      reason: 'Sin ventanas de cuota para esta cuenta',
      plan,
      windows: [],
    };
  }

  // Verifica la frescura de TODOS los collectors
  const staleCollectors = (quotas.collectors ?? []).filter((c) => {
    const f = freshness(c, thresholds, now);
    return f.state === 'stale' || f.state === 'absent';
  });

  // Si ALGÚN collector está caduco, todos los porcentajes se vuelven "?"
  const allStale = staleCollectors.length > 0;

  const windows: WindowSummary[] = allWindows.map((w): WindowSummary => {
    const used = w.used_percent;
    const remaining = w.remaining_percent;
    const resetInSeconds = w.reset_in_seconds;
    const resetAt = w.reset_at;

    // Honestidad: si la sonda está caduca o los números son null, mostrar "?"
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
// Asignaciones por cuenta: ¿quién la tiene?

export interface AssignedAgent {
  alias: string | null;
  display_name: string | null;
  container_name: string | null;
  priority: number | null;
  enabled: boolean | null;
  isPrimary: boolean;
}

/**
 * Lista los agentes asignados a una cuenta, ordenados por prioridad.
 * Priority 0 = primaria, 1+ = fallbacks.
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
// Huérfanos: las tres direcciones

export interface Orphans {
  accountsWithoutQuotas: ProviderAccount[];
  unboundGroups: Array<{
    host: string | null;
    provider: string | null;
    group_key: string | null;
    reason: string | null;
    detail: string | null;
  }>;
  agentsWithoutBindings: Agent[];
}

/**
 * Encuentra huérfanos en tres direcciones:
 * 1. Cuentas registradas sin datos de cuota (el recolector no las conoce)
 * 2. Grupos de cuota sin cuenta del registro (unbound_groups)
 * 3. Agentes sin ninguna binding
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
// Formateadores de UI

/**
 * Formatea "segundos hasta reset" como "en 2 h 51 min", "en 12 min", etc.
 * Si es null, devuelve UNKNOWN. Si es <= 0, prepend "hace".
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
// Extractores de configuración

export function extractProviderAccounts(config: ConfigurationSnapshot | null | undefined): ProviderAccount[] {
  if (!config?.provider_accounts) return [];
  return (config.provider_accounts as Array<Record<string, unknown>>).map((raw) => ({
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
  return (config.agents as Array<Record<string, unknown>>).map((raw) => ({
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
  return (config.agent_account_bindings as Array<Record<string, unknown>>).map((raw) => ({
    tenant_id: (raw.tenant_id ?? null) as string | null,
    agent_alias: (raw.agent_alias ?? null) as string | null,
    account_id: (raw.account_id ?? null) as string | null,
    priority: (raw.priority ?? null) as number | null,
    enabled: (raw.enabled ?? null) as boolean | null,
  }));
}

export function extractCeiling(config: ConfigurationSnapshot | null | undefined): AliasRoutingCeiling[] {
  if (!config?.alias_routing_ceiling) return [];
  return (config.alias_routing_ceiling as Array<Record<string, unknown>>).map((raw) => ({
    tenant_id: (raw.tenant_id ?? null) as string | null,
    alias: (raw.alias ?? null) as string | null,
    account_id: (raw.account_id ?? null) as string | null,
    account_payer_tenant: (raw.account_payer_tenant ?? null) as string | null,
    created_by_tenant: (raw.created_by_tenant ?? null) as string | null,
  }));
}

export function extractCollectors(quotas: QuotaSnapshot | null | undefined): Collector[] {
  if (!quotas?.collectors) return [];
  return (quotas.collectors as QuotaCollector[]).map((c): Collector => ({
    host: c.host ?? null,
    captured_at: c.captured_at ?? null,
    received_at: c.received_at ?? null,
    age_seconds: c.age_seconds ?? null,
    stale: c.stale ?? null,
    provider_count: c.provider_count ?? null,
    window_count: c.window_count ?? null,
  }));
}
