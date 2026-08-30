import type { ConfigurationSnapshot } from '../../api/types';

/**
 * Information about pending agent configuration layers awaiting integration.
 */

interface CapaPendiente {
  id: string;
  titulo: string;
  pedido: string;
  porQueNo: string;
  queFalta: string;
}

export const CAPAS_PENDIENTES: CapaPendiente[] = [
  {
    id: 'herramientas',
    titulo: 'Herramientas · qué puede usar y qué no',
    pedido: 'Ver y cambiar qué herramientas, MCP y skills tiene permitidos cada agente.',
    porQueNo:
      'Cauce no guarda esto en un punto único: está repartido entre settings.json en el contenedor, '
      + 'allowlist de managed-settings y la configuración de cada arnés. Ninguno se almacena en el '
      + 'store central ni se expone con autoridad en el gateway.',
    queFalta:
      'Definir la fuente canónica para herramientas y separar de forma segura la exposición de '
      + 'herramientas respecto a credenciales o secretos en configuraciones compartidas.',
  },
  {
    id: 'prompts',
    titulo: 'Prompts · falta acordar qué son',
    pedido: 'Editar «los prompts» del agente desde la web.',
    porQueNo:
      'El concepto abarca dos implementaciones: preámbulos generados por el adapter en cada entrega '
      + '(no editables) o plantillas de rol reutilizables (catálogo persistido en el store).',
    queFalta:
      'Definir si la edición aplica a plantillas de rol reutilizables o directivas dinámicas.',
  },
];

/** Where an alias's configuration really lives, according to what the registry DECLARES. */
export interface UbicacionDeclarada {
  contenedor?: string;
  home?: string;
}

/**
 * The container and `$HOME` that the registry declares for an alias.
 *
 * It comes from the configuration snapshot this tab ALREADY reads, so it does not cost a single
 * extra request. It makes the gap actionable: "cannot be edited from here" is a complaint, and
 * "cannot be edited from here, and lives at ws-kant:/home/dev" is an instruction.
 *
 * Returns the keys only if they are present: a missing `home_directory` is UNKNOWN, and filling it
 * with a plausible default —`/home/dev`, which fits almost all of them— would send someone to look
 * at the wrong file precisely on the alias that breaks the rule.
 */
export function ubicacionDeclarada(
  snapshot: ConfigurationSnapshot | undefined,
  tenantId: string,
  alias: string,
): UbicacionDeclarada {
  const agents = snapshot?.agents;
  if (!Array.isArray(agents)) return {};
  const fila = agents.find((row) => row.tenant_id === tenantId && row.alias === alias);
  if (!fila) return {};
  const contenedor = typeof fila.container_name === 'string' ? fila.container_name : undefined;
  const home = typeof fila.home_directory === 'string' ? fila.home_directory : undefined;
  return { ...(contenedor ? { contenedor } : {}), ...(home ? { home } : {}) };
}
