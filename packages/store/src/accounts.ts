import type { Tenant } from '@cauce/protocol'; /* eslint @typescript-eslint/no-unnecessary-type-conversion: "error" */
import type { DatabasePool, DatabaseClient } from './db.js';
import { withTransaction } from './db.js';

/**
 * Prefix that identifies an automatic pause applied by the quota collector.
 */
export const AUTOMATIC_PAUSE_PREFIX = 'quota_exhausted:';

/** Reason a candidate account is not available for selection. */
export type AccountSkipReason =
  /** `agent_account_bindings.enabled = false`: binding disabled. */
  | 'binding_disabled'
  /** `provider_accounts.enabled = false`: account disabled globally. */
  | 'account_disabled'
  /** `paused_until > now()` with automatic reason due to quota. */
  | 'paused_automatic'
  /** `paused_until > now()` with manual operator reason. */
  | 'paused_manual'
  /** No active pause, but quota exhausted reported in quota_window_state. */
  | 'quota_exhausted';

export interface AccountCandidate {
  readonly account_id: string;
  readonly provider: string;
  readonly priority: number;
  readonly payer_tenant_id: string;
  readonly label: string | null;
  /** Type of credential locator. */
  readonly credential_ref_kind: 'env_path' | 'file' | 'secret_manager';
  readonly credential_ref: string;
  /** `null` if it was selected, or the reason it was skipped. */
  readonly skipped: AccountSkipReason | null;
  /** Human-readable detail for the operator about the selection or skip. */
  readonly detail: string | null;
  /** Date until which the account is paused, if applicable. */
  readonly paused_until: string | null;
  /** Identifier of the exhausted window (`proveedor/grupo/ventana`), if applicable. */
  readonly exhausted_window: string | null;
}

export interface AccountSelection {
  readonly tenant_id: Tenant;
  readonly alias: string;
  readonly provider: string;
  readonly observed_at: string;
  /** The account to use, or `null` if none remained available. */
  readonly selected: AccountCandidate | null;
  /** ALL ceiling candidates, in the actual fallback order. Includes the selected one. */
  readonly candidates: readonly AccountCandidate[];
  /** true when the chosen one was not the highest priority: there was failover. */
  readonly failover: boolean;
  /** Accounts that THIS call just auto-paused. */
  readonly auto_paused: readonly {
    readonly account_id: string;
    readonly paused_until: string;
    readonly paused_reason: string;
  }[];
}

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
  /** Most restrictive exhausted window of the account, or NULL if none is NOW. */
  exhausted_window: string | null;
  /** `reset_at` of that window. NULL = the provider did not report a reset horizon. */
  exhausted_reset_at: Date | null;
}

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
  /** Injectable for deterministic tests. */
  readonly now?: Date;
}

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
    // We evaluate the WHOLE list even after one is chosen: the trace of why each was discarded
    // is what makes failover auditable. There are ≤ 6 rows per alias in the worst real case.
    const verdict = await evaluate(client, row, now, autoPaused);
    const candidate: AccountCandidate = {
      account_id: row.account_id,
      provider: row.provider,
      priority: Number(row.priority), // eslint-disable-line @typescript-eslint/no-unnecessary-type-conversion -- Database rows are runtime input; normalize priority despite the declared row type.
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
    // There is failover if the chosen one is not the first in the list, which already comes in
    // priority order. Comparing by object identity is exact: `selected` comes from this very array.
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
 * The order of checks IS the semantics and is NOT interchangeable:
 *
 *  1. `binding_disabled` / `account_disabled` first: they are explicit decisions from an operator
 *     and win over any quota-derived state.
 *  2. The CURRENT pause before exhaustion: if it is already paused there is nothing to decide, and
 *     distinguishing `paused_manual` from `paused_automatic` here is what tells the operator
 *     whether they or the machine set that pause.
 *  3. Exhaustion last, which is the only case that also WRITES.
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

  // Exhausted and with no current pause. Always skipped; persisting the pause depends on having a horizon.
  if (row.exhausted_reset_at === null) {
    return {
      skipped: 'quota_exhausted',
      detail: `Cuota agotada en ${row.exhausted_window}. El proveedor no informó reset, así que se`
        + ' salta esta vez pero NO se persiste una pausa: una pausa sin horizonte necesita un humano'
        + ' para levantarla.',
      pausedUntil: null
    };
  }

  // A manual pause WITHOUT a current `paused_until` (or already expired) still keeps its reason: the
  // WHERE of the UPDATE does not match and `rowCount` returns 0. Reported as a respected manual pause
  // instead of reporting an auto-pause that did not occur.
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
