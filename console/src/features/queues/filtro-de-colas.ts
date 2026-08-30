import type { DeliveryState, QueueItem } from '../../api/types';
import { safeDeliveryState } from '../../lib';

/**
 * Grouping of queue states for filtering and for pinning the set of states of each group.
 * Keeps the correspondence between the header metrics and the delivery filtering.
 */

export type GrupoDeEstado = 'todas' | 'revision' | 'retry' | 'pendientes';

/**
 * `revision` includes `failed` alongside `dead`, and that is not a detail.
 *
 * `failed` ALSO leaves a row in `dead_letters` and `replayDelivery` accepts it: the server's own
 * `dead` counter sums it (`queueSnapshot`, packages/store). A "require review" group showing only
 * `dead` would hide exactly the same 197 deliveries the replay button had stopped hiding, and the
 * operator would land on a filter that tells them there is nothing to do while rescue is
 * available.
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

interface FiltroDeColas {
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
 * How many rows each group has WITHIN the snapshot being watched.
 *
 * `snapshot.pending/retrying/dead` are not reused here: the server computes those three over the
 * same data, but they are numbers over the whole snapshot, and here we need the count of what
 * the table can actually show. When they match, they match; when they do not, the difference is
 * information —it means the server's `LIMIT` truncated it— and covering it with the server's
 * number would paint a filter that promises rows that are not there.
 */
export function contarPorGrupo(items: readonly QueueItem[]): Record<GrupoDeEstado, number> {
  return {
    todas: items.length,
    revision: filtrarEntregas(items, { grupo: 'revision', texto: '' }).length,
    retry: filtrarEntregas(items, { grupo: 'retry', texto: '' }).length,
    pendientes: filtrarEntregas(items, { grupo: 'pendientes', texto: '' }).length,
  };
}
