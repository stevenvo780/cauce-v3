import type { QuotaGroup, QuotaProviderReport, QuotaSeverity, QuotaWindow } from '../../api/types';
import type { BadgeTone } from '../live/activity';

export const SEVERITY_LABEL: Record<QuotaSeverity, string> = {
  ok: 'OK',
  warn: 'ATENCIÓN',
  critical: 'CRÍTICO',
  exhausted: 'AGOTADO',
  unknown: 'SIN DATO',
};

export const SEVERITY_TONE: Record<QuotaSeverity, BadgeTone> = {
  ok: 'done',
  warn: 'warning',
  critical: 'danger',
  exhausted: 'danger',
  unknown: 'unknown',
};

const SEVERITY_RANK: Record<QuotaSeverity, number> = {
  exhausted: 4,
  critical: 3,
  warn: 2,
  unknown: 1,
  ok: 0,
};

/** unknown sorts above ok: a provider without a severity must not be assumed healthy. */
export function severityRank(severity: QuotaSeverity | null | undefined): number {
  return severity && severity in SEVERITY_RANK ? SEVERITY_RANK[severity] : SEVERITY_RANK.unknown;
}

/** Worst first: the provider about to run out must appear at the top of the list. */
export function sortProvidersBySeverity(providers: readonly QuotaProviderReport[]): QuotaProviderReport[] {
  return [...providers].sort((left, right) => {
    const rankDiff = severityRank(right.severity) - severityRank(left.severity);
    if (rankDiff !== 0) return rankDiff;
    return `${left.host ?? ''}:${left.provider ?? ''}`.localeCompare(`${right.host ?? ''}:${right.provider ?? ''}`);
  });
}

/** The most compromised window in a set: highest severity, and at equal severity, the lowest
 *  remaining_percent (nulls go last: not reporting is not the same as being at zero). */
export function worstWindow(windows: readonly QuotaWindow[]): QuotaWindow | undefined {
  if (windows.length === 0) return undefined;
  return [...windows].sort((left, right) => {
    const rankDiff = severityRank(right.severity) - severityRank(left.severity);
    if (rankDiff !== 0) return rankDiff;
    const leftRemaining = left.remaining_percent ?? Number.POSITIVE_INFINITY;
    const rightRemaining = right.remaining_percent ?? Number.POSITIVE_INFINITY;
    return leftRemaining - rightRemaining;
  })[0];
}

export interface WindowFamilyGroup {
  /** Stable key for React; synthetic when the window does not declare a family. */
  key: string;
  /** Real family, or the label/window_key of the single window when there is no real grouping. */
  label: string;
  windows: QuotaWindow[];
  worst: QuotaWindow;
  /** true when there are multiple windows in the same quota family (collapsed by default). */
  collapsible: boolean;
}

/**
 * Groups a group's windows by `family` (fallback: each window without a family is its own
 * single-element family, so things that declare no kinship are not mixed together).
 */
export function groupWindowsByFamily(windows: readonly QuotaWindow[]): WindowFamilyGroup[] {
  const order: string[] = [];
  const buckets = new Map<string, QuotaWindow[]>();
  windows.forEach((window, index) => {
    const key = window.family ?? `__solo:${String(window.window_key ?? index)}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
      order.push(key);
    }
    bucket.push(window);
  });
  return order.map((key) => {
    const group = buckets.get(key) ?? [];
    const worst = worstWindow(group);
    return {
      key,
      label: group[0]?.family ?? group[0]?.label ?? group[0]?.window_key ?? 'sin nombre',
      windows: group,
      worst: worst ?? group[0],
      collapsible: group.length > 1,
    };
  });
}

export interface QuotaRow {
  group: QuotaGroup;
  family: WindowFamilyGroup;
}

/** Flattens (provider→group→family) into table rows: one row per account+window family, which
 *  is exactly the grain that "shouting from the screen" needs to show at a glance. */
export function buildQuotaRows(groups: readonly QuotaGroup[]): QuotaRow[] {
  const rows: QuotaRow[] = [];
  for (const group of groups) {
    for (const family of groupWindowsByFamily(group.windows ?? [])) {
      rows.push({ group, family });
    }
  }
  return rows;
}

/** reset_in_seconds <= 0 is explicitly shown as "expired": a slow collector clock must not be
 *  read as "resets in -3s". null stays UNKNOWN, never "right now". */
export function formatResetIn(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return 'sin dato';
  if (seconds <= 0) return 'vencido';
  return `en ${humanDuration(seconds)}`;
}

function humanDuration(totalSeconds: number): string {
  const abs = Math.round(totalSeconds);
  const days = Math.floor(abs / 86_400);
  const hours = Math.floor((abs % 86_400) / 3600);
  const minutes = Math.floor((abs % 3600) / 60);
  if (days > 0) return `${String(days)}d ${String(hours)}h`;
  if (hours > 0) return `${String(hours)}h ${String(minutes)}m`;
  return `${String(minutes)}m`;
}

/** Absence of threshold or age leaves the result UNKNOWN instead of assuming freshness. */
export function isAgeStale(ageSeconds: number | null | undefined, staleAfterSeconds: number | null | undefined): boolean | undefined {
  if (ageSeconds === null || ageSeconds === undefined) return undefined;
  if (staleAfterSeconds === null || staleAfterSeconds === undefined) return undefined;
  return ageSeconds > staleAfterSeconds;
}

/** used/limit are only shown when the provider reports them (opencode); a denominator is not
 *  invented for providers that only speak in percentages. */
export function formatUnits(used: number | null | undefined, limit: number | null | undefined): string | undefined {
  if (limit === null || limit === undefined) return undefined;
  return `${String(used ?? '?')} / ${String(limit)}`;
}

/* ============================================================================================ *
 * The percentage on a provider's header.
 * ============================================================================================ */

/**
 * Computes the worst remaining percentage across a provider's windows, to align it with the
 * most restrictive severity on the header.
 */
export function peorPorcentajeDelProveedor(provider: QuotaProviderReport): number | undefined {
  let peor: number | undefined;
  for (const group of provider.groups ?? []) {
    for (const window of group.windows ?? []) {
      const valor = window.remaining_percent;
      if (typeof valor !== 'number' || !Number.isFinite(valor)) continue;
      peor = peor === undefined ? valor : Math.min(peor, valor);
    }
  }
  return peor;
}

/**
 * `true` when the server's effective percentage and the worst window do NOT tell the same story.
 * Used to say so on the header instead of letting the operator discover it.
 */
export function porcentajesEnConflicto(provider: QuotaProviderReport): boolean {
  const efectivo = provider.effective_remaining_percent;
  const peor = peorPorcentajeDelProveedor(provider);
  if (typeof efectivo !== 'number' || peor === undefined) return false;
  return Math.abs(efectivo - peor) >= 10;
}
