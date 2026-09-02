import { RFC_UUID_PATTERN, SHA256_HEX_PATTERN, type DeliveryState } from '@cauce/protocol';
import { safeAuditSummary } from '@cauce/store';
import type { Principal } from './auth.js';

type Row = Record<string, unknown>;

function object(value: unknown): Row | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : undefined;
}

function participant(value: unknown, principal: Principal): boolean {
  const row = object(value);
  return row?.tenant_id === principal.tenant_id && (row.alias === principal.alias || row.actor_alias === principal.alias);
}

function deliveries(row: Row): Row[] {
  return Array.isArray(row.deliveries) ? row.deliveries.map(object).filter((item): item is Row => item !== undefined) : [];
}

export function messageVisible(row: Row, principal: Principal): boolean {
  const senderTenant = row.message_tenant_id ?? row.tenant_id;
  if (senderTenant === principal.tenant_id && row.actor_alias === principal.alias) return true;
  if (Array.isArray(row.participants) && row.participants.some((item) => participant(item, principal))) return true;
  return deliveries(row).some((delivery) => {
    const tenant = delivery.recipient_tenant ?? delivery.tenant_id;
    const alias = delivery.recipient_alias ?? delivery.alias;
    return tenant === principal.tenant_id && alias === principal.alias;
  });
}

function redactMessage(row: Row, principal: Principal): Row {
  const isSender = (row.message_tenant_id ?? row.tenant_id) === principal.tenant_id && row.actor_alias === principal.alias;
  if (isSender || !Array.isArray(row.deliveries)) return row;
  return {
    ...row,
    deliveries: deliveries(row).filter((delivery) =>
      (delivery.recipient_tenant ?? delivery.tenant_id) === principal.tenant_id &&
      (delivery.recipient_alias ?? delivery.alias) === principal.alias
    )
  };
}

export function visibleMessageList(value: Row, principal: Principal): Row {
  if (!Array.isArray(value.items)) return { ...value, items: [] };
  return {
    ...value,
    items: value.items.map(object).filter((item): item is Row => item !== undefined)
      .filter((item) => messageVisible(item, principal))
      .map((item) => redactMessage(item, principal))
  };
}

export function visibleMessage(value: Row, principal: Principal): Row | undefined {
  return messageVisible(value, principal) ? redactMessage(value, principal) : undefined;
}

const VISIBLE_PENDING_STATES: readonly DeliveryState[] = ['pending', 'leased', 'accepted', 'started'];

function queueRowVisible(row: Row, principal: Principal): boolean {
  const recipientTenant = row.recipient_tenant ?? row.tenant_id;
  if (recipientTenant === principal.tenant_id && row.recipient_alias === principal.alias) return true;
  const senderTenant = row.message_tenant_id ?? row.sender_tenant_id;
  return senderTenant === principal.tenant_id && row.actor_alias === principal.alias;
}

export function visibleQueue(value: Row, principal: Principal): Row {
  const parsed = Array.isArray(value.items)
    ? value.items.map(object).filter((item): item is Row => item !== undefined)
    : [];
  const items = parsed.filter((item) => queueRowVisible(item, principal));
  const counts = items.reduce<{ pending: number; retrying: number; dead: number }>((result, row) => {
    if (row.state === 'retry') result.retrying += 1;
    else if (row.state === 'dead' || row.state === 'failed') result.dead += 1;
    else if (VISIBLE_PENDING_STATES.some((state) => state === String(row.state))) result.pending += 1;
    return result;
  }, { pending: 0, retrying: 0, dead: 0 });
  // Store totals span a broader rule: forwarding them after dropping rows would headline withheld deliveries.
  const withheld = parsed.length !== items.length;
  const vouched = withheld ? {} : {
    ...(value.totals === undefined ? {} : { totals: value.totals }),
    ...(value.muestra_recortada === undefined ? {} : { muestra_recortada: value.muestra_recortada }),
  };
  const rest = { ...value };
  delete rest.totals;
  delete rest.muestra_recortada;
  return { ...rest, ...vouched, ...counts, items };
}

