import { describe, expect, it } from 'vitest';
import {
  safeAuditPage, safeCancelReceipt, safeDlqPage, safeDlqResolution, safeReplayReceipt
} from './facades.js';

describe('safeAuditPage', () => {
  it('keeps participant-visible cross-tenant rows but drops raw metadata and unsafe summaries', () => {
    const page = safeAuditPage({
      next_cursor: '17',
      metadata: { token: 'page-secret' },
      items: [{
        event_id: '18',
        at: '2026-08-26T08:00:00.000Z',
        tenant_id: 'Miguel',
        actor_alias: 'atlas',
        action: 'delivery.ack',
        decision: 'info',
        request_id: null,
        trace_id: 'trace-visible',
        summary: JSON.stringify({ ack: 'done', token: 'row-secret', body: 'private text' }),
        metadata: { token: 'row-secret' },
        payload: 'private text',
      }],
    });

    expect(page).toEqual({
      next_cursor: '17',
      items: [{
        event_id: '18',
        at: '2026-08-26T08:00:00.000Z',
        tenant_id: 'Miguel',
        actor_alias: 'atlas',
        action: 'delivery.ack',
        decision: 'info',
        request_id: null,
        trace_id: 'trace-visible',
        summary: '{"ack":"done"}',
      }],
    });
    expect(JSON.stringify(page)).not.toContain('secret');
    expect(JSON.stringify(page)).not.toContain('private text');
  });

  it('fails closed on malformed identifiers, decisions, cursors and non-JSON summaries', () => {
    expect(safeAuditPage({
      next_cursor: '01',
      items: [{ event_id: 'x', action: '__proto__', decision: 'allowed', summary: 'raw secret' }],
    })).toEqual({
      next_cursor: null,
      items: [{
        event_id: null,
        at: null,
        tenant_id: null,
        actor_alias: null,
        action: null,
        decision: null,
        request_id: null,
        trace_id: null,
        summary: null,
      }],
    });
  });
});

