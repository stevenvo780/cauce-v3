import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildGateway, type AuthProvider, type Principal,
} from '../../services/gateway/src/index.js';
import { MemoryConsoleUserStore } from '../../services/gateway/src/test-support/console-users.js';
import { PasswordAuthProvider } from '../../services/gateway/src/password-auth.js';
import {
  closeGatewaysAndSockets, fakePool, fakeRepository, grants, noDeliveryWakes, roles,
} from './helpers.js';

const apps: Awaited<ReturnType<typeof buildGateway>>[] = [];

afterEach(async () => {
  await closeGatewaysAndSockets(apps, []);
});

const GATE_PROBE_PRINCIPAL: Principal = {
  tenant_id: 'Steven', alias: 'gate-probe', session_id: 'gate-probe', channel: 'gate',
  roles: roles('agent'), permissions: grants('route', 'read'),
};

class StubFallbackProvider implements AuthProvider {
  readonly mode = 'production' as const;

  constructor(readonly name: string, private readonly principal: Principal) {}

  async authenticateHttp(): Promise<Principal> { return this.principal; }
  async authenticateHello(): Promise<Principal> { return this.principal; }
}

async function passwordFallbackGateway(fallbackName: string) {
  const app = await buildGateway({
    pool: fakePool(),
    repository: fakeRepository(),
    authProvider: new PasswordAuthProvider({
      users: new MemoryConsoleUserStore(),
      signingKey: randomBytes(32),
      fallback: new StubFallbackProvider(fallbackName, GATE_PROBE_PRINCIPAL),
    }),
    deliveryWakeSubscriber: noDeliveryWakes,
    outboxPollMs: 60_000,
  });
  apps.push(app);
  return app;
}

describe('system.gate.probe behind the production console-password provider', () => {
  const nonce = '0123456789abcdef0123456789abcdef';
  const payload = {
    room_id: 'grp.steven',
    recipients: [{ tenant_id: 'Steven', alias: 'kant' }],
    body: { type: 'system.gate.probe', nonce, timeout_ms: 5_000 },
    idempotency_key: `gate:Steven:kant:${nonce}`,
    lane: 'interactive',
    priority: -100,
  };

  it('is admitted when this request actually authenticated through the mTLS fallback', async () => {
    const app = await passwordFallbackGateway('mtls');
    const response = await app.inject({ method: 'POST', url: '/v3/messages', payload });
    expect(response.statusCode).toBe(202);
  });

  it('stays closed when the fallback that resolved this request is not mTLS', async () => {
    const app = await passwordFallbackGateway('hashed-token-file');
    const response = await app.inject({ method: 'POST', url: '/v3/messages', payload });
    expect(response.statusCode).toBe(403);
  });
});
