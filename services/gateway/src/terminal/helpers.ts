import type { Tenant } from '@cauce/protocol';
import type { GatewayRepository } from '../app.js';
import type { Principal } from '../auth.js';
import { fleetIdentityLabel, type containerCohort } from './authority.js';
import type { TerminalSessionRow } from './types.js';

/**
 * The canonical cross-tenant authorizer, derived from the gateway contract so no caller in this
 * plane restates the predicate.
 */
export type AgentTargetRepository = Required<Pick<GatewayRepository, 'authorizeAgentTarget'>>;

/**
 * Deriving `assertPermission` from the gateway contract would widen `permission` to the whole
 * union and let this plane assert one it must never assert, so the literal stays hand written.
 */
export interface TerminalControlRepository extends AgentTargetRepository {
  assertPermission(tenantId: Tenant, alias: string, permission: 'control'): Promise<void>;
}

export type FleetCohort = ReturnType<typeof containerCohort>;

export function exactObjectKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

export function boundedInteger(value: unknown, min: number, max: number, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${String(min)} and ${String(max)}`);
  }
  return value;
}

export function cohortLabels(cohort: FleetCohort): string[] {
  return cohort.map(fleetIdentityLabel);
}

export function sessionExpiry(row: TerminalSessionRow, sessionTtlSeconds: number): Date | undefined {
  if (row.consumed_at === null) return undefined;
  return new Date(row.consumed_at.getTime() + sessionTtlSeconds * 1_000);
}

export function subjectFor(actor: Pick<Principal, 'tenant_id' | 'alias'>): string {
  return `${actor.tenant_id}:${actor.alias}`;
}

export function operatorScopePredicate(
  operatorParameter: number,
  attributedParameter: number,
  subjectParameter: number,
): string {
  return `operator_id=$${String(operatorParameter)}
          AND ($${String(attributedParameter)}::boolean OR console_subject=$${String(subjectParameter)})`;
}
