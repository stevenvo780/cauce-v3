import type { FleetPurgeResource } from '@cauce/protocol/fleet-operation';
import type { DatabaseClient } from '../db.js';

interface PurgedAgent {
  container_name: string | null; runtime_mode: string | null; state_directory: string | null;
  sharing: string;
}

const LABELS = 'solo si lleva las etiquetas cauce.fleet esperadas';

/**
 * The plan of a purge's physical effect, with the executor's rules (ops/cli/fleet_executor_container.py): a container of its
 * own goes with its `-state` and `-provider-profiles` volumes only when they carry the expected `cauce.fleet` labels; a container
 * shared by several agents (ws-humanizar) is kept and only the alias residue goes; a native agent loses its state directories.
 * The executor decides again on what it observes, so this is the plan, not the outcome.
 */
export async function fleetPurgeResources(client: DatabaseClient, tenantId: string, alias: string): Promise<FleetPurgeResource[]> {
  const agent = (await client.query<PurgedAgent>(`SELECT agent.container_name,agent.runtime_mode,agent.state_directory,
      (SELECT count(*)::text FROM agents other WHERE other.container_name=agent.container_name AND other.purged_at IS NULL
        AND NOT (other.tenant_id=agent.tenant_id AND other.alias=agent.alias)) AS sharing
    FROM agents agent WHERE agent.tenant_id=$1 AND agent.alias=$2`, [tenantId, alias])).rows[0];
  if (!agent) return [];
  const name = agent.container_name;
  if (agent.runtime_mode === 'native' || name?.startsWith('host:')) {
    // `state_directory` already is `state_root/runtime_key` (the invariant the executor enforces), so it is shown as is.
    const directory = agent.state_directory?.replace(/(?<=.)\/+$/u, '');
    return [directory
      ? { type: 'directory', name: directory, action: 'delete', reason: 'Estado y control del agente nativo en su equipo.' }
      : { type: 'directory', name: 'Estado del agente nativo (ruta no registrada)', action: 'delete', reason: 'El agente nativo no tiene directorio de estado registrado: el ejecutor lo resuelve en su equipo.' }];
  }
  if (!name) return [];
  if (agent.sharing !== '0') {
    return [{ type: 'container', name, action: 'keep', reason: `Contenedor compartido con ${agent.sharing} agente(s) más: solo se retiran los restos del alias.` }];
  }
  return [
    { type: 'container', name, action: 'delete', reason: `Contenedor propio del agente, ${LABELS}.` },
    { type: 'volume', name: `${name}-state`, action: 'delete', reason: `Volumen de estado, ${LABELS}.` },
    { type: 'volume', name: `${name}-provider-profiles`, action: 'delete', reason: `Volumen de perfiles de proveedor (si existe), ${LABELS}.` },
  ];
}
