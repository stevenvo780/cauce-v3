import type { DatabaseClient } from '../db.js';
import { ConfigurationError, type ConfigurationCapabilities, type ConfigurationDependency, type ConfigurationLeafMutation, type ConfigurationResourceCapability } from './contracts.js';

export function has(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/** alias_routing_ceiling has no mutable value: it is granted or revoked. */
type ValuedConfigMutation = Exclude<ConfigurationLeafMutation, { resource: 'alias_routing_ceiling' }>;

export function valueRequired(mutation: ValuedConfigMutation): Record<string, unknown> {
  if (mutation.action === 'delete') return {};
  if (!mutation.value) throw new ConfigurationError('conflict', `${mutation.resource} ${mutation.action} requires value`);
  return mutation.value;
}

export function databaseError(error: unknown): never {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (['23503', '23505', '23514', '23P01'].includes(code)) {
    throw new ConfigurationError('conflict', 'configuration change violates a durable constraint');
  }
  throw error;
}

/** Reject generic mutations whose runtime projection cannot be synchronously acknowledged. */
export function assertRuntimeSynchronizedMutation(mutation: unknown): void {
  if (mutation === null || typeof mutation !== 'object' || Array.isArray(mutation)) return;
  const record = mutation as Record<string, unknown>;
  if (record.resource === 'batch' && Array.isArray(record.mutations)) {
    for (const mutation of record.mutations) assertRuntimeSynchronizedMutation(mutation);
    return;
  }
  if (record.resource === 'agent_profile') {
    throw new ConfigurationError(
      'invalid_input',
      'agent_profile is only writable through the canonical profile endpoint with runtime ACK',
    );
  }
  if (record.resource !== 'agent') return;
  const value = record.value;
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && has(value, 'role_brief')) {
    throw new ConfigurationError(
      'invalid_input',
      'agent role_brief is a read-only legacy projection; write the canonical profile instead',
    );
  }
}

export function configurationCapabilities(
  tenant: string, alias: string, hub: boolean, control: boolean,
): ConfigurationCapabilities {
  const resources = [
    'tenant', 'room', 'membership', 'acl_edge', 'harness', 'role_policy', 'chain_policy',
    'egress_destination', 'agent', 'provider_account', 'alias_routing_ceiling',
    'agent_account_binding', 'agent_profile',
  ] as const;
  return {
    actor: { tenant_id: tenant, alias, is_hub: hub, can_control: control },
    resources: resources.map((resource): ConfigurationResourceCapability => {
      const owned = ['room', 'membership', 'egress_destination', 'acl_edge'].includes(resource);
      if (!control || resource === 'agent_profile' || (!hub && !owned)) {
        return { resource, actions: [], scope: 'none' };
      }
      const actions: ConfigurationResourceCapability['actions'] = resource === 'chain_policy' ? ['update']
        : resource === 'alias_routing_ceiling' ? ['create', 'delete']
          : ['tenant', 'room', 'membership'].includes(resource)
            ? ['create', 'update', 'delete', 'retire', 'restore'] : ['create', 'update', 'delete'];
      return hub ? { resource, actions, scope: 'hub' }
        : { resource, actions, scope: resource === 'acl_edge' ? 'outgoing_acl' : 'tenant', tenant_id: tenant };
    }),
  };
}

const dependencyTables: Readonly<Record<ConfigurationLeafMutation['resource'], string>> = {
  tenant: 'tenants', room: 'rooms', membership: 'memberships', acl_edge: 'acl_edges',
  harness: 'harness_definitions', role_policy: 'role_policies', chain_policy: 'agent_chain_policies',
  egress_destination: 'egress_destinations', agent: 'agents', provider_account: 'provider_accounts',
  alias_routing_ceiling: 'alias_routing_ceiling', agent_account_binding: 'agent_account_bindings',
};

