import Fastify, { type FastifyInstance } from 'fastify';
import { execFile } from 'node:child_process';
import { createHash, randomBytes, sign, X509Certificate } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FleetOperationsRepository, createPool, hostRequestMessage, hostKeyFingerprint, withTransaction, type DatabasePool, type RegisteredCompany,
  type FleetOperationClaim } from '@cauce/store';
import { preparePostgresSuite } from '../../../../packages/store/test/postgres-suite.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../../tests/helpers/postgres.js';
import { channelCompany, channelHost, channelCreate, type ChannelHost } from './host-channel.fixtures.js';
import { startSignedFleetAuthorityBridge } from './authority/signed-bridge.js';
import { SignedFleetAuthorityClient } from './authority/signed-client.js';
import type { AuthorityCommand } from './authority/command.js';
import type { AuthorityScope } from './authority/schemas.js';
import { registerHostAuthorityRoutes } from './host-authority.routes.js';
import { hostFleetExecution } from './host-channel.execution.js';
import { buildGateway } from '../app.js';
import { DevOnlyAuthProvider } from '../auth.js';
import { noDeliveryWakes } from '../test-support/gateway-doubles.js';

let database: TestDatabase | undefined; let current: EmptyTestDatabase | undefined;
let pool: DatabasePool; let app: FastifyInstance; let company: RegisteredCompany; let host: ChannelHost;
let directory: string; let socket: string; let bridge: FastifyInstance; let command: AuthorityCommand;
let repo: FleetOperationsRepository; let claim: FleetOperationClaim; let scope: AuthorityScope; let client: SignedFleetAuthorityClient;
let issue: { action: 'issue'; phase: 'bootstrap'; csr_pem: string; csr_sha256: string; idempotency_key: string; scope: AuthorityScope };
const execute = promisify(execFile); const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function packet(payload: Record<string, unknown>, signedHost = host, path = `/v3/fleet/hosts/${signedHost.host_id}/authority`) {
  const value = { company_id: signedHost.company_id, host_id: signedHost.host_id, issued_at: Date.now(),
    nonce: randomBytes(32).toString('hex'), payload, proof: '' };
  value.proof = sign(null, Buffer.from(hostRequestMessage('POST', path, value)), signedHost.keys.privateKey).toString('base64');
  return value;
}
function post(payload: Record<string, unknown>, headers: Record<string, string> = {}) {
  return app.inject({ method: 'POST', url: `/v3/fleet/hosts/${host.host_id}/authority`, headers, payload: packet(payload) });
}
function raw(body: unknown, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    const outgoing = httpRequest({ socketPath: socket, path: '/signed-authority', method: 'POST',
      headers: { 'content-type': 'application/json', ...headers } }, response => {
      let data = ''; response.on('data', chunk => { data += String(chunk); });
      response.on('end', () => { resolve({ status: response.statusCode ?? 0, body: JSON.parse(data) as unknown }); });
    }); outgoing.on('error', reject); outgoing.end(JSON.stringify(body));
  });
}
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);
beforeEach(async () => {
  if (!database) throw new Error('Test database absent');
  current = await startTestCaseDatabase(database); pool = createPool(current.url, { max: 1 });
  company = await channelCompany(pool, 'signed-authority'); host = await channelHost(pool, company);
  directory = await mkdtemp('/var/tmp/cauce-enrolled-authority-');
  await mkdir(join(directory, 'runtime'), { mode: 0o700 });
  repo = new FleetOperationsRepository(pool);
  const create = channelCreate(company, host, 'signed-worker');
  if (create.kind !== 'create') throw new Error('Create request absent');
  create.parameters.placement = { host_id: host.host_id, mode: 'native', runtime_user: userInfo().username,
    systemd_user: userInfo().username, home_directory: directory, state_directory: join(directory, 'runtime/signed-worker') };
  await repo.enqueue(company.hub.id, 'owner', create, `console:${company.user.id}`);
  const acquired = await repo.claim(`host-${host.host_id}`, host.host_id); if (!acquired) throw new Error('Claim absent'); claim = acquired;
  const prepared = await repo.prepare(claim); const slice = (await repo.hostSlices(claim))[0];
  if (!slice || prepared.operation.desired_revision === null) throw new Error('Host slice absent');
  scope = { operation_id: claim.operation.id, host_id: host.host_id, scope_sha256: slice.target_sha256, runtime_key: 'signed-worker',
    claim_epoch: claim.epoch, worker_id: claim.worker_id, claim_token: claim.claim_token, prepared_revision: prepared.operation.desired_revision };
  await repo.startStep(claim, 'artifacts'); await repo.completeStep(claim, 'artifacts', { artifact_sha256: 'a'.repeat(64) });
  await repo.startStep(claim, 'credentials');
  const state = join(directory, 'state'); await mkdir(state, { mode: 0o700 });
  const registries: Record<string, string> = {};
  for (const name of ['base_mtls', 'base_token', 'fleet_mtls', 'fleet_token']) {
    const parent = join(directory, name); await mkdir(parent, { mode: 0o700 });
    registries[name] = join(parent, name.endsWith('mtls') ? 'mtls_identities.json' : 'token_hashes.json');
    await writeFile(registries[name], JSON.stringify({ version: 1, identities: [] }), { mode: 0o600 });
  }
  const certificate = join(directory, 'ca.crt'), key = join(directory, 'ca.key');
  await execute('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '3', '-subj', '/CN=enrolled-authority-fixture',
    '-keyout', key, '-out', certificate, '-addext', 'basicConstraints=critical,CA:TRUE',
    '-addext', 'keyUsage=critical,keyCertSign,cRLSign']); await chmod(key, 0o600);
  const csr = join(directory, 'worker.csr');
  await execute('/usr/bin/openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=agent-signed-worker',
    '-keyout', join(directory, 'worker.key'), '-out', csr]);
  const csr_pem = await readFile(csr, 'utf8');
  issue = { action: 'issue', phase: 'bootstrap', scope, csr_pem, csr_sha256: hash(csr_pem), idempotency_key: 'signed-authority-fixture' };
  const policy_file = join(directory, 'policy.json');
  await writeFile(policy_file, JSON.stringify({ version: 1, state_root: state, registries,
    signer: { certificate, key, certificate_sha256: hash(await readFile(certificate)), key_sha256: hash(await readFile(key)) } }), { mode: 0o600 });
  const executable = fileURLToPath(new URL('../../../../ops/cli/fleet-authority-issuer.py', import.meta.url));
  command = { python: '/usr/bin/python3', executable, sha256: hash(await readFile(executable)), policy_file, policy_sha256: hash(await readFile(policy_file)) };
  socket = join(directory, 'signed.sock'); const policy = { ownerUid: process.geteuid?.() ?? 0, peerUid: process.geteuid?.() ?? 0 };
  bridge = await startSignedFleetAuthorityBridge(socket, pool, { ...policy, command }); client = new SignedFleetAuthorityClient(socket, policy);
  app = Fastify(); registerHostAuthorityRoutes(app, client);
});
afterEach(async () => { await app.close(); await bridge.close(); await pool.end(); await current?.close();
  if (directory) await rm(directory, { recursive: true, force: true }); });
