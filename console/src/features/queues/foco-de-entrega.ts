import type { QueueItem } from '../../api/types';

/**
 * **El enlace profundo `/queues?delivery=<uuid>` — de dónde salió y qué tenía de falso.**
 *
 * El cajón de «La flota ahora» pinta, por cada entrega en vuelo, un enlace «Ver en Queues» que
 * apunta a `/queues?delivery=<uuid>` (commit `d3411de`). 
 * `QueuesPage` no leía `location.search` —el ÚNICO código de la consola que lo tocaba era
 * `LiveFleetPage`, con sus propios `agente`, `pestana` y `trace`—, así que el aterrizaje pintaba la
 * lista genérica de 200 filas, el id pedido aparecía CERO veces en `<main>` y ninguna fila quedaba
 * marcada. El enlace no llevaba a ningún sitio: llevaba a una página que se parecía a la respuesta.
 *
 * Este módulo es la parte pura de la reparación, separada de la pantalla para poder probarla por
 * tabla: qué pide la URL, qué filas corresponden y —lo que importa— cuándo el snapshot NO trae la
 * entrega pedida.
 *
 * Lo que la consola NO puede saber cuando la entrega no está.** `GET /v3/console/queues`
 * devuelve las entregas visibles ordenadas por `created_at DESC` con un `LIMIT` del servidor
 * (200 hoy) y no acepta consulta por entrega: no existe `GET /v3/console/queues/:id`. Por lo tanto
 * «no figura en este snapshot» NO distingue «ya no existe» de «es más antigua que las que caben».
 * Las dos se dicen juntas y en voz alta (`TEXTO_AUSENTE`); inventar una de las dos sería
 * exactamente la clase de mentira que esta reparación viene a quitar.
 */

export type EstadoDelFoco = 'sin-foco' | 'encontrada' | 'ausente';

export interface FocoDeEntrega {
  estado: EstadoDelFoco;
  /** El id pedido por la URL. `undefined` sólo cuando `estado` es `sin-foco`. */
  deliveryId?: string;
  /** Lo que la tabla debe pintar. Con foco encontrado es UNA fila; con foco ausente, ninguna. */
  filas: readonly QueueItem[];
}

/**
 * Lee `?delivery=` de una query string. Un parámetro vacío o sólo con espacios es lo mismo que no
 * pedir nada: el enlace del cajón se construye con `item.delivery_id ?? ''`, así que una entrega
 * sin id produce `/queues?delivery=` y eso NO debe filtrar la tabla a cero filas.
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
 * Las palabras exactas del caso ausente. Se exportan para que la prueba las exija y para que
 * cambiarlas obligue a pasar por ella: son la única cosa que el operador lee cuando el enlace no
 * encuentra su entrega.
 */
export const TEXTO_AUSENTE =
  'Esa entrega no está en esta página. Este snapshot trae sólo las entregas más recientes que tu '
  + 'cuenta puede ver, y el endpoint no acepta buscar una por id: puede que ya no exista, o puede '
  + 'que sea más antigua que las que caben acá. La consola no puede distinguir cuál de las dos es.';
