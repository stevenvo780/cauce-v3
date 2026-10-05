import { RESERVED_INTERNAL_MESSAGE_TYPES, SYSTEM_GATE_PROBE_MESSAGE_TYPE, type Tenant } from '@cauce/protocol';
import type { DatabaseClient } from '../../db.js';
import { AGENT_ROOT_OPEN_LIMIT } from '../../delegation-guard.js';
import { StoreError } from '../errors.js';
import type { HumanPublishProvenance } from './contracts.js';
import { assertHumanMessageRoot } from './human-initiators.js';

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

// A root counts as an agent root through its own `message.publish` (or, for a replayed clone,
// `delivery.replay`) audit row, which retention never deletes; trace_id rides the audit trace index.
const AGENT_ROOT_AUDIT = `audit.trace_id=m.trace_id AND audit.message_id=m.id
  AND audit.action IN ('message.publish','delivery.replay')
  AND audit.decision='allow' AND audit.metadata->>'agent_root'='true'`;
const OPEN_STATES = `('pending','retry','leased','accepted','started')`;
const UUID_TEXT = `'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'`;
export const CHAIN_TYPES: readonly string[] = [...RESERVED_INTERNAL_MESSAGE_TYPES];
// Only store-written internal messages can name a root: a client body carrying `correlation` never holds a slot.
const CHAIN_ROOT_OF_OPEN = `CASE WHEN om.body->>'type'=ANY($3::text[])
  AND (om.body->'correlation'->>'root_message_id') ~ ${UUID_TEXT}
  THEN (om.body->'correlation'->>'root_message_id')::uuid ELSE om.id END`;

/** Whether the chain of `root` still runs: its own open deliveries, an open internal hop or an open gate. */
export function chainOpenSql(root: string, chainTypes: string): string {
  return `(EXISTS (SELECT 1 FROM deliveries own WHERE own.message_id=${root} AND own.status IN ${OPEN_STATES})
    OR EXISTS (SELECT 1 FROM messages cm JOIN deliveries cd ON cd.message_id=cm.id
               WHERE cm.body->'correlation'->>'root_message_id'=${root}::text
                 AND cm.body->>'type'=ANY(${chainTypes}) AND cd.status IN ${OPEN_STATES})
    OR EXISTS (SELECT 1 FROM agent_chain_gates gate
               WHERE gate.root_message_id=${root} AND gate.status='open'))`;
}

/**
 * Agent roots of the actor whose chain is still running: the root's own deliveries, every
 * internal message of its chain (delegations, responses, fan-in) and any open human gate. The
 * scan starts from the small set of open deliveries and open gates, never from the actor's history.
 */
