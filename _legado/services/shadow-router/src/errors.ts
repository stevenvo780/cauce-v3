/** A durable idempotency key exists, but its trusted immutable dimensions differ. */
export class ShadowInboxIdempotencyConflictError extends Error {
  readonly code = 'shadow_inbox_idempotency_conflict';

  constructor() {
    super('shadow inbox idempotency conflict');
    this.name = 'ShadowInboxIdempotencyConflictError';
  }
}

/**
 * Routing failed with an explicit side-effect boundary.
 *
 * Before the target method is invoked, returning the inbox lease may safely restore the claim's
 * attempt. Once that call boundary is crossed, the outcome is ambiguous and must consume an
 * attempt even when cancellation wins the response race.
 */
export class ShadowRouteExecutionError extends Error {
  readonly targetInvoked: boolean;

  constructor(error: unknown, targetInvoked: boolean) {
    super(error instanceof Error ? error.message : 'shadow routing failed');
    this.name = 'ShadowRouteExecutionError';
    this.targetInvoked = targetInvoked;
  }
}
