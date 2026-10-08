import { chmod, lstat } from 'node:fs/promises';
import { dirname } from 'node:path';
import Fastify from 'fastify';
import { assertAuthBridgeParent, prepareAuthBridgeSocket, type AuthBridgeSocketPolicy } from '../auth-bridge-socket.js';
import { AuthorityRequestSchema, FleetAuthorityError } from './schemas.js';
import type { FleetAuthorityService } from './service.js';

export interface AuthoritySocketPolicy { ownerUid: number; host_id: string }
export async function assertAuthoritySocket(filename: string, policy: AuthoritySocketPolicy): Promise<void> {
  await assertAuthBridgeParent(filename, policy);
  const parent = await lstat(dirname(filename));
  if ((parent.mode & 0o777) !== 0o700) throw new FleetAuthorityError('AUTHORITY_UNAVAILABLE');
  const details = await lstat(filename);
  if (!details.isSocket() || details.uid !== policy.ownerUid || (details.mode & 0o777) !== 0o600) {
    throw new FleetAuthorityError('AUTHORITY_UNAVAILABLE');
  }
}
export async function startFleetAuthoritySocket(filename: string, service: FleetAuthorityService, policy: AuthoritySocketPolicy) {
  const bridgePolicy: AuthBridgeSocketPolicy = { ownerUid: policy.ownerUid };
  await assertAuthBridgeParent(filename, policy);
  if (((await lstat(dirname(filename))).mode & 0o777) !== 0o700) throw new FleetAuthorityError('AUTHORITY_UNAVAILABLE');
  await prepareAuthBridgeSocket(filename, bridgePolicy);
  const app = Fastify({ logger: false, bodyLimit: 65_536 });
  app.post('/authority', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    try {
      const parsed = AuthorityRequestSchema.safeParse(request.body);
      if (!parsed.success) throw new FleetAuthorityError('INVALID_REQUEST');
      const value = parsed.data;
      if (value.scope.host_id !== policy.host_id) throw new FleetAuthorityError('AUTHORITY_REVOKED');
      return await service.execute(value);
    } catch (error) {
      return reply.code(409).send({ error: error instanceof FleetAuthorityError ? error.code : 'AUTHORITY_UNAVAILABLE' });
    }
  });
  try {
    await app.listen({ path: filename });
    await chmod(filename, 0o600);
    await assertAuthoritySocket(filename, policy);
    return await app;
  } catch (error) { await app.close(); throw error; }
}