describe('safeDlqPage', () => {
  it('keeps only the bounded causal projection and drops every sensitive extra field', () => {
    const page = safeDlqPage({
      schemaVersion: 1,
      total: 1,
      truncated: false,
      nextCursor: 'ab12',
      payload: 'page-secret',
      items: [{
        target: 'outbox',
        id: '70000000-0000-4000-8000-000000000001',
        tenantId: 'Steven',
        kind: 'origin_relay',
        adapter: 'telegram',
        disposition: 'ambiguous',
        open: true,
        actionable: true,
        evidenceSha256: 'a'.repeat(64),
        attempts: 3,
        resolutionRule: 'telegram_effect_ambiguous_v1',
        createdAt: '2026-08-26T00:00:00.000Z',
        dispositionAt: null,
        resolvedAt: null,
        reopenCount: 0,
        lastReopenedAt: null,
        payload: { text: 'secret-body' },
        reason: 'secret-reason',
        error: 'secret-error',
        origin: { conversation_id: 'secret-conversation' },
        provider_message_id: 'secret-provider-id',
        message_id: 'secret-message-id',
      }],
    });

    expect(page).toEqual({
      schemaVersion: 1,
      total: 1,
      truncated: false,
      nextCursor: 'ab12',
      items: [{
        target: 'outbox',
        id: '70000000-0000-4000-8000-000000000001',
        tenantId: 'Steven',
        kind: 'origin_relay',
        adapter: 'telegram',
        disposition: 'ambiguous',
        open: true,
        actionable: true,
        evidenceSha256: 'a'.repeat(64),
        attempts: 3,
        resolutionRule: 'telegram_effect_ambiguous_v1',
        createdAt: '2026-08-26T00:00:00.000Z',
        dispositionAt: null,
        resolvedAt: null,
        reopenCount: 0,
        lastReopenedAt: null,
      }],
    });
    const safeItem = (page.items as Record<string, unknown>[])[0];
    if (safeItem === undefined) throw new Error('expected one sanitized DLQ item');
    for (const forbidden of ['payload', 'reason', 'error', 'origin', 'provider_message_id', 'message_id']) {
      expect(safeItem).not.toHaveProperty(forbidden);
    }
    expect(JSON.stringify(page)).not.toContain('secret-');
  });

  it('normalizes malformed fields instead of reflecting attacker-controlled objects or prototypes', () => {
    const page = safeDlqPage({
      schemaVersion: '1',
      total: -1,
      truncated: 'false',
      nextCursor: '__proto__',
      items: [{
        target: 'constructor',
        id: { toString: () => 'not-an-id' },
        tenantId: 'x'.repeat(129),
        disposition: 'toString',
        open: 1,
        actionable: 'true',
        attempts: Number.POSITIVE_INFINITY,
        evidenceSha256: 'a'.repeat(65),
      }],
    });

    expect(page).toEqual({
      schemaVersion: null,
      total: null,
      truncated: null,
      nextCursor: null,
      items: [{
        target: null,
        id: null,
        tenantId: null,
        kind: null,
        adapter: null,
        disposition: null,
        open: null,
        actionable: null,
        evidenceSha256: null,
        attempts: null,
        resolutionRule: null,
        createdAt: null,
        dispositionAt: null,
        resolvedAt: null,
        reopenCount: null,
        lastReopenedAt: null,
      }],
    });
  });

  it('projects a no-replay result without reflecting the durable operator reason', () => {
    const result = safeDlqResolution({
      schemaVersion: 1,
      suite: 'cauce-v3-dlq-no-replay-resolution',
      phase: 'resolved',
      appliedCount: 1,
      alreadyApplied: false,
      evidenceSha256: 'a'.repeat(64),
      reasonSha256: 'b'.repeat(64),
      possibleDuplicateAcknowledged: true,
      possibleNoDeliveryAcknowledged: true,
      reason: 'operator-private-reason',
      payload: 'private-payload',
      actorAlias: 'private-actor',
    });

    expect(result).toEqual({
      schemaVersion: 1,
      suite: 'cauce-v3-dlq-no-replay-resolution',
      phase: 'resolved',
      appliedCount: 1,
      alreadyApplied: false,
      evidenceSha256: 'a'.repeat(64),
      reasonSha256: 'b'.repeat(64),
      possibleDuplicateAcknowledged: true,
      possibleNoDeliveryAcknowledged: true,
    });
    expect(JSON.stringify(result)).not.toContain('private-');
  });
});

describe('safe delivery mutation receipts', () => {
  const sourceId = '70000000-0000-4000-8000-000000000001';
  const replayId = '70000000-0000-4000-8000-000000000002';

  it('projects replay causality and drops unexpected fields', () => {
    expect(safeReplayReceipt({
      delivery_id: replayId,
      replayed_from_delivery_id: sourceId,
      state: 'pending',
      replayed: true,
      reason: 'private',
      payload: { text: 'private' },
    })).toEqual({
      delivery_id: replayId,
      replayed_from_delivery_id: sourceId,
      state: 'pending',
      replayed: true,
    });
  });

  it('projects cancellation without reflecting its private reason', () => {
    const receipt = safeCancelReceipt({
      delivery_id: sourceId,
      state: 'dead',
      cancelled: true,
      cancelled_from_state: 'started',
      parent_notice: 'returned',
      origin_relayed: false,
      replayable: true,
      reason: 'Cancelled by operator Steven:kant: private note',
      payload: { text: 'private' },
    });
    expect(receipt).toEqual({
      delivery_id: sourceId,
      state: 'dead',
      cancelled: true,
      cancelled_from_state: 'started',
      parent_notice: 'returned',
      origin_relayed: false,
      replayable: true,
    });
    expect(JSON.stringify(receipt)).not.toContain('private');
  });

  it('fails closed for non-causal states and forged dispositions', () => {
    expect(safeReplayReceipt({ delivery_id: replayId, state: 'done', replayed: 'true' }))
      .toMatchObject({ state: null, replayed: null });
    expect(safeCancelReceipt({
      delivery_id: sourceId,
      state: 'dead',
      cancelled: true,
      cancelled_from_state: 'done',
      parent_notice: 'constructor',
      origin_relayed: true,
      replayable: true,
    })).toMatchObject({ cancelled_from_state: null, parent_notice: null });
  });
});
