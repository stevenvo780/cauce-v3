import type {
  ConsolePublishIntentExpired,
  ConsolePublishIntentReconciliation,
  PublishResult as ProtocolPublishResult,
  Tenant,
} from '@cauce/protocol';
import type { DatabaseClient } from '../../db.js';
import { StoreError } from '../errors.js';
import type { ConsoleMessageAuthor } from './author.js';
import type { HumanClientProvenance } from '../../human-client-provenance.js';

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

export interface HumanPublishProvenance {
  readonly humanId: string;
  readonly tenantId: Tenant;
  readonly actorAlias: string;
  readonly clientProvenance?: HumanClientProvenance;
}

export interface HumanMessageOptions {
  readonly humanAuthority: (client: DatabaseClient) => Promise<Readonly<HumanPublishProvenance>>;
  readonly signal: AbortSignal;
  readonly coalesceConsolePublishIntents?: boolean;
}

export interface SystemGateProbeAuthority {
  readonly tenant_id: Tenant;
  readonly alias: 'gate-probe';
  readonly session_id: 'gate-probe';
  readonly channel: 'gate';
}

export interface PublishOptions extends Partial<HumanMessageOptions> {
  readonly systemGateProbeAuthority?: SystemGateProbeAuthority;
  /** Console-only gate. Machine endpoints deliberately leave it disabled. */
  readonly requirePreparedConsoleIntent?: boolean;
  readonly consoleIntentOperatorScope?: string;
  readonly consoleAuthor?: ConsoleMessageAuthor;
  readonly agentRoot?: boolean; // Server-derived from the principal's roles, never from the request body.
}

export function terminal(status: string): boolean {
  return status === 'done' || status === 'failed' || status === 'dead';
}
