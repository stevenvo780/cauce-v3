import { describe, expect, it } from 'vitest';
import type { DatabaseClient } from '@cauce/store';
import { fleetSharedHumans } from './baseline.js';

const OWNER = `Miguel:${'1'.repeat(8)}-1111-1111-1111-${'1'.repeat(12)}`;
const ADMIN = `Steven:${'a'.repeat(8)}-aaaa-aaaa-aaaa-${'a'.repeat(12)}`;
function client(entries: string[], calls: unknown[][]): DatabaseClient {
  return { query: async (text: string, values: unknown[]) => { calls.push([text, values]); return { rows: entries.map(entry => ({ entry })) }; } } as unknown as DatabaseClient;
}

describe('fleet shared humans', () => {
  it('lists the company owners and admins on shared-TUI harnesses, scoped by the company id', async () => {
    const calls: unknown[][] = [];
    const agents = await fleetSharedHumans(client([ADMIN, OWNER, 'Bad:entry'], calls), 'humanizar', [
      { tenant_id: 'Miguel', alias: 'gaia', harness_id: 'openclaw' }, { tenant_id: 'Steven', alias: 'hades', harness_id: 'grok' }]);
    expect(agents).toEqual([
      { tenant_id: 'Miguel', alias: 'gaia', harness_id: 'openclaw', shared_human_ids: [ADMIN, OWNER] },
      { tenant_id: 'Steven', alias: 'hades', harness_id: 'grok', shared_human_ids: [ADMIN, OWNER] }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]).toEqual(['humanizar']);
  });
  it('lists the humans on a Muse agent with a shared TUI and never on other harnesses', async () => {
    const calls: unknown[][] = [];
    const agents = await fleetSharedHumans(client([OWNER], calls), 'humanizar', [
      { tenant_id: 'Miguel', alias: 'hegel', harness_id: 'muse' },
      { tenant_id: 'Miguel', alias: 'fake1', harness_id: 'fake' }]);
    expect(agents).toEqual([
      { tenant_id: 'Miguel', alias: 'hegel', harness_id: 'muse', shared_human_ids: [OWNER] },
      { tenant_id: 'Miguel', alias: 'fake1', harness_id: 'fake' }]);
    // One company-scoped query: rows can only ever name humans of this company.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]).toEqual(['humanizar']);
    expect(String(calls[0]?.[0])).toContain('human.company_id=$1');
  });
  it('does not query without shared-TUI agents and leaves agents untouched without humans', async () => {
    const calls: unknown[][] = [];
    const fake = [{ tenant_id: 'Steven', alias: 'hades', harness_id: 'fake' }];
    expect(await fleetSharedHumans(client([ADMIN], calls), 'humanizar', fake)).toBe(fake);
    expect(calls).toHaveLength(0);
    const openclaw = [{ tenant_id: 'Miguel', alias: 'gaia', harness_id: 'openclaw' }];
    expect(await fleetSharedHumans(client([], calls), 'humanizar', openclaw)).toBe(openclaw);
  });
});
