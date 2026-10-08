import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import type { DatabasePool } from '@cauce/store';
import { buildGateway } from '../../services/gateway/src/index.js';
import { DevOnlyAuthProvider } from '../../services/gateway/src/auth.js';
import { noDeliveryWakes } from './helpers.js';
import {
  apps, connect, deliveryId, humanDelivery, queuedRepository, registerDeliveryAdmissionTeardown,
} from './delivery-admission-helpers.js';

registerDeliveryAdmissionTeardown();

/*
 * Work that becomes claimable without any edge — a hold released or expired, a claim that skipped a
 * locked row, a lost NOTIFY — must not wait for an unrelated publish to the same alias.
 */

type Store = ReturnType<typeof queuedRepository>;

/** The pool answers the sweep the way PostgreSQL would: the alias is claimable while it has work. */
function sweepPool(store: Store, claimable: () => boolean = () => store.pending().length > 0): {
  pool: DatabasePool; sweeps: () => number;
} {
  let sweeps = 0;
  const query = vi.fn(async (sql: string) => {
    if (!sql.includes('terminal_control_holds')) return { rows: [{ '?column?': 1 }], rowCount: 1 };
    sweeps += 1;
    const rows = claimable() ? [{ tenant_id: 'Pablo', alias: 'midas' }] : [];
    return { rows, rowCount: rows.length };
  });
  return { pool: { query } as unknown as DatabasePool, sweeps: () => sweeps };
}

async function start(store: Store, pool: DatabasePool, pendingSweepMs: number): Promise<number> {
  const app = await buildGateway({
    pool, repository: store.repository, authProvider: DevOnlyAuthProvider.forTests(),
    deliveryWakeSubscriber: noDeliveryWakes,
    admission: { maxInflightDeliveries: 2, humanReservedDeliveries: 2 },
    ackDeadlineMs: 600_000, outboxPollMs: 60_000, pendingSweepMs,
  });
  apps.push(app);
  await app.listen({ host: '127.0.0.1', port: 0 });
  return (app.server.address() as AddressInfo).port;
}

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('gateway pending sweep', () => {
  it('drains a delivery that became claimable with no wake, without any new publish', async () => {
    const store = queuedRepository();
    const { pool } = sweepPool(store);
    const session = await connect(await start(store, pool, 50), 'swept-consumer');
    await settle(100);
    expect(session.seen().filter((frame) => frame.type === 'delivery')).toHaveLength(0);

    store.enqueue(humanDelivery(1, 'hold liberado'));
    expect(await session.next()).toMatchObject({ type: 'delivery', delivery_id: deliveryId(1) });
    expect(store.pending()).toHaveLength(0);
  });

  it('does not touch the claim path while the store reports nothing claimable', async () => {
    const store = queuedRepository();
    const { pool, sweeps } = sweepPool(store, () => false);
    await connect(await start(store, pool, 50), 'idle-consumer');
    const afterHello = store.claimCalls().length;
    await settle(400);
    expect(sweeps()).toBeGreaterThanOrEqual(3);
    expect(store.claimCalls()).toHaveLength(afterHello);
  });

  it('can be disabled, and then only an edge drains', async () => {
    const store = queuedRepository();
    const { pool, sweeps } = sweepPool(store);
    const session = await connect(await start(store, pool, 0), 'unswept-consumer');
    store.enqueue(humanDelivery(1, 'sin barrido'));
    await settle(300);
    expect(sweeps()).toBe(0);
    expect(session.seen().filter((frame) => frame.type === 'delivery')).toHaveLength(0);
    expect(store.pending()).toHaveLength(1);
  });

  it('rejects a cadence outside its bounds', async () => {
    const store = queuedRepository();
    await expect(start(store, sweepPool(store).pool, -1)).rejects.toThrow(/pendingSweepMs/u);
    await expect(start(store, sweepPool(store).pool, 1.5)).rejects.toThrow(/pendingSweepMs/u);
  });
});
