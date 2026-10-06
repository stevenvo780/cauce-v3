import type { DatabaseClient } from './db.js';
import { readAgentBehaviorPolicy } from './agent-behavior-policy.js';
import type { DeliveryRow } from './repository/observability.js';
import type { AgentNotifyEntry } from './repository/deliveries.js';

export async function supervisionNoticeEffectAllowed(
  client: DatabaseClient, row: DeliveryRow, entry: AgentNotifyEntry,
): Promise<boolean> {
  if (row.body.type !== 'praxis.supervision.notice') return true;
  await client.query('SELECT pg_advisory_xact_lock_shared(783_003_004)');
  const policy = await readAgentBehaviorPolicy(client, {
    tenant_id: row.recipient_tenant, room_id: row.room_id, alias: row.recipient_alias,
  });
  const notice = policy?.supervision_notice;
  const body = row.body;
  return notice !== undefined && row.tenant_id === row.recipient_tenant
    && row.actor_alias === notice.issuer_alias && row.auth_session_id === notice.issuer_session_id
    && row.auth_channel === 'adapter' && row.origin === null
    && Object.keys(body).every((key) => key === 'type' || key === 'text' || key === 'kind')
    && typeof body.text === 'string' && body.text.trim().length > 0 && body.text.length <= 800
    && (body.kind === 'alert' || body.kind === 'decision_request' || body.kind === 'digest')
    && entry.handle === notice.egress_handle && entry.kind === body.kind && entry.body === body.text;
}
