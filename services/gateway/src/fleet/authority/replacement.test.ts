import { describe, expect, it } from 'vitest';
import { lateCheckpoint } from './replacement.js';

const steps = (stop: string, later = 'pending') => [
  { name: 'prepare', status: 'succeeded' }, { name: 'stop', status: stop },
  { name: 'artifacts', status: later }, { name: 'credentials', status: 'pending' }, { name: 'runtime', status: 'pending' },
];

describe('lateCheckpoint', () => {
  it('admits a compensation of an update that failed before its stop completed', () => {
    expect(lateCheckpoint({ status: 'cancelling', steps: steps('failed') } as never)).toBe(true);
  });

  it('refuses once the stop completed, a later step started or the operation is not compensating', () => {
    expect(lateCheckpoint({ status: 'cancelling', steps: steps('succeeded') } as never)).toBe(false);
    expect(lateCheckpoint({ status: 'cancelling', steps: steps('failed', 'failed') } as never)).toBe(false);
    expect(lateCheckpoint({ status: 'cancelling', steps: steps('failed', 'running') } as never)).toBe(false);
    expect(lateCheckpoint({ status: 'running', steps: steps('failed') } as never)).toBe(false);
    expect(lateCheckpoint({ status: 'failed', steps: steps('failed') } as never)).toBe(false);
  });
});
