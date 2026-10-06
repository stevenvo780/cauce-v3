import { SYSTEM_GATE_PROBE_MESSAGE_TYPE, TenantSchema, type Tenant } from '@cauce/protocol';
import type { DatabaseClient } from '../../db.js';
import { chainGateOriginTenantSql, tenantReadableSql } from '../acl-edges.js';
import { consolePublishConversationHash } from '../config.js';
import { StoreError } from '../errors.js';
import { CHAIN_TYPES, chainOpenSql, humanSenderView, type CanonicalReplyMedia } from './agent-roots.js';
import type { HumanPublishProvenance } from './contracts.js';
import { loadMessageDetail } from './message-detail.js';

export const HUMAN_INBOX_MAX_LIMIT = 50;
/** A feed `since` older than this is refused: it bounds the lineage scan and matches the 7-day lease cap. */
export const HUMAN_INBOX_FEED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const HUMAN_INBOX_QUESTIONS_PER_ROOT = 5;
export const HUMAN_INBOX_CHAIN_MESSAGES_PER_ROOT = 10;
/** Characters the store reads of a free text; the gateway trims to bytes and flags the cut. */
export const HUMAN_INBOX_TEXT_CHARS = 8192;
const WATERMARK_SLACK_SECONDS = 120;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const MICRO_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u;
// Keys keep the microseconds of timestamptz: a JS Date drops them and the keyset would skip ties.
const utcKey = (expression: string): string => `to_char((${expression}) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export interface HumanInboxKey { readonly at: string; readonly id: string }
export interface HumanInboxQuery {
  readonly mode: 'recent' | 'feed';
  readonly limit: number;
  readonly openOnly: boolean;
  readonly after?: HumanInboxKey;
  readonly since?: string;
}
export interface HumanInboxDelivery extends Partial<CanonicalReplyMedia> {
  readonly deliveryId: string; readonly tenantId: string; readonly alias: string; readonly status: string;
  readonly clientMailbox?: { readonly label: string; readonly state: 'stored' };
  readonly attempt: number; readonly terminalAt: string | null; readonly reply: string | null;

}
export interface HumanInboxQuestion {
  readonly gateId: string; readonly askedBy: { readonly tenantId: string; readonly alias: string };
  readonly question: string; readonly status: string; readonly createdAt: string; readonly answeredAt: string | null;
}
export interface HumanInboxChainMessage {
  readonly messageId: string; readonly createdAt: string; readonly from: { readonly tenantId: string; readonly alias: string };
  readonly type: string | null; readonly text: string | null; readonly deliveryStatus: string;
}
export interface HumanInboxItem {
  readonly key: HumanInboxKey;
  readonly messageId: string;
  readonly createdAt: string;
  readonly lastActivityAt: string;
  readonly roomId: string;
  readonly from: { readonly tenantId: Tenant; readonly alias: string };
  readonly text: string | null;
  readonly chainOpen: boolean;
  readonly deliveries: readonly HumanInboxDelivery[];
  readonly questions: readonly HumanInboxQuestion[];
  readonly chainMessages: readonly HumanInboxChainMessage[];
  readonly chainMessagesTruncated: boolean;
}
export interface HumanInboxPage {
  readonly items: readonly HumanInboxItem[];
  /** Owned roots scanned but not shown: integrity mismatch, gate probe or agent-root view. */
  readonly withheld: number;
  /** Keyset position after the last scanned root, present only when more roots may follow. */
  readonly next?: HumanInboxKey;
  /** Feed mode only: the `since` that resumes after this scan, behind now() for late ACK commits. */
  readonly watermark?: string;
}

interface RootRow {
  message_id: string; conversation_id: string; room_id: string; actor_alias: string;
  created_key: string; position_key: string;
}

export function assertHumanInboxQuery(query: HumanInboxQuery, now = Date.now()): void {
  const valid = Number.isSafeInteger(query.limit) && query.limit >= 1 && query.limit <= HUMAN_INBOX_MAX_LIMIT
    && (query.after === undefined || (MICRO_ISO.test(query.after.at) && UUID.test(query.after.id)))
    && (query.mode === 'feed') === (query.since !== undefined)
    && (query.since === undefined || (Number.isFinite(Date.parse(query.since))
      && Date.parse(query.since) >= now - HUMAN_INBOX_FEED_WINDOW_MS));
  if (!valid) throw new StoreError('invalid_input', 'invalid human inbox query');
}

/**
 * One page of the roots this human started, newest first (`recent`) or by last chain activity
 * (`feed`). The caller's READ COMMITTED transaction holds the human authority, the room/policy
 * locks and every read; it cannot be READ ONLY because PostgreSQL refuses FOR SHARE there.
 */
export async function loadHumanInboxPage(
  client: DatabaseClient, human: HumanPublishProvenance, query: HumanInboxQuery,
): Promise<HumanInboxPage> {
  assertHumanInboxQuery(query);
  const roots = await lockInboxRoots(client, human, query);
  const more = roots.length > query.limit;
  const scanned = more ? roots.slice(0, query.limit) : roots;
  const kept: { root: RootRow; item: Omit<HumanInboxItem, 'questions' | 'chainMessages' | 'chainMessagesTruncated' | 'lastActivityAt'> }[] = [];
  let withheld = 0;
  for (const root of scanned) {
    const item = await inboxItem(client, human, root);
    if (item === undefined) withheld += 1;
    else kept.push({ root, item });
  }
  const ids = kept.map(({ root }) => root.message_id);
  const questions = await inboxQuestions(client, human.tenantId, ids);
  const chain = await inboxChainMessages(client, human, ids);
  const activity = await inboxActivity(client, human, ids);
  const watermark = query.mode === 'feed' ? (await client.query<{ watermark: string }>(
    `SELECT ${utcKey(`now()-interval '${String(WATERMARK_SLACK_SECONDS)} seconds'`)} AS watermark`,
  )).rows[0]?.watermark : undefined;
  const last = scanned.at(-1);
  return Object.freeze({
    items: Object.freeze(kept.map(({ root, item }) => Object.freeze({
      ...item,
      lastActivityAt: query.mode === 'feed' ? root.position_key : activity.get(root.message_id) ?? root.created_key,
      questions: Object.freeze(questions.get(root.message_id) ?? []),
      chainMessages: Object.freeze(chain.messages.get(root.message_id) ?? []),
      chainMessagesTruncated: chain.truncated.has(root.message_id),
    }))),
    withheld,
    ...(more && last !== undefined ? { next: Object.freeze({ at: last.position_key, id: last.message_id }) } : {}),
    ...(watermark === undefined ? {} : { watermark }),
  });
}

async function lockInboxRoots(client: DatabaseClient, human: HumanPublishProvenance, query: HumanInboxQuery): Promise<RootRow[]> {
  const feed = query.mode === 'feed';
  const position = feed ? 'activity.at' : 'h.created_at';
  const parameters: unknown[] = [human.tenantId, human.humanId, human.actorAlias, SYSTEM_GATE_PROBE_MESSAGE_TYPE,
    query.after?.at ?? null, query.after?.id ?? null, query.limit + 1, query.openOnly, CHAIN_TYPES];
  if (feed) parameters.push(query.since);
  // The activity of a root: its lineage rows, their deliveries and its gates. The lineage scan rides
  // the owner index and is bounded by the feed window, so it never walks the human's whole history.
  const activity = feed ? `WITH activity AS MATERIALIZED (
       SELECT lineage.root_message_id AS root_id,
              GREATEST(max(lineage.created_at),max(d.updated_at),(SELECT max(gate.updated_at) FROM agent_chain_gates gate
                WHERE gate.root_message_id=lineage.root_message_id)) AS at
       FROM human_message_initiators lineage LEFT JOIN deliveries d ON d.message_id=lineage.message_id
       WHERE lineage.initiating_tenant_id=$1 AND lineage.initiating_human_id=$2::uuid
         AND lineage.created_at>=$10::timestamptz-interval '7 days'
       GROUP BY lineage.root_message_id
     ) ` : '';
  const result = await client.query<RootRow>(
    `${activity}SELECT h.message_id,h.conversation_id,m.room_id,m.actor_alias,
            ${utcKey('h.created_at')} AS created_key,${utcKey(position)} AS position_key
     FROM human_message_initiators h
     JOIN messages m ON m.id=h.message_id AND m.tenant_id=h.message_tenant_id
     ${feed ? 'JOIN activity ON activity.root_id=h.message_id' : ''}
     JOIN memberships membership ON membership.tenant_id=m.tenant_id AND membership.room_id=m.room_id AND membership.alias=$3
     JOIN role_policies policy ON policy.role=membership.role
     JOIN tenants tenant ON tenant.id=membership.tenant_id
     JOIN rooms room ON room.id=membership.room_id AND room.tenant_id=membership.tenant_id
     WHERE h.initiating_tenant_id=$1 AND h.initiating_human_id=$2::uuid
       AND h.message_id=h.root_message_id AND h.message_tenant_id=$1
       AND membership.enabled AND policy.allow_read AND tenant.enabled AND room.enabled
       AND m.body->>'type' IS DISTINCT FROM $4
       AND (NOT $8::boolean OR ${chainOpenSql('m.id', '$9::text[]')})
       ${feed ? 'AND activity.at>$10::timestamptz' : ''}
       AND ($5::timestamptz IS NULL OR ${position}${feed ? '>' : '<'}$5::timestamptz
            OR (${position}=$5::timestamptz AND h.message_id>$6::uuid))
     ORDER BY ${position} ${feed ? 'ASC' : 'DESC'},h.message_id ASC LIMIT $7
     FOR SHARE OF membership,policy,tenant,room`,
    parameters,
  );
  return result.rows;
}

async function inboxItem(
  client: DatabaseClient, human: HumanPublishProvenance, root: RootRow,
): Promise<Omit<HumanInboxItem, 'questions' | 'chainMessages' | 'chainMessagesTruncated' | 'lastActivityAt'> | undefined> {
  let row;
  try {
    row = await loadMessageDetail(client, root.message_id, human.tenantId, human.actorAlias);
  } catch (error) {
    if (error instanceof StoreError && error.code === 'not_found') return undefined;
    throw error;
  }
  const conversation = consolePublishConversationHash({
    tenant_id: human.tenantId, room_id: row.room_id, actor_alias: row.actor_alias,
    recipients: row.deliveries.map((delivery) => ({ tenant_id: TenantSchema.parse(delivery.tenant_id), alias: delivery.alias })),
  });
  // A root whose recipients no longer hash to its durable conversation is withheld, never shown or thrown.
  if (conversation !== root.conversation_id || row.deliveries.length === 0) return undefined;
  const view = await humanSenderView(client, root.message_id, human);
  if (view === undefined) return undefined;
  const body = row.body !== null && typeof row.body === 'object' && !Array.isArray(row.body) ? row.body as Record<string, unknown> : {};
  return {
    key: { at: root.position_key, id: root.message_id },
    messageId: root.message_id, createdAt: root.created_key, roomId: row.room_id,
    from: { tenantId: human.tenantId, alias: row.actor_alias },
    text: typeof body.text === 'string' ? body.text.slice(0, HUMAN_INBOX_TEXT_CHARS) : null,
    chainOpen: view.chainOpen,
    deliveries: row.deliveries.map((delivery) => {
      // humanSenderView reads the reply whole (its query is shared with cauce_receipt's single-message
      // read, which an inbox page cannot cap in SQL without touching that shared query). Slicing here,
      // right where the row enters the page, keeps a 50-root x 100-delivery scan from retaining
      // it unbounded the way it already avoids for the root's own body.text above.
      const reply = view.replies.get(delivery.delivery_id) ?? null;
      return {
        ...(delivery.client_mailbox == null ? {} : { clientMailbox: delivery.client_mailbox }),
        deliveryId: delivery.delivery_id, tenantId: delivery.tenant_id, alias: delivery.alias, status: delivery.status,
        attempt: delivery.attempt, terminalAt: delivery.terminal_at,
        reply: typeof reply === 'string' ? reply.slice(0, HUMAN_INBOX_TEXT_CHARS) : null,
        ...view.replyMedia?.get(delivery.delivery_id),
      };
    }),
  };
}

/** Questions (`@human` gates) of these roots the human's tenant may read; never the answer nor who gave it. */
async function inboxQuestions(
  client: DatabaseClient, tenant: Tenant, roots: readonly string[],
): Promise<Map<string, HumanInboxQuestion[]>> {
  const grouped = new Map<string, HumanInboxQuestion[]>();
  if (roots.length === 0) return grouped;
  const result = await client.query<{
    id: string; root_message_id: string; tenant_id: string; asked_by_alias: string; question: string;
    status: string; created_at: Date; answered_at: Date | null;
  }>(
    `SELECT ranked.id,ranked.root_message_id,ranked.tenant_id,ranked.asked_by_alias,ranked.question,
            ranked.status,ranked.created_at,ranked.answered_at
     FROM (SELECT gate.id,gate.root_message_id,gate.tenant_id,gate.asked_by_alias,left(gate.question,$3) AS question,
                  gate.status,gate.created_at,gate.answered_at,
                  row_number() OVER (PARTITION BY gate.root_message_id ORDER BY gate.created_at DESC,gate.id DESC) AS rank
           FROM agent_chain_gates gate
           WHERE gate.root_message_id=ANY($1::uuid[]) AND ${tenantReadableSql('$2::text', 'gate.tenant_id')}
             AND ${tenantReadableSql('$2::text', chainGateOriginTenantSql)}) ranked
     WHERE ranked.rank<=$4 ORDER BY ranked.root_message_id,ranked.created_at DESC,ranked.id DESC`,
    [roots, tenant, HUMAN_INBOX_TEXT_CHARS, HUMAN_INBOX_QUESTIONS_PER_ROOT],
  );
  for (const row of result.rows) {
    const list = grouped.get(row.root_message_id) ?? [];
    list.push({ gateId: row.id, askedBy: { tenantId: row.tenant_id, alias: row.asked_by_alias }, question: row.question,
      status: row.status, createdAt: row.created_at.toISOString(), answeredAt: row.answered_at?.toISOString() ?? null });
    grouped.set(row.root_message_id, list);
  }
  return grouped;
}

/**
 * Messages of these chains delivered back to the alias that sent the root: same human lineage,
 * and a foreign-tenant message only through a readable edge. The agent behind that alias consumes them.
 */
async function inboxChainMessages(
  client: DatabaseClient, human: HumanPublishProvenance, roots: readonly string[],
): Promise<{ messages: Map<string, HumanInboxChainMessage[]>; truncated: Set<string> }> {
  const messages = new Map<string, HumanInboxChainMessage[]>();
  const truncated = new Set<string>();
  if (roots.length === 0) return { messages, truncated };
  const result = await client.query<{
    root_message_id: string; id: string; created_at: Date; tenant_id: string; actor_alias: string;
    type: string | null; text: string | null; status: string; total: string;
  }>(
    `SELECT ranked.root_message_id,ranked.id,ranked.created_at,ranked.tenant_id,ranked.actor_alias,ranked.type,
            ranked.text,ranked.status,ranked.total
     FROM (SELECT h.root_message_id,m.id,m.created_at,m.tenant_id,m.actor_alias,m.body->>'type' AS type,
                  left(m.body->>'text',$4) AS text,d.status,
                  row_number() OVER (PARTITION BY h.root_message_id ORDER BY m.created_at DESC,m.id DESC) AS rank,
                  count(*) OVER (PARTITION BY h.root_message_id)::text AS total
           FROM human_message_initiators h
           JOIN messages m ON m.id=h.message_id AND m.tenant_id=h.message_tenant_id
           JOIN messages root ON root.id=h.root_message_id AND root.tenant_id=$1
           JOIN deliveries d ON d.message_id=m.id AND d.recipient_tenant=$1 AND d.recipient_alias=root.actor_alias
           WHERE h.initiating_tenant_id=$1 AND h.initiating_human_id=$2::uuid AND h.root_message_id=ANY($3::uuid[])
             AND h.message_id<>h.root_message_id
             -- answerChainGate's resume message carries the gate answer and who gave it (chain-control.ts):
             -- never surface it here, inboxQuestions is the only sanctioned path for a gate's outcome.
             AND m.auth_channel IS DISTINCT FROM 'chain-gate'
             AND (m.tenant_id=$1 OR EXISTS (SELECT 1 FROM acl_edges edge
                  WHERE edge.from_tenant=$1 AND edge.to_tenant=m.tenant_id AND edge.enabled AND edge.allow_read))) ranked
     WHERE ranked.rank<=$5 ORDER BY ranked.root_message_id,ranked.created_at DESC,ranked.id DESC`,
    [human.tenantId, human.humanId, roots, HUMAN_INBOX_TEXT_CHARS, HUMAN_INBOX_CHAIN_MESSAGES_PER_ROOT],
  );
  for (const row of result.rows) {
    const list = messages.get(row.root_message_id) ?? [];
    list.push({ messageId: row.id, createdAt: row.created_at.toISOString(),
      from: { tenantId: row.tenant_id, alias: row.actor_alias }, type: row.type, text: row.text, deliveryStatus: row.status });
    messages.set(row.root_message_id, list);
    if (Number(row.total) > HUMAN_INBOX_CHAIN_MESSAGES_PER_ROOT) truncated.add(row.root_message_id);
  }
  return { messages, truncated };
}

/** Last activity of each root over its whole lineage, for the `recent` mode that does not sort by it. */
async function inboxActivity(
  client: DatabaseClient, human: HumanPublishProvenance, roots: readonly string[],
): Promise<Map<string, string>> {
  if (roots.length === 0) return new Map();
  const result = await client.query<{ root_id: string; at: string }>(
    `SELECT lineage.root_message_id AS root_id,
            ${utcKey(`GREATEST(max(lineage.created_at),max(d.updated_at),(SELECT max(gate.updated_at)
              FROM agent_chain_gates gate WHERE gate.root_message_id=lineage.root_message_id))`)} AS at
     FROM human_message_initiators lineage LEFT JOIN deliveries d ON d.message_id=lineage.message_id
     WHERE lineage.initiating_tenant_id=$1 AND lineage.initiating_human_id=$2::uuid
       AND lineage.root_message_id=ANY($3::uuid[])
     GROUP BY lineage.root_message_id`,
    [human.tenantId, human.humanId, roots],
  );
  return new Map(result.rows.map((row) => [row.root_id, row.at]));
}