const DLQ_TARGETS = new Set(['delivery', 'outbox']);
const DLQ_DISPOSITIONS = new Set([
  'ambiguous', 'safe_retry', 'missing_final', 'auth', 'expected_offline', 'unclassified',
]);
const DLQ_RULE = /^[a-z0-9_]+_v[0-9]+$/u;
const CANCELLABLE_DELIVERY_STATES: ReadonlySet<string> = new Set<DeliveryState>([
  'pending', 'retry', 'leased', 'accepted', 'started',
]);
const PARENT_NOTICE_DISPOSITIONS = new Set(['not_child', 'returned', 'denied', 'deferred', 'coalesced']);
const AUDIT_ID = /^[1-9][0-9]{0,18}$/u;
const AUDIT_ACTION = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const AUDIT_DECISIONS = new Set(['allow', 'deny', 'info']);

function boundedString(value: unknown, maxLength: number): string | null {
  return typeof value === 'string' && value.length <= maxLength ? value : null;
}

function matchingString(value: unknown, pattern: RegExp, maxLength: number): string | null {
  return typeof value === 'string' && value.length <= maxLength && pattern.test(value) ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function safeDlqCursor(value: unknown): string | null {
  return typeof value === 'string' && value.length >= 2 && value.length <= 1_024
    && value.length % 2 === 0 && /^[a-f0-9]+$/u.test(value)
    ? value
    : null;
}

function safeAuditSummaryProjection(action: string | null, value: unknown): string | null {
  if (action === null || typeof value !== 'string' || value.length > 4_096) return null;
  try {
    return safeAuditSummary(action, JSON.parse(value) as unknown);
  } catch {
    return null;
  }
}

/**
 * Exact browser projection for the participant-aware audit query.
 *
 * The repository deliberately returns cross-tenant rows when this principal is the sender or
 * recipient participant. This facade therefore does not filter by `tenant_id`: it repeats only
 * the privacy allowlist and never reflects raw metadata or unexpected fields from a test double.
 */
export function safeAuditPage(value: unknown): Row {
  const page = object(value) ?? {};
  const items = Array.isArray(page.items)
    ? page.items.map(object).filter((item): item is Row => item !== undefined).map((item) => {
      const action = matchingString(item.action, AUDIT_ACTION, 128);
      return {
        event_id: matchingString(item.event_id, AUDIT_ID, 19),
        at: boundedString(item.at, 64),
        tenant_id: boundedString(item.tenant_id, 128),
        actor_alias: item.actor_alias === null ? null : boundedString(item.actor_alias, 128),
        action,
        decision: typeof item.decision === 'string' && AUDIT_DECISIONS.has(item.decision)
          ? item.decision
          : null,
        request_id: item.request_id === null ? null : matchingString(item.request_id, RFC_UUID_PATTERN, 64),
        trace_id: item.trace_id === null ? null : boundedString(item.trace_id, 256),
        summary: safeAuditSummaryProjection(action, item.summary),
      };
    })
    : [];
  return {
    items,
    next_cursor: page.next_cursor === null ? null : matchingString(page.next_cursor, AUDIT_ID, 19),
  };
}

/**
 * Second allowlist for the browser-facing DLQ contract.
 *
 * PostgreSQL already returns a safe schema-030 projection.  This boundary intentionally repeats
 * the projection so a regressed query or a permissive repository double cannot expose payload,
 * errors, operator reasons, origins or provider/message identifiers through `/v3/console/*`.
 */
export function safeDlqPage(value: unknown): Row {
  const page = object(value) ?? {};
  const items = Array.isArray(page.items)
    ? page.items.map(object).filter((item): item is Row => item !== undefined).map((item) => ({
      target: typeof item.target === 'string' && DLQ_TARGETS.has(item.target) ? item.target : null,
      id: matchingString(item.id, RFC_UUID_PATTERN, 64),
      tenantId: boundedString(item.tenantId, 128),
      kind: boundedString(item.kind, 128),
      adapter: boundedString(item.adapter, 128),
      disposition: typeof item.disposition === 'string' && DLQ_DISPOSITIONS.has(item.disposition)
        ? item.disposition
        : null,
      open: typeof item.open === 'boolean' ? item.open : null,
      actionable: typeof item.actionable === 'boolean' ? item.actionable : null,
      evidenceSha256: matchingString(item.evidenceSha256, SHA256_HEX_PATTERN, 64),
      attempts: nonNegativeInteger(item.attempts),
      resolutionRule: matchingString(item.resolutionRule, DLQ_RULE, 128),
      createdAt: boundedString(item.createdAt, 64),
      dispositionAt: boundedString(item.dispositionAt, 64),
      resolvedAt: boundedString(item.resolvedAt, 64),
      reopenCount: nonNegativeInteger(item.reopenCount),
      lastReopenedAt: boundedString(item.lastReopenedAt, 64),
    }))
    : [];
  return {
    schemaVersion: page.schemaVersion === 1 ? 1 : null,
    items,
    total: nonNegativeInteger(page.total),
    truncated: typeof page.truncated === 'boolean' ? page.truncated : null,
    nextCursor: safeDlqCursor(page.nextCursor),
  };
}

/** Safe, exact acknowledgement for the no-replay mutation. */
export function safeDlqResolution(value: unknown): Row {
  const result = object(value) ?? {};
  return {
    schemaVersion: result.schemaVersion === 1 ? 1 : null,
    suite: result.suite === 'cauce-v3-dlq-no-replay-resolution' ? result.suite : null,
    phase: result.phase === 'resolved' ? result.phase : null,
    appliedCount: nonNegativeInteger(result.appliedCount),
    alreadyApplied: typeof result.alreadyApplied === 'boolean' ? result.alreadyApplied : null,
    evidenceSha256: matchingString(result.evidenceSha256, SHA256_HEX_PATTERN, 64),
    reasonSha256: matchingString(result.reasonSha256, SHA256_HEX_PATTERN, 64),
    possibleDuplicateAcknowledged: typeof result.possibleDuplicateAcknowledged === 'boolean'
      ? result.possibleDuplicateAcknowledged
      : null,
    possibleNoDeliveryAcknowledged: typeof result.possibleNoDeliveryAcknowledged === 'boolean'
      ? result.possibleNoDeliveryAcknowledged
      : null,
  };
}

/** Browser-safe projection for a durable replay acknowledgement. */
export function safeReplayReceipt(value: unknown): Row {
  const result = object(value) ?? {};
  return {
    delivery_id: matchingString(result.delivery_id, RFC_UUID_PATTERN, 64),
    replayed_from_delivery_id: matchingString(result.replayed_from_delivery_id, RFC_UUID_PATTERN, 64),
    state: result.state === 'pending' ? 'pending' : null,
    replayed: typeof result.replayed === 'boolean' ? result.replayed : null,
  };
}

/**
 * Browser-safe cancellation acknowledgement.  The durable reason remains in DB/audit; reflecting
 * it here would disclose operator text through a response that only needs causal booleans.
 */
export function safeCancelReceipt(value: unknown): Row {
  const result = object(value) ?? {};
  return {
    delivery_id: matchingString(result.delivery_id, RFC_UUID_PATTERN, 64),
    state: result.state === 'dead' ? 'dead' : null,
    cancelled: typeof result.cancelled === 'boolean' ? result.cancelled : null,
    cancelled_from_state: typeof result.cancelled_from_state === 'string'
      && CANCELLABLE_DELIVERY_STATES.has(result.cancelled_from_state)
      ? result.cancelled_from_state
      : null,
    parent_notice: typeof result.parent_notice === 'string'
      && PARENT_NOTICE_DISPOSITIONS.has(result.parent_notice)
      ? result.parent_notice
      : null,
    origin_relayed: typeof result.origin_relayed === 'boolean' ? result.origin_relayed : null,
    replayable: typeof result.replayable === 'boolean' ? result.replayable : null,
  };
}

export function sameTenantRows(value: Row, principal: Principal): Row {
  const items = Array.isArray(value.items)
    ? value.items.map(object).filter((item): item is Row => item !== undefined)
      .filter((item) => item.tenant_id === principal.tenant_id)
    : [];
  return { ...value, items };
}

export function visibleOriginRelays(value: Row, principal: Principal): Row {
  const items = Array.isArray(value.items)
    ? value.items.map(object).filter((item): item is Row => item !== undefined).filter((item) => {
      if (item.actor_alias === principal.alias && item.tenant_id === principal.tenant_id) return true;
      if (Array.isArray(item.participants) && item.participants.some((entry) => participant(entry, principal))) return true;
      return item.recipient_tenant === principal.tenant_id && item.recipient_alias === principal.alias;
    })
    : [];
  return { ...value, items };
}
