import { FleetHostIdSchema, isCanonicalUuidV4 } from '@cauce/protocol';
import type { DatabaseClient, DatabasePool } from '@cauce/store';
import type { TerminalSessionRow } from './types.js';
import { decodeTerminalSubject } from './authority-continuity.js';

/** Audit metadata excludes tickets, PTY bytes and document contents; only measurements and digest prefixes are safe. */

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

function auditHost(value: unknown): string | null {
  const result = FleetHostIdSchema.safeParse(value);
  return result.success ? result.data : null;
}

async function terminalAuditHost(database: DatabasePool | DatabaseClient, entry: TerminalAuditEntry): Promise<string | null> {
  const metadata = entry.metadata;
  if (metadata.session_id === undefined
      || (entry.action === 'terminal.session.request' && entry.decision === 'allow' && metadata.receipt_recovered !== true)) {
    return auditHost(metadata.host_id);
  }
  if (!isCanonicalUuidV4(metadata.session_id)
      || typeof metadata.target_tenant !== 'string' || typeof metadata.target_alias !== 'string') return null;
  const sessions = await database.query<Pick<TerminalSessionRow, 'tenant_id' | 'alias' | 'console_subject' | 'issued_at'>>(
    'SELECT * FROM terminal_sessions WHERE id=$1', [metadata.session_id],
  );
  const session = sessions.rows[0];
  if (session?.tenant_id !== metadata.target_tenant || session.alias !== metadata.target_alias
      || !(session.issued_at instanceof Date) || !Number.isFinite(session.issued_at.getTime())) return null;
  let actor: ReturnType<typeof decodeTerminalSubject>['actor'];
  try { actor = decodeTerminalSubject(session.console_subject).actor; } catch { return null; }
  // The tenant/time index bounds admission evidence; absent evidence never falls back to a later placement.
  const result = await database.query<{ host_id: unknown }>(
    `SELECT audit.metadata->>'host_id' AS host_id
       FROM (
         SELECT * FROM audit_events
          WHERE tenant_id=$5 AND created_at BETWEEN $7::timestamptz-interval '1 minute' AND $7::timestamptz+interval '1 minute'
          ORDER BY created_at DESC LIMIT 1000
       ) audit
       JOIN tenants actor_tenant ON actor_tenant.id=audit.tenant_id
       JOIN terminal_sessions session ON session.id::text=audit.metadata->>'session_id'
       JOIN tenants target_tenant ON target_tenant.id=session.tenant_id
      WHERE session.id=$1::uuid AND session.tenant_id=$2 AND session.alias=$3
        AND audit.action='terminal.session.request' AND audit.decision='allow'
        AND audit.actor_alias=$6 AND audit.trace_id IS NOT DISTINCT FROM session.trace_id
        AND audit.metadata->>'target_tenant'=session.tenant_id
        AND audit.metadata->>'target_alias'=session.alias
        AND COALESCE(audit.company_id,actor_tenant.company_id)=target_tenant.company_id
        AND ($4::text IS NULL OR audit.trace_id=$4)
      ORDER BY audit.id LIMIT 1`,
    [metadata.session_id, metadata.target_tenant, metadata.target_alias, entry.trace_id ?? null,
      actor.tenantId, actor.alias, session.issued_at],
  );
  return auditHost(result.rows[0]?.host_id);
}

export async function recordTerminalAudit(database: DatabasePool | DatabaseClient, entry: TerminalAuditEntry): Promise<void> {
  const component = entry.action.startsWith('agent_document.') || entry.action.startsWith('agent_profile.') ? 'context' : 'terminal';
  const metadata = { ...entry.metadata, host_id: await terminalAuditHost(database, entry), component };
  await database.query(
    `INSERT INTO audit_events(tenant_id, actor_alias, action, decision, trace_id, metadata)
     VALUES($1,$2,$3,$4,$5,$6::jsonb)`,
    [
      entry.tenant_id,
      entry.actor_alias,
      entry.action,
      entry.decision,
      entry.trace_id ?? null,
      JSON.stringify(metadata)
    ]
  );
}

export interface TerminalAuditContext {
  readonly operator_id: string;
  readonly attributed: boolean;
  readonly target_tenant: string;
  readonly target_alias: string;
  readonly container: string | null;
  readonly host_id?: string | null;
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
    ...extra,
    host_id: context.host_id ?? null,
    component: 'terminal',
  };
}