export async function openAgentRoots(client: DatabaseClient, tenant: Tenant, alias: string): Promise<OpenAgentRoot[]> {
  const result = await client.query<{ message_id: string; created_at: Date; recipients: OpenAgentRootRecipient[] }>(
    `WITH open_roots AS MATERIALIZED (
       SELECT DISTINCT ${CHAIN_ROOT_OF_OPEN} AS root_id
       FROM deliveries open JOIN messages om ON om.id=open.message_id
       WHERE open.status IN ${OPEN_STATES}
       UNION
       SELECT gate.root_message_id FROM agent_chain_gates gate WHERE gate.status='open'
     )
     SELECT m.id AS message_id,m.created_at,
            jsonb_agg(jsonb_build_object('tenant_id',d.recipient_tenant,'alias',d.recipient_alias,'status',d.status)
                      ORDER BY d.created_at,d.id) AS recipients
     FROM open_roots
     JOIN messages m ON m.id=open_roots.root_id AND m.tenant_id=$1 AND m.actor_alias=$2
     JOIN deliveries d ON d.message_id=m.id
     WHERE EXISTS (SELECT 1 FROM audit_events audit WHERE ${AGENT_ROOT_AUDIT})
     GROUP BY m.id,m.created_at ORDER BY m.created_at,m.id`,
    [tenant, alias, CHAIN_TYPES],
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

/** Who reads a message: the reply of what it sent is shown only to the same kind of principal. */
export type MessageReader = 'agent' | 'operator';

export interface SenderView {
  readonly chainOpen: boolean;
  readonly replies: ReadonlyMap<string, string | null>;
}

/**
 * What the sender asked for: whether the chain still runs and, per root delivery, its branch's
 * fan-in reply (only it, even when it failed), else the branch's newest response, else the root hop.
 * An agent reads only roots it published as an agent; an operator only the rest; gate probes never.
 */
export async function senderView(
  pool: Pick<DatabaseClient, 'query'>, messageId: string, reader: MessageReader,
): Promise<SenderView | undefined> {
  return loadSenderView(pool, messageId, reader);
}

export async function humanSenderView(
  client: DatabaseClient, messageId: string, human: HumanPublishProvenance,
): Promise<SenderView | undefined> {
  await assertHumanMessageRoot(client, messageId, human);
  return loadSenderView(client, messageId, 'human');
}

async function loadSenderView(
  pool: Pick<DatabaseClient, 'query'>, messageId: string, reader: MessageReader | 'human',
): Promise<SenderView | undefined> {
  const head = await pool.query<{ probe: boolean; agent_root: boolean; chain_open: boolean }>(
    `SELECT m.body->>'type' IS NOT DISTINCT FROM $2 AS probe,
            EXISTS (SELECT 1 FROM audit_events audit WHERE ${AGENT_ROOT_AUDIT}) AS agent_root,
            ${chainOpenSql('m.id', '$3::text[]')} AS chain_open
     FROM messages m WHERE m.id=$1::uuid`,
    [messageId, SYSTEM_GATE_PROBE_MESSAGE_TYPE, CHAIN_TYPES],
  );
  const row = head.rows[0];
  if (row === undefined || row.probe || row.agent_root !== (reader === 'agent')) return undefined;
  const replies = await pool.query<{ delivery_id: string; reply: string | null }>(
    `SELECT d.id AS delivery_id,CASE WHEN fanin.id IS NOT NULL
       THEN CASE WHEN fanin.status='done' THEN fanin.result->'output'->>'reply' END
       ELSE COALESCE((
         SELECT c.result->'output'->>'reply' FROM messages cm JOIN deliveries c ON c.message_id=cm.id
         WHERE cm.body->'correlation'->>'root_message_id'=$2 AND cm.body->>'type'='agent.response'
           AND cm.body->'correlation'->>'root_delivery_id'=d.id::text
           AND c.recipient_tenant=d.recipient_tenant AND c.recipient_alias=d.recipient_alias
           AND c.status='done' AND c.result->'output'->>'reply' IS NOT NULL
         ORDER BY c.terminal_at DESC NULLS LAST,c.created_at DESC LIMIT 1
       ),d.result->'output'->>'reply') END AS reply
     FROM deliveries d
     LEFT JOIN LATERAL ( -- The fan-in is this branch's consolidated answer: when it exists nothing else speaks for it.
       SELECT c.id,c.status,c.result FROM messages cm JOIN deliveries c ON c.message_id=cm.id
       WHERE cm.body->'correlation'->>'root_message_id'=$2 AND cm.body->>'type'='agent.fanin'
         AND cm.body->'correlation'->>'root_delivery_id'=d.id::text
         AND c.recipient_tenant=d.recipient_tenant AND c.recipient_alias=d.recipient_alias
       ORDER BY c.created_at DESC,c.id DESC LIMIT 1
     ) fanin ON true
     WHERE d.message_id=$1::uuid`,
    [messageId, messageId.toLowerCase()],
  );
  return {
    chainOpen: row.chain_open,
    replies: new Map(replies.rows.map((entry) => [entry.delivery_id, entry.reply])),
  };
}
