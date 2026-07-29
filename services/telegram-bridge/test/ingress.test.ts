import { describe, expect, it } from 'vitest';
import {
  AGENT_PRIORITY_CEILING, HUMAN_CHAT_PRIORITY, isHumanPriority, type PublishMessage
} from '@cauce/protocol';
import type { CauceRepository, PublishResult } from '@cauce/store';
import { StoreTelegramIngress } from '../src/ingress.js';
import type { TelegramIngressMessage } from '../src/types.js';

class RecordingRepository implements Pick<CauceRepository, 'publish'> {
  readonly published: PublishMessage[] = [];

  async publish(input: PublishMessage): Promise<PublishResult> {
    this.published.push(input);
    return {
      message_id: '11111111-1111-4111-8111-111111111111',
      delivery_ids: ['22222222-2222-4222-8222-222222222222'],
      duplicate: false,
      request_id: input.request_id,
      trace_id: input.trace_id
    };
  }
}

function ingressMessage(overrides: Partial<TelegramIngressMessage> = {}): TelegramIngressMessage {
  return {
    bot_id: '900001',
    update_id: 42,
    tenant_id: 'Steven',
    alias: 'kant',
    room_id: 'grp.steven',
    recipients: [{ tenant_id: 'Steven', alias: 'kant' }],
    body: { type: 'telegram.message', text: '¿cómo va el deploy?' },
    origin: {
      adapter: 'telegram',
      channel: 'telegram',
      conversation_id: '201',
      external_message_id: '142',
      relay: [],
      metadata: { bridge_alias: 'kant', bridge_tenant: 'Steven', chat_type: 'private' }
    },
    session_id: 'telegram:900001:201',
    human: true,
    ...overrides
  };
}

describe('Telegram ingress priority', () => {
  it('admits a message from an allowlisted person into the reserved human band', async () => {
    const repository = new RecordingRepository();
    await new StoreTelegramIngress(repository).publish(ingressMessage());

    const published = repository.published[0];
    expect(published?.priority).toBe(HUMAN_CHAT_PRIORITY);
    expect(isHumanPriority(published?.priority ?? 0)).toBe(true);
    // The band is what changes. The lane, the channel and the idempotency key are the contract
    // the egress and the deduplication depend on and must not move with it.
    expect(published?.lane).toBe('interactive');
    expect(published?.idempotency_key).toBe('telegram:900001:42');
    expect(published?.authenticated_context?.channel).toBe('telegram');
  });

  it('leaves a non-human sender at the neutral priority it has always had', async () => {
    const repository = new RecordingRepository();
    await new StoreTelegramIngress(repository).publish(ingressMessage({ human: false }));

    const published = repository.published[0];
    expect(published?.priority).toBe(0);
    expect(isHumanPriority(published?.priority ?? 0)).toBe(false);
  });

  it('grants a band an agent cannot reach through its own publish surface', async () => {
    const repository = new RecordingRepository();
    await new StoreTelegramIngress(repository).publish(ingressMessage());

    expect(repository.published[0]?.priority).toBeGreaterThan(AGENT_PRIORITY_CEILING);
  });
});
