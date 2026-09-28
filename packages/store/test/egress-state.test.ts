import { describe, expect, it } from 'vitest';
import { deriveAgentEgressState, toAgentEgressItem, type AgentEgressRow } from '../src/repository/agents/egress-state.js';

const base: AgentEgressRow = {
  notification_id: 'n1', source_delivery_id: 'd1', source_attempt: 1, notify_index: 0,
  handle: 'steven_dm', kind: 'decision_request', adapter: 'telegram', conversation_id: '6979524541',
  decision: 'allowed', denial_code: null, produced_outbox_id: 'o1', created_at: '2026-09-08T20:27:19.000Z',
  outbox_status: 'sent', chunk_count: 1, chunks_seen: 1, chunks_sent: 1, states: ['sent'],
  provider_message_ids: ['2703'], effect_ids: ['o1:0'], last_sent_at: '2026-09-08T20:27:20.000Z',
};

describe('agent egress receipt state', () => {
  it('confirms sent only from a per-chunk receipt and exposes the provider id', () => {
    const item = toAgentEgressItem(base);
    expect(item.state).toBe('sent');
    expect(item.provider_message_id).toBe('2703');
    expect(item.sent_at).toBe('2026-09-08T20:27:20.000Z');
    expect(item.destination).toEqual({ adapter: 'telegram', channel: 'telegram', conversation_id: '6979524541', handle: 'steven_dm' });
  });
  it('never declares a multi-chunk send delivered from one sent chunk', () => {
    const row: AgentEgressRow = { ...base, chunk_count: 3, chunks_seen: 3, chunks_sent: 1,
      states: ['sent', 'prepared', 'prepared'], provider_message_ids: ['2703', null, null] };
    const item = toAgentEgressItem(row);
    expect(item.state).toBe('partial');
    expect(item.provider_message_id).toBeUndefined();
    expect(item.provider_message_ids).toEqual(['2703']);
    expect(item.chunks).toEqual({ expected: 3, sent: 1 });
  });
  it('reports an outbox marked sent without any receipt as unconfirmed, not sent', () => {
    const row: AgentEgressRow = { ...base, chunk_count: null, chunks_seen: 0, chunks_sent: 0, states: null,
      provider_message_ids: null, effect_ids: null, last_sent_at: null };
    const item = toAgentEgressItem(row);
    expect(item.state).toBe('unconfirmed');
    expect(item.provider_message_id).toBeUndefined();
    expect(item.sent_at).toBeUndefined();
  });
  it('maps the real source states: pending, ambiguous, dead, denied, unknown', () => {
    expect(deriveAgentEgressState({ ...base, outbox_status: 'pending', chunk_count: null, chunks_seen: 0, chunks_sent: 0, states: null })).toBe('pending');
    expect(deriveAgentEgressState({ ...base, chunks_sent: 0, states: ['sending'], provider_message_ids: [null] })).toBe('pending');
    expect(deriveAgentEgressState({ ...base, chunk_count: 2, chunks_seen: 2, chunks_sent: 1, states: ['sent', 'ambiguous'] })).toBe('ambiguous');
    expect(deriveAgentEgressState({ ...base, states: ['dead'], chunks_sent: 0 })).toBe('dead');
    expect(deriveAgentEgressState({ ...base, outbox_status: 'failed' })).toBe('dead');
    expect(deriveAgentEgressState({ ...base, decision: 'denied', denial_code: 'quota', produced_outbox_id: null, outbox_status: null })).toBe('denied');
    expect(deriveAgentEgressState({ ...base, produced_outbox_id: null, outbox_status: null })).toBe('unknown');
  });
  it('accepts count columns as strings from the driver', () => {
    expect(deriveAgentEgressState({ ...base, chunk_count: '1', chunks_seen: '1', chunks_sent: '1' })).toBe('sent');
  });
});
