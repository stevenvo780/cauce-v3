import type { QueueItem } from '../../api/types';

/**
 * **The deep link `/queues?delivery=<uuid>` — where it came from and what was wrong with it.**
 *
 * The "Live fleet" panel renders, for every delivery in flight, a "View in Queues" link pointing
 * to `/queues?delivery=<uuid>` (commit `d3411de`). `QueuesPage` did not read `location.search`
 * — the ONLY console code that touched it was `LiveFleetPage`, with its own `agente`, `pestana`
 * and `trace` — so the landing rendered the generic list of 200 rows, the requested id appeared
 * ZERO times in `<main>`, and no row was marked. The link went nowhere: it led to a page that
 * looked like the answer.
 *
 * This module is the pure part of the fix, separated from the view so it can be tested by
 * table: what the URL asks for, which rows match, and — importantly — when the snapshot does
 * NOT contain the requested delivery.
 *
 * What the console CANNOT know when the delivery is missing.** `GET /v3/console/queues`
 * returns the visible deliveries ordered by `created_at DESC` with a server-side `LIMIT`
 * (200 today) and does not accept a per-delivery query: there is no `GET /v3/console/queues/:id`.
 * Therefore "not in this snapshot" does NOT distinguish "no longer exists" from "older than what
 * fits". Both are said together, out loud (`TEXTO_AUSENTE`); inventing either would be exactly
 * the kind of lie this fix comes to remove.
 */

export type EstadoDelFoco = 'sin-foco' | 'encontrada' | 'ausente';

export interface FocoDeEntrega {
  estado: EstadoDelFoco;
  /** The id requested by the URL. `undefined` only when `estado` is `sin-foco`. */
  deliveryId?: string;
  /** What the table must render. With a found focus it is ONE row; with an absent focus, none. */
  filas: readonly QueueItem[];
}

/**
 * Reads `?delivery=` from a query string. An empty parameter, or one with only whitespace, is
 * the same as asking for nothing: the panel link is built with `item.delivery_id ?? ''`, so a
 * delivery without an id produces `/queues?delivery=` and that MUST NOT filter to zero rows.
 */
export function leerEntregaPedida(search: string): string | undefined {
  const pedido = new URLSearchParams(search).get('delivery')?.trim();
  if (!pedido) return undefined;
  return pedido;
}

export function enfocarEntrega(
  items: readonly QueueItem[],
  deliveryId: string | undefined,
): FocoDeEntrega {
  if (!deliveryId) return { estado: 'sin-foco', filas: items };
  const fila = items.find((item) => item.delivery_id === deliveryId);
  return fila
    ? { estado: 'encontrada', deliveryId, filas: [fila] }
    : { estado: 'ausente', deliveryId, filas: [] };
}

/**
 * The exact wording of the absent case. Exported so the test can require them, and so changing
 * them forces going through it: it is the only thing the operator reads when the link does not
 * find its delivery.
 */
export const TEXTO_AUSENTE =
  'Esa entrega no está en esta página. Este snapshot trae sólo las entregas más recientes que tu '
  + 'cuenta puede ver, y el endpoint no acepta buscar una por id: puede que ya no exista, o puede '
  + 'que sea más antigua que las que caben acá. La consola no puede distinguir cuál de las dos es.';
