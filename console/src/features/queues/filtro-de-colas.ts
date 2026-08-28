import type { DeliveryState, QueueItem } from '../../api/types';
import { safeDeliveryState } from '../../lib';

/**
 * Agrupación de estados de colas para filtrado y fijación del conjunto de estados de cada grupo.
 * Mantiene la correspondencia entre las métricas de cabecera y el filtrado de entregas.
 */

export type GrupoDeEstado = 'todas' | 'revision' | 'retry' | 'pendientes';

/**
 * `revision` incluye `failed` además de `dead`, y no es un detalle.
 *
 * `failed` TAMBIÉN deja fila en `dead_letters` y `replayDelivery` la acepta: el propio contador
 * `dead` del servidor la suma (`queueSnapshot`, packages/store). Un grupo «requieren revisión» que
 * mostrara sólo `dead` escondería exactamente las mismas 197 entregas que el botón de replay ya
 * había dejado de esconder, y el operador llegaría a un filtro que le dice que no hay nada que
 * hacer mientras el rescate está disponible.
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
  /** Texto libre contra alias, tenant, delivery id, message id y último error. */
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
      // Un estado que la consola no reconoce NO entra en ningún grupo concreto: meterlo en
      // «pendientes» o en «revisión» sería adivinar, y adivinar acá manda a un operador a
      // reinyectar algo que no sabe qué es.
      if (estado === undefined || !ESTADOS_DEL_GRUPO[filtro.grupo].has(estado)) return false;
    }
    return coincideElTexto(item, filtro.texto);
  });
}

/**
 * Cuántas filas hay en cada grupo DENTRO del snapshot que se está mirando.
 *
 * No se reusan `snapshot.pending/retrying/dead` para esto: esos tres los calcula el servidor sobre
 * lo mismo, pero son cifras del snapshot entero y acá hace falta el conteo de lo que la tabla
 * puede mostrar. Cuando coinciden, coinciden; cuando no, la diferencia es información —significa
 * que el `LIMIT` del servidor recortó— y taparla con la cifra del servidor sería pintar un filtro
 * que promete filas que no están.
 */
export function contarPorGrupo(items: readonly QueueItem[]): Record<GrupoDeEstado, number> {
  return {
    todas: items.length,
    revision: filtrarEntregas(items, { grupo: 'revision', texto: '' }).length,
    retry: filtrarEntregas(items, { grupo: 'retry', texto: '' }).length,
    pendientes: filtrarEntregas(items, { grupo: 'pendientes', texto: '' }).length,
  };
}
