import type {
  ConsolePublishIntentExpired,
  ConsolePublishIntentReconciliation,
  PublishResult as ProtocolPublishResult,
} from '@cauce/protocol';
import { StoreError } from '../errors.js';

export class PublishIntentReconciliationRequired extends StoreError {
  constructor(readonly reconciliation: ConsolePublishIntentReconciliation) {
    super('conflict', 'a committed console publish intent requires explicit reconciliation');
    this.name = 'PublishIntentReconciliationRequired';
  }
}

export class PublishIntentExpiredError extends StoreError {
  readonly expiration: ConsolePublishIntentExpired;

  constructor(idempotencyKey: string) {
    super('conflict', 'console publish intent expired before it produced an effect');
    this.name = 'PublishIntentExpiredError';
    this.expiration = {
      version: 1,
      error: 'publish_intent_expired',
      state: 'expired',
      idempotency_key: idempotencyKey,
      safe_to_resubmit: true,
    };
  }
}

export type PublishResult = ProtocolPublishResult;

export interface PublishOptions {
  /** Console-only gate. Machine endpoints deliberately leave it disabled. */
  readonly requirePreparedConsoleIntent?: boolean;
  readonly consoleIntentOperatorScope?: string;
}

export function terminal(status: string): boolean {
  return status === 'done' || status === 'failed' || status === 'dead';
}
