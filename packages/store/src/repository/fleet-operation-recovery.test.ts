import { describe, expect, it, vi } from 'vitest';
import type { FleetOperationRequest } from '@cauce/protocol';
import type { DatabaseClient } from '../db.js';
import type { FleetOperationRow } from './fleet-operation-contracts.js';
import { assertFleetRecoveryAdmission, FLEET_RECOVERY_STOPPED, lockFleetRecoveryConnection, prepareFleetRecovery } from './fleet-operation-recovery.js';

const writer = '00000000-0000-4000-8000-0000000000a1';
const other = '00000000-0000-4000-8000-0000000000f9';
const identity = { generation: 'a'.repeat(64), container_id: 'b'.repeat(64), writer_instance_id: writer };

function row(strategy?: 'relaunch', force = true): FleetOperationRow {
  const request: FleetOperationRequest = { kind: 'recover', target: { resource: 'agent', tenant_id: 'A', alias: 'one' },
    expected_revision: 4, idempotency_key: 'recover-fixture',
    parameters: { action: 'apply', identity, expected_fingerprint: 'c'.repeat(64), force, ...(strategy ? { strategy } : {}) } };
  return { request } as FleetOperationRow;
}
const running = { enabled: true, lifecycle_state: 'ready', runtime_mode: 'container' };

function client(lease?: { instance_id: string; live: boolean }) {
  const query = vi.fn(async (sql: string) => sql.includes('FROM deliveries') ? { rows: [], rowCount: 0 }
    : { rows: lease ? [lease] : [], rowCount: lease ? 1 : 0 });
  return { client: { query } as unknown as DatabaseClient, query };
}

describe('recovery connection fence', () => {
  it('requires the confirmed live writer for a terminal recovery', async () => {
    await expect(lockFleetRecoveryConnection(client({ instance_id: writer, live: true }).client, row())).resolves.toBeUndefined();
    for (const lease of [undefined, { instance_id: writer, live: false }, { instance_id: other, live: true }]) {
      await expect(lockFleetRecoveryConnection(client(lease).client, row()))
        .rejects.toThrow('recovery adapter connection differs from its confirmed identity');
    }
  });

  it('fences the lease of an interrupted adapter whose instance came from the operation that started it', async () => {
    for (const lease of [undefined, { instance_id: other, live: false }, { instance_id: other, live: true }, { instance_id: writer, live: true }]) {
      const fixture = client(lease);
      await expect(lockFleetRecoveryConnection(fixture.client, row('relaunch', false))).resolves.toBeUndefined();
      expect(fixture.query.mock.calls[0]?.[0]).toContain('FOR UPDATE');
    }
    for (const strategy of [undefined, 'relaunch'] as const) {
      const fixture = client({ instance_id: writer, live: true });
      await prepareFleetRecovery(fixture.client, row(strategy));
      const statements = fixture.query.mock.calls.map(call => call[0]);
      expect(statements.some(sql => sql.includes('UPDATE agents SET enabled=false'))).toBe(true);
      expect(statements.filter(sql => sql.includes('UPDATE connection_leases SET lease_until=now(),epoch=epoch+1'))).toHaveLength(strategy ? 1 : 0);
    }
  });

  it('rejects a running relaunch whose live connection belongs to another writer before any write', async () => {
    for (const lease of [undefined, { instance_id: other, live: false }, { instance_id: writer, live: true }]) {
      await expect(lockFleetRecoveryConnection(client(lease).client, row('relaunch'))).resolves.toBeUndefined();
    }
    const fixture = client({ instance_id: other, live: true });
    await expect(lockFleetRecoveryConnection(fixture.client, row('relaunch')))
      .rejects.toThrow('recovery adapter connection differs from its confirmed identity');
    expect(fixture.query.mock.calls.map(call => call[0]).filter(sql => /^\s*UPDATE/u.test(sql))).toEqual([]);
  });
});

describe('recovery admission', () => {
  it('rejects a stopped or unadmitted agent so Reiniciar never undoes Detener', () => {
    const probe = { ...row().request, parameters: { action: 'probe' } } as FleetOperationRequest;
    for (const request of [row().request, row('relaunch', false).request, probe]) {
      expect(() => { assertFleetRecoveryAdmission(request, running, false); }).not.toThrow();
      for (const agent of [{ ...running, enabled: false, lifecycle_state: 'draft' }, { ...running, enabled: false },
        { ...running, lifecycle_state: 'failed' }, { ...running, lifecycle_state: 'auth_pending' }]) {
        expect(() => { assertFleetRecoveryAdmission(request, agent, false); }).toThrow(FLEET_RECOVERY_STOPPED);
      }
    }
    expect(() => { assertFleetRecoveryAdmission(row('relaunch').request, { ...running, enabled: false, lifecycle_state: 'verifying' }, true); })
      .not.toThrow();
  });

  it('rejects a relaunch outside a dedicated container before the lease is fenced', () => {
    expect(() => { assertFleetRecoveryAdmission(row('relaunch').request, { ...running, runtime_mode: 'native' }, false); })
      .toThrow('relaunch recovery requires a dedicated container runtime');
    expect(() => { assertFleetRecoveryAdmission(row().request, { ...running, runtime_mode: 'native' }, false); }).not.toThrow();
  });
});
