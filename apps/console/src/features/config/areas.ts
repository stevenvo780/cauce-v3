import type { ConfigCollection } from './collections';

/**
 * En qué pestaña vive cada colección de configuración.
 *
 * `/config` era UN scroll con dieciséis paneles seguidos: el alta rápida, el wizard, el editor de
 * JSON crudo, doce tablas de colección y el audit trail, todo a la vez. Para cambiar una arista de
 * ACL había que pasar por delante del registro de agentes y del pool de cuentas. La queja del dueño
 * («pestañas, botones amigables, toggles, tooltips») es exactamente eso: la pantalla no está mal
 * *poblada*, está mal *ordenada*.
 *
 * Este mapa fija el ORDEN y el agrupamiento, NO el alcance. Igual que `collections.ts`, se deriva
 * del snapshot: una clave que el servidor publique mañana y que este mapa no conozca cae en «Otros»
 * y se sigue viendo. Un agrupador que se come lo que no reconoce es peor que no agrupar — repetiría
 * el defecto que `configCollections()` acaba de cerrar, donde seis claves hardcodeadas dejaban
 * invisibles a `chain_policies` y `egress_destinations`.
 */

export type ConfigAreaId =
  | 'espacios' | 'permisos' | 'roles' | 'agentes' | 'avisos' | 'historial' | 'otros';

export interface ConfigArea {
  id: ConfigAreaId;
  /** Lo que se lee en la pestaña. Lenguaje de negocio, no nombre de tabla. */
  label: string;
  /**
   * UNA frase de ~90 caracteres como mucho. Se pinta abierta bajo la pestaña activa.
   *
   * El tope no es estético. MEDIDO en Chrome: las siete descripciones eran de dos y tres frases y
   * ocupaban tres párrafos de prosa gris ANTES del primer control de la página. Quien entra veinte
   * veces al día ya sabe qué es la pantalla y los vuelve a saltar veinte veces, pagando el scroll
   * cada vez. `LARGO_DESCRIPCION` lo comprueba en `areas.test.ts`.
   */
  descripcion: string;
  /**
   * El resto, plegado en un `<details>` CERRADO. Plegado y no borrado: acá está lo que explica
   * por qué la pestaña importa —de dónde saca el enrutado la flota, que todo empieza denegado—, y
   * eso es la diferencia entre entender la pantalla y no entenderla. Lo que no hace falta es
   * releerlo en cada visita.
   */
  detalle: string;
}

/** El tope de la frase que se lee sin plegar. Ver `descripcion`. */
export const LARGO_DESCRIPCION = 90;

/**
 * El orden de las pestañas es el orden en que se monta una flota: primero el espacio (quién existe
 * y dónde habla), después quién puede hablarle a quién, después qué hace cada bot, y al final el
 * historial para deshacer. No es alfabético a propósito.
 */
export const CONFIG_AREAS: readonly ConfigArea[] = [
  {
    id: 'espacios',
    label: 'Espacios y miembros',
    descripcion: 'Los clientes, sus salas y quién está dentro de cada sala.',
    detalle: 'Es de acá de donde el enrutado saca la flota: un alias sin membership habilitada no '
      + 'recibe entregas, aunque esté en el registro de agentes.',
  },
  {
    id: 'permisos',
    label: 'Permisos',
    descripcion: 'Quién puede hablarle a quién entre clientes, y qué puede hacer cada rol.',
    detalle: 'Todo empieza denegado: lo que no esté acá, no pasa.',
  },
  {
    id: 'roles',
    label: 'Roles de agente',
    descripcion: 'El texto de identidad que cada bot recibe antes de su contrato.',
    detalle: 'Acá se ve qué roles hay en uso, quién lleva cada uno y cómo pasarle el mismo rol a '
      + 'otro agente.',
  },
  {
    id: 'agentes',
    label: 'Agentes y cuentas',
    descripcion: 'El registro de bots, con qué programa corre cada uno y a qué cuentas de IA llega.',
    detalle: 'Esto NO decide a quién se le entrega: eso son las membresías, en «Espacios y '
      + 'miembros».',
  },
  {
    id: 'avisos',
    label: 'Avisos y cadena',
    descripcion: 'Qué ve un bot de la cadena que él disparó y a qué humanos puede escribirle.',
    detalle: 'Un aviso proactivo es un mensaje que nadie pidió: por eso cada destino declara a qué '
      + 'conversación va, cada cuánto y cuántas veces por día.',
  },
  {
    id: 'historial',
    label: 'Historial y JSON',
    descripcion: 'Cada cambio queda con su inversa: acá se deshace.',
    detalle: 'Y acá está la válvula de escape, el editor de mutación cruda, para lo que ninguna '
      + 'pestaña sepa hacer todavía.',
  },
  {
    id: 'otros',
    label: 'Otros',
    descripcion: 'Colecciones que este gateway publica y esta consola no sabe presentar todavía.',
    detalle: 'Se muestran igual, en crudo: esconder un dato que el servidor manda sería mentir '
      + 'sobre lo que hay configurado.',
  },
];

const AREA_POR_COLECCION: Record<string, ConfigAreaId> = {
  tenants: 'espacios',
  rooms: 'espacios',
  memberships: 'espacios',
  acl_edges: 'permisos',
  role_policies: 'permisos',
  agents: 'agentes',
  harness_definitions: 'agentes',
  provider_accounts: 'agentes',
  alias_routing_ceiling: 'agentes',
  agent_account_bindings: 'agentes',
  chain_policies: 'avisos',
  egress_destinations: 'avisos',
};

/** La pestaña que se abre al entrar. La primera pregunta de un operador es «quién hay». */
export const AREA_POR_DEFECTO: ConfigAreaId = 'espacios';

export function areaDeColeccion(key: string): ConfigAreaId {
  // `Object.hasOwn` y no `?.`: una colección del servidor llamada `toString` heredaría un valor del
  // prototipo y acabaría clasificada en una pestaña que no existe.
  return Object.hasOwn(AREA_POR_COLECCION, key) ? AREA_POR_COLECCION[key] : 'otros';
}

export interface AreaConColecciones {
  area: ConfigArea;
  colecciones: ConfigCollection[];
}

/**
 * Las pestañas a pintar, en orden, con lo que va dentro de cada una.
 *
 * «Roles» e «Historial» salen siempre aunque no tengan colecciones asignadas: su contenido no es
 * una tabla del snapshot. «Otros» sale SÓLO si el servidor publicó algo que no sabemos clasificar —
 * una pestaña vacía y permanente enseña a ignorarla, y el día que aparezca una colección nueva
 * nadie la va a mirar.
 */
export function agruparPorArea(colecciones: readonly ConfigCollection[]): AreaConColecciones[] {
  const porArea = new Map<ConfigAreaId, ConfigCollection[]>();
  for (const coleccion of colecciones) {
    const id = areaDeColeccion(coleccion.key);
    const lista = porArea.get(id);
    if (lista) lista.push(coleccion);
    else porArea.set(id, [coleccion]);
  }
  return CONFIG_AREAS
    .filter((area) => area.id !== 'otros' || (porArea.get('otros')?.length ?? 0) > 0)
    .map((area) => ({ area, colecciones: porArea.get(area.id) ?? [] }));
}
