import { describe, expect, it } from 'vitest';
import { isNightHour } from './daylight';

describe('isNightHour', () => {
  it('is night from 20:00 until 07:00 on the viewer clock', () => {
    for (const hour of [20, 23, 0, 3, 6]) expect(isNightHour(hour)).toBe(true);
    for (const hour of [7, 9, 13, 19]) expect(isNightHour(hour)).toBe(false);
  });
});
