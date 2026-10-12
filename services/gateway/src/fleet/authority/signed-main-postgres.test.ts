import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, sign, X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FleetOperationsRepository, createPool, hostRequestMessage, type DatabasePool, type RegisteredCompany } from '@cauce/store';
import { preparePostgresSuite } from '../../../../../packages/store/test/postgres-suite.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../../../tests/helpers/postgres.js';
import { channelCompany, channelCreate, channelHost, type ChannelHost } from '../host-channel.fixtures.js';
import { SignedFleetAuthorityClient } from './signed-client.js';
import type { AuthorityScope } from './schemas.js';

const execute = promisify(execFile); const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const projectRoot = resolve(import.meta.dirname, '../../../../..');
const entry = join(projectRoot, 'services/gateway/src/fleet/authority/signed-main.ts');
const uid = process.geteuid?.() ?? 0;
let database: TestDatabase | undefined; let current: EmptyTestDatabase | undefined; let pool: DatabasePool;
let company: RegisteredCompany; let host: ChannelHost; let directory: string; let socket: string; let enclave: ChildProcess | undefined;
let environment: NodeJS.ProcessEnv; let diagnostic: string; let closed: Promise<unknown>;
function packet(payload: Record<string, unknown>) {
  const value = { company_id: host.company_id, host_id: host.host_id, issued_at: Date.now(), nonce: randomBytes(32).toString('hex'), payload, proof: '' };
  value.proof = sign(null, Buffer.from(hostRequestMessage('POST', `/v3/fleet/hosts/${host.host_id}/authority`, value)), host.keys.privateKey).toString('base64');
  return value;
}
function unsigned(body: unknown) {
  return new Promise<{ status: number; body: unknown }>((done, fail) => {
    const outgoing = httpRequest({ socketPath: socket, path: '/signed-authority', method: 'POST', headers: { 'content-type': 'application/json' } }, response => {
      let data = ''; response.on('data', chunk => { data += String(chunk); });
      response.on('end', () => { done({ status: response.statusCode ?? 0, body: JSON.parse(data) as unknown }); });
    }); outgoing.on('error', fail); outgoing.end(JSON.stringify(body));
  });
}
async function launch(): Promise<ChildProcess> {
  diagnostic = '';
  const child = spawn(process.execPath, ['--import', 'tsx', entry], { cwd: projectRoot, env: environment, stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.on('data', (chunk: Buffer) => { diagnostic += chunk.toString(); });
  closed = once(child, 'close'); enclave = child; return child;
}
async function listening(child: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (child.exitCode !== null) throw new Error(diagnostic || 'enclave exited');
    if (await lstat(socket).then(value => value.isSocket(), () => false)) return;
    await delay(50);
  }
  throw new Error('enclave socket absent');
}
async function exited(child: ChildProcess): Promise<number | null> { await closed; return child.exitCode; }
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);
beforeEach(async () => {
  if (!database) throw new Error('Test database absent');
  current = await startTestCaseDatabase(database); pool = createPool(current.url, { max: 1 });
  company = await channelCompany(pool, 'zz-canary');
  host = await channelHost(pool, company, `zz-canary-${randomBytes(4).toString('hex')}`);
  directory = await mkdtemp('/var/tmp/cauce-signed-enclave-');
  await mkdir(join(directory, 'run'), { mode: 0o700 }); socket = join(directory, 'run/authority.sock');
  const state = join(directory, 'state'); await mkdir(state, { mode: 0o700 });
  const registries: Record<string, string> = {};
  for (const name of ['base_mtls', 'base_token', 'fleet_mtls', 'fleet_token']) {
    await mkdir(join(directory, name), { mode: 0o700 });
    registries[name] = join(directory, name, name.endsWith('mtls') ? 'mtls_identities.json' : 'token_hashes.json');
    await writeFile(registries[name], JSON.stringify({ version: 1, identities: [] }), { mode: 0o600 });
  }
  const certificate = join(directory, 'ca.crt'), key = join(directory, 'ca.key');
  await execute('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '3', '-subj', '/CN=zz-canary-enclave',
    '-keyout', key, '-out', certificate, '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  await chmod(key, 0o600);
  const policy = join(directory, 'authority.v1.json');
  await writeFile(policy, JSON.stringify({ version: 1, state_root: state, registries,
    signer: { certificate, key, certificate_sha256: hash(await readFile(certificate)), key_sha256: hash(await readFile(key)) } }), { mode: 0o600 });
  const executable = join(projectRoot, 'ops/cli/fleet-authority-issuer.py');
  await writeFile(join(directory, 'command.v1.json'), JSON.stringify({ python: '/usr/bin/python3', executable, sha256: hash(await readFile(executable)),
    policy_file: policy, policy_sha256: hash(await readFile(policy)) }), { mode: 0o600 });
  await writeFile(join(directory, 'database-url'), current.url, { mode: 0o600 });
  environment = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: userInfo().homedir,
    CAUCE_FLEET_AUTHORITY_SOCKET: socket, CAUCE_FLEET_AUTHORITY_OWNER_UID: String(uid), CAUCE_FLEET_AUTHORITY_PEER_UID: String(uid),
    CAUCE_FLEET_AUTHORITY_COMMAND_FILE: join(directory, 'command.v1.json'), CAUCE_FLEET_AUTHORITY_DATABASE_URL_FILE: join(directory, 'database-url') };
});
afterEach(async () => {
  if (enclave?.exitCode === null && enclave.signalCode === null) { enclave.kill('SIGKILL'); await exited(enclave); }
  enclave = undefined; await pool.end(); await current?.close(); await rm(directory, { recursive: true, force: true });
});
afterAll(async () => { await database?.pool.end(); await database?.container.stop(); });
describe('signed authority enclave as a standalone service process', () => {
  it('serves ready and a fenced authority for a zz-canary host, revokes it and stops cleanly', async () => {
    const child = await launch(); await listening(child);
    const client = new SignedFleetAuthorityClient(socket, { ownerUid: uid, peerUid: uid });
    expect(await client.invoke(host.host_id, packet({ action: 'ready' }))).toEqual({ ready: true, host_id: host.host_id });
    const probe = { host_id: 'zz-canary-probe', packet: { company_id: 'zz-canary-probe', host_id: 'zz-canary-probe', issued_at: Date.now(),
      nonce: randomBytes(32).toString('hex'), payload: { action: 'ready' }, proof: 'AAAA' } };
    expect(await unsigned(probe)).toEqual({ status: 403, body: { error: 'forbidden' } });
    const installer = 'import importlib.util,json,sys\nsys.path.insert(0,sys.argv[1])\n'
      + "s=importlib.util.spec_from_file_location('installer',sys.argv[2]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\n"
      + 'print(json.dumps(m.probe(sys.argv[3])))\n';
    const measured = await execute('/usr/bin/python3', ['-c', installer, join(projectRoot, 'ops/scripts'),
      join(projectRoot, 'ops/scripts/fleet-authority-install.py'), socket], { env: { PATH: '/usr/bin:/bin', PYTHONDONTWRITEBYTECODE: '1' } });
    expect(JSON.parse(measured.stdout)).toEqual([403, { error: 'forbidden' }]);

    const repo = new FleetOperationsRepository(pool);
    const create = channelCreate(company, host, 'canary-worker');
    if (create.kind !== 'create') throw new Error('Create request absent');
    create.parameters.placement = { host_id: host.host_id, mode: 'native', runtime_user: userInfo().username,
      systemd_user: userInfo().username, home_directory: directory, state_directory: join(directory, 'run/canary-worker') };
    await repo.enqueue(company.hub.id, 'owner', create, `console:${company.user.id}`);
    const claim = await repo.claim(`host-${host.host_id}`, host.host_id); if (!claim) throw new Error('Claim absent');
    const prepared = await repo.prepare(claim); const slice = (await repo.hostSlices(claim))[0];
    if (!slice || prepared.operation.desired_revision === null) throw new Error('Host slice absent');
    const scope: AuthorityScope = { operation_id: claim.operation.id, host_id: host.host_id, scope_sha256: slice.target_sha256,
      runtime_key: 'canary-worker', claim_epoch: claim.epoch, worker_id: claim.worker_id, claim_token: claim.claim_token,
      prepared_revision: prepared.operation.desired_revision };
    await repo.startStep(claim, 'artifacts'); await repo.completeStep(claim, 'artifacts', { artifact_sha256: 'a'.repeat(64) });
    await repo.startStep(claim, 'credentials');
    await execute('/usr/bin/openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=agent-canary-worker',
      '-keyout', join(directory, 'worker.key'), '-out', join(directory, 'worker.csr')]);
    const csr_pem = await readFile(join(directory, 'worker.csr'), 'utf8');
    const issued = await client.invoke(host.host_id, packet({ action: 'issue', phase: 'bootstrap', scope, csr_pem, csr_sha256: hash(csr_pem),
      idempotency_key: 'zz-canary-enclave' })) as { certificate_pem: string; certificate_sha256: string; token: string; token_sha256: string };
    expect(new X509Certificate(issued.certificate_pem).fingerprint256.replaceAll(':', '').toLowerCase()).toBe(issued.certificate_sha256);
    expect(hash(issued.token)).toBe(issued.token_sha256);
    await writeFile(join(directory, 'issued.crt'), issued.certificate_pem);
    await execute('/usr/bin/openssl', ['verify', '-purpose', 'sslclient', '-CAfile', join(directory, 'ca.crt'), join(directory, 'issued.crt')]);
    const registered = JSON.parse(await readFile(join(directory, 'fleet_mtls/mtls_identities.json'), 'utf8')) as { identities: unknown[] };
    expect(registered.identities).toEqual([expect.objectContaining({ certificate_sha256: issued.certificate_sha256 })]);

    const observed = await client.invoke(host.host_id, packet({ action: 'inventory', scope })) as { authorities: { id: string; sha256: string }[] };
    const operation = await repo.get(company.hub.id, 'owner', claim.operation.id, `console:${company.user.id}`);
    await repo.cancel(company.hub.id, 'owner', operation.id, operation.version, `console:${company.user.id}`);
    await client.invoke(host.host_id, packet({ action: 'revoke', scope, expected_inventory: observed.authorities.map(({ id, sha256 }) => ({ id, sha256 })) }));
    const absent = await client.invoke(host.host_id, packet({ action: 'verify_absent', scope })) as { authorities: { matching_records: unknown[] }[] };
    expect(absent.authorities.every(row => row.matching_records.length === 0)).toBe(true);
    expect(JSON.parse(await readFile(join(directory, 'fleet_mtls/mtls_identities.json'), 'utf8'))).toEqual({ version: 1, identities: [] });

    child.kill('SIGTERM'); expect(await exited(child)).toBe(0); expect(diagnostic).toBe('');
    await expect(lstat(socket)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 60_000);
  it('names the failing startup stage without printing the database URL', async () => {
    await chmod(join(directory, 'database-url'), 0o640);
    expect(await exited(await launch())).toBe(1);
    expect(diagnostic).toBe('Signed fleet authority database configuration is unavailable\n');
    await chmod(join(directory, 'database-url'), 0o600); await chmod(join(directory, 'run'), 0o750);
    expect(await exited(await launch())).toBe(1);
    expect(diagnostic).toBe('Signed fleet authority socket is unavailable\n');
    await chmod(join(directory, 'run'), 0o700); await writeFile(join(directory, 'command.v1.json'), '{}', { mode: 0o600 });
    expect(await exited(await launch())).toBe(1);
    expect(diagnostic).toBe('Signed fleet authority issuer command is unavailable\n');
  }, 60_000);
});
