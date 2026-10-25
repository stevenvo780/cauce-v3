import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { docker } from '../../services/gateway/src/fleet/host-computer.fixtures.js';
import { bodySnippet } from './v4-console-real-browser.helpers.js';
import { ALIAS, EVIDENCE, KEY, PREFIX, confirmReplacement, createReplacementAgent, operations, replacementUpdatePanel,
  reply, snapshot, startReplacementFixture, type Operation, type ReplacementFixture } from './v4-contenedor-sustituido.fixtures.js';

let fixture: ReplacementFixture | undefined;
let paused = false;
const destination = `${PREFIX}-n-${KEY}`;
const evidence: Record<string, unknown> = {};
const active = () => { if (!fixture) throw new Error('late cancellation fixture absent'); return fixture; };

beforeAll(async () => { fixture = await startReplacementFixture(); }, 900_000);
afterAll(async () => {
  const failures: unknown[] = [];
  try {
    try { if (paused) await docker(['unpause', destination]); }
    catch (error) { failures.push(error); }
    try { await fixture?.close(); }
    catch (error) { failures.push(error); }
  } finally {
    await writeFile(join(EVIDENCE, 'late-cancel.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  }
  if (failures.length) throw new AggregateError(failures, 'late cancellation cleanup incomplete');
}, 300_000);

describe('cancelación tardía de sustitución física', () => {
  it('restaura el original y su respuesta tras cancelar con el sustituto iniciado', async () => {
    const { page, computer, tenant } = active();
    try {
      evidence.create = await createReplacementAgent(active());
      evidence.reply_before = await reply(active(), 'BEFORE-LATE-CANCEL');
      evidence.original_before = await snapshot(`${PREFIX}-${KEY}`);
      await confirmReplacement(await replacementUpdatePanel(active()));
      let operation: Operation | undefined;
      await expect.poll(async () => {
        operation = (await operations(active())).find(row => row.kind === 'update');
        if (operation?.status !== 'running') return false;
        const observed = await snapshot(destination);
        if (observed?.running !== true) return false;
        const metadata = await computer.onComputer(['docker', 'exec', '--user', '0', destination, 'test', '-f',
          `/run/cauce-fleet/${KEY}/cauce-v3-adapter.json`]);
        return metadata.code === 0;
      }, { timeout: 180_000, interval: 100 }).toBe(true);
      await docker(['pause', destination]); paused = true;
      evidence.replacement_at_cancel = await snapshot(destination);
      if (!operation) throw new Error('late cancellation operation absent');
      const operationId = operation.id;
      const card = page.getByRole('region', { name: 'Operación de flota', exact: true }).filter({ hasText: operationId });
      const cancel = card.getByRole('button', { name: 'Cancelar', exact: true });
      await expect.poll(() => cancel.isDisabled(), { timeout: 30_000 }).toBe(false);
      await page.screenshot({ path: join(EVIDENCE, 'late-cancel-before.png') });
      await cancel.click();
      await expect.poll(async () => (await operations(active())).find(row => row.id === operationId)?.status,
        { timeout: 30_000, interval: 100 }).toBe('cancelling');
      await docker(['unpause', destination]); paused = false;
      await expect.poll(async () => {
        operation = (await operations(active())).find(row => row.kind === 'update');
        evidence.cancel = operation;
        return operation?.status;
      }, { timeout: 180_000, interval: 500 }).toBe('cancelled');
      evidence.original_after = await snapshot(`${PREFIX}-${KEY}`);
      evidence.replacement_after = await snapshot(destination);
      const agent = (await computer.pool.query<{ enabled: boolean; lifecycle_state: string; container_name: string }>(
        'SELECT enabled,lifecycle_state,container_name FROM agents WHERE tenant_id=$1 AND alias=$2', [tenant, ALIAS])).rows[0];
      evidence.agent_after = agent;
      try { evidence.reply_after = await reply(active(), 'AFTER-LATE-CANCEL'); }
      catch (error) { evidence.reply_failure = error instanceof Error ? error.message : String(error); }
      await page.screenshot({ path: join(EVIDENCE, 'late-cancel-after.png') });
      expect(agent).toMatchObject({ enabled: true, container_name: `${PREFIX}-${KEY}` });
      expect(evidence.reply_failure).toBeUndefined();
    } catch (error) {
      evidence.failure = error instanceof Error ? error.message : String(error);
      evidence.page = await bodySnippet(page);
      await page.screenshot({ path: join(EVIDENCE, 'late-cancel-failure.png') });
      throw error;
    }
  }, 900_000);
});
