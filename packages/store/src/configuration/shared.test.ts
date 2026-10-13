import { describe, expect, it } from 'vitest';
import { ConfigurationError } from './contracts.js';
import { databaseError } from './shared.js';

describe('configuration database contention errors', () => {
  it.each(['55P03', '40001', '40P01'])('maps %s to a retryable conflict without exposing driver details', code => {
    try { databaseError({ code, message: 'private database details' }); }
    catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect(error).toMatchObject({ code: 'conflict', message: 'authority is busy; reload and retry' });
      return;
    }
    throw new Error('database contention must reject');
  });
  it('preserves unrelated failures', () => {
    const failure = new Error('unexpected failure');
    expect(() => databaseError(failure)).toThrow(failure);
  });
});
