import { describe, expect, it } from 'vitest';
import { cleanupLabelsForFailure, createCleanupAggregate } from './fixture-cleanup-error.js';
import { cleanupAggregate } from '../helpers/cleanup-failure.js';

describe('real PTY cleanup error summary', () => {
  it('names the failed steps and carries every nested cause with its secrets redacted', () => {
    const password = 'Zx9-cleanup-password-must-not-leak';
    const token = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH';
    const daemonFailure = Object.assign(new Error(`subprocess docker failed for postgresql://cauce_test:${password}@10.0.0.2:5432/cauce_test`), {
      code: 1, stderr: `Error response from daemon: Bearer ${token}\npassword=${password}\n`,
    });
    const originalCause = Object.assign(new Error('timed out after 15000ms'), { cause: daemonFailure });
    const resourceFailure = new Error('cleanup failed for owned browser image', { cause: originalCause });
    const unknownFailure = new Error('unrecognized cleanup failure: No such container: cauce-ui-browser-x');
    const nested = new AggregateError([resourceFailure, unknownFailure], 'trusted browser cleanup was incomplete');
    const labels = cleanupLabelsForFailure('owned browser runtime', nested);
    const aggregate = createCleanupAggregate([nested], labels);

    expect(aggregate.message).toMatch(/^real PTY fixture cleanup incomplete; failed steps: owned browser runtime, owned browser image; causes: /u);
    for (const cause of ['trusted browser cleanup was incomplete', 'cleanup failed for owned browser image', 'timed out after 15000ms',
      'No such container: cauce-ui-browser-x', 'code=1', 'Error response from daemon']) expect(aggregate.message).toContain(cause);
    expect(aggregate.message).not.toContain(password);
    expect(aggregate.message).not.toContain(token);
    expect(aggregate.errors).toEqual([nested]);
    expect(aggregate.errors[0]).toBe(nested);
    expect(nested.errors[0]).toBe(resourceFailure);
    expect(resourceFailure.cause).toBe(originalCause);
  });

  it('bounds the detail and survives cyclic causes', () => {
    const cyclic = new Error('first') as Error & { cause?: unknown };
    cyclic.cause = cyclic;
    const aggregate = cleanupAggregate([cyclic, new Error('x'.repeat(10_000))], 'owned drill cleanup failed');
    expect(aggregate.message.startsWith('owned drill cleanup failed; causes: Error: first | Error: ')).toBe(true);
    expect(aggregate.message.length).toBeLessThan(4_100);
  });
});
