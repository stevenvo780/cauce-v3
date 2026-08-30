import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UUID_OK, buildContext, type Context, consolePrincipal, validOwnerRotation } from './gateway-terminal-session-control-fixtures.js';

describe('POST /v3/console/terminal/sessions/:sid/owner: pre-validación', () => {
  let ctx: Context;
  beforeEach(() => { ctx = buildContext(); });
  afterEach(async () => { await ctx.close(); });

  it('responde 400 con mensaje "session id is invalid" cuando sid NO es un UUID canónico', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v3/console/terminal/sessions/not-a-uuid/owner',
      payload: validOwnerRotation()
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'invalid_request', message: 'session id is invalid' });
  });

  it('rechaza el body cuando expected_owner_generation no es entero positivo', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/v3/console/terminal/sessions/${UUID_OK}/owner`,
      payload: validOwnerRotation({ expected_owner_generation: '0' })
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'invalid_request', message: 'expected_owner_generation is invalid' });
  });

  it('responde 403 cuando el principal no tiene rol operator', async () => {
    ctx = buildContext({
      principal: async () => consolePrincipal({ roles: ['agent'], permissions: ['control'] })
    });
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/v3/console/terminal/sessions/${UUID_OK}/owner`,
      payload: validOwnerRotation()
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'forbidden' });
  });
});
