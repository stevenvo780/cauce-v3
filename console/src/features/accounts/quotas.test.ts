import { expect, it } from 'vitest';
import { quotaWindowName } from './quotas';

it('nombra las ventanas en castellano, sin las claves del proveedor', () => {
  expect(quotaWindowName({ window_key: 'five-hour', window_minutes: 300 })).toBe('5 h');
  expect(quotaWindowName({ window_key: 'seven-day' })).toBe('Semanal');
  expect(quotaWindowName({ window_key: 'x', window_minutes: 10_080 })).toBe('Semanal');
  expect(quotaWindowName({ window_key: 'x', window_minutes: 90 })).toBe('90 min');
  expect(quotaWindowName({ window_key: 'custom' })).toBe('custom');
});
