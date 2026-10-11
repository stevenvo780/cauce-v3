import { resolve } from 'node:path';
import { z } from 'zod';
import { SignedFleetAuthorityClient } from './signed-client.js';

const Uid = z.string().regex(/^\d+$/u).transform(Number).pipe(z.number().int().nonnegative().max(2_147_483_647));
const Configuration = z.object({
  socket: z.string().refine(value => value.startsWith('/') && resolve(value) === value && !/[\p{Cc}]/u.test(value)),
  ownerUid: Uid,
  peerUid: Uid,
  groupGid: Uid.optional(),
}).refine(value => value.ownerUid === value.peerUid || value.groupGid !== undefined);

export function configuredSignedFleetAuthority(environment: NodeJS.ProcessEnv = process.env): SignedFleetAuthorityClient | undefined {
  const { CAUCE_FLEET_AUTHORITY_SOCKET: socket, CAUCE_FLEET_AUTHORITY_OWNER_UID: ownerUid,
    CAUCE_FLEET_AUTHORITY_PEER_UID: peerUid, CAUCE_FLEET_AUTHORITY_GROUP_GID: groupGid } = environment;
  if ([socket, ownerUid, peerUid, groupGid].every(value => value === undefined)) return undefined;
  const selected = Configuration.parse({ socket, ownerUid, peerUid, groupGid });
  return new SignedFleetAuthorityClient(selected.socket, {
    ownerUid: selected.ownerUid, peerUid: selected.peerUid,
    ...(selected.groupGid === undefined ? {} : { groupGid: selected.groupGid }),
  });
}
