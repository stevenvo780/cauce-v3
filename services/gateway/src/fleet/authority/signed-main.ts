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
class SignedAuthorityStartupError extends Error {}
async function stage<T>(name: string, work: () => T | Promise<T>): Promise<T> {
  try { return await work(); } catch { throw new SignedAuthorityStartupError(`Signed fleet authority ${name} is unavailable`); }
}
export async function runSignedFleetAuthority(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const { filename, ownerUid, peerUid, groupGid } = await stage('configuration', () => ({
    filename: Path.parse(environment.CAUCE_FLEET_AUTHORITY_SOCKET),
    ownerUid: Uid.parse(environment.CAUCE_FLEET_AUTHORITY_OWNER_UID),
    peerUid: Uid.parse(environment.CAUCE_FLEET_AUTHORITY_PEER_UID),
    groupGid: environment.CAUCE_FLEET_AUTHORITY_GROUP_GID === undefined ? undefined : Uid.parse(environment.CAUCE_FLEET_AUTHORITY_GROUP_GID),
  }));
  const databaseUrl = await stage('database configuration',
    () => readFleetHostDatabaseUrl(Path.parse(environment.CAUCE_FLEET_AUTHORITY_DATABASE_URL_FILE)));
  const command = await stage('issuer command',
    async () => AuthorityCommandSchema.parse(await readPrivateJson(Path.parse(environment.CAUCE_FLEET_AUTHORITY_COMMAND_FILE))));
  const pool = await stage('database configuration', () => createPool(databaseUrl, { applicationName: 'cauce-signed-fleet-authority', max: 4 }));
  let bridge;
  try {
    bridge = await stage('socket', () => startSignedFleetAuthorityBridge(filename, pool, { command, ownerUid, peerUid,
      ...(groupGid === undefined ? {} : { groupGid }) }));
  } catch (error) { await pool.end(); throw error; }
  await new Promise<void>(resolveStop => {
    const stop = () => { process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); resolveStop(); };
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
  });
  await bridge.close(); await pool.end();
}
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runSignedFleetAuthority().catch((error: unknown) => {
    process.stderr.write(`${error instanceof SignedAuthorityStartupError ? error.message : 'Signed fleet authority is unavailable'}\n`);
    process.exitCode = 1;
  });
}
