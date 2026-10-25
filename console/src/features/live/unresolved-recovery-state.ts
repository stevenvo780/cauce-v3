import type { ConsoleFleetOperation } from '@cauce/protocol/console-fleet-operation';

/** A failed update whose previous state was restored: nothing is left to repair, only the record still blocks a restart. */
export function isRestoredUpdate(operation: ConsoleFleetOperation): boolean {
  return operation.kind === 'update' && operation.status === 'failed' && operation.error?.retryable === false
    && operation.steps.some(step => step.status === 'compensated')
    && !operation.steps.some(step => ['running', 'failed', 'waiting'].includes(step.status));
}

/** A failed update whose automatic restoration gave up after its durable limit of attempts. */
export function isExhaustedRestoration(operation: ConsoleFleetOperation): boolean {
  return operation.kind === 'update' && operation.status === 'failed' && operation.error?.reason === 'compensation_attempts_exhausted';
}
