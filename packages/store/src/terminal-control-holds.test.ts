import { describe, expect, it, vi } from 'vitest';
import type { DatabaseClient, DatabasePool } from './db.js';
import { releaseControlHold, releaseSessionControlHolds, takeControlHoldWithinTransaction } from './terminal-control-holds.js';

function fixture(busy = false) {
  const hold = { id: 'hold', operator_id: 'steven', expires_at: new Date() };
  const query = vi.fn(async (text: string, _values?: unknown[]) => {
    if (text.includes('SELECT id FROM deliveries')) return { rows: busy ? [{ id: 'delivery' }] : [] };
    if (text.includes('SELECT id FROM terminal_sessions')) return { rows: [{ id: 'session' }] };
    if (text.includes('AS authority_live')) return { rows: [{ taken_at: new Date().toISOString(), authority_live: true }] };
    if (text.includes('INSERT INTO terminal_control_holds')) return { rows: [hold] };
    return { rows: [] };
  });
  return { query, client: { query } as unknown as DatabaseClient };
}
const input = { tenantId: 'Steven', alias: 'argos', sessionId: 'session', operatorId: 'steven',
  windowMs: 60_000, sessionTtlSeconds: 900, sessionMaxTotalSeconds: null };

describe('terminal control hold compatibility', () => {
  it('takes without justification and inserts only an empty SQL literal into the legacy column', async () => {
    const { query, client } = fixture();
    const hold = await takeControlHoldWithinTransaction(client, input);
    expect(hold).not.toHaveProperty('reason');
    const insert = query.mock.calls.find(([text]) => text.includes('INSERT INTO terminal_control_holds'));
    expect(insert?.[0]).toContain("SELECT id,tenant_id,alias,$4,'',$8::timestamptz");
    expect(insert?.[0]).toContain('secs => $6');
    expect(insert?.[0]).toContain("($5||' milliseconds')");
    expect(insert?.[0]).toMatch(/RETURNING id,session_id,tenant_id,alias,operator_id,taken_at/);
    expect(insert?.[1]).toEqual([input.tenantId, input.alias, input.sessionId, input.operatorId,
      '60000', 900, null, expect.any(String), null]);
  });

  it('keeps the busy fence and requires an explicit override', async () => {
    const { query, client } = fixture(true);
    await expect(takeControlHoldWithinTransaction(client, input)).rejects.toMatchObject({ message: 'agent_busy' });
    expect(query.mock.calls.some(([text]) => text.includes('INSERT INTO terminal_control_holds'))).toBe(false);
    await expect(takeControlHoldWithinTransaction(client, { ...input, allowBusy: true })).resolves.not.toHaveProperty('reason');
  });

  it('retains validation of technical release reasons', async () => {
    const { query, client } = fixture();
    await expect(releaseSessionControlHolds(client, 'session', '  ')).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(releaseControlHold({ query } as unknown as DatabasePool,
      { tenantId: 'Steven', alias: 'argos', holdId: 'hold' }, '')).rejects.toMatchObject({ code: 'invalid_input' });
    expect(query).not.toHaveBeenCalled();
    await releaseSessionControlHolds(client, 'session', ' session_closed ');
    expect(query).toHaveBeenCalledWith(expect.stringContaining('released_reason=$2'), ['session', 'session_closed']);
  });
});
