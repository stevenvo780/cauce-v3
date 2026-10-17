import { describe, expect, it } from 'vitest';
import { factorDePlazos, plazo } from '../helpers/plazos.js';

describe('fixture budgets under the release gate', () => {
  it('keeps the idle budget outside the gate and stretches it by the exported factor', () => {
    expect(plazo(15_000, {})).toBe(15_000);
    expect(plazo(15_000, { CAUCE_PLAZOS_FACTOR: '' })).toBe(15_000);
    expect(plazo(15_000, { CAUCE_PLAZOS_FACTOR: '3' })).toBe(45_000);
    expect(plazo(5, { CAUCE_PLAZOS_FACTOR: '1.5' })).toBe(8);
  });

  it('refuses a factor that would shrink a budget or wave a hang through', () => {
    for (const crudo of ['0.5', '0', '-2', '21', 'NaN', 'tres']) {
      expect(() => factorDePlazos({ CAUCE_PLAZOS_FACTOR: crudo })).toThrow('CAUCE_PLAZOS_FACTOR');
    }
  });
});
