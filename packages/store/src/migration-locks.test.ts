import { describe, expect, it } from 'vitest';
import {
  defaultMigrationLockTimeoutMs, migrationLockFootprints, migrationLockOrder, migrationLockTimeoutMs, migrationTableLocks,
} from './migration-locks.js';

describe('migration pre-lock plan', () => {
  it('names every footprint table exactly once in the lock order', () => {
    const footprintTables = new Set(Object.values(migrationLockFootprints).flatMap((footprint) => Object.keys(footprint)));
    expect(new Set(migrationLockOrder).size).toBe(migrationLockOrder.length);
    expect([...footprintTables].sort()).toEqual([...migrationLockOrder].sort());
  });

  it('keeps the strongest mode per table and the canonical order', () => {
    const locks = migrationTableLocks(['054_company_admins.sql', '053_company_isolation.sql', '058_context_versions.sql']);
    expect(locks.map((lock) => lock.table)).toEqual(migrationLockOrder.filter((table) => locks.some((lock) => lock.table === table)));
    expect(locks.find((lock) => lock.table === 'tenants')?.mode).toBe('ACCESS EXCLUSIVE');
    expect(locks.find((lock) => lock.table === 'memberships')?.mode).toBe('ACCESS EXCLUSIVE');
    expect(locks.find((lock) => lock.table === 'role_policies')?.mode).toBe('SHARE');
    const order = locks.map((lock) => lock.table);
    expect(order.indexOf('deliveries')).toBeLessThan(order.indexOf('messages'));
    expect(order[0]).toBe('tenants');
  });

  it('plans nothing for migrations without a footprint', () => {
    expect(migrationTableLocks(['001_initial.sql', '061_people_admin_history.sql'])).toEqual([]);
  });

  it('reads the lock timeout in milliseconds and rejects anything else', () => {
    expect(migrationLockTimeoutMs(undefined)).toBe(defaultMigrationLockTimeoutMs);
    expect(migrationLockTimeoutMs('')).toBe(defaultMigrationLockTimeoutMs);
    expect(migrationLockTimeoutMs('1500')).toBe(1500);
    for (const invalid of ['0', '5s', '-1', '1.5', '60001', ' 100']) {
      expect(() => migrationLockTimeoutMs(invalid)).toThrow('CAUCE_MIGRATION_LOCK_TIMEOUT_MS');
    }
  });
});
