import type { DatabasePool } from '@cauce/store';
import type { TerminalSessionRow } from './types.js';

/**
 * Audit trail of the PTY plane and of the governed documents that ride the same relay. Writes
 * straight through the pool: repository.ts belongs to another workflow and is not touched. Rows
 * land in audit_events, which is what /audit in the console already renders.
 * NEVER log a whole ticket, a single byte of PTY content, or a byte of a governed document. Of
 * the ticket only its sha256 truncated to 16 hex characters ever reaches metadata, and the rows
 * of the control plane carry counts and digest prefixes, never the keystrokes they measure.
 */

type TerminalAuditAction =
  | 'terminal.session.request'
  | 'terminal.session.consume'
  | 'terminal.session.resume'
  | 'terminal.session.owner_rotated'
  | 'terminal.session.revoked'
  | 'terminal.session.authz_denied'
  | 'terminal.session.extended'
  | 'terminal.session.input'
  | 'terminal.session.close'
  | 'terminal.control_taken'
  | 'terminal.control_released'
  | 'agent_profile.write'
  | 'agent_document.read'
  | 'agent_document.write'
  | 'agent_document.denied';

type TerminalAuditDecision = 'allow' | 'deny' | 'info';

export interface TerminalAuditEntry {
  readonly tenant_id: string;
  readonly actor_alias: string;
  readonly action: TerminalAuditAction;
  readonly decision: TerminalAuditDecision;
  readonly trace_id?: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export async function recordTerminalAudit(pool: DatabasePool, entry: TerminalAuditEntry): Promise<void> {
  await pool.query(
    `INSERT INTO audit_events(tenant_id, actor_alias, action, decision, trace_id, metadata)
     VALUES($1,$2,$3,$4,$5,$6::jsonb)`,
    [
      entry.tenant_id,
      entry.actor_alias,
      entry.action,
      entry.decision,
      entry.trace_id ?? null,
      JSON.stringify(entry.metadata)
    ]
  );
}

export interface TerminalAuditContext {
  readonly operator_id: string;
  readonly attributed: boolean;
  readonly target_tenant: string;
  readonly target_alias: string;
  readonly container: string | null;
  /** Tenant-qualified identities; bare aliases are ambiguous across tenants. */
  readonly cohort: readonly string[];
  readonly mode: string;
}

type TerminalAuditSession = Pick<
  TerminalSessionRow,
  'operator_id' | 'attributed' | 'tenant_id' | 'alias' | 'container' | 'mode'
>;

export function terminalSessionAuditContext(
  session: TerminalAuditSession,
  cohort: readonly string[],
): TerminalAuditContext {
  return {
    operator_id: session.operator_id,
    attributed: session.attributed,
    target_tenant: session.tenant_id,
    target_alias: session.alias,
    container: session.container,
    cohort,
    mode: session.mode,
  };
}

/** Shared metadata skeleton so allow and deny rows carry the same columns in /audit. */
export function terminalAuditMetadata(
  context: TerminalAuditContext,
  extra: Readonly<Record<string, unknown>> = {}
): Record<string, unknown> {
  return {
    operator_id: context.operator_id,
    attributed: context.attributed,
    target_tenant: context.target_tenant,
    target_alias: context.target_alias,
    container: context.container,
    cohort: [...context.cohort],
    mode: context.mode,
    ...extra
  };
}
