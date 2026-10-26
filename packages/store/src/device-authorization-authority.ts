import { lockCompanyAuthority } from './company-authority.js';
import { type DatabaseClient } from './db.js';
import { lockConsoleHuman, type ConsoleCredentialStampVerifier } from './human-identity.js';
import { StoreError } from './repository/errors.js';

export interface DeviceAuthorizationIdentity {
  readonly humanId: string;
  readonly tenantId: string;
  readonly actorAlias: string;
  readonly activeCompany: string;
  readonly credentialStamp: string;
}

export interface DeviceAuthorizationDecision extends DeviceAuthorizationIdentity {
  readonly userCodeHash: string;
  readonly decision: 'approve' | 'deny';
  readonly verifyCredentialStamp: ConsoleCredentialStampVerifier;
  readonly sessionExpiresAtMs: number;
  /** Login instant of the approving session: the session the device receives inherits it as its ceiling anchor. */
  readonly sessionAuthAtMs: number;
}

export async function lockDeviceIdentity(
  client: DatabaseClient, identity: DeviceAuthorizationIdentity, verifyCredentialStamp: ConsoleCredentialStampVerifier,
): Promise<{ revision: string; snapshot: string }> {
  const human = await lockConsoleHuman(client, identity.humanId, {
    credentialStamp: identity.credentialStamp, verifyCredentialStamp,
  });
  if (human.account.defaultTenant !== identity.tenantId || human.account.actorAlias !== identity.actorAlias
    || human.membership.actorAlias !== identity.actorAlias || !human.membership.permissions.includes('read')) {
    throw new StoreError('forbidden', 'device authorization identity is unavailable');
  }
  const authority = await lockCompanyAuthority(client, { humanId: identity.humanId, tenant: identity.tenantId,
    alias: identity.actorAlias, requestedCompany: identity.activeCompany });
  if (authority.role === 'none' || authority.actingCompany !== identity.activeCompany) {
    throw new StoreError('forbidden', 'device authorization company is unavailable');
  }
  const snapshot = (await client.query<{ snapshot: string }>(
    'SELECT xmin::text AS snapshot FROM human_tenant_memberships WHERE human_id=$1 AND tenant_id=$2',
    [identity.humanId, identity.tenantId],
  )).rows[0]?.snapshot;
  if (snapshot === undefined) throw new StoreError('forbidden', 'device authorization membership is unavailable');
  return { revision: human.membership.revision, snapshot };
}
