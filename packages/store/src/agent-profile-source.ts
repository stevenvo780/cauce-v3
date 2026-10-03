import type { DatabaseClient, DatabasePool } from './db.js';
import { isJournalCursor } from './agent-context-revisions.js';

export interface AgentProfileSourceGuard {
  readonly application_id: string;
  readonly expected_journal_id: string;
  readonly instance_id: string;
  readonly commit: string;
  readonly tree: string;
  readonly profile_sha256: string;
  readonly source_journal_id: string;
  readonly source_revision: number;
  readonly operator_id: string;
}

export interface AgentProfileSourceReceipt {
  readonly application_id: string;
  readonly revision: number;
}

export function validProfileSourceGuard(value: AgentProfileSourceGuard): boolean {
  const oid = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
  const hash = /^[a-f0-9]{64}$/u;
  return hash.test(value.application_id) && isJournalCursor(value.expected_journal_id)
    && /^[a-z0-9][a-z0-9_-]{0,63}$/u.test(value.instance_id)
    && oid.test(value.commit) && oid.test(value.tree) && hash.test(value.profile_sha256)
    && isJournalCursor(value.source_journal_id) && Number.isSafeInteger(value.source_revision)
    && value.source_revision > 0 && value.operator_id.length > 0 && value.operator_id.length <= 256;
}

export async function readProfileSourceReceipt(
  connection: DatabasePool | DatabaseClient,
  tenantId: string, alias: string,
  actor: { readonly tenant_id: string; readonly alias: string },
  applicationId: string,
): Promise<AgentProfileSourceReceipt | undefined> {
  if (!/^[a-f0-9]{64}$/u.test(applicationId)) return undefined;
  const result = await connection.query<{ revision: unknown }>(
    `SELECT metadata->'desired_revision' AS revision FROM audit_events
     WHERE tenant_id=$1 AND actor_alias=$2 AND action='agent_profile.desired' AND decision='allow'
       AND metadata->>'target_tenant'=$3 AND metadata->>'target_alias'=$4
       AND metadata->'context_source'->>'application_id'=$5
     ORDER BY id DESC LIMIT 1`,
    [actor.tenant_id, actor.alias, tenantId, alias, applicationId],
  );
  const revision = result.rows[0]?.revision;
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) return undefined;
  return { application_id: applicationId, revision };
}
