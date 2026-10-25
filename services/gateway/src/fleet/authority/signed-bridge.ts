import { spawn } from 'node:child_process';
import { chmod, chown, lstat } from 'node:fs/promises';
import type { Socket } from 'node:net';
import { dirname } from 'node:path';
import Fastify from 'fastify';
import { z } from 'zod';
import { HostEnrollmentRepository, StoreError, migrationSourcesForApply, type DatabasePool } from '@cauce/store';
import { assertAuthBridgeParent, prepareAuthBridgeSocket } from '../auth-bridge-socket.js';
import { SignedAuthorityEnvelopeSchema, assertSignedAuthoritySocket, type SignedFleetAuthoritySocketPolicy } from './signed-client.js';
import { AuthorityRequestSchema, FleetAuthorityError } from './schemas.js';
import { createFleetAuthorityService } from './service.js';
import { runAuthorityReadiness, type AuthorityCommand } from './command.js';

const Ready = z.object({ action: z.literal('ready') }).strict();
let bundledSchema: Promise<string | undefined> | undefined;
function bundledSchemaVersion(): Promise<string | undefined> {
  bundledSchema ??= migrationSourcesForApply().then(
    sources => sources.at(-1)?.version,
    () => undefined,
  );
  return bundledSchema;
}
export interface SignedFleetAuthorityBridgeOptions extends SignedFleetAuthoritySocketPolicy { command: AuthorityCommand }
function unavailable(): FleetAuthorityError { return new FleetAuthorityError('AUTHORITY_UNAVAILABLE'); }
async function peerUid(socket: Socket): Promise<number> {
  const descriptor = (socket as Socket & { _handle?: { fd?: number } })._handle?.fd;
  if (descriptor === undefined || descriptor < 0) throw unavailable();
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/python3', ['-c', 'import socket,struct;print(struct.unpack("3i",socket.socket(fileno=3).getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))[1])'],
      { stdio: ['ignore', 'pipe', 'ignore', descriptor], env: { PATH: '/usr/bin:/bin', PYTHONDONTWRITEBYTECODE: '1' } });
    let output = ''; const timer = setTimeout(() => { child.kill('SIGKILL'); }, 1000);
    child.stdout?.on('data', (raw: Buffer) => { output += raw.toString('utf8'); if (output.length > 32) child.kill('SIGKILL'); });
    child.once('error', () => { clearTimeout(timer); reject(unavailable()); });
    child.once('exit', code => {
      clearTimeout(timer);
      if (code !== 0 || !/^\d+\n$/u.test(output) || !Number.isSafeInteger(Number(output))) reject(unavailable());
      else resolve(Number(output));
    });
  });
}
export async function startSignedFleetAuthorityBridge(filename: string, pool: DatabasePool, options: SignedFleetAuthorityBridgeOptions) {
  if (process.geteuid?.() !== options.ownerUid || ![options.ownerUid,options.peerUid,options.groupGid ?? 0]
    .every(value => Number.isSafeInteger(value) && value >= 0) || options.ownerUid !== options.peerUid && options.groupGid === undefined) throw unavailable();
  await assertAuthBridgeParent(filename, options);
  const parent = await lstat(dirname(filename)); const shared = options.ownerUid !== options.peerUid;
  if ((parent.mode & 0o7777) !== (shared ? 0o750 : 0o700) || shared && parent.gid !== options.groupGid) throw unavailable();
  await prepareAuthBridgeSocket(filename, options);
  const app = Fastify({ logger: false, bodyLimit: 262_144 }); const enrollment = new HostEnrollmentRepository(pool);
  app.addHook('onRequest', async (request, reply) => {
    try {
      if (request.headers.cookie !== undefined || await peerUid(request.raw.socket) !== options.peerUid) throw new FleetAuthorityError('AUTHORITY_REVOKED');
    } catch { return reply.code(403).send({ error: 'AUTHORITY_REVOKED' }); }
  });
  app.setErrorHandler((_error, _request, reply) => reply.code(400).send({ error: 'INVALID_REQUEST' }));
  app.post('/signed-authority', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    try {
      const { host_id, packet } = SignedAuthorityEnvelopeSchema.parse(request.body);
      return await enrollment.request(host_id, 'POST', `/v3/fleet/hosts/${host_id}/authority`, packet, async (client, identity) => {
        const applied = (await client.query<{ version: string | null }>('SELECT max(version) AS version FROM schema_migrations')).rows[0]?.version;
        const bundled = await bundledSchemaVersion();
        if (bundled !== undefined && applied !== bundled) throw unavailable();
        if (Ready.safeParse(packet.payload).success) { await runAuthorityReadiness(options.command); return { ready: true, host_id: identity.host_id }; }
        const input = AuthorityRequestSchema.parse(packet.payload);
        if (input.scope.host_id !== identity.host_id) throw new FleetAuthorityError('AUTHORITY_REVOKED');
        const owned = (await client.query(`SELECT 1 FROM fleet_operations WHERE id=$1 AND company_id=$2 AND executor_host=$3`,
          [input.scope.operation_id,identity.company_id,identity.host_id])).rowCount;
        if (owned !== 1) throw new FleetAuthorityError('AUTHORITY_REVOKED');
        return createFleetAuthorityService(pool, { host_id: identity.host_id, command: options.command }).executeInTransaction(client, input);
      });
    } catch (error) {
      if (error instanceof StoreError) return reply.code(error.code === 'forbidden' ? 403 : error.code === 'conflict' ? 409 : error.code === 'invalid_input' ? 422 : 503)
        .send({ error: ['forbidden','conflict','invalid_input'].includes(error.code) ? error.code : 'AUTHORITY_UNAVAILABLE' });
      return reply.code(error instanceof z.ZodError ? 400 : 409)
        .send({ error: error instanceof FleetAuthorityError ? error.code : error instanceof z.ZodError ? 'INVALID_REQUEST' : 'AUTHORITY_UNAVAILABLE' });
    }
  });
  try {
    await app.listen({ path: filename });
    if (shared) await chown(filename, options.ownerUid, options.groupGid ?? 0);
    await chmod(filename, shared ? 0o660 : 0o600); await assertSignedAuthoritySocket(filename, options);
    return await app;
  } catch (error) { await app.close(); throw error; }
}
