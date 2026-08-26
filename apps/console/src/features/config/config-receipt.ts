import type { ConfigMutation, ConfigurationChangeResult } from '../../api/types';

const RESOURCES = new Set([
  'tenant', 'room', 'membership', 'acl_edge', 'harness', 'role_policy',
  'chain_policy', 'egress_destination', 'agent', 'provider_account',
  'alias_routing_ceiling', 'agent_account_binding',
]);
const ACTIONS = new Set(['create', 'update', 'delete']);

function mutation(value: unknown): value is ConfigMutation {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.resource === 'string' && RESOURCES.has(row.resource)
    && typeof row.action === 'string' && ACTIONS.has(row.action);
}

function canonical(value: unknown): string | undefined {
  try {
    const normalized = (entry: unknown): unknown => {
      if (Array.isArray(entry)) return entry.map(normalized);
      if (entry !== null && typeof entry === 'object') {
        return Object.fromEntries(Object.entries(entry as Record<string, unknown>)
          .filter(([, child]) => child !== undefined)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, normalized(child)]));
      }
      return entry;
    };
    return JSON.stringify(normalized(value));
  } catch {
    return undefined;
  }
}

/** A 2xx is credited only when its receipt proves the requested mutation and rollback inverse. */
export function exactConfigurationReceipt(
  result: ConfigurationChangeResult,
  dryRun: boolean,
  expectedMutation?: ConfigMutation,
  expectedRolledBackRevisionId: number | null = null,
): boolean {
  const minimumRevision = dryRun ? 0 : 1;
  return result.applied === !dryRun
    && result.dry_run === dryRun
    && Number.isSafeInteger(result.revision)
    && Number(result.revision) >= minimumRevision
    && result.rolled_back_revision_id === expectedRolledBackRevisionId
    && typeof result.summary === 'string'
    && result.summary.length >= 1
    && result.summary.length <= 2_000
    && mutation(result.mutation)
    && mutation(result.inverse_mutation)
    && (expectedMutation === undefined
      || canonical(result.mutation) === canonical(expectedMutation));
}
