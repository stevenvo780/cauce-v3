import { chown, lstat, unlink } from 'node:fs/promises';
import { connect } from 'node:net';
import { dirname, normalize } from 'node:path';

export interface AuthBridgeSocketPolicy { ownerUid?: number; groupGid?: number }
function invalid(): Error { return new Error('Host authentication socket is unavailable'); }
function owner(policy: AuthBridgeSocketPolicy): number {
  const uid = policy.ownerUid ?? 0;
  if (!Number.isSafeInteger(uid) || uid < 0) throw invalid();
  return uid;
}
export async function assertAuthBridgeParent(socketPath: string, policy: AuthBridgeSocketPolicy): Promise<void> {
  if (!socketPath.startsWith('/') || normalize(socketPath) !== socketPath || /[\p{Cc}]/u.test(socketPath)) throw invalid();
  const uid = owner(policy);
  let path = dirname(socketPath);
  const parent = path;
  for (;;) {
    const stat = await lstat(path);
    const stickyTemporary = path !== parent && ['/tmp', '/var/tmp'].includes(path) && stat.uid === 0 && (stat.mode & 0o1000) !== 0;
    if (!stat.isDirectory() || ![0, uid].includes(stat.uid) || ((stat.mode & 0o022) !== 0 && !stickyTemporary)) throw invalid();
    if (path === parent && stat.uid !== uid) throw invalid();
    if (path === '/') break;
    path = dirname(path);
  }
}
export async function assertAuthBridgeSocket(socketPath: string, policy: AuthBridgeSocketPolicy): Promise<void> {
  await assertAuthBridgeParent(socketPath, policy);
  const stat = await lstat(socketPath);
  if (!stat.isSocket() || stat.uid !== owner(policy) || (stat.mode & 0o007) !== 0
      || (policy.groupGid !== undefined && stat.gid !== policy.groupGid)) throw invalid();
}
export async function prepareAuthBridgeSocket(socketPath: string, policy: AuthBridgeSocketPolicy): Promise<void> {
  await assertAuthBridgeParent(socketPath, policy);
  let existing;
  try { existing = await lstat(socketPath); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw invalid(); }
  await assertAuthBridgeSocket(socketPath, policy);
  const abandoned = await new Promise<boolean>(resolve => {
    const socket = connect(socketPath);
    socket.setTimeout(1000, () => { socket.destroy(); resolve(false); });
    socket.once('connect', () => { socket.destroy(); resolve(false); });
    socket.once('error', error => { socket.destroy(); resolve((error as NodeJS.ErrnoException).code === 'ECONNREFUSED'); });
  });
  if (!abandoned) throw invalid();
  const current = await lstat(socketPath);
  if (current.dev !== existing.dev || current.ino !== existing.ino) throw invalid();
  await unlink(socketPath);
}
export async function setAuthBridgeGroup(socketPath: string, policy: AuthBridgeSocketPolicy): Promise<void> {
  if (policy.groupGid === undefined) return;
  if (!Number.isSafeInteger(policy.groupGid) || policy.groupGid < 0) throw invalid();
  await chown(socketPath, owner(policy), policy.groupGid);
}
