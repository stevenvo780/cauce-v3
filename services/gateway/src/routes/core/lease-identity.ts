import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { RuntimeKeySchema } from '@cauce/protocol';
import type { LeaseAcquireOptions } from '@cauce/store';
import type { Principal } from '../../auth.js';
import { isAuthorizedTlsSocket } from '../../runtime-guards.js';
import type { CoreRouteOptions } from './contracts.js';

export async function runtimeLeaseIdentity(
  request: FastifyRequest, actor: Principal, options: CoreRouteOptions,
): Promise<LeaseAcquireOptions['identity']> {
  if (options.authProvider.mode !== 'production' || actor.human_id !== undefined) return undefined;
  const socket = request.raw.socket;
  const certificate = isAuthorizedTlsSocket(socket) ? socket.getPeerX509Certificate() : undefined;
  const identity = { channel: actor.channel, sessionId: actor.session_id,
    ...(options.legacyRuntimeHostId === undefined ? {} : { legacyHostId: options.legacyRuntimeHostId }) };
  if (certificate === undefined || identity.channel !== 'adapter' || !actor.session_id.startsWith('adapter-')) return identity;
  const runtime = RuntimeKeySchema.safeParse(actor.session_id.slice('adapter-'.length));
  if (!runtime.success || certificate.subjectAltName !== `URI:urn:cauce:runtime:${runtime.data}`) return identity;
  const fingerprint = createHash('sha256').update(certificate.raw).digest('hex');
  const normalIdentity = { ...identity, normalRuntimeKey: runtime.data, certificateFingerprint: fingerprint,
    certificateExpiresAt: new Date(certificate.validTo).toISOString() };
  try {
    const authority = await options.signedFleetAuthorityClient?.resolveRuntimeAuthority(fingerprint);
    if (authority == null) return normalIdentity;
    if (authority.tenant_id !== actor.tenant_id || authority.alias !== actor.alias
        || authority.runtime_key !== runtime.data || Date.parse(authority.expires_at) <= Date.now()) {
      return { ...normalIdentity, provenanceRejected: true };
    }
    return { ...normalIdentity, hostId: authority.host_id,
      expiresAt: new Date(Math.min(Date.parse(authority.expires_at), Date.parse(certificate.validTo))).toISOString() };
  } catch { return normalIdentity; }
}
