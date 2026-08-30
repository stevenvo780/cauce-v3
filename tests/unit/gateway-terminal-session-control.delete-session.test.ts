import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseClient, DatabasePool } from '@cauce/store';
import { UUID_OK, buildContext, type Context, consolePrincipal, validDeleteSession, makeRow } from './gateway-terminal-session-control-fixtures.js';

describe('DELETE /v3/console/terminal/sessions/:sid: pre-validación', () => {
  let ctx: Context;
  beforeEach(() => { ctx = buildContext(); });
  afterEach(async () => { await ctx.close(); });

  it('responde 400 con mensaje "session id is invalid" cuando sid NO es un UUID canónico', async () => {
    const response = await ctx.app.inject({
      method: 'DELETE',
      url: '/v3/console/terminal/sessions/no-uuid',
      payload: validDeleteSession()
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'invalid_request', message: 'session id is invalid' });
  });

  it('rechaza el body cuando owner_generation no es entero positivo', async () => {
    const response = await ctx.app.inject({
      method: 'DELETE',
      url: `/v3/console/terminal/sessions/${UUID_OK}`,
      payload: validDeleteSession({ owner_generation: '0' })
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'invalid_request', message: 'owner_generation is invalid' });
  });

  it('responde 403 cuando el principal no tiene permission control', async () => {
    ctx = buildContext({
      principal: async () => consolePrincipal({ permissions: ['route', 'read'] })
    });
    const response = await ctx.app.inject({
      method: 'DELETE',
      url: `/v3/console/terminal/sessions/${UUID_OK}`,
      payload: validDeleteSession()
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'forbidden' });
  });

  it('responde 204 cuando el UPDATE marca revoked_at y devuelve la fila', async () => {
    const issuedAt = new Date('2026-01-01T00:00:00Z');
    const revokedRow = makeRow({ id: UUID_OK, issued_at: issuedAt, expires_at: new Date('2026-01-01T01:00:00Z') });
    const releasedClient: DatabaseClient = {
      query: vi.fn(async (text: string) => {
        if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [], rowCount: 0 };
        if (text.includes('UPDATE terminal_sessions SET revoked_at')) return { rows: [revokedRow], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn()
    } as unknown as DatabaseClient;
    const pool: DatabasePool = {
      query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
      connect: vi.fn(async () => releasedClient)
    } as unknown as DatabasePool;
    ctx = buildContext({ pool });
    const response = await ctx.app.inject({
      method: 'DELETE',
      url: `/v3/console/terminal/sessions/${UUID_OK}`,
      payload: validDeleteSession()
    });
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
  });

  it('responde 409 conflict cuando el UPDATE no devuelve filas ni settled', async () => {
    const releasedClient: DatabaseClient = {
      query: vi.fn(async (text: string) => {
        if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [], rowCount: 0 };
        // Empty UPDATE + SELECT settled: false
        if (text.includes('UPDATE terminal_sessions SET revoked_at')) return { rows: [], rowCount: 0 };
        if (text.includes('SELECT EXISTS')) return { rows: [{ settled: false }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn()
    } as unknown as DatabaseClient;
    const pool: DatabasePool = {
      query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
      connect: vi.fn(async () => releasedClient)
    } as unknown as DatabasePool;
    ctx = buildContext({ pool });
    const response = await ctx.app.inject({
      method: 'DELETE',
      url: `/v3/console/terminal/sessions/${UUID_OK}`,
      payload: validDeleteSession()
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'conflict', reason: 'stale_terminal_owner' });
  });

  it('responde 204 cuando el UPDATE no devuelve filas pero settled=true (idempotente)', async () => {
    const releasedClient: DatabaseClient = {
      query: vi.fn(async (text: string) => {
        if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [], rowCount: 0 };
        if (text.includes('UPDATE terminal_sessions SET revoked_at')) return { rows: [], rowCount: 0 };
        if (text.includes('SELECT EXISTS')) return { rows: [{ settled: true }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn()
    } as unknown as DatabaseClient;
    const pool: DatabasePool = {
      query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
      connect: vi.fn(async () => releasedClient)
    } as unknown as DatabasePool;
    ctx = buildContext({ pool });
    const response = await ctx.app.inject({
      method: 'DELETE',
      url: `/v3/console/terminal/sessions/${UUID_OK}`,
      payload: validDeleteSession()
    });
    expect(response.statusCode).toBe(204);
  });
});