const identityKeys = new Set([
  'id', 'tenant_id', 'room_id', 'alias', 'agent_alias', 'actor_alias', 'recipient_tenant',
  'recipient_alias', 'from_tenant', 'from_alias', 'to_tenant', 'to_alias', 'account_id',
  'payer_tenant_id', 'account_payer_tenant', 'created_by_tenant', 'role', 'handle', 'human_id',
  'key_id', 'message_id', 'delivery_id', 'kind', 'sha256', 'owner_tenant_id',
]);

export function configurationIdentity(mutation: ConfigurationLeafMutation): Record<string, string> {
  return Object.fromEntries(Object.entries(mutation)
    .filter(([key, value]) => identityKeys.has(key) && typeof value === 'string'));
}

function quotedIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]*$/u.test(value)) throw new Error('invalid configuration dependency identifier');
  return `"${value}"`;
}

interface ReferenceDefinition {
  table_name: string;
  columns: string[];
  target_columns: string[];
  identity_columns: string[];
}

function safeIdentity(value: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(value).filter(([key, field]) =>
    identityKeys.has(key) && (typeof field === 'string' || typeof field === 'number'))
    .map(([key, field]) => [key, String(field)]));
}

export async function configurationDependencies(
  client: DatabaseClient, mutation: ConfigurationLeafMutation,
): Promise<ConfigurationDependency[]> {
  const identity = configurationIdentity(mutation);
  const selected = await client.query<ReferenceDefinition>(
    `SELECT source.relname AS table_name,
            array_agg(source_attribute.attname::text ORDER BY paired.ordinality) AS columns,
            array_agg(target_attribute.attname::text ORDER BY paired.ordinality) AS target_columns,
            COALESCE((SELECT array_agg(attribute.attname::text ORDER BY keys.ordinality)
              FROM pg_constraint primary_key
              CROSS JOIN LATERAL unnest(primary_key.conkey) WITH ORDINALITY keys(attnum,ordinality)
              JOIN pg_attribute attribute ON attribute.attrelid=primary_key.conrelid AND attribute.attnum=keys.attnum
              WHERE primary_key.conrelid=reference.conrelid AND primary_key.contype='p'), ARRAY[]::text[]) AS identity_columns
     FROM pg_constraint reference
     JOIN pg_class source ON source.oid=reference.conrelid
     JOIN pg_namespace namespace ON namespace.oid=source.relnamespace
     CROSS JOIN LATERAL unnest(reference.conkey,reference.confkey) WITH ORDINALITY paired(source_key,target_key,ordinality)
     JOIN pg_attribute source_attribute ON source_attribute.attrelid=reference.conrelid AND source_attribute.attnum=paired.source_key
     JOIN pg_attribute target_attribute ON target_attribute.attrelid=reference.confrelid AND target_attribute.attnum=paired.target_key
     WHERE reference.contype='f' AND reference.confrelid=to_regclass($1) AND namespace.nspname=current_schema()
     GROUP BY reference.oid,reference.conrelid,source.relname ORDER BY source.relname,reference.oid`,
    [dependencyTables[mutation.resource]],
  );
  const references = [...selected.rows];
  if (mutation.resource === 'agent' || mutation.resource === 'tenant') {
    const pairs = [
      ['tenant_id', 'alias'], ['tenant_id', 'agent_alias'], ['tenant_id', 'actor_alias'],
      ['actor_tenant', 'actor_alias'], ['recipient_tenant', 'recipient_alias'],
      ['source_tenant', 'source_alias'], ['target_tenant', 'target_alias'],
      ['parent_tenant', 'parent_alias'], ['child_tenant', 'child_alias'],
      ['collector_tenant', 'collector_alias'], ['from_tenant', 'from_alias'], ['to_tenant', 'to_alias'],
      ['tenant_id', 'asked_by_alias'], ['tenant_id', 'bridge_alias'], ['tenant_id', 'created_by'],
      ['source_tenant_id', 'source_alias'], ['target_tenant_id', 'target_alias'],
    ];
    const tenantColumns = [...new Set(pairs.map((pair) => pair[0]))].concat([
      'payer_tenant_id', 'account_payer_tenant', 'created_by_tenant', 'owner_tenant_id',
      'initiating_tenant_id', 'message_tenant_id',
    ]);
    const patterns = mutation.resource === 'tenant'
      ? tenantColumns.map((column) => ({ columns: [column], target_columns: ['id'] }))
      : pairs.map((columns) => ({ columns, target_columns: ['tenant_id', 'alias'] }));
    const implicit = await client.query<ReferenceDefinition>(
      `SELECT source.relname AS table_name,pattern.columns,pattern.target_columns,
         COALESCE((SELECT array_agg(attribute.attname::text ORDER BY keys.ordinality)
           FROM pg_constraint primary_key
           CROSS JOIN LATERAL unnest(primary_key.conkey) WITH ORDINALITY keys(attnum,ordinality)
           JOIN pg_attribute attribute ON attribute.attrelid=primary_key.conrelid AND attribute.attnum=keys.attnum
           WHERE primary_key.conrelid=source.oid AND primary_key.contype='p'), ARRAY[]::text[]) AS identity_columns
       FROM pg_class source JOIN pg_namespace namespace ON namespace.oid=source.relnamespace
       CROSS JOIN jsonb_to_recordset($1::jsonb) AS pattern(columns text[],target_columns text[])
       WHERE namespace.nspname=current_schema() AND source.relkind IN ('r','p') AND source.relname<>$2
         AND NOT EXISTS(SELECT 1 FROM unnest(pattern.columns) expected(column_name)
           WHERE NOT EXISTS(SELECT 1 FROM pg_attribute attribute
             WHERE attribute.attrelid=source.oid AND attribute.attname=expected.column_name AND NOT attribute.attisdropped))
       ORDER BY source.relname`, [JSON.stringify(patterns), dependencyTables[mutation.resource]],
    );
    references.push(...implicit.rows);
  }
  if (mutation.resource === 'membership') {
    references.push({ table_name: 'deliveries', columns: ['recipient_tenant', 'recipient_alias'], target_columns: ['tenant_id', 'alias'], identity_columns: ['id', 'recipient_tenant', 'recipient_alias'] });
    references.push({ table_name: 'connection_leases', columns: ['tenant_id', 'alias'], target_columns: ['tenant_id', 'alias'], identity_columns: ['tenant_id', 'alias'] });
  }
  const dependencies: ConfigurationDependency[] = [];
  for (const reference of references) {
    const restorableBinding = mutation.resource === 'alias_routing_ceiling' && reference.table_name === 'agent_account_bindings';
    const matchedColumns = reference.columns.map((column, index) => ({ column, target: reference.target_columns[index] }))
      .filter((pair): pair is { column: string; target: string } => pair.target !== undefined && identity[pair.target] !== undefined);
    if (matchedColumns.length === 0) continue;
    const columns = reference.identity_columns.filter((column) => identityKeys.has(column));
    const projection = columns.length === 0 ? `'{}'::jsonb`
      : `jsonb_build_object(${columns.map((column) => `'${column}',${quotedIdentifier(column)}::text`).join(',')})`;
    const predicate = matchedColumns.map((pair, index) => `${quotedIdentifier(pair.column)}=$${String(index + 1)}`).join(' AND ');
    const rows = await client.query<{ dependency_identity: Record<string, unknown> }>(
      `SELECT ${projection} AS dependency_identity FROM ${quotedIdentifier(reference.table_name)} WHERE ${predicate} LIMIT 101`,
      matchedColumns.map((pair) => identity[pair.target]),
    );
    for (const row of rows.rows) {
      const item: ConfigurationDependency = { type: reference.table_name, identity: safeIdentity(row.dependency_identity), blocking: !restorableBinding };
      if (!dependencies.some((existing) => existing.type === item.type && JSON.stringify(existing.identity) === JSON.stringify(item.identity))) dependencies.push(item);
    }
  }
  return dependencies;
}

export async function assertConfigurationDeleteAllowed(client: DatabaseClient, mutation: ConfigurationLeafMutation): Promise<void> {
  const dependencies = await configurationDependencies(client, mutation);
  if (dependencies.some((dependency) => dependency.blocking)) throw new ConfigurationError('conflict', 'configuration resource has durable dependencies', dependencies);
}
