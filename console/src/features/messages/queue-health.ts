import type { FleetActivitySnapshot, QueueSnapshot } from '../../api/types';
import { deliveryPolicy } from '../deliveries/delivery-policy';
import { fleetAgentId, type FleetAgent } from '../terminal/fleet';

/**
 * The TWO ceilings the server applies to this view's sources, measured in
 * `packages/store/src/repository.ts` (not inferred):
 *
 *  - `listMessages(actorTenant, actorAlias, limit = 100)` → the thread is filtered on the client side
 *    over those 100 GLOBAL messages. There is no per-pair filter or real cursor (`next_cursor` is always
 *    returned as `null`), so on a loaded fleet an agent's thread can look EMPTY without that meaning there
 *    is no history.
 *  - `queueSnapshot(actorTenant, actorAlias, limit = 200)` → the endpoint's own counters are computed OVER
 *    those 200 rows, not over the table.
 *
 * They live here rather than in a loose comment because the view must be able to say so on screen: a
 * truncated number painted as if it were the total is exactly the kind of data that drives the wrong
 * decision.
 */
export const LIMITE_MENSAJES = 100;
export const LIMITE_COLA = 200;

/**
 * How ONE agent's queue is doing. Every count is optional on purpose: `undefined` is UNKNOWN and is
 * NEVER collapsed to 0, which would paint as healthy exactly the agent to look at.
 */
export interface SaludDeCola {
  /** Deliveries queued and not yet picked up (`/activity` → `queued`). */
  pendientes?: number;
  /** Deliveries picked up and in flight (`/activity` → `in_flight`). */
  enCurso?: number;
  /** Deliveries being retried (`/activity` → `retrying`). */
  reintentos?: number;
  /**
   * Dead deliveries. It comes from `/queues`, counting `dead` AND `failed` — the SAME criterion
   * `queueSnapshot()` uses in the store, where the reason is written down: since that patch `failed` leaves
   * a row in `dead_letters` and `replayDelivery` accepts it, leaving it out would keep the operator
   * believing there is nothing to review.
   */
  muertas?: number;
  /**
   * `true` when `muertas` was derived from a snapshot that hit the server's ceiling: the number is a FLOOR,
   * not a total. The UI must say so, not disguise it.
   */
  muertasTruncadas: boolean;
}

function vacia(): SaludDeCola {
  return { muertasTruncadas: false };
}

/** Only a finite number counts as data. `null`, missing, or NaN stay as UNKNOWN. */
function cifra(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function entrada(mapa: Map<string, SaludDeCola>, id: string): SaludDeCola {
  const actual = mapa.get(id);
  if (actual) return actual;
  const nueva = vacia();
  mapa.set(id, nueva);
  return nueva;
}

/**
 * Merges `/v3/console/activity` (work in flight per alias) with `/v3/console/queues` (deliveries and
 * their state) into a single read per agent, indexed by `fleetAgentId`.
 *
 * They are two endpoints because neither alone answers the question on its own: activity knows what is in
 * flight and what is queued but does NOT report dead deliveries; queues does have them, but only within its
 * 200 rows. Merging them here —in a pure, tested function— is what prevents each component from improvising
 * its own cross-reference and its own invented zero.
 */
export function saludDeColaPorAgente(
  activity: FleetActivitySnapshot | undefined,
  queues: QueueSnapshot | undefined,
): Record<string, SaludDeCola> {
  const mapa = new Map<string, SaludDeCola>();

  for (const agente of activity?.agents ?? []) {
    if (!agente.tenant_id || !agente.alias) continue;
    const salud = entrada(mapa, fleetAgentId(agente.tenant_id, agente.alias));
    salud.pendientes = cifra(agente.queued);
    salud.enCurso = cifra(agente.in_flight);
    salud.reintentos = cifra(agente.retrying);
  }

  const filas = queues?.items;
  if (!Array.isArray(filas)) return Object.fromEntries(mapa);

  // `muestra_recortada` is decided against the total `COUNT`, so the server's word wins over
  // counting rows: the heuristic marks a floor on a complete page of exactly 200, and breaks the
  // day the ceiling stops being 200. Without the flag it is still the only thing available.
  const truncado = typeof queues?.muestra_recortada === 'boolean'
    ? queues.muestra_recortada
    : filas.length >= LIMITE_COLA;
  for (const fila of filas) {
    if (!fila.tenant_id || !fila.recipient_alias) continue;
    const salud = entrada(mapa, fleetAgentId(fila.tenant_id, fila.recipient_alias));
    if (deliveryPolicy(fila.state).group === 'review') salud.muertas = (salud.muertas ?? 0) + 1;
  }

  // `/queues` answered: for the aliases that show up in the view, "no dead rows" is a KNOWN zero
  // (within what the actor can see), not an UNKNOWN. Without this pass, a healthy alias would be
  // indistinguishable from one whose queue could not be read.
  for (const salud of mapa.values()) {
    salud.muertas ??= 0;
    salud.muertasTruncadas = truncado;
  }

  return Object.fromEntries(mapa);
}

/** An alias "asks for attention" if it has dead or retrying deliveries. In flight is NOT an alarm. */
export function colaNecesitaAtencion(salud: SaludDeCola | undefined): boolean {
  return (salud?.muertas ?? 0) > 0 || (salud?.reintentos ?? 0) > 0;
}

/**
 * Roster order: the bleeding first. Within each group, the order `buildFleetAgents` already brings
 * (online → unknown → expired, then alphabetical) is preserved, so this does not reorder the whole fleet: it
 * only moves aliases with dead or retrying deliveries to the top, which is what sets this view apart from a
 * contact list.
 */
export function ordenarPorSaludDeCola<T extends FleetAgent>(
  agentes: readonly T[],
  salud: Record<string, SaludDeCola>,
): T[] {
  return agentes
    .map((agente, indice) => ({ agente, indice }))
    .sort((izquierda, derecha) => {
      const pesoIzquierda = peso(salud[izquierda.agente.id]);
      const pesoDerecha = peso(salud[derecha.agente.id]);
      return pesoDerecha - pesoIzquierda || izquierda.indice - derecha.indice;
    })
    .map(({ agente }) => agente);
}

function peso(salud: SaludDeCola | undefined): number {
  return (salud?.muertas ?? 0) * 1_000 + (salud?.reintentos ?? 0);
}

/** Text for a queue figure. UNKNOWN is said with the word, never with a dash or a 0. */
export function textoDeCifra(valor: number | undefined): string {
  return valor === undefined ? 'UNKNOWN' : String(valor);
}
