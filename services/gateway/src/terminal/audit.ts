import type { DatabasePool } from '@cauce/store';

/**
 * Audit trail of the PTY plane. Writes straight through the pool: repository.ts belongs to
 * another workflow and is not touched. Rows land in audit_events, which is what /audit in the
 * console already renders.
 *
 * NEVER log a whole ticket or a single byte of PTY content. Of the ticket only its sha256
 * truncated to 16 hex characters ever reaches metadata.
 */

export type TerminalAuditAction =
  | 'terminal.session.request'
  | 'terminal.session.consume'
  | 'terminal.session.revoked'
  | 'terminal.session.close';

export type TerminalAuditDecision = 'allow' | 'deny' | 'info';

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
  readonly cohort: readonly string[];
  readonly mode: string;
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
