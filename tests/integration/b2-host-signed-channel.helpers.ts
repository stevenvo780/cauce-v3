import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { expect } from 'vitest';
import { hostEnrollmentMessage, hostRequestMessage, type DatabasePool, type HostInvitation } from '@cauce/store';
import { buildGateway } from '../../services/gateway/src/app.js';
import { PostgresConsoleUserStore } from '../../services/gateway/src/console-users.js';
import { PasswordAuthProvider } from '../../services/gateway/src/password-auth.js';

export interface HostOwner { slug: string; headers: Record<string, string> }
export interface EnrolledComputer {
  invitation: HostInvitation;
  receipt: { enrollment_id: string; company_id: string; host_id: string; state: 'enrolled'; key_fingerprint: string; executor_ready: boolean };
  keys: ReturnType<typeof generateKeyPairSync>;
}
export async function startHostGateway(pool: DatabasePool) {
  const directory = await mkdtemp('/var/tmp/zz-canary-b2-gateway-');
  const app = await buildGateway({ pool, logger: false, consoleOrigins: ['http://localhost'],
    spaceBackups: { directory, projectRoot: resolve(import.meta.dirname, '../..'), python: '/usr/bin/python3' },
    authProvider: new PasswordAuthProvider({ users: new PostgresConsoleUserStore(pool), signingKey: randomBytes(32) }) })
    .catch(async (error: unknown) => { await rm(directory, { recursive: true, force: true }); throw error; });
  const successfulHostPaths = new Set<string>();
  app.addHook('onResponse', async (request, reply) => {
    if (request.method === 'POST' && request.url.startsWith('/v3/fleet/hosts/') && reply.statusCode === 200) {
      successfulHostPaths.add(request.url);
    }
  });
  app.addHook('onClose', async () => { await rm(directory, { recursive: true, force: true }); });
  try { const url = await app.listen({ host: '127.0.0.1', port: 0 }); return { app, url, successfulHostPaths }; }
  catch (error) { await app.close(); throw error; }
}
export async function hostRequest(url: string, path: string, method = 'GET', body?: unknown,
  headers: Record<string, string> = {}) {
  return fetch(url + path, { method, redirect: 'error', signal: AbortSignal.timeout(30_000), headers: {
    ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }),
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
export async function registerHostOwner(url: string, slug: string): Promise<HostOwner> {
  const password = `${slug}-local-password-0`; const email = `${slug}@example.invalid`;
  const headers = { origin: 'http://localhost' };
  const registered = await hostRequest(url, '/v3/auth/register', 'POST', { email, name: slug, password, company: { name: slug, slug } }, headers);
  expect(registered.status).toBe(201); await registered.body?.cancel();
  const login = await hostRequest(url, '/v3/auth/login', 'POST', { email, password }, headers);
  expect(login.status).toBe(200);
  const cookie = login.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ');
  const session = await login.json() as { csrf_token: string };
  if (!cookie || !session.csrf_token) throw new Error('isolated console session absent');
  return { slug, headers: { ...headers, cookie, 'x-csrf-token': session.csrf_token } };
}
export async function inviteComputer(url: string, owner: HostOwner, suffix: string): Promise<HostInvitation> {
  const invitation = await hostRequest(url, '/v3/console/fleet/hosts/enrollments', 'POST', {
    host_id: `${owner.slug}-${suffix}`, display_name: `Ordenador ${suffix}`,
  }, owner.headers);
  expect(invitation.status).toBe(201);
  return invitation.json() as Promise<HostInvitation>;
}
export async function enrollComputer(url: string, owner: HostOwner, suffix: string): Promise<EnrolledComputer> {
  const invitation = await inviteComputer(url, owner, suffix); const keys = generateKeyPairSync('ed25519');
  const response = await hostRequest(url, `/v3/fleet/hosts/enrollments/${invitation.enrollment_id}/claim`, 'POST', {
    invitation_token: invitation.invitation_token, public_key: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    proof: sign(null, Buffer.from(hostEnrollmentMessage(invitation)), keys.privateKey).toString('base64'),
  });
  expect(response.status).toBe(200);
  const receipt = await response.json() as EnrolledComputer['receipt'];
  expect(receipt).toMatchObject({ host_id: invitation.host_id, company_id: owner.slug, state: 'enrolled', executor_ready: false });
  return { invitation, keys, receipt };
}
export function signedHostPacket(host: EnrolledComputer, path: string, payload: Record<string, unknown>,
  overrides: { company_id?: string; issued_at?: number; nonce?: string } = {}) {
  const packet = { company_id: host.receipt.company_id, host_id: host.receipt.host_id, issued_at: Date.now(),
    nonce: randomBytes(32).toString('hex'), payload, proof: '', ...overrides };
  packet.proof = sign(null, Buffer.from(hostRequestMessage('POST', path, packet)), host.keys.privateKey).toString('base64');
  return packet;
}
export async function startEnrolledController(url: string, host: EnrolledComputer) {
  const directory = await mkdtemp('/var/tmp/zz-canary-b2-host-');
  try { return await launchEnrolledController(url, host, directory); }
  catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}
async function launchEnrolledController(url: string, host: EnrolledComputer, directory: string) {
  const identity = join(directory, 'identity'); await mkdir(identity, { mode: 0o700 });
  await writeFile(join(identity, 'identity.json'), JSON.stringify({ ...host.receipt, gateway: url }), { mode: 0o600 });
  await writeFile(join(identity, 'private.pem'), host.keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const roots: Record<string, string> = {};
  for (const name of ['state', 'runtime', 'pki', 'tokens', 'identities']) {
    roots[name] = join(directory, name); await mkdir(roots[name], { mode: 0o700 });
  }
  const policy = join(directory, 'executor-policy.json');
  await writeFile(policy, JSON.stringify({ schemaVersion: 1, host_id: host.receipt.host_id, executor_user: userInfo().username,
    roots, native: [], containers: {}, bundles: {}, profiles: {}, hooks: {} }), { mode: 0o600 });
  const projectRoot = resolve(import.meta.dirname, '../..');
  const child = spawn(process.execPath, ['--import', 'tsx', join(projectRoot, 'services/gateway/src/fleet/main.ts')], {
    cwd: projectRoot, stdio: ['ignore', 'ignore', 'pipe'], env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: directory,
      PYTHONDONTWRITEBYTECODE: '1', CAUCE_FLEET_PROJECT_ROOT: projectRoot, CAUCE_FLEET_HOST: host.receipt.host_id,
      CAUCE_FLEET_WORKER_ID: 'zz-canary-b2-controller', CAUCE_FLEET_IDENTITY_DIRECTORY: identity,
      CAUCE_FLEET_PYTHON: '/usr/bin/python3', CAUCE_FLEET_EXECUTABLE: join(projectRoot, 'ops/cli/fleet-executor.py'),
      CAUCE_FLEET_POLICY_FILE: policy, CAUCE_FLEET_POLL_MS: '250' },
  });
  const closed = once(child, 'close'); let diagnostic = '';
  child.stderr.on('data', (chunk: Buffer) => { diagnostic += chunk.toString(); });
  return { child, diagnostic: () => diagnostic, async close() {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const timeout = setTimeout(() => { child.kill('SIGKILL'); }, 5000);
    try { await closed; } finally { clearTimeout(timeout); await rm(directory, { recursive: true, force: true }); }
  } };
}
