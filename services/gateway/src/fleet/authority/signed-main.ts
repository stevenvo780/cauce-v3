import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { createPool } from '@cauce/store';
import { readFleetHostDatabaseUrl } from '../main.js';
import { readPrivateJson } from '../provider-login.js';
import { startSignedFleetAuthorityBridge } from './signed-bridge.js';
import { AuthorityCommandSchema } from './command.js';

const Path = z.string().refine(value => value.startsWith('/') && resolve(value) === value && !/[\p{Cc}]/u.test(value));
const Uid = z.string().regex(/^\d+$/u).transform(Number).pipe(z.number().int().nonnegative().max(2_147_483_647));
export async function runSignedFleetAuthority(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const filename = Path.parse(environment.CAUCE_FLEET_AUTHORITY_SOCKET);
  const ownerUid = Uid.parse(environment.CAUCE_FLEET_AUTHORITY_OWNER_UID);
  const peerUid = Uid.parse(environment.CAUCE_FLEET_AUTHORITY_PEER_UID);
  const groupGid = environment.CAUCE_FLEET_AUTHORITY_GROUP_GID === undefined ? undefined : Uid.parse(environment.CAUCE_FLEET_AUTHORITY_GROUP_GID);
  const databaseUrl = await readFleetHostDatabaseUrl(Path.parse(environment.CAUCE_FLEET_AUTHORITY_DATABASE_URL_FILE));
  const command = AuthorityCommandSchema.parse(await readPrivateJson(Path.parse(environment.CAUCE_FLEET_AUTHORITY_COMMAND_FILE)));
  const pool = createPool(databaseUrl, { applicationName: 'cauce-signed-fleet-authority', max: 4 });
  let bridge;
  try { bridge = await startSignedFleetAuthorityBridge(filename, pool, { command, ownerUid, peerUid,
    ...(groupGid === undefined ? {} : { groupGid }) }); }
  catch (error) { await pool.end(); throw error; }
  await new Promise<void>(resolveStop => {
    const stop = () => { process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); resolveStop(); };
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
  });
  await bridge.close(); await pool.end();
}
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runSignedFleetAuthority().catch(() => { process.stderr.write('Signed fleet authority is unavailable\n'); process.exitCode = 1; });
}
