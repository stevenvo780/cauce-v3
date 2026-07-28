/**
 * EL SELECTOR DE CUENTA: dado (tenant, alias, proveedor), qué suscripción se gasta en la próxima
 * ejecución del harness.
 *
 * Hasta acá el registro de la migración 010 era decorativo. `provider_accounts` (6 filas en prod),
 * `alias_routing_ceiling` y `agent_account_bindings` (42 filas) sólo se leían para CONTAR en la
 * consola, y `paused_until` —que la migración 013 escribe cuando una cuota se agota— no lo
 * consultaba ningún camino de despacho. O sea: la base sabía que una suscripción estaba agotada,
 * lo mostraba en el panel, y el adaptador la seguía usando igual. Este archivo es la pieza que
 * convierte esas tablas en una decisión.
 *
 * POR QUÉ VIVE ACÁ Y NO EN `repository.ts`: la selección no es parte del camino caliente de
 * entrega (claimDeliveries/assertRuntimeRoute no la llaman) y no comparte estado con el
 * repositorio. Aislarla la deja probable con una función y un pool, que es lo que permite la
 * cobertura de abajo: prioridad, pausa, agotamiento, failover, pausa manual y sin-cuenta.
 *
 * POR QUÉ `pg` PELADO: es lo que usa todo el store. Un intento anterior de este mismo trabajo
 * metió `drizzle-orm`, que no existe en el workspace; como `repository.ts` lo importaba y
 * `index.ts` lo reexporta, habría dejado sin arrancar a gateway, dispatcher, relay-worker,
 * shadow-router y telegram-bridge de un saque.
 */

import type { Tenant } from '@cauce/protocol';
import type { DatabasePool, DatabaseClient } from './db.js';
import { withTransaction } from './db.js';

/**
 * Prefijo que marca una pausa PUESTA POR LA MÁQUINA. Es el mismo literal que ya usan
 * `recordQuotaSample()` y `quotaSnapshot()` (campo `automatic`), y la migración 013 §(e) lo
 * documenta como la única defensa contra el bug que este parche tiene prohibido reintroducir: que
 * el automatismo levante —o pise— una pausa que un operador puso a mano.
 *
 * La regla, en las dos direcciones:
 *   - No se auto-pausa una cuenta cuyo `paused_reason` NO empiece con este prefijo (pisarlo
 *     borraría el motivo escrito por la persona).
 *   - No se auto-reanuda nada que no lo tenga (eso vive en `recordQuotaSample`).
 */
export const AUTOMATIC_PAUSE_PREFIX = 'quota_exhausted:';

/** Motivo por el que un candidato NO se pudo usar. Se devuelve siempre, aunque haya selección:
 *  la traza es la mitad del valor de esto: sin ella "hoy gastó la cuenta B" es indistinguible de
 *  "alguien reordenó las prioridades", y eso es exactamente lo que costó el incidente. */
export type AccountSkipReason =
  /** `agent_account_bindings.enabled = false`: el operador sacó a la cuenta de la rotación. */
  | 'binding_disabled'
  /** `provider_accounts.enabled = false`: la suscripción está dada de baja globalmente. */
  | 'account_disabled'
  /** `paused_until > now()` con motivo automático: la puso el recolector de cuotas. */
  | 'paused_automatic'
  /** `paused_until > now()` con motivo NO automático: la puso una persona. Se respeta igual. */
  | 'paused_manual'
  /** Sin pausa vigente, pero `quota_window_state` la reporta agotada ahora mismo. */
  | 'quota_exhausted';

