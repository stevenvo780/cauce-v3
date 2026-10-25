export type StoreErrorCode =
  'forbidden' | 'no_route' | 'conflict' | 'fenced' | 'not_found' | 'invalid_actor'
  | 'invalid_input' | 'rate_limited';

export type StoreRecoveryReason =
  | 'consumer_capacity_missing'
  | 'consumer_capacity_invalid'
  | 'consumer_disabled'
  | 'idempotency_durable_conflict'
  | 'context_write_commit_unverified';

export class StoreError extends Error {
  constructor(
    public readonly code: StoreErrorCode,
    message: string,
    public readonly recoveryReason?: StoreRecoveryReason,
  ) {
    super(message);
    this.name = 'StoreError';
  }
}
