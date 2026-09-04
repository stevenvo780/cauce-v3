import { createHash } from 'node:crypto';
import {
  deterministicUuidFromSha256, HUMAN_CHAT_PRIORITY, PROTOCOL_VERSION, PublishMessageSchema,
  type PublishMessage
} from '@cauce/protocol';
import type { CauceRepository } from '@cauce/store';
import type { TelegramIngress, TelegramIngressMessage } from './types.js';

export class StoreTelegramIngress implements TelegramIngress {
  constructor(private readonly repository: Pick<CauceRepository, 'publish'>) {}

  async publish(message: TelegramIngressMessage): ReturnType<TelegramIngress['publish']> {
    const correlation = `telegram:${message.bot_id}:${String(message.update_id)}`;
    const command: PublishMessage = {
      version: PROTOCOL_VERSION,
      request_id: deterministicUuidFromSha256(`request:${correlation}`),
      trace_id: `telegram-${createHash('sha256').update(correlation).digest('hex').slice(0, 32)}`,
      tenant_id: message.tenant_id,
      room_id: message.room_id,
      actor_alias: message.alias,
      recipients: [...message.recipients],
      body: message.body,
      idempotency_key: correlation,
      lane: 'interactive',
      // A person on a chat channel enters the reserved human band; anything else stays at the
      // neutral 0 it has always used. `human` is the poller's derived fact, not a name in this
      // file: see TelegramIngressMessage.human.
      //
      // Only the ENTRY POINT is privileged. The agent traffic this message spawns is clamped back
      // to AGENT_PRIORITY_CEILING by the store when it materializes an ACK, so the human band
      // cannot grow with fan-out and cannot starve background work.
      priority: message.human ? HUMAN_CHAT_PRIORITY : 0,
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
