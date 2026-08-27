/**
 * Selector de cuenta por proveedor para alias de agentes.
 * Evalúa bindings, techos de enrutamiento, pausas manuales y estado de cuotas.
 */

import type { Tenant } from '@cauce/protocol';
import type { DatabasePool, DatabaseClient } from './db.js';
import { withTransaction } from './db.js';

/**
 * Prefijo que identifica una pausa automática aplicada por el recolector de cuotas.
 */
export const AUTOMATIC_PAUSE_PREFIX = 'quota_exhausted:';

/** Motivo por el cual una cuenta candidata no está disponible para selección. */
export type AccountSkipReason =
  /** `agent_account_bindings.enabled = false`: binding deshabilitado. */
  | 'binding_disabled'
  /** `provider_accounts.enabled = false`: cuenta deshabilitada globalmente. */
  | 'account_disabled'
  /** `paused_until > now()` con motivo automático por cuota. */
  | 'paused_automatic'
  /** `paused_until > now()` con motivo manual de operador. */
  | 'paused_manual'
  /** Sin pausa activa, pero con cuota agotada reportada en quota_window_state. */
  | 'quota_exhausted';

export interface AccountCandidate {
  readonly account_id: string;
  readonly provider: string;
  readonly priority: number;
  readonly payer_tenant_id: string;
  readonly label: string | null;
  /** Tipo de localizador de credenciales. */
  readonly credential_ref_kind: 'env_path' | 'file' | 'secret_manager';
  readonly credential_ref: string;
  /** `null` si fue seleccionada, o el motivo por el cual fue omitida. */
  readonly skipped: AccountSkipReason | null;
  /** Detalle legible para operador sobre la selección u omisión. */
  readonly detail: string | null;
  /** Fecha hasta la que se encuentra pausada la cuenta, si aplica. */
  readonly paused_until: string | null;
  /** Identificador de la ventana agotada (`proveedor/grupo/ventana`), si aplica. */
  readonly exhausted_window: string | null;
}

export interface AccountSelection {
  readonly tenant_id: Tenant;
  readonly alias: string;
  readonly provider: string;
  readonly observed_at: string;
  /** La cuenta a usar, o `null` si ninguna quedó disponible. */
  readonly selected: AccountCandidate | null;
  /** TODOS los candidatos del techo, en el orden real de fallback. Incluye a la elegida. */
  readonly candidates: readonly AccountCandidate[];
  /** true cuando la elegida no fue la de mayor prioridad: hubo failover. */
  readonly failover: boolean;
  /** Cuentas que ESTA llamada acaba de auto-pausar. */
  readonly auto_paused: readonly {
    readonly account_id: string;
    readonly paused_until: string;
    readonly paused_reason: string;
  }[];
}

/** Fila cruda del join techo + binding + cuenta + estado de cuota agregado. */
interface CandidateRow {
  account_id: string;
  provider: string;
  priority: number;
  payer_tenant_id: string;
  label: string | null;
  credential_ref_kind: 'env_path' | 'file' | 'secret_manager';
  credential_ref: string;
  binding_enabled: boolean;
  account_enabled: boolean;
  paused_until: Date | null;
  paused_reason: string | null;
  /** Ventana agotada más restrictiva de la cuenta, o NULL si ninguna lo está AHORA. */
  exhausted_window: string | null;
  /** `reset_at` de esa ventana. NULL = el proveedor no informó horizonte de reset. */
  exhausted_reset_at: Date | null;
}

/**
 * Consulta de candidatos para un proveedor y alias ordenados por prioridad y account_id.
 */
