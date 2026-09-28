import { afterEach } from 'vitest';
import {
  buildGateway, type AuthProvider, type GatewayRepository, type Principal,
} from '../../services/gateway/src/index.js';
import {
  FixedAuthProvider, fakePool, noDeliveryWakes, testPrincipal
} from './helpers.js';

export const apps: Awaited<ReturnType<typeof buildGateway>>[] = [];

export function registerGatewaySecurityTeardown(): void {
  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => app.close()));
  });
}

export async function gateway(repository: GatewayRepository, principal = testPrincipal()) {
  const app = await buildGateway({
    pool: fakePool(),
    repository,
    authProvider: new FixedAuthProvider(principal),
    deliveryWakeSubscriber: noDeliveryWakes,
    outboxPollMs: 60_000
  });
  apps.push(app);
  return app;
}

export async function gateGateway(repository: GatewayRepository, gatePrincipal: Principal, name = 'mtls') {
  const authProvider: AuthProvider = {
    name,
    mode: 'test',
    authenticateHttp: async () => gatePrincipal,
    authenticateHello: async () => gatePrincipal,
  };
  const app = await buildGateway({
    pool: fakePool(), repository, authProvider, deliveryWakeSubscriber: noDeliveryWakes,
    outboxPollMs: 60_000,
  });
  apps.push(app);
  return app;
}
