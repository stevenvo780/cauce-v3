import type { FleetActivitySnapshot, QueueSnapshot } from '../../api/types';
import { fleetAgentId, type FleetAgent } from '../terminal/fleet';

/**
 * Los DOS techos que el servidor aplica a las fuentes de esta vista, medidos en
 * `packages/store/src/repository.ts` (no inferidos):
 *
 *  - `listMessages(actorTenant, actorAlias, limit = 100)` → el hilo se filtra del lado del
 *    cliente sobre esos 100 mensajes GLOBALES. No hay filtro por par ni cursor real
 *    (`next_cursor` se devuelve siempre `null`), así que en una flota cargada el hilo de un
 *    agente puede verse VACÍO sin que eso signifique que no hay historia.
 *  - `queueSnapshot(actorTenant, actorAlias, limit = 200)` → los contadores del propio endpoint
 *    se calculan SOBRE esas 200 filas, no sobre la tabla.
 *
 * Están acá y no en un comentario suelto porque la vista tiene que poder decirlo en pantalla:
 * un número truncado que se dibuja como si fuera el total es exactamente la clase de dato que
 * hace tomar una decisión equivocada.
 */
export const LIMITE_MENSAJES = 100;
export const LIMITE_COLA = 200;

/**
 * Cómo va la cola de UN agente.
 *
 * Todos los recuentos son opcionales a propósito: `undefined` significa «la fuente no lo
 * informa» (UNKNOWN) y NUNCA se colapsa a 0. Un 0 falso acá pinta de sano justo al agente que
 * hay que mirar, que es el fallo que esta vista existe para no cometer.
 */
export interface SaludDeCola {
  /** Entregas encoladas sin tomar todavía (`/activity` → `queued`). */
  pendientes?: number;
  /** Entregas tomadas y en vuelo (`/activity` → `in_flight`). */
  enCurso?: number;
  /** Entregas en reintento (`/activity` → `retrying`). */
  reintentos?: number;
  /**
   * Entregas muertas. Sale de `/queues`, contando `dead` Y `failed` — el MISMO criterio que usa
   * `queueSnapshot()` en el store, donde está escrito por qué: desde ese parche `failed` deja
   * fila en `dead_letters` y `replayDelivery` la acepta, así que dejarla fuera mantendría al
   * operador creyendo que no hay nada que revisar.
   */
  muertas?: number;
  /**
   * `true` cuando `muertas` se derivó de un snapshot que llegó al techo del servidor: el número
   * es un PISO, no un total. La UI tiene que decirlo, no disimularlo.
   */
  muertasTruncadas: boolean;
}

function vacia(): SaludDeCola {
  return { muertasTruncadas: false };
}

/** Sólo un número finito cuenta como dato. `null`, ausente o NaN se quedan en UNKNOWN. */
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
 * Funde `/v3/console/activity` (trabajo en vuelo por alias) con `/v3/console/queues` (entregas
 * con su estado) en una sola lectura por agente, indexada por `fleetAgentId`.
 *
 * Son dos endpoints porque ninguno de los dos responde solo la pregunta de Steven: activity sabe
 * qué está en curso y qué está encolado pero NO informa entregas muertas; queues sí las tiene,
 * pero sólo dentro de sus 200 filas. Fundirlos acá —en una función pura y probada— es lo que
 * evita que cada componente improvise su propio cruce y su propio cero inventado.
 */
export function saludDeColaPorAgente(
  activity: FleetActivitySnapshot | undefined,
  queues: QueueSnapshot | undefined,
): Record<string, SaludDeCola> {
  const mapa = new Map<string, SaludDeCola>();

  for (const agente of activity?.agents ?? []) {
    if (!agente?.tenant_id || !agente.alias) continue;
    const salud = entrada(mapa, fleetAgentId(agente.tenant_id, agente.alias));
    salud.pendientes = cifra(agente.queued);
    salud.enCurso = cifra(agente.in_flight);
    salud.reintentos = cifra(agente.retrying);
  }

  const filas = queues?.items;
  if (!Array.isArray(filas)) return Object.fromEntries(mapa);

  // El techo se alcanza EXACTAMENTE en el límite: con 200 filas no se puede saber si había 200
  // o 4.000, así que a partir de ahí todo recuento derivado es un piso.
  const truncado = filas.length >= LIMITE_COLA;
  for (const fila of filas) {
    if (!fila?.tenant_id || !fila.recipient_alias) continue;
    const salud = entrada(mapa, fleetAgentId(fila.tenant_id, fila.recipient_alias));
    if (fila.state === 'dead' || fila.state === 'failed') salud.muertas = (salud.muertas ?? 0) + 1;
  }

  // `/queues` respondió: para los alias que aparecen en la vista, «ninguna fila muerta» es un
  // cero CONOCIDO (dentro de lo que el actor puede ver) y no un UNKNOWN. Sin esta pasada, un
  // agente sano quedaría indistinguible de uno cuya cola no se pudo leer.
  for (const salud of mapa.values()) {
    salud.muertas ??= 0;
    salud.muertasTruncadas = truncado;
  }

  return Object.fromEntries(mapa);
}

/** Un agente «pide atención» si tiene entregas muertas o en reintento. En vuelo NO es alarma. */
export function colaNecesitaAtencion(salud: SaludDeCola | undefined): boolean {
  return Boolean((salud?.muertas ?? 0) > 0 || (salud?.reintentos ?? 0) > 0);
}

/**
 * Orden del roster: primero lo que sangra. Dentro de cada grupo se conserva el orden que ya trae
 * `buildFleetAgents` (online → unknown → expirado, y después alfabético), así que esto no
 * reordena la flota entera: sólo sube a la cabecera a quien tiene entregas muertas o en
 * reintento, que es lo que diferencia esta vista de una lista de contactos.
 */
export function ordenarPorSaludDeCola(
  agentes: readonly FleetAgent[],
  salud: Record<string, SaludDeCola>,
): FleetAgent[] {
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

/** Texto de una cifra de cola. UNKNOWN se dice con la palabra, nunca con un guión ni con un 0. */
export function textoDeCifra(valor: number | undefined): string {
  return valor === undefined ? 'UNKNOWN' : String(valor);
}