const CANDIDATES_SQL = `
  SELECT b.account_id,
         p.provider,
         b.priority,
         p.payer_tenant_id,
         p.label,
         p.credential_ref_kind,
         p.credential_ref,
         b.enabled AS binding_enabled,
         p.enabled AS account_enabled,
         p.paused_until,
         p.paused_reason,
         q.exhausted_window,
         q.exhausted_reset_at
    FROM agent_account_bindings b
    JOIN alias_routing_ceiling c
      ON c.tenant_id = b.tenant_id AND c.alias = b.agent_alias AND c.account_id = b.account_id
    JOIN provider_accounts p
      ON p.id = b.account_id
    LEFT JOIN LATERAL (
      SELECT s.provider || '/' || s.group_key || '/' || s.window_key AS exhausted_window,
             s.reset_at AS exhausted_reset_at
        FROM quota_window_state s
       WHERE s.account_id = p.id
         AND (s.remaining_percent <= 0 OR s.status = 'rate-limited')
         AND (s.reset_at IS NULL OR s.reset_at > $4::timestamptz)
       ORDER BY s.remaining_percent ASC NULLS LAST, s.provider, s.group_key, s.window_key
       LIMIT 1
    ) q ON true
   WHERE b.tenant_id = $1 AND b.agent_alias = $2 AND p.provider = $3
   ORDER BY b.priority ASC, b.account_id ASC`;

/**
 * Actualiza la pausa automática de una cuenta agotada respetando pausas manuales preexistentes.
 */
const AUTO_PAUSE_SQL = `
  UPDATE provider_accounts
     SET paused_until  = GREATEST(COALESCE(paused_until, $2::timestamptz), $3::timestamptz),
         paused_reason = $4,
         updated_at    = now()
   WHERE id = $1
     AND (paused_reason IS NULL OR paused_reason LIKE '${AUTOMATIC_PAUSE_PREFIX}%')
  RETURNING paused_until, paused_reason`;

export interface SelectAccountOptions {
  readonly tenant_id: Tenant;
  readonly alias: string;
  readonly provider: string;
  /** Inyectable para pruebas deterministas. */
  readonly now?: Date;
}

/**
 * Selecciona la cuenta óptima disponible para un alias y proveedor, pausando automáticamente las cuentas agotadas con reset definido.
 */
export async function selectAccountForAlias(
  pool: DatabasePool,
  options: SelectAccountOptions
): Promise<AccountSelection> {
  const now = options.now ?? new Date();
  return withTransaction(pool, (client) => selectWithClient(client, options, now));
}

async function selectWithClient(
  client: DatabaseClient,
  options: SelectAccountOptions,
  now: Date
): Promise<AccountSelection> {
  const rows = await client.query<CandidateRow>(CANDIDATES_SQL, [
    options.tenant_id, options.alias, options.provider, now.toISOString()
  ]);

  const autoPaused: { account_id: string; paused_until: string; paused_reason: string }[] = [];
  const candidates: AccountCandidate[] = [];
  let selected: AccountCandidate | null = null;

  for (const row of rows.rows) {
    // Se evalúa TODA la lista aunque ya haya elegida: la traza de por qué se descartó cada una
    // es lo que hace auditable el failover. Son ≤ 6 filas por alias en el peor caso real.
    const verdict = await evaluate(client, row, now, autoPaused);
    const candidate: AccountCandidate = {
      account_id: row.account_id,
      provider: row.provider,
      priority: Number(row.priority),
      payer_tenant_id: row.payer_tenant_id,
      label: row.label,
      credential_ref_kind: row.credential_ref_kind,
      credential_ref: row.credential_ref,
      skipped: verdict.skipped,
      detail: verdict.detail,
      paused_until: verdict.pausedUntil,
      exhausted_window: row.exhausted_window
    };
    candidates.push(candidate);
    if (candidate.skipped === null && selected === null) selected = candidate;
  }

  return {
    tenant_id: options.tenant_id,
    alias: options.alias,
    provider: options.provider,
    observed_at: now.toISOString(),
    selected,
    candidates,
    // Hubo failover si la elegida no es la primera de la lista, que ya viene en orden de
    // prioridad. Comparar por identidad de objeto es exacto: `selected` sale de este mismo array.
    failover: selected !== null && candidates[0] !== selected,
    auto_paused: autoPaused
  };
}

