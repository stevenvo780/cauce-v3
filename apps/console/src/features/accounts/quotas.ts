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

/** unknown se ordena por encima de ok a propósito: un proveedor sin severidad legible no debe
 *  leerse como "todo bien" en un panel que existe para no repetir el incidente de la cuota agotada. */
export function severityRank(severity: QuotaSeverity | null | undefined): number {
  return severity && severity in SEVERITY_RANK ? SEVERITY_RANK[severity] : SEVERITY_RANK.unknown;
}

/** Peor primero: el proveedor que se está por agotar tiene que aparecer arriba de la lista. */
export function sortProvidersBySeverity(providers: readonly QuotaProviderReport[]): QuotaProviderReport[] {
  return [...providers].sort((left, right) => {
    const rankDiff = severityRank(right.severity) - severityRank(left.severity);
    if (rankDiff !== 0) return rankDiff;
    return `${left.host ?? ''}:${left.provider ?? ''}`.localeCompare(`${right.host ?? ''}:${right.provider ?? ''}`);
  });
}

/** La ventana más comprometida de un conjunto: mayor severidad, y a igual severidad, menos
 *  remaining_percent (nulls van al final: no informar no es lo mismo que estar en cero). */
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
  /** Clave estable para React; sintética cuando la ventana no declara family. */
  key: string;
  /** family real, o el label/window_key de la única ventana cuando no hay agrupación real. */
  label: string;
  windows: QuotaWindow[];
  worst: QuotaWindow;
  /**
   * true cuando hay más de una ventana bajo el mismo family: antigravity hoy reporta 8 ventanas
   * (una por modelo) en un solo grupo, y una UI ingenua dibujaría 8 filas para una sola
   * suscripción, ahogando a claude/codex que son las que realmente se agotan. Colapsado por
   * defecto; expandible para ver cada modelo.
   */
  collapsible: boolean;
}

/**
 * Agrupa las ventanas de un grupo por `family` (fallback: cada ventana sin family es su propia
 * familia de un solo elemento, para no mezclar cosas que no declaran ningún parentesco).
 */
export function groupWindowsByFamily(windows: readonly QuotaWindow[]): WindowFamilyGroup[] {
  const order: string[] = [];
  const buckets = new Map<string, QuotaWindow[]>();
  windows.forEach((window, index) => {
    const key = window.family ?? `__solo:${window.window_key ?? index}`;
    if (!buckets.has(key)) {
      buckets.set(key, []);
      order.push(key);
    }
    buckets.get(key)!.push(window);
  });
  return order.map((key) => {
    const group = buckets.get(key)!;
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

/** Aplana (proveedor→grupo→familia) a filas de tabla: una fila por cuenta+familia de ventana,
 *  que es exactamente el grano que "gritar desde la pantalla" necesita mostrar de un vistazo. */
export function buildQuotaRows(groups: readonly QuotaGroup[]): QuotaRow[] {
  const rows: QuotaRow[] = [];
  for (const group of groups) {
    for (const family of groupWindowsByFamily(group.windows ?? [])) {
      rows.push({ group, family });
    }
  }
  return rows;
}

/** reset_in_seconds <= 0 se muestra explícitamente "vencido": un reloj de recolector atrasado
 *  no debe leerse como "resetea en -3s". null se queda UNKNOWN, nunca "ahora mismo". */
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
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** Ausencia de umbral o de edad deja el resultado UNKNOWN en vez de asumir frescura. */
export function isAgeStale(ageSeconds: number | null | undefined, staleAfterSeconds: number | null | undefined): boolean | undefined {
  if (ageSeconds === null || ageSeconds === undefined) return undefined;
  if (staleAfterSeconds === null || staleAfterSeconds === undefined) return undefined;
  return ageSeconds > staleAfterSeconds;
}

/** used/limit sólo se muestran cuando el proveedor los informa (opencode); no se inventa un
 *  denominador para providers que sólo hablan en porcentaje. */
export function formatUnits(used: number | null | undefined, limit: number | null | undefined): string | undefined {
  if (limit === null || limit === undefined) return undefined;
  return `${used ?? '?'} / ${limit}`;
}

/* ============================================================================================ *
 * El porcentaje de la cabecera de un proveedor.
 * ============================================================================================ */

/**
 * «AGOTADO» y «100% libre», en la misma línea.**  la
 * tarjeta de `codex` pintaba la severidad PEOR de sus grupos (AGOTADO) al lado del
 * `effective_remaining_percent` que manda el servidor (100%), mientras sus propias filas decían
 * «Codex Pro 0% libre» y «codex_bengalfox 100% libre». Un operador que lee la cabecera y se va
 * concluye que hay saldo justo donde no lo hay.
 *
 * Lo peor no es el defecto: es que el equipo YA LO SABÍA. Tres tarjetas más abajo, en «Un número
 * por proveedor miente», hay un párrafo que describe EXACTAMENTE este riesgo, con estos números.
 * Se escribió la explicación y se dejó el número engañoso en 20 px azules. **Explicar un defecto
 * no es arreglarlo.**
 *
 * La regla, ahora: la cabecera muestra el PEOR porcentaje de las ventanas del proveedor, que es el
 * que va con la severidad que ya se pinta al lado. Si no se puede calcular ninguno —ningún grupo
 * informa porcentaje— no se muestra ninguno: no hay un número honesto que poner ahí.
 *
 * `effective_remaining_percent` no se tira: pasa al `title=` con su nombre, porque es lo que el
 * enrutador usa para elegir cuenta y hay que poder contrastarlo.
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
 * `true` cuando el porcentaje efectivo del servidor y el peor de las ventanas NO cuentan la misma
 * historia. Se usa para decirlo en la cabecera en vez de dejar que el operador lo descubra.
 */
export function porcentajesEnConflicto(provider: QuotaProviderReport): boolean {
  const efectivo = provider.effective_remaining_percent;
  const peor = peorPorcentajeDelProveedor(provider);
  if (typeof efectivo !== 'number' || peor === undefined) return false;
  return Math.abs(efectivo - peor) >= 10;
}
