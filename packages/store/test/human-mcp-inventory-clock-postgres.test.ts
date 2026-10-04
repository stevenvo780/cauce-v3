import { describe, expect, it } from 'vitest';
import { projectGatewayAgents, projectGatewayStatus } from '../../../packages/mcp-fleet-monitor/src/gateway-projection.js';
import { createHumanMcpOperationsFactory } from '../../../services/gateway/src/mcp-operations.js';
import {
  databasePool, getRepository, inventoryBarrier, reader, readList, seedInventoryLease, waitInventory,
} from './human-mcp-inventory-clock-postgres.fixtures.js';
import { verifiedIdentity } from './human-owned-receipt-postgres.fixtures.js';

type InventoryRow = Record<string, unknown>;

function rows(value: unknown): InventoryRow[] {
  if (Array.isArray(value)) return value as InventoryRow[];
  if (value !== null && typeof value === 'object' && 'items' in value && Array.isArray(value.items)) {
    return value.items as InventoryRow[];
  }
  throw new Error('real inventory read returned an invalid shape');
}

function record(value: unknown): InventoryRow {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value as InventoryRow;
  throw new Error('real gateway operation returned an invalid object');
}

async function expireLeaseWhileReadWaits(kind: 'presence' | 'agents'): Promise<void> {
  const account = await reader();
  await seedInventoryLease(account.alias);
  const barrier = inventoryBarrier(account, kind);
  const pending = readList(kind, account, barrier.options);
  void pending.catch(() => undefined);
  try {
    await waitInventory(barrier, pending);
    await databasePool().query(
      `UPDATE connection_leases SET lease_until=clock_timestamp()+interval '250 milliseconds'
       WHERE tenant_id='Steven' AND alias=$1`, [account.alias],
    );
    const deadline = Date.now() + 3_000;
    let expired = false;
    while (Date.now() < deadline) {
      const result = await databasePool().query<{ expired: boolean }>(
        `SELECT lease_until <= clock_timestamp() AS expired FROM connection_leases
         WHERE tenant_id='Steven' AND alias=$1`, [account.alias],
      );
      if (result.rows[0]?.expired) {
        expired = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(expired).toBe(true);
    barrier.release();
    const value = await pending;
    const ownRow = rows(value).find((row) => row.alias === account.alias && row.tenant_id === 'Steven');
    expect(ownRow).toBeDefined();
    expect(ownRow?.online).toBe(false);
  } finally {
    barrier.release();
    await pending.catch(() => undefined);
  }
}

describe('human MCP inventory clock and timestamps on PostgreSQL', () => {
  it('evaluates presence lease freshness after a real authority-lock wait', async () => {
    await expireLeaseWhileReadWaits('presence');
  }, 30_000);

  it('evaluates agent lease freshness after a real authority-lock wait', async () => {
    await expireLeaseWhileReadWaits('agents');
  }, 30_000);

  it('preserves legacy now() statement-start semantics across a PostgreSQL table-lock wait', async () => {
    const account = await reader();
    await seedInventoryLease(account.alias);
    const lease = await databasePool().query<{ lease_until: Date }>(
      `UPDATE connection_leases SET lease_until=clock_timestamp()+interval '400 milliseconds'
       WHERE tenant_id='Steven' AND alias=$1 RETURNING lease_until`, [account.alias],
    );
    const leaseUntil = lease.rows[0]?.lease_until;
    if (!(leaseUntil instanceof Date)) throw new Error('legacy clock fixture did not return its lease timestamp');
    const holder = await databasePool().connect();
    const observer = await databasePool().connect();
    let pending: Promise<Record<string, unknown>[]> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query('LOCK TABLE connection_leases IN ACCESS EXCLUSIVE MODE');
      pending = getRepository().listPresence('Steven', account.alias);
      void pending.catch(() => undefined);

      const blockedDeadline = Date.now() + 3_000;
      let blocked = false;
      while (Date.now() < blockedDeadline) {
        await observer.query('SELECT pg_stat_clear_snapshot()');
        const result = await observer.query<{ blocked: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM pg_stat_activity
             WHERE query LIKE '%FROM connection_leases l%'
               AND cardinality(pg_blocking_pids(pid)) > 0
           ) AS blocked`,
        );
        if (result.rows[0]?.blocked) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);

      const expiryDeadline = Date.now() + 3_000;
      let expired = false;
      while (Date.now() < expiryDeadline) {
        const result = await observer.query<{ expired: boolean }>(
          `SELECT clock_timestamp() >= $1::timestamptz AS expired`,
          [leaseUntil],
        );
        if (result.rows[0]?.expired) {
          expired = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(expired).toBe(true);
      await holder.query('COMMIT');
      const value = await pending;
      const ownRow = rows(value).find((row) => row.alias === account.alias && row.tenant_id === 'Steven');
      expect(ownRow?.online).toBe(true);
    } finally {
      await holder.query('ROLLBACK');
      await pending?.catch(() => undefined);
      holder.release();
      observer.release();
    }
  }, 30_000);

  it('serializes human timestamps for gateway projections while preserving legacy Date rows', async () => {
    const account = await reader();
    await seedInventoryLease(account.alias);

    const humanPresence = await readList('presence', account);
    const humanPresenceRow = rows(humanPresence).find((row) => row.alias === account.alias && row.tenant_id === 'Steven');
    expect(humanPresenceRow?.last_heartbeat_at).toEqual(expect.any(String));
    expect(() => projectGatewayStatus({ version: '3.0', presence: humanPresence }, 'Steven')).not.toThrow();

    const humanAgents = await readList('agents', account);
    const humanAgentRow = rows(humanAgents).find((row) => row.alias === account.alias && row.tenant_id === 'Steven');
    expect(humanAgentRow?.last_heartbeat_at).toEqual(expect.any(String));
    expect(() => projectGatewayAgents(humanAgents, 'Steven')).not.toThrow();

    const operations = createHumanMcpOperationsFactory({
      pool: databasePool(), repository: getRepository(),
      priorityLog: { info: () => undefined, warn: () => undefined }, logRedaction: () => undefined,
    });
    const request = await operations.forRequest(verifiedIdentity(account, ['cauce.read']), new AbortController().signal);
    const status = record(await request.status());
    const presenceRow = rows(record(status.presence).items).find((row) => row.alias === account.alias);
    expect(presenceRow?.online).toBe(true);
    expect(presenceRow?.last_heartbeat_at).toBeTypeOf('string');
    const agents = rows(await request.agents());
    const agentRow = agents.find((row) => row.alias === account.alias);
    expect(agentRow?.online).toBe(true);
    expect(agentRow?.deployment_status).toBe('online');
    expect(agentRow?.last_heartbeat_at).toBeTypeOf('string');

    const legacyPresence = await getRepository().listPresence('Steven', account.alias);
    const legacyPresenceRow = rows(legacyPresence).find((row) => row.alias === account.alias && row.tenant_id === 'Steven');
    expect(legacyPresenceRow?.last_heartbeat_at).toBeInstanceOf(Date);

    const legacyAgents = await getRepository().listAgents('Steven', account.alias);
    const legacyAgentRow = rows(legacyAgents).find((row) => row.alias === account.alias && row.tenant_id === 'Steven');
    expect(legacyAgentRow?.last_heartbeat_at).toBeInstanceOf(Date);
  }, 30_000);
});