interface Verdict {
  skipped: AccountSkipReason | null;
  detail: string | null;
  pausedUntil: string | null;
}

/**
 * El orden de los chequeos ES la semántica y no es intercambiable:
 *
 *  1. `binding_disabled` / `account_disabled` primero: son decisiones explícitas de un operador y
 *     ganan sobre cualquier estado derivado de cuotas.
 *  2. La pausa VIGENTE antes que el agotamiento: si ya está pausada no hay nada que decidir, y
 *     además distinguir `paused_manual` de `paused_automatic` acá es lo que le dice al operador
 *     si esa pausa la puso él o la máquina.
 *  3. El agotamiento último, que es el único caso que además ESCRIBE.
 */
async function evaluate(
  client: DatabaseClient,
  row: CandidateRow,
  now: Date,
  autoPaused: { account_id: string; paused_until: string; paused_reason: string }[]
): Promise<Verdict> {
  if (!row.binding_enabled) {
    return {
      skipped: 'binding_disabled',
      detail: 'El binding del alias con esta cuenta está deshabilitado.',
      pausedUntil: null
    };
  }
  if (!row.account_enabled) {
    return {
      skipped: 'account_disabled',
      detail: 'La suscripción está deshabilitada en provider_accounts.',
      pausedUntil: null
    };
  }

  const pausedUntil = row.paused_until;
  if (pausedUntil !== null && pausedUntil.getTime() > now.getTime()) {
    const automatic = row.paused_reason?.startsWith(AUTOMATIC_PAUSE_PREFIX) ?? false;
    return {
      skipped: automatic ? 'paused_automatic' : 'paused_manual',
      detail: automatic
        ? `Pausada automáticamente por cuota hasta ${pausedUntil.toISOString()}.`
        : `Pausa puesta a mano por un operador hasta ${pausedUntil.toISOString()}. El automatismo no la toca.`,
      pausedUntil: pausedUntil.toISOString()
    };
  }

  if (row.exhausted_window === null) return { skipped: null, detail: null, pausedUntil: null };

  // Agotada y sin pausa vigente. Se salta SIEMPRE; persistir la pausa depende de tener horizonte.
  if (row.exhausted_reset_at === null) {
    return {
      skipped: 'quota_exhausted',
      detail: `Cuota agotada en ${row.exhausted_window}. El proveedor no informó reset, así que se`
        + ' salta esta vez pero NO se persiste una pausa: una pausa sin horizonte necesita un humano'
        + ' para levantarla.',
      pausedUntil: null
    };
  }

  // Una pausa manual SIN `paused_until` vigente (o ya vencida) igual conserva su motivo: el WHERE
  // del UPDATE no matchea y `rowCount` vuelve 0. Se informa como pausa manual respetada en vez de
  // reportar una auto-pausa que no ocurrió.
  const reason = `${AUTOMATIC_PAUSE_PREFIX}${row.exhausted_window}`;
  const paused = await client.query<{ paused_until: Date; paused_reason: string }>(AUTO_PAUSE_SQL, [
    row.account_id, now.toISOString(), row.exhausted_reset_at.toISOString(), reason
  ]);
  const applied = paused.rows[0];
  if (applied === undefined) {
    return {
      skipped: 'paused_manual',
      detail: `Cuota agotada en ${row.exhausted_window}, pero la cuenta tiene un motivo de pausa`
        + ' manual: el automatismo no lo pisa.',
      pausedUntil: row.paused_until?.toISOString() ?? null
    };
  }

  autoPaused.push({
    account_id: row.account_id,
    paused_until: applied.paused_until.toISOString(),
    paused_reason: applied.paused_reason
  });
  return {
    skipped: 'quota_exhausted',
    detail: `Cuota agotada en ${row.exhausted_window}; pausada automáticamente hasta ${applied.paused_until.toISOString()}.`,
    pausedUntil: applied.paused_until.toISOString()
  };
}
