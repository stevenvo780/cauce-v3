import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bodySnippet } from './v4-console-real-browser.helpers.js';
import { EVIDENCE, KEY, PREFIX, confirmReplacement, createReplacementAgent, replacementUpdatePanel,
  reply, snapshot, startReplacementFixture, waitOperation,
  type ReplacementFixture } from './v4-contenedor-sustituido.fixtures.js';

let fixture: ReplacementFixture | undefined;
const evidence: Record<string, unknown> = {};
const active = () => { if (!fixture) throw new Error('replacement fixture absent'); return fixture; };

beforeAll(async () => { fixture = await startReplacementFixture(); }, 900_000);
afterAll(async () => {
  try { await fixture?.close(); }
  finally { await writeFile(join(EVIDENCE, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 }); }
}, 300_000);

describe('retirada de contenedor sustituido con ejecutor físico', () => {
  it('actualiza la ubicación y retira el contenedor anterior después del turno real', async () => {
    const { page } = active();
    try {
      const created = await createReplacementAgent(active());
      evidence.create = created;
      expect(created.status, JSON.stringify(created)).toBe('succeeded');
      evidence.reply_before = await reply(active(), 'BEFORE-REPLACEMENT');
      const original = `${PREFIX}-${KEY}`;
      evidence.original_before = await snapshot(original);
      expect(evidence.original_before).toMatchObject({ running: true });
      await confirmReplacement(await replacementUpdatePanel(active()));
      const updated = await waitOperation(active(), 'update');
      evidence.update = updated;
      expect(updated.status, JSON.stringify(updated)).toBe('succeeded');
      evidence.original_after = await snapshot(original);
      evidence.replacement_after = await snapshot(`${PREFIX}-n-${KEY}`);
      evidence.reply_after = await reply(active(), 'AFTER-REPLACEMENT');
      await page.screenshot({ path: join(EVIDENCE, 'update-desktop.png') });
      expect(evidence.original_after).toBeNull();
    } catch (error) {
      evidence.failure = error instanceof Error ? error.message : String(error);
      evidence.page = await bodySnippet(page);
      await page.screenshot({ path: join(EVIDENCE, 'failure.png') });
      throw error;
    }
  }, 900_000);
});
