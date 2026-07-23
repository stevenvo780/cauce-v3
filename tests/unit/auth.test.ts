import { afterEach, describe, expect, it } from 'vitest';
import type { DatabasePool } from '@cauce/store';
import { buildGateway } from '../../services/gateway/src/app.js';
import { DevOnlyAuthProvider } from '../../services/gateway/src/auth.js';

const originalNodeEnv = process.env.NODE_ENV;
type AuthRequest = Parameters<DevOnlyAuthProvider['authenticateHttp']>[0];

function request(headers: Record<string, string>): AuthRequest {
  return { headers } as unknown as AuthRequest;
}

afterEach(() => {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
});

describe('gateway authentication mode', () => {
  it('requires valid, explicit development identity headers', async () => {
    const provider = DevOnlyAuthProvider.forTests();
    const principal = await provider.authenticateHttp(request({
      'x-cauce-tenant': 'Steven', 'x-cauce-alias': 'kant'
    }));
    expect(principal).toMatchObject({
      tenant_id: 'Steven', alias: 'kant', session_id: 'dev:Steven:kant', channel: 'dev',
      origin: { adapter: 'dev-auth', channel: 'dev', conversation_id: 'dev:Steven:kant' }
    });
    await expect(provider.authenticateHttp(request({}))).rejects.toThrow('dev auth requires');
  });

  it('fails closed if a dev/test provider is injected in production', async () => {
    process.env.NODE_ENV = 'production';
    await expect(buildGateway({
      pool: {} as DatabasePool,
      authProvider: DevOnlyAuthProvider.forTests()
    })).rejects.toThrow('forbidden in production');
  });
});
