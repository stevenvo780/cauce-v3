import { OutboxOperatorRepository } from './outbox/operator.js';

export {
  objectRecord, textualReply, validConnectionToken, visibleText
} from './outbox/contracts.js';
export type {
  ClaimedOutboxEvent,
  ConnectionSessionFence,
  FencedWakeOutboxRecipient,
  OutboxAck,
  OutboxEvent,
  OutboxRetryResult,
  WakeOutboxClaimFence,
  WakeOutboxRecipient,
} from './outbox/contracts.js';

export abstract class OutboxRepository extends OutboxOperatorRepository {}
