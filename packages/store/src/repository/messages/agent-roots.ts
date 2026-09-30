import type { Tenant } from '@cauce/protocol';
import type { DatabaseClient } from '../../db.js';
import { AGENT_ROOT_OPEN_LIMIT } from '../../delegation-guard.js';
import { StoreError } from '../errors.js';

export interface OpenAgentRootRecipient {
  readonly tenant_id: Tenant;
  readonly alias: string;
  readonly status: string;
}

export interface OpenAgentRoot {
  readonly message_id: string;
  readonly created_at: string;
  readonly recipients: readonly OpenAgentRootRecipient[];
}

/**
 * The actor already has AGENT_ROOT_OPEN_LIMIT roots whose deliveries are not terminal. The limit
 * is released by completion, never by time, and the list says what the actor is waiting on.
 */
export class AgentRootLimitError extends StoreError {
  readonly reason = 'agent_root_limit';
  readonly limit = AGENT_ROOT_OPEN_LIMIT;

  constructor(readonly openRoots: readonly OpenAgentRoot[]) {
    super('conflict', `el actor ya tiene ${String(openRoots.length)} mensajes raíz abiertos`
      + ` (tope ${String(AGENT_ROOT_OPEN_LIMIT)}); esperá a que alguno termine`);
    this.name = 'AgentRootLimitError';
  }
}

const node = (tenant: string, alias: string): string => `${tenant}/${alias}`;

/** Serializes every agent-root publish of one actor, so two concurrent publishes cannot both see a free slot. */
export async function lockAgentRootActor(client: DatabaseClient, tenant: Tenant, alias: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`cauce:agent-root:${node(tenant, alias)}`]);
}

// A root counts as an agent root through its own `message.publish` audit row, which retention never
// deletes; joining on trace_id rides the audit trace index instead of scanning the table.
const AGENT_ROOT_AUDIT = `audit.trace_id=m.trace_id AND audit.message_id=m.id AND audit.action='message.publish'
  AND audit.decision='allow' AND audit.metadata->>'agent_root'='true'`;

/** Agent roots of the actor with a non-terminal delivery, found from the small set of open deliveries. */
export async function openAgentRoots(client: DatabaseClient, tenant: Tenant, alias: string): Promise<OpenAgentRoot[]> {
  const result = await client.query<{ message_id: string; created_at: Date; recipients: OpenAgentRootRecipient[] }>(
    `WITH open_messages AS MATERIALIZED (
       SELECT DISTINCT open.message_id FROM deliveries open
       WHERE open.status IN ('pending','retry','leased','accepted','started')
     )
     SELECT m.id AS message_id,m.created_at,
            jsonb_agg(jsonb_build_object('tenant_id',d.recipient_tenant,'alias',d.recipient_alias,'status',d.status)
                      ORDER BY d.created_at,d.id) AS recipients
     FROM open_messages
     JOIN messages m ON m.id=open_messages.message_id AND m.tenant_id=$1 AND m.actor_alias=$2
     JOIN deliveries d ON d.message_id=m.id
     WHERE EXISTS (SELECT 1 FROM audit_events audit WHERE ${AGENT_ROOT_AUDIT})
     GROUP BY m.id,m.created_at ORDER BY m.created_at,m.id`,
    [tenant, alias],
  );
  return result.rows.map((row) => ({
    message_id: row.message_id, created_at: row.created_at.toISOString(), recipients: row.recipients,
  }));
}

export async function assertAgentRootSlot(client: DatabaseClient, tenant: Tenant, alias: string): Promise<void> {
  const open = await openAgentRoots(client, tenant, alias);
  if (open.length >= AGENT_ROOT_OPEN_LIMIT) throw new AgentRootLimitError(open);
}

/** The chain node of the agent principal that published this root, or undefined when none did. */
export async function agentRootActorNode(client: DatabaseClient, rootMessageId: string): Promise<string | undefined> {
  const result = await client.query<{ node: string }>(
    `SELECT m.tenant_id||'/'||m.actor_alias AS node FROM messages m
     WHERE m.id=$1::uuid AND EXISTS (SELECT 1 FROM audit_events audit WHERE ${AGENT_ROOT_AUDIT})`,
    [rootMessageId],
  );
  return result.rows[0]?.node;
}
