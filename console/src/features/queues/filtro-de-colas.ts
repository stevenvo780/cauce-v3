import type { DeliveryState, QueueItem, QueueSnapshot } from '../../api/types';
import { safeDeliveryState } from '../../lib';

/**
 * Grouping of queue states for filtering and for pinning the set of states of each group.
 * Keeps the correspondence between the header metrics and the delivery filtering.
 */

export type GrupoDeEstado = 'todas' | 'revision' | 'retry' | 'pendientes';

/**
 * `revision` includes `failed` alongside `dead`: `failed` also leaves a row in `dead_letters`,
 * `replayDelivery` accepts it and the server's `dead` counter sums it, so leaving it out would
 * hide rescuable deliveries behind a filter that says there is nothing to do.
 */
export const ESTADOS_DEL_GRUPO: Record<Exclude<GrupoDeEstado, 'todas'>, ReadonlySet<DeliveryState>> = {
  revision: new Set<DeliveryState>(['dead', 'failed']),
  retry: new Set<DeliveryState>(['retry']),
  pendientes: new Set<DeliveryState>(['pending', 'leased', 'accepted', 'started']),
};

export const ROTULO_DEL_GRUPO: Record<GrupoDeEstado, string> = {
  todas: 'todas las entregas',
  revision: 'las que requieren revisión (dead y failed)',
  retry: 'las que están en retry',
  pendientes: 'las pendientes o en manos de un adaptador',
};

export interface FiltroDeColas {
  grupo: GrupoDeEstado;
  /** Free text against alias, tenant, delivery id, message id and last error. */
  texto: string;
}

export const FILTRO_VACIO: FiltroDeColas = { grupo: 'todas', texto: '' };

function coincideElTexto(item: QueueItem, buscado: string): boolean {
  const aguja = buscado.trim().toLocaleLowerCase();
  if (!aguja) return true;
  const campos = [item.recipient_alias, item.tenant_id, item.delivery_id, item.message_id, item.last_error, item.lane];
  return campos.some((campo) => typeof campo === 'string' && campo.toLocaleLowerCase().includes(aguja));
}

export function filtrarEntregas(items: readonly QueueItem[], filtro: FiltroDeColas): QueueItem[] {
  return items.filter((item) => {
    if (filtro.grupo !== 'todas') {
      const estado = safeDeliveryState(item.state);
      // A state the console does not recognize does NOT enter any specific group: putting it in
      // "pendientes" or "revision" would be guessing, and guessing here sends an operator to
      // re-inject something they cannot identify.
      if (estado === undefined || !ESTADOS_DEL_GRUPO[filtro.grupo].has(estado)) return false;
    }
    return coincideElTexto(item, filtro.texto);
  });
}

/**
 * How many rows each group has WITHIN the page. NOT the total —`totalDelGrupo` is—: the total is
 * what the operator acts on and this is what the table can show; the difference IS the truncation.
 */
export function contarPorGrupo(items: readonly QueueItem[]): Record<GrupoDeEstado, number> {
  return {
    todas: items.length,
    revision: filtrarEntregas(items, { grupo: 'revision', texto: '' }).length,
    retry: filtrarEntregas(items, { grupo: 'retry', texto: '' }).length,
    pendientes: filtrarEntregas(items, { grupo: 'pendientes', texto: '' }).length,
  };
}

const CAMPO_DEL_GRUPO: Record<Exclude<GrupoDeEstado, 'todas'>, 'pending' | 'retrying' | 'dead'> = {
  revision: 'dead',
  retry: 'retrying',
  pendientes: 'pending',
};

/** Only a finite number is data: `null`, missing or NaN stay UNKNOWN, never collapsed to 0. */
function cifra(valor: unknown): number | undefined {
  return typeof valor === 'number' && Number.isFinite(valor) ? valor : undefined;
}

/**
 * How many deliveries of a group the server sees IN TOTAL: `totals`, its `COUNT` with no `LIMIT`.
 * A gateway that does not publish it falls back to the per-page counters, which under-count but
 * are never UNKNOWN; `muestraRecortada` still says the page is not everything.
 */
export function totalDelGrupo(
  snapshot: QueueSnapshot | undefined,
  grupo: Exclude<GrupoDeEstado, 'todas'>,
): number | undefined {
  const campo = CAMPO_DEL_GRUPO[grupo];
  return cifra(snapshot?.totals?.[campo]) ?? cifra(snapshot?.[campo]);
}

/** `true` only when the server ASSERTS the page left visible deliveries out. */
export function muestraRecortada(snapshot: QueueSnapshot | undefined): boolean {
  return snapshot?.muestra_recortada === true;
}
