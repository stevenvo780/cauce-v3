import { execFile } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FleetOperationsRepository, companyRevision, createPool, withTransaction, type DatabasePool, type FleetOperationClaim } from '@cauce/store';
import { preparePostgresSuite } from '../../../../../packages/store/test/postgres-suite.js';
import { seedCompanyActors } from '../../../../../packages/store/test/companies-postgres.fixtures.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../../../tests/helpers/postgres.js';
import { FleetAuthorityClient } from './client.js';
import { createFleetAuthorityService } from './service.js';
import { startFleetAuthoritySocket } from './socket.js';
import { runAuthorityReadiness, type AuthorityCommand } from './command.js';
import { AuthorityInventorySchema, AuthorityIssuedRevocationSchema, type AuthorityScope, type TerminalIssue } from './schemas.js';

const execute = promisify(execFile);
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
let database: TestDatabase | undefined;
let current: EmptyTestDatabase | undefined;
let pool: DatabasePool; let directory: string; let repo: FleetOperationsRepository; let claim: FleetOperationClaim;
let scope: AuthorityScope; let humanId: string; let command: AuthorityCommand;
let server: Awaited<ReturnType<typeof startFleetAuthoritySocket>> | undefined;
let client: FleetAuthorityClient;
let request: { phase: 'bootstrap'; csr_pem: string; csr_sha256: string; idempotency_key: string };
async function readiness() {
  return new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    const outgoing = httpRequest({ socketPath: join(directory, 'host-a.sock'), path: '/authority-ready', method: 'POST',
      headers: { 'content-type': 'application/json' } }, response => {
      let body = ''; response.on('data', chunk => { body += String(chunk); });
      response.on('end', () => { resolve({ status: response.statusCode ?? 0, body: JSON.parse(body) as unknown }); });
    }); outgoing.on('error', reject); outgoing.end('{}');
  });
}
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
  await current.adminPool.query("INSERT INTO company_admins(company_id,human_id,role,source) SELECT company_id,id,'admin','v4.0-hub-operator' FROM console_users WHERE id=$1", [humanId]);
  await pool.query(`INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,permissions)
    VALUES($1,'Steven','authority_operator',ARRAY['read','control'])`, [humanId]);
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
  const socket = join(directory, 'host-a.sock'), socketPolicy = { host_id: 'host-a', ownerUid: process.geteuid?.() ?? 0,
    readiness: () => runAuthorityReadiness(command) };
  server = await startFleetAuthoritySocket(socket, service, socketPolicy); client = new FleetAuthorityClient(socket, socketPolicy);
});
afterEach(async () => {
  await server?.close(); server = undefined; await pool.end(); await current?.close(); current = undefined;
  await rm(directory, { recursive: true, force: true });
});
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });
describe('central fleet authority through a private host socket and PostgreSQL', () => {
  async function terminalRequest(): Promise<TerminalIssue> {
    const filename = join(directory, 'policy.json');
    const policy = JSON.parse(await readFile(filename, 'utf8')) as { registries: Record<string, string>; terminal?: unknown };
    policy.registries.pty = join(directory, 'pty_agent_identities.json');
    await writeFile(policy.registries.pty, JSON.stringify({ version: 1, agents: [] }), { mode: 0o600 });
    const master = join(directory, 'terminal-master'); await writeFile(master, 'ab'.repeat(32), { mode: 0o600 });
    policy.terminal = { master_file: master, master_sha256: hash(await readFile(master)), relay_host: 'relay.example.test', relay_port: 8445 };
    await writeFile(filename, JSON.stringify(policy), { mode: 0o600 }); command.policy_sha256 = hash(await readFile(filename));
    await execute('/usr/bin/openssl', ['req', '-new', '-key', join(directory, 'worker.key'), '-subj', '/CN=pty-runtime-a',
      '-out', join(directory, 'terminal.csr')]);
    const csr_pem = await readFile(join(directory, 'terminal.csr'), 'utf8');
    return { csr_pem, csr_sha256: hash(csr_pem), idempotency_key: 'terminal-grant-fixture' };
  }
  async function startAdmission() {
    await repo.completeStep(claim, 'credentials', { certificate_fingerprint: 'a'.repeat(64) });
    for (const [name, evidence] of [
      ['runtime', { runtime_digest: 'a'.repeat(64) }], ['authenticate', { provider_verified: true }],
      ['profile', { profile_verified: true }],
      ['verify', { provider_verified: true, profile_verified: true, bootstrap_verified: true, roundtrip_verified: true }],
    ] as const) { await repo.startStep(claim, name); await repo.completeStep(claim, name, evidence); }
    await repo.startStep(claim, 'admission');
  }
  it('issues only a fenced terminal grant during admission and revokes only its own receipt', async () => {
    const terminal = await terminalRequest();
    await expect(client.issueTerminal(scope, terminal)).rejects.toMatchObject({ code: 'AUTHORITY_REVOKED' });
    await startAdmission();
    expect(await client.terminalReceipt(scope, terminal)).toEqual({ grant: null, registered: false, revoked: false });
    const granted = await client.issueTerminal(scope, terminal);
    expect(await client.terminalReceipt(scope, terminal)).toEqual({ grant: granted, registered: true, revoked: false });
    expect(new X509Certificate(granted.certificate_pem).subject).toBe('CN=pty-runtime-a');
    expect(granted.alias_key_hex).toMatch(/^[a-f0-9]{64}$/u); expect(granted).not.toHaveProperty('token');
    expect(await client.issueTerminal(scope, terminal)).toEqual(granted);
    await expect(client.revokeTerminal(scope, { grant_id: granted.grant_id, certificate_sha256: 'f'.repeat(64) }))
      .rejects.toMatchObject({ code: 'AUTHORITY_UNAVAILABLE' });
    expect(await client.revokeTerminal(scope, { grant_id: granted.grant_id, certificate_sha256: granted.certificate_sha256 }))
      .toMatchObject({ revoked: true, grant_id: granted.grant_id });
    expect((await client.inventory(scope)).authorities.find(row => row.id === 'pty')?.matching_records).toEqual([]);
    expect(await client.terminalReceipt(scope, terminal)).toEqual({ grant: granted, registered: false, revoked: true });
    await expect(client.issueTerminal(scope, terminal)).rejects.toMatchObject({ code: 'AUTHORITY_UNAVAILABLE' });
  });
  it('rejects stale terminal claims, altered scope, CSR, consent and replay without rotating the grant', async () => {
    const terminal = await terminalRequest(); await startAdmission();
    const granted = await client.issueTerminal(scope, terminal);
    for (const change of [{ host_id: 'foreign-host' }, { runtime_key: 'foreign-runtime' }, { scope_sha256: 'f'.repeat(64) },
      { claim_epoch: scope.claim_epoch + 1 }, { prepared_revision: scope.prepared_revision + 1 }, { claim_token: '71000000-0000-4000-8000-000000000099' }]) {
      await expect(client.issueTerminal({ ...scope, ...change }, terminal)).rejects.toMatchObject({ code: 'AUTHORITY_REVOKED' });
    }
    await expect(client.issueTerminal(scope, { ...terminal, csr_sha256: 'f'.repeat(64) }))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(client.issueTerminal(scope, { ...terminal, idempotency_key: 'another-terminal-request' }))
      .rejects.toMatchObject({ code: 'AUTHORITY_UNAVAILABLE' });
    await pool.query("UPDATE fleet_operations SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [scope.operation_id]);
    await expect(client.issueTerminal(scope, terminal)).rejects.toMatchObject({ code: 'AUTHORITY_REVOKED' });
    const replacement = await repo.claim('terminal-replacement', 'host-a'); if (!replacement) throw new Error('Replacement absent');
    const updated = { ...scope, claim_epoch: replacement.epoch, worker_id: replacement.worker_id, claim_token: replacement.claim_token };
    expect(await client.issueTerminal(updated, terminal)).toEqual(granted);
    expect((await client.terminalReceipt(updated, terminal)).grant).toEqual(granted);
    await pool.query('UPDATE console_users SET active=false WHERE id=$1', [humanId]);
    await expect(client.issueTerminal(updated, terminal)).rejects.toMatchObject({ code: 'AUTHORITY_REVOKED' });
    await expect(client.revokeTerminal(updated, { grant_id: granted.grant_id, certificate_sha256: granted.certificate_sha256 }))
      .rejects.toMatchObject({ code: 'AUTHORITY_REVOKED' });
  });
  it('keeps the terminal registry during non-purge operations and rejects caller preservation flags', async () => {
    const policy = join(directory, 'policy.json');
    const document = JSON.parse(await readFile(policy, 'utf8')) as { registries: Record<string, string> };
    const terminal = join(directory, 'pty_agent_identities.json');
    const record = { tenant_id: 'Steven', alias: 'authority_agent', fingerprint_sha256: 'A'.repeat(64), expires_at: '2099-01-01T00:00:00Z' };
    await writeFile(terminal, JSON.stringify({ version: 1, agents: [record] }), { mode: 0o600 });
    document.registries.pty = terminal;
    await writeFile(policy, JSON.stringify(document), { mode: 0o600 });
    command.policy_sha256 = hash(await readFile(policy));
    const observed = await client.inventory(scope);
    expect(observed.authorities.find(row => row.id === 'pty')).toMatchObject({ preserved: true, matching_records: [record] });
    const service = createFleetAuthorityService(pool, { host_id: 'host-a', command });
    await expect(service.execute({ action: 'inventory', scope, preserve_terminal: false })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(JSON.parse(await readFile(terminal, 'utf8'))).toEqual({ version: 1, agents: [record] });
  });
  it('revokes only the purged terminal identity and revalidates it during the purge step', async () => {
    const initial = await repo.get('Steven', 'authority_operator', scope.operation_id, `console:${humanId}`);
    await repo.cancel('Steven', 'authority_operator', initial.id, initial.version, `console:${humanId}`);
    expect((await client.verifyAbsent(scope)).authorities.every(row => row.matching_records.length === 0)).toBe(true);
    await repo.compensate(claim, { revocation_verified: true });
    await pool.query(`INSERT INTO fleet_hosts(host_id,display_name,company_id)
      SELECT 'host-purge','Terminal purge',company_id FROM tenants WHERE id='Steven'`);
    await pool.query(`INSERT INTO agents(tenant_id,alias,harness_id,enabled,lifecycle_state,retired_at,runtime_key,
      host_id,runtime_mode,container_name,runtime_user,home_directory,state_directory,systemd_user)
      VALUES('Steven','terminal_purge','codex',false,'retired',now(),'terminal-purge',
        'host-purge','native','host:host-purge','dev','/home/dev','/var/tmp/authority-runtime/terminal-purge','stev')`);
    const purge = new FleetOperationsRepository(pool, { controllerHost: 'host-purge' });
    const company = (await pool.query<{ company_id: string }>("SELECT company_id FROM tenants WHERE id='Steven'")).rows[0]?.company_id;
    if (!company) throw new Error('Terminal purge company absent');
    const revision = await withTransaction(pool, value => companyRevision(value, company));
    await purge.enqueue('Steven', 'authority_operator', { kind: 'purge',
      target: { resource: 'agent', tenant_id: 'Steven', alias: 'terminal_purge' }, expected_revision: revision,
      idempotency_key: 'terminal-purge', parameters: { confirm_alias: 'terminal_purge' } }, `console:${humanId}`);
    const acquired = await purge.claim('terminal-worker', 'host-purge');
    if (!acquired) throw new Error('Terminal purge claim absent');
    const prepared = await purge.prepare(acquired); const slice = (await purge.hostSlices(acquired))[0];
    if (!slice || prepared.operation.desired_revision === null) throw new Error('Terminal purge slice absent');
    const purgeScope: AuthorityScope = { operation_id: acquired.operation.id, host_id: 'host-purge',
      scope_sha256: slice.target_sha256, runtime_key: 'terminal-purge', prepared_revision: prepared.operation.desired_revision,
      worker_id: acquired.worker_id, claim_token: acquired.claim_token, claim_epoch: acquired.epoch };
    const policy = join(directory, 'policy.json');
    const document = JSON.parse(await readFile(policy, 'utf8')) as { registries: Record<string, string> };
    const terminal = join(directory, 'pty_agent_identities.json');
    const own = { tenant_id: 'Steven', alias: 'terminal_purge', fingerprint_sha256: 'A'.repeat(64), expires_at: '2099-01-01T00:00:00Z' };
    const foreign = { ...own, tenant_id: 'Other', fingerprint_sha256: 'B'.repeat(64) };
    await writeFile(terminal, JSON.stringify({ version: 1, agents: [own, foreign] }), { mode: 0o600 });
    document.registries.pty = terminal; await writeFile(policy, JSON.stringify(document), { mode: 0o600 });
    command.policy_sha256 = hash(await readFile(policy));
    const service = createFleetAuthorityService(pool, { host_id: 'host-purge', command });
    const observed = AuthorityInventorySchema.parse(await service.execute({ action: 'inventory', scope: purgeScope }));
    const pins = observed.authorities.map(({ id, sha256 }) => ({ id, sha256 }));
    await expect(service.execute({ action: 'revoke', scope: purgeScope, expected_inventory: pins })).rejects.toMatchObject({ code: 'AUTHORITY_REVOKED' });
    await purge.startStep(acquired, 'stop'); await purge.completeStep(acquired, 'stop', { stopped_verified: true });
    await purge.startStep(acquired, 'revoke');
    const revoked = await service.execute({ action: 'revoke', scope: purgeScope, expected_inventory: pins });
    await purge.completeStep(acquired, 'revoke', { revocation_verified: true });
    await purge.startStep(acquired, 'purge');
    expect(await service.execute({ action: 'revoke', scope: purgeScope, expected_inventory: pins })).toEqual(revoked);
    expect(JSON.parse(await readFile(terminal, 'utf8'))).toEqual({ version: 1, agents: [foreign] });
  });
  it('reports legacy authority readiness only while the private issuer remains usable', async () => {
    expect(await readiness()).toEqual({ status: 200, body: { ready: true, host_id: 'host-a' } });
    await chmod(join(directory, 'ca.key'), 0o644);
    expect(await readiness()).toEqual({ status: 409, body: { error: 'AUTHORITY_UNAVAILABLE' } });
  });
  it('validates and issues with the caller transaction without acquiring another pool connection', async () => {
    const service = createFleetAuthorityService(pool, { host_id: 'host-a', command });
    expect(typeof service.executeInTransaction).toBe('function');
    const issued = await withTransaction(pool, client => service.executeInTransaction(client, { action: 'issue', scope, ...request }));
    expect(new X509Certificate((issued as { certificate_pem: string }).certificate_pem).subject).toBe('CN=agent-runtime-a');
  });
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
  it('keeps issuing for its company while another company claims and prepares in parallel', async () => {
    if (!current) throw new Error('Test database absent');
    const leon = await seedCompanyActors(current.adminPool);
    await current.adminPool.query("INSERT INTO fleet_hosts(host_id,display_name,company_id) VALUES('praxis-host','Praxis host','praxis')");
    await current.adminPool.query(`INSERT INTO provider_accounts(id,provider,external_account_id,payer_tenant_id,credential_ref_kind,credential_ref,shared_with_pool,enabled)
      VALUES('praxis-account','codex','praxis-external','PraxisHub','env_path','CAUCE_TEST_PRAXIS_PATH',true,true)`);
    await current.adminPool.query(`INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,permissions)
      VALUES($1,'PraxisHub','company_admin',ARRAY['read','control'])`, [leon]);
    const south = new FleetOperationsRepository(pool);
    await south.enqueue('PraxisHub', 'company_admin', { kind: 'create', target: { resource: 'agent', tenant_id: 'PraxisTeam', alias: 'south_agent' },
      expected_revision: await withTransaction(pool, value => companyRevision(value, 'praxis')), idempotency_key: 'authority-south-create',
      parameters: { runtime_key: 'south-agent', harness_id: 'codex', primary_room_id: 'company-team', primary_account_id: 'praxis-account',
        memberships: [{ room_id: 'company-team', role: 'agent' }], placement: { host_id: 'praxis-host', mode: 'container', runtime_user: 'dev',
          container_name: 'cauce-south-agent', home_directory: '/home/dev', state_directory: '/home/dev/.cauce/south-agent' } } }, `console:${leon}`);
    const southClaim = await south.claim('praxis-worker', 'praxis-host'); if (!southClaim) throw new Error('South claim absent');
    const southRevision = (await south.prepare(southClaim)).operation.desired_revision;
    if (southRevision === null) throw new Error('South revision absent');
    expect(southRevision).toBeGreaterThan(scope.prepared_revision);
    const issued = await client.issue(scope, request);
    expect(new X509Certificate(issued.certificate_pem).subject).toBe('CN=agent-runtime-a');
    expect((await south.startStep(southClaim, 'artifacts')).status).toBe('running');
    await pool.query(`INSERT INTO config_revisions(actor_tenant,actor_alias,operation,inverse_operation,summary)
      VALUES('Steven','authority_operator','{}','{}','Own company configuration changed during credentials')`);
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
  it('revokes only what a cancelled start issued and refuses every other kind or a running start', async () => {
    const issued = await client.issue(scope, request);
    const kept = { certificate_sha256: 'c'.repeat(64), principal: { tenant_id: 'Steven', alias: 'authority_agent', channel: 'adapter',
      session_id: 'adapter-runtime-a', roles: ['adapter'], permissions: ['route', 'read'] }, expires_at: '2099-01-01T00:00:00Z' };
    const policy = JSON.parse(await readFile(join(directory, 'policy.json'), 'utf8')) as { registries: Record<string, string> };
    const base = policy.registries.base_mtls ?? '';
    await writeFile(base, JSON.stringify({ version: 1, identities: [kept] }), { mode: 0o600 });
    await expect(client.invoke({ action: 'revoke_issued', scope })).rejects.toMatchObject({ code: 'AUTHORITY_REVOKED' });
    const operation = await repo.get('Steven', 'authority_operator', scope.operation_id, `console:${humanId}`);
    await repo.cancel('Steven', 'authority_operator', scope.operation_id, operation.version, `console:${humanId}`);
    // A cancelled create keeps its full revocation: only a start never owned the runtime's other credentials.
    await expect(client.invoke({ action: 'revoke_issued', scope })).rejects.toMatchObject({ code: 'AUTHORITY_REVOKED' });
    // The fixture's create stands in for a cancelled start: its kind is immutable, so the fixture bypasses the guard.
    const admin = await current?.adminPool.connect();
    try {
      await admin?.query("SET session_replication_role = replica");
      await admin?.query("UPDATE fleet_operations SET kind='start' WHERE id=$1", [scope.operation_id]);
    } finally { await admin?.query('RESET session_replication_role'); admin?.release(); }
    const revoked = AuthorityIssuedRevocationSchema.parse(await client.invoke({ action: 'revoke_issued', scope }));
    expect(revoked.revoked_credentials).toEqual([{ phase: 'bootstrap', certificate_sha256: issued.certificate_sha256, token_sha256: issued.token_sha256 }]);
    expect(revoked.authorities.find(row => row.id === 'base_mtls')?.matching_records).toEqual([kept]);
    expect(revoked.authorities.filter(row => row.id.startsWith('fleet_')).every(row => row.matching_records.length === 0)).toBe(true);
    expect(JSON.parse(await readFile(base, 'utf8'))).toEqual({ version: 1, identities: [kept] });
    expect(AuthorityIssuedRevocationSchema.parse(await client.invoke({ action: 'revoke_issued', scope }))).toEqual(revoked);
    expect(JSON.stringify(revoked)).not.toContain(issued.token);
  });
});
