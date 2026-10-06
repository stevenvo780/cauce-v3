import type { ConfigCollection } from './collections';

/**
 * The information architecture of Ajustes: a section per question the operator comes with.
 * Collections are assigned to a section by key; a key the console does not know falls under
 * "Avanzado", shown raw, instead of staying invisible behind an allowlist.
 */

export type ConfigSectionId = 'general' | 'espacios' | 'agentes' | 'arneses' | 'acceso' | 'avanzado';

export interface ConfigSection {
  id: ConfigSectionId;
  label: string;
  /** What the section is for: one sentence, read on entry. */
  proposito: string;
  /** Folded under «¿Qué es esto?»: why the section matters and what it does NOT decide. */
  detalle: string;
}

/** Ordered the way a fleet is set up: overview, who exists, which agents, how they run, who may talk, the escape hatch. */
export const CONFIG_SECTIONS: readonly ConfigSection[] = [
  {
    id: 'general',
    label: 'General',
    proposito: 'El estado de la configuración y las políticas de cadena que valen para toda la flota.',
    detalle: 'Un aviso proactivo o una cadena de delegaciones es un mensaje que nadie pidió: por eso estas '
      + 'políticas ponen los topes que el servidor aplica de verdad (abanico por turno, repeticiones de arista, '
      + 'delegaciones por raíz) y la compuerta humana. Todo cambio se deshace desde «Avanzado».',
  },
  {
    id: 'espacios',
    label: 'Espacios y salas',
    proposito: 'Los clientes, sus salas y quién está dentro de cada una.',
    detalle: 'De acá sale el enrutado de la flota: un alias sin membresía habilitada no recibe entregas, aunque '
      + 'esté en el registro de agentes. El «Rol de permisos» de una membresía elige una política por rol; no es '
      + 'el contexto ni el rol declarado del agente.',
  },
  {
    id: 'agentes',
    label: 'Agentes',
    proposito: 'El registro de agentes: identidad, arnés declarado y estado; su contexto vive en su propia página.',
    detalle: 'Es un registro declarado, no un mando: el programa que corre cada agente sale del binario en '
      + 'ejecución y no de la columna «Arnés». Y esto no decide a quién se le entrega: eso son las membresías, '
      + 'en «Espacios y salas».',
  },
  {
    id: 'arneses',
    label: 'Arneses',
    proposito: 'Qué lee de verdad cada arnés y las definiciones de arnés registradas.',
    detalle: 'Contexto declarado, capacidades del runtime y permisos no son lo mismo. Las definiciones de arnés '
      + 'son un catálogo declarado; el arnés en ejecución se mide dentro del contenedor.',
  },
  {
    id: 'acceso',
    label: 'Acceso y roles',
    proposito: 'Quién puede hablarle a quién entre clientes, qué puede hacer cada rol y a qué humanos se avisa.',
    detalle: 'Todo empieza denegado: lo que no esté acá, no pasa. Cada destino de aviso declara a qué conversación '
      + 'va, cada cuánto y cuántas veces por día.',
  },
  {
    id: 'avanzado',
    label: 'Avanzado',
    proposito: 'Historial de revisiones con rollback, editor de mutaciones JSON y colecciones sin vista propia.',
    detalle: 'Cada cambio queda con su inversa y una revisión esperada (control de concurrencia optimista). Acá '
      + 'está la válvula de escape para lo que ninguna sección sabe hacer todavía.',
  },
];

const SECCION_POR_COLECCION: Record<string, ConfigSectionId> = {
  chain_policies: 'general',
  tenants: 'espacios',
  rooms: 'espacios',
  memberships: 'espacios',
  agents: 'agentes',
  harness_definitions: 'arneses',
  acl_edges: 'acceso',
  role_policies: 'acceso',
  egress_destinations: 'acceso',
};

export const SECCION_POR_DEFECTO: ConfigSectionId = 'general';

export function seccionDeColeccion(key: string): ConfigSectionId {
  // `Object.hasOwn`, not `?.`: a server key named `toString` would inherit a value from the prototype.
  return Object.hasOwn(SECCION_POR_COLECCION, key) ? SECCION_POR_COLECCION[key] : 'avanzado';
}

export function coleccionesDe(seccion: ConfigSectionId, colecciones: readonly ConfigCollection[]): ConfigCollection[] {
  return colecciones.filter((coleccion) => seccionDeColeccion(coleccion.key) === seccion);
}
