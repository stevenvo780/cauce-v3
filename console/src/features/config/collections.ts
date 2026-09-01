import type { ConfigurationSnapshot } from '../../api/types';

/**
 * The collections of `GET /v3/console/config` (packages/store/src/configuration.ts), with the
 * title the console gives them. The map fixes order and translation; dedicated typed keys are
 * excluded, while a new server key is still published with its own name as title.
 *
 * The effective-data panel had six hardcoded entries while the snapshot carried more; deriving
 * from it keeps new general collections visible without duplicating the account registry owned
 * by Cuentas y cuotas.
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

/** Snapshot keys rendered by their dedicated typed views. */
const NON_COLLECTION_KEYS = new Set([
  'revision', 'observed_at', 'revisions', 'agent_profiles',
  'provider_accounts', 'alias_routing_ceiling', 'agent_account_bindings',
]);

export interface ConfigCollection {
  key: string;
  title: string;
  /**
   * `undefined` means the gateway did NOT publish the key — data unavailable, which is not the
   * same as `[]` (zero known rows). A gateway from before a migration does not publish its
   * table, and saying "no records" there would be lying.
   */
  rows?: Record<string, unknown>[];
}

export function configCollections(snapshot: ConfigurationSnapshot | undefined): ConfigCollection[] {
  if (!snapshot) return [];
  const record = snapshot as Record<string, unknown>;
  const known = Object.keys(COLLECTION_TITLES).filter((key) => !NON_COLLECTION_KEYS.has(key));
  // `Object.hasOwn` rather than `in`: a server key named `toString` would inherit the prototype
  // title and a function would render as the panel name.
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
