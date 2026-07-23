export type JobLane = 'interactive' | 'batch';

/** Weighted round-robin: at most interactiveBurst interactive picks while batch work waits. */
export class FairLaneScheduler {
  private interactiveSinceBatch = 0;

  constructor(private readonly interactiveBurst = 3) {
    if (!Number.isInteger(interactiveBurst) || interactiveBurst < 1) {
      throw new Error('interactiveBurst must be a positive integer');
    }
  }

  next(hasInteractive: boolean, hasBatch: boolean): JobLane | undefined {
    if (!hasInteractive && !hasBatch) return undefined;
    if (!hasBatch) {
      this.interactiveSinceBatch = Math.min(this.interactiveBurst, this.interactiveSinceBatch + 1);
      return 'interactive';
    }
    if (!hasInteractive) {
      this.interactiveSinceBatch = 0;
      return 'batch';
    }
    if (this.interactiveSinceBatch >= this.interactiveBurst) {
      this.interactiveSinceBatch = 0;
      return 'batch';
    }
    this.interactiveSinceBatch += 1;
    return 'interactive';
  }
}