export interface AccountCandidate {
  readonly account_id: string;
  readonly provider: string;
  readonly priority: number;
  readonly payer_tenant_id: string;
  readonly label: string | null;
  /** LOCATOR, nunca el secreto: ver el comentario de `credential_ref` en la migración 010. */
  readonly credential_ref_kind: 'env_path' | 'file' | 'secret_manager';
  readonly credential_ref: string;
  /** `null` = elegida. Cualquier otro valor = por qué se saltó y se cayó a la siguiente. */
  readonly skipped: AccountSkipReason | null;
  /** Texto para el operador. Nunca incluye el locator ni nada derivado de un secreto. */
  readonly detail: string | null;
  /** Instante hasta el que está pausada, si lo está. */
  readonly paused_until: string | null;
  /** Ventana que la reportó agotada (`proveedor/grupo/ventana`), cuando la hay. */
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
 * Candidatos de un alias para un proveedor, en el orden EXACTO de fallback.
 *
 * El orden es `(priority ASC, account_id ASC)` y el desempate por `account_id` no es decorativo:
 * `agent_account_bindings_order_idx` es único sólo `WHERE enabled`, así que dos bindings
 * DESHABILITADOS pueden compartir prioridad. Sin el segundo criterio, dos llamadas seguidas
 * podrían devolver la traza en distinto orden y la función dejaría de ser determinista —que es
 * justo lo que la vuelve testeable.
 *
 * El agotamiento se resuelve en SQL contra `quota_window_state` con dos guardas:
 *   - `remaining_percent <= 0 OR status = 'rate-limited'` es la misma condición que usa la
 *     auto-pausa de la migración 013 §(d); replicar otra la haría divergir del panel.
 *   - `reset_at IS NULL OR reset_at > now()` es el agregado de este parche: una ventana cuyo
 *     reset YA PASÓ no está agotada, tiene una muestra vieja. Sin esto, un `remaining_percent=0`
 *     de anteayer que nadie volvió a muestrear (y en prod NADIE muestreaba: la ingesta estaba
 *     rota, ver el fix de `ON CONFLICT` en repository.ts) dejaría al alias sin ninguna cuenta
 *     para siempre. Fallar hacia "usala" es correcto acá: el proveedor rechaza por su cuenta si
 *     de verdad no hay saldo, mientras que fallar hacia "no la uses" corta el despacho sin que
 *     nada pueda volver a habilitarlo.
 *
 * Se ordena por `remaining_percent ASC NULLS LAST` al elegir la ventana representativa para que
 * el motivo que se le muestra al operador sea la ventana MÁS restrictiva, no una cualquiera.
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
 * Auto-pausa una cuenta agotada. TODA la defensa contra pisar una pausa manual está en el
 * `WHERE`, no en el código que lo llama: así la guarda viaja con la escritura y no se puede
 * perder por un refactor que reordene las condiciones en TypeScript.
 *
 * `GREATEST(COALESCE(paused_until, $2), $3)` copia la fórmula de la migración 013 §(d): una
 * pausa automática nunca ACORTA otra pausa automática que ya estaba puesta más lejos.
 *
 * Sólo se llama con `reset_at` conocido. Una pausa sin horizonte necesita un humano para
 * levantarla y es peor que el problema que resuelve — la 013 lo dice con todas las letras. La
 * cuenta agotada sin `reset_at` igual se SALTA en esta selección (queda en la traza como
 * `quota_exhausted`); lo que no se hace es persistir un corte que nadie podría deshacer.
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
  /** Inyectable para que los tests sean deterministas y no dependan del reloj de la máquina. */
  readonly now?: Date;
}

/**
 * Resuelve qué cuenta usar, y deja la base coherente con lo que devolvió.
 *
 * Todo va en UNA transacción porque la lectura de candidatos y la auto-pausa tienen que ver el
 * mismo estado: si se leyera fuera, dos adaptadores arrancando a la vez podrían elegir una cuenta
 * que el otro acaba de pausar y la traza mentiría sobre por qué se gastó lo que se gastó.
 *
 * NO se toma `FOR UPDATE` sobre `provider_accounts` a propósito. La pausa es un UPDATE puntual y
 * autoprotegido por su propio WHERE, así que no necesita el candado; y esta base ya se comió una
 * caída entera de producción por una cláusula de bloqueo mal puesta (ver la migración 012 sobre
 * FOR UPDATE + funciones de ventana en el reaper). No se agrega una donde no hace falta.
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
