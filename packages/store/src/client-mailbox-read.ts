import { isAnyUuid } from '@cauce/protocol';
import type { DatabaseClient } from './db.js';
import { clientMailboxAddress, resolveClientMailbox } from './client-mailbox.js';
import type { HumanPublishProvenance } from './repository/messages/contracts.js';
import { StoreError } from './repository/errors.js';

export interface ClientMailboxQuery { readonly limit: number; readonly after?: { readonly at: string; readonly id: string } }
export interface ClientMailboxPage {
  readonly address: { readonly tenant_id: string; readonly alias: string }; readonly label: string;
  readonly items: readonly {
    readonly delivery_id: string; readonly message_id: string; readonly stored_at: string;
    readonly from: { readonly tenant_id: string; readonly alias: string }; readonly text: string;
    readonly text_truncated: boolean; readonly state: 'stored';
  }[];
  readonly next?: { readonly at: string; readonly id: string };
}
export async function loadClientMailbox(client: DatabaseClient, human: HumanPublishProvenance,
  query: ClientMailboxQuery): Promise<ClientMailboxPage | null> {
  if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 50
      || (query.after !== undefined && (!isAnyUuid(query.after.id)
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u.test(query.after.at)))) {
    throw new StoreError('invalid_input', 'invalid client mailbox query');
  }
  const provenance = human.clientProvenance;
  if (provenance?.kind !== 'oauth_client') return null;
  const alias = clientMailboxAddress(provenance.grantId, human.tenantId);
  const mailbox = await resolveClientMailbox(client, human.tenantId, alias);
  if (!mailbox) return null;
  if (mailbox.human_id !== human.humanId || mailbox.actor_alias !== human.actorAlias) {
    throw new StoreError('forbidden', 'client mailbox owner is inconsistent');
  }
  const rows = (await client.query<{ delivery_id: string; message_id: string; stored_at: string;
    tenant_id: string; actor_alias: string; text: string; text_truncated: boolean }>(
    `SELECT d.id AS delivery_id,m.id AS message_id,
      to_char(d.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS stored_at,
      m.tenant_id,m.actor_alias,m.body->>'text' AS text,false AS text_truncated
    FROM deliveries d JOIN messages m ON m.id=d.message_id
    WHERE d.recipient_tenant=$1 AND d.recipient_alias=$2 AND d.status='done' AND d.attempt=0
      AND d.result->>'kind'='client_mailbox' AND d.result->>'state'='stored'
      AND d.result->>'owner_human_id'=$3 AND d.result->>'grant_id'=$4
      AND ($5::timestamptz IS NULL OR (d.created_at,d.id)<($5::timestamptz,$6::uuid))
    ORDER BY d.created_at DESC,d.id DESC LIMIT $7`,
    [human.tenantId, alias, human.humanId, provenance.grantId, query.after?.at ?? null, query.after?.id ?? null, query.limit + 1],
  )).rows;
  const kept = rows.slice(0, query.limit);
  const last = kept.at(-1);
  return { address: { tenant_id: human.tenantId, alias }, label: mailbox.label,
    items: kept.map((row) => ({ delivery_id: row.delivery_id, message_id: row.message_id,
      stored_at: row.stored_at, from: { tenant_id: row.tenant_id, alias: row.actor_alias },
      text: row.text, text_truncated: row.text_truncated, state: 'stored' })),
    ...(rows.length > query.limit && last !== undefined ? { next: { at: last.stored_at, id: last.delivery_id } } : {}),
  };
}