afterAll(async () => { await database?.pool.end(); await database?.container.stop(); });
describe('signed authority for self-service enrolled computers', () => {
  it('reports authority readiness through the enrolled proof without a static host catalog', async () => {
    const path = `/v3/fleet/hosts/${host.host_id}/authority`;
    const response = await app.inject({ method: 'POST', url: path, payload: packet({ action: 'ready' }) });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ready: true, host_id: host.host_id });
  });
  it('issues a real certificate through the signed envelope and central issuer without a second SQL connection', async () => {
    const response = await post(issue); expect(response.statusCode).toBe(200);
    const issued = response.json<{ certificate_pem: string; certificate_sha256: string; token: string; token_sha256: string }>();
    expect(new X509Certificate(issued.certificate_pem).fingerprint256.replaceAll(':', '').toLowerCase()).toBe(issued.certificate_sha256);
    expect(hash(issued.token)).toBe(issued.token_sha256);
    await writeFile(join(directory, 'issued.crt'), issued.certificate_pem);
    await execute('/usr/bin/openssl', ['verify', '-purpose', 'sslclient', '-CAfile', join(directory, 'ca.crt'), join(directory, 'issued.crt')]);
    expect((await post(issue)).json()).toEqual(issued);
    const inventory = (await post({ action: 'inventory', scope })).body;
    expect(inventory).not.toContain(issued.token); expect(inventory).not.toContain('PRIVATE KEY');
  });
  it('rejects replay and signatures bound to another route before issuance', async () => {
    const envelope = packet({ action: 'ready' });
    expect(await client.invoke(host.host_id, envelope)).toEqual({ ready: true, host_id: host.host_id });
    await expect(client.invoke(host.host_id, envelope)).rejects.toMatchObject({ code: 'conflict' });
    await expect(client.invoke(host.host_id, packet(issue, host, `/v3/fleet/hosts/${host.host_id}/channel`))).rejects.toMatchObject({ code: 'forbidden' });
    const inventory = (await post({ action: 'inventory', scope })).json<{ authorities: { id: string; matching_records: unknown[] }[] }>();
    expect(inventory.authorities.find(row => row.id === 'fleet_mtls')?.matching_records).toEqual([]);
  });
  it.each(['identity','host','company'] as const)('rejects a revoked %s without falling back to the legacy issuer', async kind => {
    if (kind === 'identity') await pool.query('UPDATE fleet_host_identities SET enabled=false WHERE host_id=$1', [host.host_id]);
    if (kind === 'host') await pool.query('UPDATE fleet_hosts SET enabled=false WHERE host_id=$1', [host.host_id]);
    if (kind === 'company') await current?.adminPool.query('UPDATE companies SET enabled=false WHERE id=$1', [host.company_id]);
    expect((await post(issue)).statusCode).toBe(403);
    expect((await post({ action: 'ready' })).statusCode).toBe(403);
  });
  it('rejects foreign company operations and altered scope, claim, CSR and admission phase', async () => {
    const otherCompany = await channelCompany(pool, 'foreign-authority'); const otherHost = await channelHost(pool, otherCompany);
    await expect(client.invoke(otherHost.host_id, packet(issue, otherHost))).rejects.toMatchObject({ code: 'AUTHORITY_REVOKED' });
    for (const change of [{ host_id: otherHost.host_id }, { runtime_key: 'other-worker' }, { scope_sha256: '0'.repeat(64) },
      { claim_epoch: scope.claim_epoch + 1 }, { claim_token: '51000000-0000-4000-8000-000000000009' }]) {
      expect((await post({ ...issue, scope: { ...scope, ...change } })).statusCode).toBe(409);
    }
    expect((await post({ ...issue, csr_sha256: '0'.repeat(64) })).statusCode).toBe(409);
    expect((await post({ ...issue, phase: 'normal' })).statusCode).toBe(409);
  });
  it('denies the original fence after lease expiry and after human authority revocation', async () => {
    await pool.query("UPDATE fleet_operations SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [scope.operation_id]);
    expect((await post(issue)).statusCode).toBe(409);
    const replacement = await repo.claim('replacement-worker', host.host_id); if (!replacement) throw new Error('Replacement absent');
    const second = (await pool.query<{ id: string }>(`INSERT INTO console_users(email,email_normalized,password_hash,display_name,role,tenant_id,alias)
      SELECT 'second-owner@example.test','second-owner@example.test',password_hash,'Second owner',role,tenant_id,alias
      FROM console_users WHERE id=$1 RETURNING id`, [company.user.id])).rows[0];
    if (!second) throw new Error('Second owner absent');
    await pool.query(`INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,role,permissions)
      VALUES($1,$2,'owner','operator',ARRAY['read','control'])`, [second.id,company.hub.id]);
    await current?.adminPool.query(`INSERT INTO company_admins(company_id,human_id,role,source)
      VALUES($1,$2,'owner','v4.0-hub-operator')`, [company.company.id,second.id]);
    await pool.query('UPDATE console_users SET active=false WHERE id=$1', [company.user.id]);
    expect((await post({ ...issue, scope: { ...scope, claim_epoch: replacement.epoch, worker_id: replacement.worker_id,
      claim_token: replacement.claim_token } })).statusCode).toBe(409);
  });
  it('rejects session cookies and malformed requests at both transport boundaries', async () => {
    expect((await post(issue, { cookie: 'console_session=fixture' })).statusCode).toBe(403);
    expect(await raw({ host_id: host.host_id, packet: packet(issue) }, { cookie: 'console_session=fixture' }))
      .toEqual({ status: 403, body: { error: 'AUTHORITY_REVOKED' } });
    expect(await raw({ host_id: host.host_id, packet: { ...packet(issue), extra: true } }))
      .toEqual({ status: 400, body: { error: 'INVALID_REQUEST' } });
    expect((await post({ action: 'issue', private_key: 'must-not-log' })).statusCode).toBe(400);
  });
  it('fails closed when the issuer is unavailable or the caller aborts', async () => {
    await chmod(join(directory, 'ca.key'), 0o644);
    expect((await post({ action: 'ready' })).statusCode).toBe(409);
    expect((await post(issue)).statusCode).toBe(409);
    const abort = new AbortController(); abort.abort();
    await expect(client.invoke(host.host_id, packet(issue), abort.signal)).rejects.toMatchObject({ code: 'AUTHORITY_UNAVAILABLE' });
  });
  it('wires the complete gateway to the real authority client while accepting only enrolled proof', async () => {
    const gateway = await buildGateway({ pool: current?.pool ?? pool, authProvider: DevOnlyAuthProvider.forTests(),
      signedFleetAuthorityClient: client, deliveryWakeSubscriber: noDeliveryWakes });
    try {
      const response = await gateway.inject({ method: 'POST', url: `/v3/fleet/hosts/${host.host_id}/authority`, payload: packet({ action: 'ready' }) });
      expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ ready: true, host_id: host.host_id });
    } finally { await gateway.close(); }
  });
  it('revokes centrally issued material through a fresh signed claim and observes absence', async () => {
    expect((await post(issue)).statusCode).toBe(200);
    const observed = (await post({ action: 'inventory', scope })).json<{ authorities: { id: string; sha256: string }[] }>();
    const expected_inventory = observed.authorities.map(({ id, sha256 }) => ({ id, sha256 }));
    expect((await post({ action: 'revoke', scope, expected_inventory })).statusCode).toBe(409);
    const operation = await repo.get(company.hub.id, 'owner', claim.operation.id, `console:${company.user.id}`);
    await repo.cancel(company.hub.id, 'owner', operation.id, operation.version, `console:${company.user.id}`);
    expect((await post({ action: 'revoke', scope, expected_inventory })).statusCode).toBe(200);
    const absent = (await post({ action: 'verify_absent', scope })).json<{ authorities: { matching_records: unknown[] }[] }>();
    expect(absent.authorities.every(row => row.matching_records.length === 0)).toBe(true);
  });
  it('measures the Unix peer UID and rejects a different configured gateway process', async () => {
    await bridge.close(); await chmod(directory, 0o750);
    bridge = await startSignedFleetAuthorityBridge(socket, pool, { command, ownerUid: process.geteuid?.() ?? 0,
      peerUid: (process.geteuid?.() ?? 0) + 1, groupGid: process.getegid?.() ?? 0 });
    expect(await raw({ host_id: host.host_id, packet: packet({ action: 'ready' }) }))
      .toEqual({ status: 403, body: { error: 'AUTHORITY_REVOKED' } });
  });
  it('materializes signed Python credentials over verified TLS and starts and stops a fenced native fixture process', async () => {
    const tlsKey = join(directory, 'gateway.key'), tlsCsr = join(directory, 'gateway.csr'), tlsCert = join(directory, 'gateway.crt');
    await execute('/usr/bin/openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=127.0.0.1', '-keyout', tlsKey, '-out', tlsCsr]);
    const extension = join(directory, 'gateway.ext');
    await writeFile(extension, 'basicConstraints=critical,CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1\n');
    await execute('/usr/bin/openssl', ['x509', '-req', '-in', tlsCsr, '-CA', join(directory, 'ca.crt'), '-CAkey', join(directory, 'ca.key'),
      '-set_serial', '42', '-days', '1', '-extfile', extension, '-out', tlsCert]);
    const gateway = Fastify({ https: { key: await readFile(tlsKey), cert: await readFile(tlsCert) } });
    registerHostAuthorityRoutes(gateway, client); await gateway.listen({ host: '127.0.0.1', port: 0 });
    try {
      const address = gateway.server.address(); if (!address || typeof address === 'string') throw new Error('TLS server absent');
      const identity = join(directory, 'identity'); await mkdir(identity, { mode: 0o700 });
      await writeFile(join(identity, 'private.pem'), host.keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
      const enrollment = (await pool.query<{ enrollment_id: string }>('SELECT enrollment_id FROM fleet_host_identities WHERE host_id=$1', [host.host_id])).rows[0];
      await writeFile(join(identity, 'identity.json'), JSON.stringify({ enrollment_id: enrollment?.enrollment_id, company_id: host.company_id,
        host_id: host.host_id, gateway: `https://127.0.0.1:${String(address.port)}/`, state: 'enrolled', executor_ready: false,
        key_fingerprint: hostKeyFingerprint(host.keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')) }), { mode: 0o600 });
      const execution = await withTransaction(pool, tx => hostFleetExecution(tx, host, claim));
      const context = { operation_id: claim.operation.id, request: execution.request, fenced_targets: execution.fenced_targets,
        previous_agents: execution.previous_agents ?? [], desired_memberships: execution.desired_memberships ?? [],
        snapshot: execution.snapshot, trusted_accounts: execution.trusted_accounts, fleet_scope: execution.fleet_scope };
      const source = fileURLToPath(new URL('../../../../ops/tests/test_fleet_executor.py', import.meta.url));
      const script = `import importlib.util,json,pathlib,sys
s=importlib.util.spec_from_file_location('physical_fixture',sys.argv[1])
m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
f=m.PhysicalExecutorTest();f.setUp();c=json.load(sys.stdin);f.context=c;a=c['snapshot']['agents'][0]
f.policy['host_id']=a['host_id']
f.policy['roots']['runtime']=str(pathlib.Path(a['state_directory']).parent)
f.roots['runtime']=pathlib.Path(f.policy['roots']['runtime'])
f.policy['native']=[{'runtime_user':a['runtime_user'],'systemd_user':a['systemd_user'],
 'home_directory':a['home_directory'],'state_root':f.policy['roots']['runtime']}]
f.policy['authority']={'identity_directory':sys.argv[2],'host_id':a['host_id'],'ca_certificate':sys.argv[3]}
f.policy['transport']={'bootstrap_url':'https://bootstrap.fixture.invalid','gateway_url':'https://gateway.fixture.invalid',
 'ca_certificate':sys.argv[3],'network':'none'}
profile=f.root/'provider-profile';profile.mkdir(mode=448)
f.policy['profiles']={a['primary_account_id']:{'provider':'codex','identity':a['primary_account_id'],
 'runtime_user':a['runtime_user'],'path':str(profile)}}
f.save_policy();out={}
try:
 sys.path.insert(0,str(pathlib.Path(sys.argv[1]).parents[1]/'cli'))
 import fleet_executor_authority as authority
 assert authority.authority_ready(f.policy),'signed Python issuer readiness rejected'
 for step in ('artifacts','credentials','runtime'):
  r=f.run_step(step)
  assert r.returncode==0,r.stderr
  out[step]=json.loads(r.stdout)['evidence']
 metadata=json.loads((f.roots['runtime']/'.control'/a['runtime_key']/'cauce-v3-adapter.json').read_text())
 pid=metadata['pid'];out['running']=pathlib.Path('/proc/'+str(pid)).exists()
 out['runtime_uid']=metadata['runtimeUid'];out['tenant']=metadata['tenantId'];out['alias']=metadata['wireAlias']
 r=f.run_step('stop');assert r.returncode==0,r.stderr
 out['stopped']=json.loads(r.stdout)['evidence']['stopped_verified'];out['process_absent']=not pathlib.Path('/proc/'+str(pid)).exists()
finally:
 f.run_step('stop');f.temporary.cleanup()
print(json.dumps(out))
`;
      const running = execute('/usr/bin/python3', ['-c', script, source, identity, join(directory, 'ca.crt')],
        { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, timeout: 45_000, maxBuffer: 16_384 });
      running.child.stdin?.end(JSON.stringify(context));
      const receipt = JSON.parse((await running).stdout) as { running: boolean; runtime_uid: number; tenant: string; alias: string;
        stopped: boolean; process_absent: boolean; credentials: { certificate_fingerprint: string } };
      expect(receipt).toMatchObject({ running: true, runtime_uid: process.geteuid?.(), tenant: company.hub.id, alias: 'signed-worker',
        stopped: true, process_absent: true });
      expect(receipt.credentials.certificate_fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    } finally { await gateway.close(); }
  }, 60_000);
});
