import type {
  PrincipalPermission, PrincipalRole
} from '../../services/gateway/src/index.js';

export {
  fakePool, fakeRepository, testPrincipal, FixedAuthProvider, ids, noDeliveryWakes,
  buildTestGateway, frameReader, text,
} from '../../services/gateway/src/test-support/gateway-doubles.js';

export function roles(...values: PrincipalRole[]): readonly PrincipalRole[] {
  return values;
}

export function grants(...values: PrincipalPermission[]): readonly PrincipalPermission[] {
  return values;
}

export async function closeGatewaysAndSockets(
  apps: { close(): Promise<unknown> }[],
  sockets: { close(): void }[],
): Promise<void> {
  for (const socket of sockets.splice(0)) socket.close();
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
}
