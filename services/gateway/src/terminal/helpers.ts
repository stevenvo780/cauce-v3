import { terminalSessionWindowExpression } from '@cauce/store';
import type { Tenant } from '@cauce/protocol';
import type { GatewayRepository } from '../app.js';
import type { Principal } from '../auth.js';
import { fleetIdentityLabel, type containerCohort, type ResolvedOperator } from './authority.js';
import type { TerminalConfig } from './config.js';
import { ticketSha256 } from './tickets.js';
import { isWritableMode, type TerminalMode, type TerminalSessionRow } from './types.js';

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

/** `window_extended_to` arrives with `SELECT *` before `TerminalSessionRow` declares it. */
export interface SessionWindowRow {
  readonly consumed_at: Date | null;
  readonly window_extended_to?: Date | null;
}

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

/** Migration 040 window shared with the relay `/authz` and with the control hold of the store, which owns the one text this delegates to. The ceiling parameter is optional because an extension is already clamped when it is WRITTEN. */
export function sessionWindowExpression(ttlParameter: number, maxTotalParameter?: number): string {
  return terminalSessionWindowExpression(ttlParameter, maxTotalParameter);
}

/** JavaScript twin of `sessionWindowExpression`, for the rows already read into memory. */
export function sessionExpiry(
  row: SessionWindowRow, sessionTtlSeconds: number, sessionMaxTotalSeconds?: number,
): Date | undefined {
  if (row.consumed_at === null) return undefined;
  const consumedAt = row.consumed_at.getTime();
  const ceiling = sessionMaxTotalSeconds === undefined
    ? Number.POSITIVE_INFINITY
    : consumedAt + sessionMaxTotalSeconds * 1_000;
  const extended = row.window_extended_to?.getTime() ?? 0;
  return new Date(Math.min(Math.max(consumedAt + sessionTtlSeconds * 1_000, extended), ceiling));
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

export interface OwnedTerminalSession extends TerminalSessionRow {
  session_expires_at: Date;
}

export interface OwnedSessionRequest {
  readonly sessionId: string;
  readonly body: {
    readonly request_id: string;
    readonly owner_generation: string;
    readonly owner_token: string;
  };
  readonly operator: ResolvedOperator;
  readonly consoleSubject: string;
  readonly config: TerminalConfig;
  readonly lock?: boolean;
}

/**
 * The fence every route that acts on a LIVE session shares: the operator scope, the browser owner
 * digest and generation of the tab that opened it, and the migration 040 window. A stale tab, a
 * second subject or a session already closed matches nothing and can mutate nothing.
 */
export function ownedLiveSessionQuery(
  input: OwnedSessionRequest,
): { text: string; values: unknown[] } {
  const window = sessionWindowExpression(8, 9);
  return {
    text: `SELECT terminal_sessions.*, ${window} AS session_expires_at
             FROM terminal_sessions
            WHERE id=$1 AND ${operatorScopePredicate(2, 3, 4)}
              AND request_id=$5
              AND browser_owner_generation=$6::bigint
              AND browser_owner_sha256=$7
              AND consumed_at IS NOT NULL AND revoked_at IS NULL AND closed_at IS NULL
              AND ${window}>now()${input.lock === true ? '\n            FOR UPDATE' : ''}`,
    values: [
      input.sessionId,
      input.operator.operator_id,
      input.operator.attributed,
      input.consoleSubject,
      input.body.request_id,
      input.body.owner_generation,
      ticketSha256(input.body.owner_token),
      input.config.sessionTtlSeconds,
      input.config.sessionMaxTotalSeconds ?? null,
    ],
  };
}

export const CONTROL_HOLD_COLUMNS =
  `EXISTS(SELECT 1 FROM terminal_control_holds h WHERE h.session_id=terminal_sessions.id)
     AS control_ever_held,
   EXISTS(SELECT 1 FROM terminal_control_holds h WHERE h.session_id=terminal_sessions.id
            AND h.released_at IS NULL AND h.expires_at>now()) AS control_held`;

export interface ControlHoldColumns {
  readonly control_ever_held: boolean;
  readonly control_held: boolean;
}

export const CONTROL_RELEASED = 'control_released';

export function controlWasReleased(
  row: ControlHoldColumns & { readonly mode: TerminalMode },
): boolean {
  return isWritableMode(row.mode) && row.control_ever_held && !row.control_held;
}
