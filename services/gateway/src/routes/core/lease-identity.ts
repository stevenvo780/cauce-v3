import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { RuntimeLeaseIdentity } from '@cauce/store';
import { isAgentPrincipal, type AuthProvider, type Principal } from '../../auth.js';
import { isAuthorizedTlsSocket } from '../../runtime-guards.js';

export function runtimeLeaseIdentity(
  request: FastifyRequest, actor: Principal, provider: AuthProvider,
): RuntimeLeaseIdentity | undefined {
  if (provider.mode !== 'production') return undefined;
  const socket = request.raw.socket;
  const certificate = isAuthorizedTlsSocket(socket) ? socket.getPeerX509Certificate() : undefined;
  return { channel: isAgentPrincipal(actor) ? actor.channel : '', sessionId: actor.session_id,
    ...(certificate === undefined ? {} : { certificateSha256: createHash('sha256').update(certificate.raw).digest('hex') }) };
}
