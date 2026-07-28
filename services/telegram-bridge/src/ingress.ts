import { createHash } from 'node:crypto';
import { PROTOCOL_VERSION, PublishMessageSchema, type PublishMessage } from '@cauce/protocol';
import type { CauceRepository } from '@cauce/store';
import type { TelegramIngress, TelegramIngressMessage } from './types.js';

function stableUuid(namespace: string): string {
  const bytes = createHash('sha256').update(namespace).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class StoreTelegramIngress implements TelegramIngress {
  constructor(private readonly repository: Pick<CauceRepository, 'publish'>) {}

  async publish(message: TelegramIngressMessage): Promise<{ duplicate: boolean }> {
    const correlation = `telegram:${message.bot_id}:${message.update_id}`;
    const command: PublishMessage = {
      version: PROTOCOL_VERSION,
      request_id: stableUuid(`request:${correlation}`),
      trace_id: `telegram-${createHash('sha256').update(correlation).digest('hex').slice(0, 32)}`,
      tenant_id: message.tenant_id,
      room_id: message.room_id,
      actor_alias: message.alias,
      recipients: [...message.recipients],
      body: message.body,
      idempotency_key: correlation,
      lane: 'interactive',
      priority: 0,
      authenticated_context: {
        session_id: message.session_id,
        channel: 'telegram',
        origin: message.origin
      }
    };
    const result = await this.repository.publish(PublishMessageSchema.parse(command));
    return { duplicate: result.duplicate };
  }
}

export { stableUuid };
