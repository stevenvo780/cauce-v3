import { describe, expect, it } from 'vitest';
import { isMaintenanceOperation, maintenanceBackoffMs } from '../src/repository/fleet-operation-maintenance.js';

describe('host maintenance scheduling', () => {
  it('backs off exponentially and bounds retries after long inactivity', () => {
    expect([1, 2, 3, 7, 8, 1000].map(maintenanceBackoffMs)).toEqual([30_000, 60_000, 120_000, 1_920_000, 3_600_000, 3_600_000]);
    for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => maintenanceBackoffMs(invalid)).toThrow('maintenance attempt is invalid');
    }
  });
  it('recognizes the explicit host subject on durable and public operations', () => {
    const subject = `host:company-host:${'a'.repeat(64)}`;
    expect(isMaintenanceOperation({ actor_subject: subject })).toBe(true);
    expect(isMaintenanceOperation({ actor: { actor_subject: subject } })).toBe(true);
    expect(isMaintenanceOperation({ actor_subject: 'console:00000000-0000-4000-8000-000000000000' })).toBe(false);
    expect(isMaintenanceOperation({})).toBe(false);
  });
});
