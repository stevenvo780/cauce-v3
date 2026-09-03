import type { AgentDocumentsMap, ConfigurationSnapshot } from '../../api/types';

/**
 * Where the configuration of an alias really lives. `agents.container_name` and
 * `agents.home_directory` are DECLARED columns that `docs/directiva-ficheros-del-agente.md`
 * documents as lying, and sending an operator to edit the wrong file is the failure: a declared
 * value is never shown alone as the location. Either a measurement confirms it, or both are
 * shown, or it stays unknown.
 */

/** The versioned roadmap section; its prose is not carried in the SPA bundle. */
export const ROADMAP_DE_CAPAS = {
  fichero: 'docs/roadmap.md',
  seccion: 'Capas pendientes del contexto',
} as const;

export interface UbicacionDeclarada {
  tenantId: string;
  alias: string;
  contenedor?: string;
  home?: string;
}

export interface UbicacionMedida {
  home?: string;
  arnes?: string;
}

export type ContrasteDeUbicacion =
  | { estado: 'medido'; valor: string }
  | { estado: 'discrepa'; declarado: string; medido: string }
  | { estado: 'desconocido'; declarado?: string };

function texto(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const limpio = value.trim();
  return limpio.length === 0 ? undefined : limpio;
}

/** What the registry DECLARES, from the snapshot this dialog already reads, plus the identity
 *  it was asked about so the caller can measure that same alias. */
export function ubicacionDeclarada(
  snapshot: ConfigurationSnapshot | undefined,
  tenantId: string,
  alias: string,
): UbicacionDeclarada {
  const identidad = { tenantId, alias };
  const agents = snapshot?.agents;
  if (!Array.isArray(agents)) return identidad;
  const fila = agents.find((row) => row.tenant_id === tenantId && row.alias === alias);
  if (!fila) return identidad;
  const contenedor = texto(fila.container_name);
  const home = texto(fila.home_directory);
  return { ...identidad, ...(contenedor ? { contenedor } : {}), ...(home ? { home } : {}) };
}

/** Facts MEASURED inside the container, only when the gateway says so: `registry` and
 *  `database` are deduced from the same columns that lie. */
export function ubicacionMedida(mapa: AgentDocumentsMap | undefined): UbicacionMedida {
  if (mapa?.publicado !== true || mapa.facts_source !== 'measured') return {};
  const home = texto(mapa.home);
  const arnes = texto(mapa.harness);
  return { ...(home ? { home } : {}), ...(arnes ? { arnes } : {}) };
}

/** Missing measurement is UNKNOWN, never the declared value: `/home/dev` fits almost every
 *  alias and would look right precisely on the one that breaks the rule. */
export function contrasteDeUbicacion(
  declarado: string | undefined,
  medido: string | undefined,
): ContrasteDeUbicacion {
  if (medido === undefined) {
    return declarado === undefined ? { estado: 'desconocido' } : { estado: 'desconocido', declarado };
  }
  if (declarado === undefined || declarado === medido) return { estado: 'medido', valor: medido };
  return { estado: 'discrepa', declarado, medido };
}
