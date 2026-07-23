import { describe, expect, it, vi } from 'vitest';
import { asClaimedJob, JobHandlerRegistry } from '../src/handlers.js';

describe('JobHandlerRegistry', () => {
  it('has no fallback and invokes only a registered kind', async () => {
    const execute = vi.fn(async () => undefined);
    const registry = new JobHandlerRegistry().register('known.kind', execute);
    const job = asClaimedJob({
      id: 'job-1', kind: 'known.kind', lane: 'interactive', payload: { input: 1 }, claim_token: 'claim-1'
    });
    await registry.get(job.kind)?.(job);
    expect(execute).toHaveBeenCalledOnce();
    expect(registry.get('unknown.kind')).toBeUndefined();
  });

  it('rejects malformed claims and duplicate registrations', () => {
    const registry = new JobHandlerRegistry().register('known.kind', async () => undefined);
    expect(() => registry.register('known.kind', async () => undefined)).toThrow(/duplicate/);
    expect(() => asClaimedJob({ id: 'job-1', kind: 'known.kind', lane: 'batch', payload: [] })).toThrow(/payload/);
  });
});
