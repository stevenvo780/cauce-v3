import type { ConfigurationSnapshot } from '../../api/types';

/**
 * Las colecciones de `GET /v3/console/config` (packages/store/src/configuration.ts), con el título
 * que la consola les da. El mapa fija el ORDEN y la traducción, no el alcance: una clave que el
 * servidor agregue mañana igual se publica, con su propio nombre como título.
 *
 * El panel de datos efectivos tenía seis entradas hardcodeadas mientras el snapshot ya traía doce,
 * así que `chain_policies` y `egress_destinations` quedaban invisibles pese a existir en el
 * servidor y ser deshacibles desde el audit trail. Derivar del snapshot cierra esa clase de bug.
 */
const COLLECTION_TITLES: Record<string, string> = {
  tenants: 'Tenants',
  rooms: 'Rooms',
  memberships: 'Memberships / agents',
  acl_edges: 'Directed ACL',
  harness_definitions: 'Harness definitions',
  role_policies: 'Route/read/control policies',
  chain_policies: 'Chain visibility policy',
  egress_destinations: 'Proactive egress allowlist',
  agents: 'Agent registry',
  provider_accounts: 'Provider accounts',
  alias_routing_ceiling: 'Alias routing ceiling',
  agent_account_bindings: 'Agent ↔ account bindings',
};

/** Claves del snapshot que no son colecciones de configuración: tienen su propio render. */
const NON_COLLECTION_KEYS = new Set(['revision', 'observed_at', 'revisions']);

export interface ConfigCollection {
  key: string;
  title: string;
  /**
   * `undefined` significa que el gateway NO publicó la clave — dato no disponible, que no es lo
   * mismo que `[]` (cero filas conocidas). Un gateway anterior a una migración no publica su
   * tabla, y decir "sin registros" ahí sería mentir.
   */
  rows?: Record<string, unknown>[];
}

export function configCollections(snapshot: ConfigurationSnapshot | undefined): ConfigCollection[] {
  if (!snapshot) return [];
  const record = snapshot as Record<string, unknown>;
  const known = Object.keys(COLLECTION_TITLES);
  // `Object.hasOwn` y no `in`: una clave del servidor llamada `toString` heredaría el título del
  // prototipo y se renderizaría una función como nombre de panel.
  const extra = Object.keys(record).filter((key) =>
    !NON_COLLECTION_KEYS.has(key) && !Object.hasOwn(COLLECTION_TITLES, key) && Array.isArray(record[key]));
  return [...known, ...extra].map((key) => {
    const rows = record[key];
    return {
      key,
      title: Object.hasOwn(COLLECTION_TITLES, key) ? COLLECTION_TITLES[key] : key,
      ...(Array.isArray(rows) ? { rows: rows as Record<string, unknown>[] } : {}),
    };
  });
}
