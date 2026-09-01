import type { ConfigCollection } from './collections';

/**
 * Organization and grouping of configuration collections into tabs.
 */

export type ConfigAreaId =
  | 'espacios' | 'permisos' | 'agentes' | 'avisos' | 'historial' | 'otros';

export interface ConfigArea {
  id: ConfigAreaId;
  /** What is read on the tab. Business language, not a table name. */
  label: string;
  /** Sentence of ~90 characters visible under the active tab. */
  descripcion: string;
  /**
   * The rest, folded into a CLOSED `<details>`. Folded, not deleted: here is what explains why
   * the tab matters —where the fleet's routing comes from, that everything starts denied—, and
   * that is the difference between understanding the screen and not understanding it. What
   * isn't needed is re-reading it on every visit.
   */
  detalle: string;
}

/**
 * The order of the tabs is the order in which a fleet is set up: first the space (who exists
 * and where it speaks), then who can speak to whom, then what each bot does, and finally the
 * history to undo. It's not alphabetical on purpose.
 */
export const CONFIG_AREAS: readonly ConfigArea[] = [
  {
    id: 'espacios',
    label: 'Espacios y miembros',
    descripcion: 'Los clientes, sus salas y quién está dentro de cada sala.',
    detalle: 'Es de acá de donde el enrutado saca la flota: un alias sin membership habilitada no '
      + 'recibe entregas, aunque esté en el registro de agentes. El «Rol de permisos» de una '
      + 'membership selecciona una role_policy; no es el contexto ni el rol declarado del agente.',
  },
  {
    id: 'permisos',
    label: 'Permisos',
    descripcion: 'Quién puede hablarle a quién entre clientes, y qué puede hacer cada rol.',
    detalle: 'Todo empieza denegado: lo que no esté acá, no pasa.',
  },
  {
    id: 'agentes',
    label: 'Agentes y cuentas',
    descripcion: 'El registro de bots declarados y a qué cuentas de IA llega cada uno.',
    detalle: 'Es un registro declarado, no un mando: el programa que corre cada bot sale del '
      + 'binario en ejecución y no de la columna «Harness». Y esto NO decide a quién se le entrega: '
      + 'eso son las membresías, en «Espacios y miembros».',
  },
  {
    id: 'avisos',
    label: 'Avisos y cadena',
    descripcion: 'Qué ve un bot de la cadena que él disparó y a qué humanos puede escribirle.',
    detalle: 'Un aviso proactivo es un mensaje que nadie pidió: por eso cada destino declara a qué '
      + 'conversación va, cada cuánto y cuántas veces por día. Acá están también los cinco topes de '
      + 'delegación que el servidor aplica de verdad —abanico por turno, repeticiones de arista, '
      + 'delegaciones por raíz— y la compuerta humana. Se deshacen desde Historial como todo lo demás.',
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

/** The tab that opens on entry. An operator's first question is "who's there". */
export const AREA_POR_DEFECTO: ConfigAreaId = 'espacios';

export function areaDeColeccion(key: string): ConfigAreaId {
  // `Object.hasOwn` and not `?.`: a server collection named `toString` would inherit a value from
  // the prototype and end up classified into a tab that doesn't exist.
  return Object.hasOwn(AREA_POR_COLECCION, key) ? AREA_POR_COLECCION[key] : 'otros';
}

interface AreaConColecciones {
  area: ConfigArea;
  colecciones: ConfigCollection[];
}

/**
 * The tabs to render, in order, with what goes inside each one.
 *
 * "Historial" is always shown even when it has no collections assigned: its content is not a
 * table from the snapshot. "Otros" is shown ONLY if the server published something we don't
 * know how to classify — an empty permanent tab teaches you to ignore it, and the day a new
 * collection shows up nobody will look at it.
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
