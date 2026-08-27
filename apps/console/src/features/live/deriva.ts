import type { TopologySnapshot } from '../../api/types';
import type { LiveAgentView } from './agent-state';

/**
 * Medición de deriva bidireccional entre el registro de agentes (`activity.agents`)
 * y la topología de salas y membresías (`topology.memberships`).
 *
 * El registro se discrimina por el flag `unregistered`/`registered` provisto por el servidor.
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
