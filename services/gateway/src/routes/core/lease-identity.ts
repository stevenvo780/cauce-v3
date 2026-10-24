import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { RuntimeLeaseIdentity } from '@cauce/store';
import { isAgentPrincipal, type Principal } from '../../auth.js';
import { isAuthorizedTlsSocket } from '../../runtime-guards.js';
import type { CoreRouteOptions } from './contracts.js';

export async function runtimeLeaseIdentity(
  request: FastifyRequest, actor: Principal, options: CoreRouteOptions,
): Promise<RuntimeLeaseIdentity | undefined> {
  if (options.authProvider.mode !== 'production') return undefined;
  const socket = request.raw.socket;
  const certificate = isAuthorizedTlsSocket(socket) ? socket.getPeerX509Certificate() : undefined;
  const identity = { channel: isAgentPrincipal(actor) ? actor.channel : '', sessionId: actor.session_id,
    ...(options.legacyRuntimeHostId === undefined ? {} : { legacyHostId: options.legacyRuntimeHostId }) };
  if (certificate === undefined || identity.channel !== 'adapter' || !actor.session_id.startsWith('adapter-')) return identity;
  try {
    const authority = await options.signedFleetAuthorityClient?.resolveRuntimeAuthority(
      createHash('sha256').update(certificate.raw).digest('hex'));
    if (authority?.tenant_id !== actor.tenant_id || authority.alias !== actor.alias
        || actor.session_id !== `adapter-${authority.runtime_key}`) return identity;
    return { ...identity, hostId: authority.host_id,
      expiresAt: new Date(Math.min(Date.parse(authority.expires_at), Date.parse(certificate.validTo))).toISOString() };
  } catch { return identity; }
}
