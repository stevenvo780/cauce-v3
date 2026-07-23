import { describe, expect, it } from 'vitest';
import { FairLaneScheduler } from '../../services/dispatcher/src/scheduler.js';

describe('lane fairness', () => {
  it('bounds batch starvation while preserving interactive priority', () => {
    const scheduler = new FairLaneScheduler(3);
    expect(Array.from({ length: 8 }, () => scheduler.next(true, true))).toEqual([
      'interactive', 'interactive', 'interactive', 'batch',
      'interactive', 'interactive', 'interactive', 'batch'
    ]);
  });

  it('serves batch immediately after a long interactive-only run', () => {
    const scheduler = new FairLaneScheduler(2);
    scheduler.next(true, false);
    scheduler.next(true, false);
    expect(scheduler.next(true, true)).toBe('batch');
  });
});
