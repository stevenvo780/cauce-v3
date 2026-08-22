import type { TopologySnapshot } from '../../api/types';
import type { LiveAgentView } from './agent-state';

/**
 * **La deriva entre las dos tablas que dicen quién es la flota, medida en las DOS direcciones.**
 *
 * «La flota ahora» lee dos planos que nadie reconcilia en el servidor:
 *
 *   - `agents` (vía `GET /v3/console/activity`) → el REGISTRO. Decide quién existe y cómo está.
 *   - `memberships` (vía `GET /v3/console/topology`) → las SALAS. Decide dentro de qué recuadro va.
 *
 * Que un alias esté en uno y no en el otro casi nunca es una avería por sí solo, pero SIEMPRE es
 * un alta o una baja hecha tocando una sola de las dos tablas, y eso es lo que se quiere ver el
 * mismo día y no dentro de un mes.
 *
 * 🔴 **Por qué existe este módulo.** Hasta el 2026-08-22 esto se calculaba dentro de
 * `LiveFleetPage` con un comentario que afirmaba —literalmente— que era «la diferencia simétrica
 * entre `memberships` y `agents`». No lo era: el bucle recorría SÓLO las membresías y contaba las
 * que no reportaban actividad. La otra mitad —un alias del registro sin una sola membresía
 * habilitada— valía cero siempre, aunque estuviera ahí.
 *
 * Y esa mitad ciega es exactamente el caso `gaia`: se dio de alta en `agents`, no se le puso
 * membresía, y la pantalla que existe para mostrar la flota no decía una palabra al respecto. El
 * defecto que motivó todo el arreglo del mapa quedó, después del arreglo, sin nadie que lo
 * contara. Un contador que promete simetría y mide una sola dirección es peor que no tenerlo,
 * porque un cero se lee como «no hay deriva» y no como «no se miró».
 *
 * **El lado del registro se decide por `unregistered`/`registered`, no por «está en `views`».** El
 * universo de la actividad es `agents ∪ entregas-abiertas ∪ connection_leases`: un alias puede
 * aparecer en `views` sin tener fila en `agents`. Contarlo como «del registro» convertiría a un
 * participante sin dar de alta en un alias registrado, que es justo lo contrario de lo que el
 * chip promete. El servidor manda el flag `unregistered` precisamente para separarlos.
 */
export interface Deriva {
  /**
   * Membresía HABILITADA cuyo alias no tiene fila en el registro de agentes. El caso
   * `quota-collector`: un principal de operador que vive así a propósito.
   */
  sinRegistro: number;
  /**
   * Alias del registro sin una sola membresía habilitada. El caso `gaia`. Se dibuja igual —en el
   * recuadro «sin sala»— pero hasta ahora no se contaba en ninguna parte.
   */
  sinSala: number;
  /** La diferencia simétrica: `sinRegistro + sinSala`. Los dos conjuntos son disjuntos. */
  total: number;
}

/**
 * `enabled === false` es una BAJA que alguien dio a propósito y que la base conserva porque el
 * historial de mensajes la referencia. No es deriva, y contarla convertiría cada retiro correcto
 * en una alarma permanente. `undefined` sí cuenta: el servidor no la declaró deshabilitada.
 */
function membresiasHabilitadas(topology: TopologySnapshot | undefined): Set<string> {
  const claves = new Set<string>();
  for (const tenant of topology?.tenants ?? []) {
    for (const room of tenant.rooms ?? []) {
      for (const member of room.members ?? []) {
        if (!member.alias || !tenant.id) continue;
        if (member.enabled === false) continue;
        claves.add(`${tenant.id}/${member.alias}`);
      }
    }
  }
  return claves;
}

/** `true` sólo cuando el participante tiene fila propia en `agents`. Ver el bloque de arriba. */
function estaEnElRegistro(view: LiveAgentView): boolean {
  if (view.flags.includes('unregistered')) return false;
  return view.agent.registered !== false;
}

/**
 * La diferencia simétrica entre las membresías habilitadas y el registro de agentes.
 *
 * `views` tiene que venir YA acotado al cliente elegido cuando hay filtro, igual que `topology`:
 * medir un conjunto recortado contra otro entero convierte cada alias de otro cliente en deriva
 * inventada. Es la razón por la que esta función no filtra nada por su cuenta — no sabe qué se
 * está mirando— y por la que recibe los dos lados ya recortados.
 */
export function derivaDelRegistro(
  views: readonly LiveAgentView[],
  topology: TopologySnapshot | undefined,
): Deriva {
  const membresias = membresiasHabilitadas(topology);
  const registro = new Set(views.filter(estaEnElRegistro).map((view) => view.key));

  let sinRegistro = 0;
  for (const clave of membresias) if (!registro.has(clave)) sinRegistro += 1;

  let sinSala = 0;
  for (const clave of registro) if (!membresias.has(clave)) sinSala += 1;

  return { sinRegistro, sinSala, total: sinRegistro + sinSala };
}
