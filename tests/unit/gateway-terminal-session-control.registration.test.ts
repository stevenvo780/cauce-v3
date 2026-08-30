import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { UUID_OK, buildContext, type Context } from './gateway-terminal-session-control-fixtures.js';

describe('registerTerminalSessionControl: rutas registradas', () => {
  let ctx: Context;
  beforeEach(() => { ctx = buildContext(); });
  afterEach(async () => { await ctx.close(); });

  interface InjectedResponse {
    statusCode: number;
    json(): unknown;
  }
  function safeJson(response: InjectedResponse): null | object | undefined {
    try { return response.json() as null | object | undefined; } catch { return null; }
  }
  async function routeResponds(
    app: FastifyInstance, method: 'GET' | 'POST' | 'DELETE', url: string, payload: string | object = {}
  ): Promise<{ registered: boolean; status: number; body: unknown }> {
    const response = (await app.inject({ method, url, payload })) as unknown as InjectedResponse;
    const body: unknown = safeJson(response);
    let registered = response.statusCode !== 404;
    if (!registered && typeof body === 'object' && body !== null) {
      const record = body as { error?: unknown };
      registered = typeof record.error === 'string' && record.error !== 'Not Found';
    }
    return { registered, status: response.statusCode, body };
  }

  it('publica POST /v3/console/terminal/sessions', async () => {
    const observed = await routeResponds(ctx.app, 'POST', '/v3/console/terminal/sessions', {});
    expect(observed.registered).toBe(true);
  });

  it('publica GET /v3/console/terminal/sessions', async () => {
    const observed = await routeResponds(ctx.app, 'GET', '/v3/console/terminal/sessions');
    expect(observed.registered).toBe(true);
    expect(observed.status).toBe(200);
  });

  it('publica POST /v3/console/terminal/sessions/:sid/owner', async () => {
    const observed = await routeResponds(
      ctx.app, 'POST', `/v3/console/terminal/sessions/${UUID_OK}/owner`, {}
    );
    expect(observed.registered).toBe(true);
  });

  it('publica DELETE /v3/console/terminal/sessions/:sid', async () => {
    const observed = await routeResponds(
      ctx.app, 'DELETE', `/v3/console/terminal/sessions/${UUID_OK}`, {}
    );
    expect(observed.registered).toBe(true);
  });
});
