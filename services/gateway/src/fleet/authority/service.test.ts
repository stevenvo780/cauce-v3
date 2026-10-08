import { execFile } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FleetOperationsRepository, createPool, type DatabasePool, type FleetOperationClaim } from '@cauce/store';
import { preparePostgresSuite } from '../../../../../packages/store/test/postgres-suite.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../../../tests/helpers/postgres.js';
import { FleetAuthorityClient } from './client.js';
import { createFleetAuthorityService } from './service.js';
import { startFleetAuthoritySocket } from './socket.js';
import type { AuthorityCommand } from './command.js';
import type { AuthorityScope } from './schemas.js';

const execute = promisify(execFile);
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
let database: TestDatabase | undefined;
let current: EmptyTestDatabase | undefined;
let pool: DatabasePool; let directory: string; let repo: FleetOperationsRepository; let claim: FleetOperationClaim;
let scope: AuthorityScope; let humanId: string; let command: AuthorityCommand;
let server: Awaited<ReturnType<typeof startFleetAuthoritySocket>> | undefined;
let client: FleetAuthorityClient;
let request: { phase: 'bootstrap'; csr_pem: string; csr_sha256: string; idempotency_key: string };
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);
beforeEach(async () => {
  if (!database) throw new Error('Test database absent');
  current = await startTestCaseDatabase(database); pool = createPool(current.url, { max: 1 });
  directory = await mkdtemp('/var/tmp/cauce-central-authority-');
  await pool.query("INSERT INTO rooms(id,tenant_id) VALUES('authority-admin','Steven'),('authority-room','Steven')");
  await pool.query("INSERT INTO agents(tenant_id,alias) VALUES('Steven','authority_operator')");
  await pool.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES('Steven','authority-admin','authority_operator','operator')");
  const human = (await pool.query<{ id: string }>(`INSERT INTO console_users(email,email_normalized,password_hash,display_name,role,tenant_id,alias)
    VALUES('authority@example.test','authority@example.test',$1,'Authority fixture','operator','Steven','authority_operator') RETURNING id`,
  ['$scrypt$' + 'x'.repeat(48)])).rows[0];
  if (!human) throw new Error('Test human absent'); humanId = human.id;
  await pool.query(`INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,role,permissions)
    VALUES($1,'Steven','authority_operator','operator',ARRAY['read','control'])`, [humanId]);
  await pool.query(`INSERT INTO provider_accounts(id,provider,external_account_id,payer_tenant_id,credential_ref_kind,credential_ref,enabled)
    VALUES('authority-account','codex','authority-fixture-account','Steven','env_path','CAUCE_AUTHORITY_FIXTURE_PATH',true)`);
  repo = new FleetOperationsRepository(pool, { controllerHost: 'host-a', coordinatorEnabled: true, coordinatorHosts: ['host-a'] });
  await repo.enqueue('Steven', 'authority_operator', { kind: 'create', target: { resource: 'agent', tenant_id: 'Steven', alias: 'authority_agent' },
    expected_revision: 0, idempotency_key: 'authority-create-fixture', parameters: { runtime_key: 'runtime-a', harness_id: 'codex',
      primary_room_id: 'authority-room', primary_account_id: 'authority-account', memberships: [{ room_id: 'authority-room', role: 'agent' }],
      placement: { host_id: 'host-a', mode: 'native', runtime_user: 'dev', home_directory: '/home/dev',
        state_directory: '/var/tmp/authority-runtime/runtime-a', systemd_user: 'stev' } } }, `console:${humanId}`);
  const acquired = await repo.claim('authority-worker', 'host-a'); if (!acquired) throw new Error('Claim absent'); claim = acquired;
  const prepared = await repo.prepare(claim); const slice = (await repo.hostSlices(claim))[0];
  if (!slice || prepared.operation.desired_revision === null) throw new Error('Host slice absent');
  scope = { operation_id: claim.operation.id, host_id: 'host-a', scope_sha256: slice.target_sha256, runtime_key: 'runtime-a',
    claim_epoch: claim.epoch, worker_id: claim.worker_id, claim_token: claim.claim_token, prepared_revision: prepared.operation.desired_revision };
  await repo.startStep(claim, 'artifacts'); await repo.completeStep(claim, 'artifacts', { artifact_sha256: 'a'.repeat(64) });
  await repo.startStep(claim, 'credentials');
  const state = join(directory, 'state'); await execute('/usr/bin/mkdir', ['-m', '700', state]);
  const registries: Record<string, string> = {};
  for (const name of ['base_mtls', 'base_token', 'fleet_mtls', 'fleet_token']) {
    const parent = join(directory, name); await execute('/usr/bin/mkdir', ['-m', '700', parent]);
    registries[name] = join(parent, name.endsWith('mtls') ? 'mtls_identities.json' : 'token_hashes.json');
    await writeFile(registries[name], JSON.stringify({ version: 1, identities: [] }), { mode: 0o600 });
  }
  const certificate = join(directory, 'ca.crt'), key = join(directory, 'ca.key');
  await execute('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=central-authority-fixture',
    '-keyout', key, '-out', certificate, '-addext', 'basicConstraints=critical,CA:TRUE']); await chmod(key, 0o600);
  const csr = join(directory, 'worker.csr');
  await execute('/usr/bin/openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=agent-runtime-a',
    '-keyout', join(directory, 'worker.key'), '-out', csr]);
  const csr_pem = await readFile(csr, 'utf8'); request = { phase: 'bootstrap', csr_pem, csr_sha256: hash(csr_pem), idempotency_key: 'authority-issue-fixture' };
  const policy_file = join(directory, 'policy.json');
  await writeFile(policy_file, JSON.stringify({ version: 1, state_root: state, registries,
    signer: { certificate, key, certificate_sha256: hash(await readFile(certificate)), key_sha256: hash(await readFile(key)) } }), { mode: 0o600 });
  const executable = fileURLToPath(new URL('../../../../../ops/cli/fleet-authority-issuer.py', import.meta.url));
  command = { python: '/usr/bin/python3', executable, sha256: hash(await readFile(executable)), policy_file, policy_sha256: hash(await readFile(policy_file)) };
  const service = createFleetAuthorityService(pool, { host_id: 'host-a', command });
  const socket = join(directory, 'host-a.sock'), socketPolicy = { host_id: 'host-a', ownerUid: process.geteuid?.() ?? 0 };
  server = await startFleetAuthoritySocket(socket, service, socketPolicy); client = new FleetAuthorityClient(socket, socketPolicy);
});
afterEach(async () => {
  await server?.close(); server = undefined; await pool.end(); await current?.close(); current = undefined;
  await rm(directory, { recursive: true, force: true });
});
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });
describe('central fleet authority through a private host socket and PostgreSQL', () => {
  it('issues a real constrained CSR certificate and recovers the same private response after caller loss', async () => {
    const issued = await client.issue(scope, request);
    expect(new X509Certificate(issued.certificate_pem).fingerprint256.replaceAll(':', '').toLowerCase()).toBe(issued.certificate_sha256);
    expect(hash(issued.token)).toBe(issued.token_sha256);
    await writeFile(join(directory, 'issued.crt'), issued.certificate_pem);
    await execute('/usr/bin/openssl', ['verify', '-purpose', 'sslclient', '-CAfile', join(directory, 'ca.crt'), join(directory, 'issued.crt')]);
    expect(await client.issue(scope, request)).toEqual(issued);
    expect((await lstat(join(directory, 'host-a.sock'))).mode & 0o777).toBe(0o600);
    const observed = await client.inventory(scope);
    expect(observed.authorities.filter(row => row.matching_records.length === 1).map(row => row.id)).toEqual(['fleet_mtls', 'fleet_token']);
    expect(JSON.stringify(observed)).not.toContain(issued.token);
    expect(JSON.stringify(observed)).not.toContain('PRIVATE KEY');
  });
  it('rejects foreign host, runtime, slice, epoch and claim before an effect, including a stale human', async () => {
    for (const changed of [{ host_id: 'host-b' }, { runtime_key: 'runtime-b' }, { scope_sha256: '0'.repeat(64) },
      { claim_epoch: scope.claim_epoch + 1 }, { claim_token: '71000000-0000-4000-8000-000000000009' }]) {
      await expect(client.issue({ ...scope, ...changed }, request)).rejects.toMatchObject({ code: 'AUTHORITY_REVOKED' });
    }
    expect((await client.inventory(scope)).authorities.every(row => row.matching_records.length === 0)).toBe(true);
    await pool.query('UPDATE console_users SET active=false WHERE id=$1', [humanId]);
    await expect(client.issue(scope, request)).rejects.toMatchObject({ code: 'AUTHORITY_REVOKED' });
  });
  it('recovers the same issuance after claim replacement and denies the expired original claim', async () => {
    const issued = await client.issue(scope, request);
    await pool.query("UPDATE fleet_operations SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [scope.operation_id]);
    const replacement = await repo.claim('replacement-worker', 'host-a'); if (!replacement) throw new Error('Replacement absent');
    await expect(client.inventory(scope)).rejects.toMatchObject({ code: 'AUTHORITY_REVOKED' });
    expect(await client.issue({ ...scope, claim_epoch: replacement.epoch, worker_id: replacement.worker_id, claim_token: replacement.claim_token }, request))
      .toEqual(issued);
  });
  it('requires explicit cancellation for revocation and credits only freshly observed absence after CAS', async () => {
    const issued = await client.issue(scope, request); const observed = await client.inventory(scope);
    const pins = observed.authorities.map(({ id, sha256 }) => ({ id, sha256 }));
    await expect(client.revoke(scope, pins)).rejects.toMatchObject({ code: 'AUTHORITY_REVOKED' });
    await expect(client.verifyAbsent(scope)).rejects.toMatchObject({ code: 'AUTHORITY_UNAVAILABLE' });
    const operation = await repo.get('Steven', 'authority_operator', scope.operation_id, `console:${humanId}`);
    await repo.cancel('Steven', 'authority_operator', scope.operation_id, operation.version, `console:${humanId}`);
    await pool.query(`INSERT INTO config_revisions(actor_tenant,actor_alias,operation,inverse_operation,summary)
      VALUES('Steven','authority_operator','{}','{}','Fixture configuration changed after cancellation')`);
    const revoked = await client.revoke(scope, pins);
    expect(revoked.authorities.every(row => row.matching_records.length === 0)).toBe(true);
    expect(await client.verifyAbsent(scope)).toEqual(revoked);
    await expect(client.issue(scope, request)).rejects.toMatchObject({ code: 'AUTHORITY_REVOKED' });
    expect(JSON.stringify(revoked)).not.toContain(issued.token);
    await chmod(join(directory, 'host-a.sock'), 0o660);
    await expect(client.inventory(scope)).rejects.toMatchObject({ code: 'AUTHORITY_UNAVAILABLE' });
  });
});
