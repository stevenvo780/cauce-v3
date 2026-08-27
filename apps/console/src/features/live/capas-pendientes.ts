import type { ConfigurationSnapshot } from '../../api/types';

/**
 * Información sobre capas de configuración de agentes pendientes de integración.
 */

export interface CapaPendiente {
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

/** Dónde vive de verdad la configuración de un alias, según lo que el registro DECLARA. */
export interface UbicacionDeclarada {
  contenedor?: string;
  home?: string;
}

/**
 * El contenedor y el `$HOME` que el registro declara para un alias.
 *
 * Sale del snapshot de configuración que esta pestaña YA lee, así que no cuesta ni una petición
 * más. Sirve para que el hueco sea accionable: «no se puede editar desde acá» es una queja, y
 * «no se puede editar desde acá, y vive en ws-kant:/home/dev» es una instrucción.
 *
 * Devuelve las claves sólo si están: un `home_directory` ausente es UNKNOWN, y rellenarlo con un
 * valor por defecto plausible —`/home/dev`, que es el de casi todos— mandaría a alguien a mirar el
 * fichero equivocado justamente en el alias que se sale de la norma.
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
