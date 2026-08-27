import type { ConfigurationSnapshot } from '../../api/types';

/**
 * LO QUE 
 *
 * El encargo eran cuatro cosas: la directiva, el `CLAUDE.md`, las herramientas y los prompts. Las
 * dos primeras tienen sitio en esta pestaña —la primera se edita, la segunda tiene su hueco
 * rotulado esperando al endpoint—. Las otras dos no, y este módulo es la razón por la que se
 * DICEN en pantalla en vez de faltar en silencio.
 *
 * Un hueco rotulado y un hueco a secas no son lo mismo. Sin esto, un operador que abre la pestaña
 * y no ve «herramientas» concluye una de dos cosas, las dos falsas: que se olvidó, o que este
 * agente no tiene herramientas configuradas. Con esto sabe que existe, dónde vive y qué falta para
 * llegar. La regla es la misma que gobierna el resto de la consola: no afirmar lo que no se midió,
 * y no callar lo que sí.
 *
 * Y la razón de fondo para NO haberlo construido a medias: en las dos capas de abajo, el sitio
 * donde vive el dato todavía no está decidido. Una pantalla que escriba en un fichero que nadie
 * lee es peor que no tener pantalla —parece que funcionó—.
 */

export interface CapaPendiente {
  id: string;
  titulo: string;
  /** Qué preguntó Steven, en sus términos. */
  pedido: string;
  /** Por qué hoy no se puede, dicho sin tecnicismos y sin excusas. */
  porQueNo: string;
  /** Qué haría falta para que esto tuviera editor. Concreto, no «hace falta trabajo». */
  queFalta: string;
}

export const CAPAS_PENDIENTES: CapaPendiente[] = [
  {
    id: 'herramientas',
    titulo: 'Herramientas · qué puede usar y qué no',
    pedido: 'Ver y cambiar qué herramientas, MCP y skills tiene permitidos cada agente.',
    porQueNo:
      'Cauce no guarda esto en ningún sitio. El permiso está repartido entre el settings.json de '
      + 'dentro del contenedor, las allowlist de managed-settings y la configuración de cada arnés '
      + '—y ninguno de los tres vive en la base ni lo publica el gateway—. No hay una fuente que '
      + 'mandar sobre las otras, así que no hay nada que un editor pueda escribir con efecto.',
    queFalta:
      'Decidir primero cuál de los tres sitios manda. Y hay un escollo medido: en los alias '
      + 'openclaw, las herramientas y las credenciales están en el MISMO fichero, así que servirlo '
      + 'entero al navegador sería una fuga; habría que publicar sólo la parte de herramientas.',
  },
  {
    id: 'prompts',
    titulo: 'Prompts · falta acordar qué son',
    pedido: 'Editar «los prompts» del agente desde la web.',
    porQueNo:
      'Hoy la palabra puede señalar dos cosas distintas y sólo una es alcanzable. Si son el '
      + 'preámbulo que el adaptador arma en cada entrega, eso lo genera el código y no es editable '
      + 'desde ningún sitio. Si son plantillas de rol reutilizables, la tabla ya existe y está '
      + 'VACÍA: cero plantillas creadas, comprobado el 23 de agosto de 2026.',
    queFalta:
      'Una respuesta de Steven sobre cuál de las dos quiso. Con la segunda, el editor sale casi '
      + 'gratis: el catálogo de plantillas ya se lee y ya se puede aplicar a un alias.',
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
