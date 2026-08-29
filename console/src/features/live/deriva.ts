import type { TopologySnapshot } from '../../api/types';
import type { LiveAgentView } from './agent-state';

/**
 * Bidirectional drift measurement between the agents registry (`activity.agents`)
 * and the rooms/memberships topology (`topology.memberships`).
 *
 * The registry is discriminated by the `unregistered`/`registered` flag provided by the server.
 */
export interface Deriva {
  /**
   * ENABLED membership whose alias has no row in the agents registry. The case `quota-collector`:
   * an operator principal that lives like that on purpose.
   */
  sinRegistro: number;
  /**
   * Registry alias without a single enabled membership. The case `gaia`. It is drawn the same way
   * —in the "no room" box— but so far was not counted anywhere.
   */
  sinSala: number;
  /** The symmetric difference: `sinRegistro + sinSala`. The two sets are disjoint. */
  total: number;
}

/**
 * `enabled === false` is a REMOVAL that someone performed on purpose and that the database keeps
 * because the message history references it. It is not drift, and counting it would turn every
 * correct removal into a permanent alarm. `undefined` does count: the server did not mark it disabled.
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

/** `true` only when the participant has its own row in `agents`. See the block above. */
function estaEnElRegistro(view: LiveAgentView): boolean {
  if (view.flags.includes('unregistered')) return false;
  return view.agent.registered !== false;
}

/**
 * The symmetric difference between the enabled memberships and the agents registry.
 *
 * `views` must already be restricted to the selected tenant when a filter is active, the same as
 * `topology`: measuring a trimmed set against a whole one turns every alias of another tenant
 * into invented drift. That is why this function does not filter anything on its own — it does
 * not know what is being watched — and why it receives both sides already trimmed.
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
