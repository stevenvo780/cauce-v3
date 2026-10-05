import { afterEach, describe, expect, it } from 'vitest';
import {
  UUID_OK, UNIT_SUBJECT, consolePrincipal, buildContext, configBase, type Context, makeRow, stubFleetPool,
} from './gateway-terminal-session-control-fixtures.js';

describe('GET /v3/console/terminal/sessions: helper sessionState vía filas', () => {
  let ctx: Context;
  afterEach(async () => { await ctx.close(); });

  it('devuelve items vacíos cuando el pool no devuelve filas', async () => {
    const pool = stubFleetPool([], { selectList: [] });
    ctx = buildContext({ pool });
    const response = await ctx.app.inject({
      method: 'GET', url: '/v3/console/terminal/sessions'
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [] });
  });

  it('state=issued cuando occupies_slot=true y consumed_at=null (issued pero no consumido)', async () => {
    const issuedAt = new Date('2026-01-01T00:00:00Z');
    const expiresAt = new Date('2026-01-01T00:00:30Z');
    const row = makeRow({
      id: UUID_OK,
      consumed_at: null,
      issued_at: issuedAt,
      expires_at: expiresAt,
      occupies_slot: true
    });
    const pool = stubFleetPool([], { selectList: [row] });
    ctx = buildContext({ pool });
    const response = await ctx.app.inject({
      method: 'GET', url: '/v3/console/terminal/sessions'
    });
    expect(response.statusCode).toBe(200);
    const body: { items: { state: string; session_id: string }[] } = response.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.state).toBe('issued');
  });

  it('state=active cuando occupies_slot=true y consumed_at != null', async () => {
    const issuedAt = new Date('2026-01-01T00:00:00Z');
    const consumedAt = new Date('2026-01-01T00:00:05Z');
    const expiresAt = new Date('2026-01-01T00:15:00Z');
    const row = makeRow({
      id: UUID_OK,
      consumed_at: consumedAt,
      issued_at: issuedAt,
      expires_at: expiresAt,
      occupies_slot: true
    });
    const pool = stubFleetPool([], { selectList: [row] });
    ctx = buildContext({ pool });
    const response = await ctx.app.inject({
      method: 'GET', url: '/v3/console/terminal/sessions'
    });
    expect(response.statusCode).toBe(200);
    const body: { items: { state: string; expires_at: string }[] } = response.json();
    expect(body.items[0]?.state).toBe('active');
    expect(body.items[0]?.expires_at)
      .toBe(new Date(consumedAt.getTime() + configBase().sessionTtlSeconds * 1_000).toISOString());
  });

  it('state=closed cuando occupies_slot=false aunque issued_at/expires_at sean válidos', async () => {
    const issuedAt = new Date('2026-01-01T00:00:00Z');
    const expiresAt = new Date('2026-01-01T00:00:30Z');
    const row = makeRow({
      id: UUID_OK,
      consumed_at: null,
      issued_at: issuedAt,
      expires_at: expiresAt,
      occupies_slot: false
    });
    const pool = stubFleetPool([], { selectList: [row] });
    ctx = buildContext({ pool });
    const response = await ctx.app.inject({
      method: 'GET', url: '/v3/console/terminal/sessions'
    });
    expect(response.statusCode).toBe(200);
    const body: { items: { state: string }[] } = response.json();
    expect(body.items[0]?.state).toBe('closed');
  });

  it('filtra WHO h2 absoluto sin OR por email y conserva openPredicate', async () => {
    const pool = stubFleetPool([], { selectList: [] });
    ctx = buildContext({ pool });
    const response = await ctx.app.inject({
      method: 'GET', url: '/v3/console/terminal/sessions'
    });
    expect(response.statusCode).toBe(200);
    const recorded = (pool as unknown as { __queries: { text: string; values: unknown[] }[] }).__queries;
    const sessions = recorded.filter((query) => query.text.includes('FROM terminal_sessions'));
    expect(sessions).toHaveLength(1);
    expect(recorded.some((query) => query.text === 'SELECT clock_timestamp() AS database_now')).toBe(true);
    const text = sessions[0]?.text ?? '';
    expect(text).toContain('console_subject=$4');
    const scope = text.split('WHERE ')[1]?.split('ORDER BY')[0];
    expect(scope).not.toMatch(/operator_id=| OR /u);
    // Open predicate: closed_at IS NULL AND revoked_at IS NULL
    expect(text).toMatch(/closed_at IS NULL AND revoked_at IS NULL/);
    // Order: open ones first
    expect(text).toMatch(/ORDER BY occupies_slot DESC, issued_at DESC/u);
    expect(text).toMatch(/LIMIT 100/u);
    // Values: operator_id, ttlSeconds, attributed (boolean), console_subject
    const recordedValues = sessions[0]?.values;
    expect(recordedValues).toEqual(['steven-kant', 30, true, UNIT_SUBJECT]);
  });
  it('keeps the same WHO history scope when the human email label changes', async () => {
    const pool = stubFleetPool([], { selectList: [makeRow({ occupies_slot: true })] });
    ctx = buildContext({ pool, principal: async () => consolePrincipal({ operator_id: 'changed-label@example.invalid' }) });
    const response = await ctx.app.inject({ method: 'GET', url: '/v3/console/terminal/sessions' });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ items: unknown[] }>().items).toHaveLength(1);
    const query = pool.__queries.find((entry) => entry.text.includes('FROM terminal_sessions'));
    expect(query?.values[0]).toBe('changed-label@example.invalid');
    expect(query?.values[3]).toBe(UNIT_SUBJECT);
    expect(query?.text).not.toContain('operator_id=');
  });

});
