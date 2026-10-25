import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { cancelDeployCapture } from './v4-fleet-cancel-deploy.helpers.js';
import type { CancelDeployActor } from './v4-fleet-cancel-deploy.flow.js';

export async function assertCancelDeployLive(actor: CancelDeployActor, phase: string, evidence: Record<string, unknown>): Promise<void> {
  const { computer, page, baseUrl, tenantId } = actor.fixture;
  const lease = async () => (await computer.pool.query<{ instance_id: string; epoch: string; last_heartbeat_at: Date }>(
    'SELECT instance_id,epoch,last_heartbeat_at FROM connection_leases WHERE tenant_id=$1 AND alias=$2 AND lease_until>now()',
    [tenantId, actor.alias])).rows[0];
  await expect.poll(async () => (await lease())?.instance_id, { timeout: 45_000 }).toBeTruthy();
  const first = await lease();
  if (!first) throw new Error('the real SDK did not acquire its durable consumer lease');
  await expect.poll(async () => (await lease())?.last_heartbeat_at.getTime() ?? 0, { timeout: 35_000 }).toBeGreaterThan(first.last_heartbeat_at.getTime());
  const marker = `FLEET-DEPLOY-DELIVERY-${randomUUID()}`;
  const observed = await lease();
  evidence.heartbeat = { first, observed };
  evidence.marker = marker;
  await page.goto(`${baseUrl}/messages/${tenantId}/${actor.alias}`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel(`Mensaje para ${actor.alias}`).fill(marker);
  await page.getByRole('button', { name: 'Enviar', exact: true }).click();
  const persisted = async () => (await computer.pool.query<{
    id: string; status: string; last_error: string | null; consumer_instance_id: string; consumer_epoch: string; execution_started_at: Date | null;
  }>(`SELECT delivery.id,delivery.status,delivery.last_error,delivery.consumer_instance_id,delivery.consumer_epoch,delivery.execution_started_at
       FROM messages message JOIN deliveries delivery ON delivery.message_id=message.id
      WHERE message.tenant_id=$1 AND message.body->>'text'=$2 AND delivery.recipient_alias=$3`, [tenantId, marker, actor.alias])).rows;
  const deadline = Date.now() + 45_000;
  let rows = await persisted();
  while (Date.now() < deadline && rows[0]?.status !== 'done') {
    if (rows[0]?.status === 'dead') {
      evidence.delivery = rows;
      throw new Error(`the real SDK rejected its durable delivery: ${JSON.stringify(rows)}`);
    }
    await page.waitForTimeout(500);
    rows = await persisted();
  }
  evidence.delivery = rows;
  expect(rows).toHaveLength(1); expect(rows[0]?.status).toBe('done'); expect(rows[0]?.execution_started_at).not.toBeNull();
  const receipts = await computer.pool.query<{ status: string; applied: boolean; renewal: boolean; instance_id: string; epoch: string }>(
    'SELECT status,applied,renewal,instance_id,epoch FROM delivery_acks WHERE delivery_id=$1 ORDER BY id', [rows[0]?.id]);
  evidence.acknowledgements = receipts.rows;
  const applied = receipts.rows.filter(row => row.applied);
  expect(applied.filter(row => !row.renewal).map(row => row.status)).toEqual(['accepted', 'started', 'done']);
  const rank = (status: string) => ['accepted', 'started', 'done'].indexOf(status);
  expect(applied.map(row => rank(row.status))).toEqual(applied.map(row => rank(row.status)).sort());
  for (const ack of applied) {
    if (ack.renewal) expect(['accepted', 'started']).toContain(ack.status);
    expect(ack.instance_id).toBe(observed?.instance_id); expect(ack.epoch).toBe(observed?.epoch);
  }
  expect(rows[0]?.consumer_instance_id).toBe(observed?.instance_id); expect(rows[0]?.consumer_epoch).toBe(observed?.epoch);
  await page.getByText(`DELIVERED:${marker}`, { exact: true }).waitFor({ timeout: 20_000 });
  await cancelDeployCapture(page, `${phase}-durable-delivery`);
}
