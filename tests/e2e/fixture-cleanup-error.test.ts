import { describe, expect, it } from 'vitest';
import { cleanupLabelsForFailure, createCleanupAggregate } from './fixture-cleanup-error.js';

describe('real PTY cleanup error summary', () => {
  it('reports static step labels while preserving nested causes without printing their messages', () => {
    const secretMarker = 'cleanup-secret-marker-must-not-leak';
    const originalCause = new Error(secretMarker);
    const resourceFailure = new Error('cleanup failed for owned browser image', { cause: originalCause });
    const unknownFailure = new Error(`unrecognized cleanup failure: ${secretMarker}`);
    const nested = new AggregateError([resourceFailure, unknownFailure], 'trusted browser cleanup was incomplete');
    const labels = cleanupLabelsForFailure('owned browser runtime', nested);
    const aggregate = createCleanupAggregate([nested], labels);

    expect(aggregate.message).toBe('real PTY fixture cleanup incomplete; failed steps: owned browser runtime, owned browser image');
    expect(aggregate.message).not.toContain(secretMarker);
    expect(aggregate.errors).toEqual([nested]);
    expect(aggregate.errors[0]).toBe(nested);
    expect(nested.errors[0]).toBe(resourceFailure);
    expect(nested.errors[1]).toBe(unknownFailure);
    expect(resourceFailure.cause).toBe(originalCause);
  });
});
