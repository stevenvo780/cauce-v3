import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ContextVersionStore, HostEnrollmentRepository, lockCompanyAuthority, reserveAgentContextWrite, type CompanyAuthoritySource,
  type DatabasePool } from '@cauce/store';
import { seedSyntheticCompanyContexts } from '../../../../packages/store/src/seed-dev-cli.js';
import type { EmptyTestDatabase } from '../../../../tests/helpers/postgres.js';
import { channelCapabilities, channelHost } from '../fleet/host-channel.fixtures.js';
import { NATIVE_PROFILE, writeNativeFixture } from '../console/context-repository/native-test-fixtures.js';
import { hashPassword } from '../password.js';

export { snapshotCompany } from './route-isolation-snapshot.js';

export interface IsolationCompany {
  company: string; tenant: string; alias: string; ownerAlias: 'owner'; human: string; email: string; password: string;
  room: string; host: string; invitation: string; account: string; environment: string; quotaOperation: string;
  backup: string; message: string; delivery: string; blob: string; operation: string; session: string;
  contextVersion: number; trace: string; gate: string; revision: number;
  homeDirectory: string; stateDirectory: string; contextRepositoryPath: string; contextCommit: string;
  nativePiece: string; nativeOperation: string;
  dlq: string; dlqEvidence: string;
  egressDestination: string;
  privateSentinels: string[];
  authorityProof?: string; requestId?: string; ownerToken?: string; ownerGeneration?: string;
  connectionInstance?: string; connectionEpoch?: number; connectionToken?: string;
  providerSession?: string; providerOperation?: string;
}

const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
async function backupArchive(directory: string, identity: Record<string, string>) {
  const id = randomUUID(); const path = join(directory, `${id}.zip`);
  const source = join(directory, `space-${identity.alias ?? id}`);
  await mkdir(join(source, 'context'), { recursive: true, mode: 0o700 });
  await writeFile(join(source, 'context', 'mission.md'), 'Synthetic private context backup.', { mode: 0o600 });
  const script = 'import json,sys\nsys.path.insert(0,sys.argv[1])\nimport space_archive,space_backup_validate\n'
    + 'identity=json.loads(sys.argv[4])\nspace_archive.backup_space(sys.argv[2],sys.argv[3],identity)\n'
    + 'print(json.dumps(space_backup_validate.verified_archive(sys.argv[3],identity)))';
  const { stdout } = await promisify(execFile)('/usr/bin/python3', ['-B', '-c', script,
    fileURLToPath(new URL('../../../../ops/cli', import.meta.url)), source, path, JSON.stringify(identity)], { timeout: 15_000 });
  const receipt = JSON.parse(stdout) as { bytes: number; sha256: string; manifest_sha256: string };
  return { id, ...receipt };
}
async function insertId(pool: DatabasePool, sql: string, values: unknown[]): Promise<string> {
  const id = (await pool.query<{ id: string }>(sql, values)).rows[0]?.id;
  if (id === undefined) throw new Error('isolation resource insertion returned no id');
  return id;
}

export async function seedIsolationFixtures(database: EmptyTestDatabase, storageDirectory: string): Promise<{
  a: IsolationCompany; b: IsolationCompany;
}> {
  const seeded = await seedSyntheticCompanyContexts(database.adminUrl);
  const pool = database.adminPool;
  const password = 'isolation-fixture-password';
  const hash = await hashPassword(password, { cost: 1_024, blockSize: 8, parallelism: 1 });
  await mkdir(storageDirectory, { recursive: true, mode: 0o700 });
  await mkdir(join(storageDirectory, 'blobs'), { recursive: true, mode: 0o700 });
  const contextRepositoryPath = join(storageDirectory, 'context-repository');
  const repositoryFiles: Record<string, string> = {};
  const sourceAgents = seeded.map((seed, index) => {
    const alias = `isolation-${index === 0 ? 'a' : 'b'}`;
    repositoryFiles[`tenants/${seed.tenant_id}/agents/${alias}/profile.json`] = JSON.stringify(NATIVE_PROFILE);
    return { tenant_id: seed.tenant_id, alias, source_journal: null };
  });
  repositoryFiles['context.json'] = JSON.stringify({ schema_version: 1, instance_id: 'isolation', agents: sourceAgents });
  const contextCommit = await writeNativeFixture(contextRepositoryPath, repositoryFiles);
  const companies: IsolationCompany[] = [];
  for (const [index, seed] of seeded.entries()) {
    const side = index === 0 ? 'a' : 'b';
    const alias = `isolation-${side}`; const room = `${alias}-room`; const host = `${seed.company_id}-host`;
    const account = `${alias}-account`; const email = `${seed.company_id}@dev.example`;
    const homeDirectory = join(storageDirectory, `home-${side}`); const stateDirectory = join(homeDirectory, '.cauce');
    const nativePiece = 'isolation-check';
    const nativePath = join(homeDirectory, '.codex', 'skills', nativePiece, 'SKILL.md');
    await mkdir(join(homeDirectory, '.codex', 'skills', nativePiece), { recursive: true, mode: 0o700 });
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    const nativeContent = '# Synthetic isolation skill\n';
    await writeFile(nativePath, nativeContent, { mode: 0o600 });
    await pool.query('UPDATE console_users SET password_hash=$1 WHERE id=$2', [hash, seed.human_id]);
    await pool.query("UPDATE human_tenant_memberships SET permissions=ARRAY['read','route','control'] WHERE human_id=$1", [seed.human_id]);
    await pool.query('INSERT INTO rooms(tenant_id,id,company_id) VALUES($1,$2,$3)', [seed.tenant_id, room, seed.company_id]);
    await pool.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES($1,$2,'owner','operator'),($1,$2,$3,'agent')",
      [seed.tenant_id, room, alias]);
    await pool.query(`INSERT INTO provider_accounts(id,provider,external_account_id,payer_tenant_id,credential_ref_kind,credential_ref,enabled)
      VALUES($1,'codex',$1,$2,'env_path','CAUCE_ISOLATION_SYNTHETIC_PATH',true)`, [account, seed.tenant_id]);
    const registered = { company: { id: seed.company_id, slug: seed.company_id, name: seed.company_id },
      hub: { id: seed.tenant_id, name: seed.tenant_id }, user: { id: seed.human_id, username: 'owner', email, name: 'Synthetic owner' } };
    await channelHost(pool, registered, host);
    await pool.query(`UPDATE fleet_host_identities SET capabilities=$2::jsonb,capabilities_seen_at=now() WHERE host_id=$1`,
      [host, JSON.stringify(channelCapabilities())]);
    await pool.query(`INSERT INTO agents(tenant_id,alias,company_id,runtime_key,harness_id,display_name,enabled,
      container_name,runtime_user,home_directory,state_directory,host_id,runtime_mode,systemd_user,primary_room_id,primary_account_id,lifecycle_state)
      VALUES($1,$2,$3,$2,'codex',$2,true,$4,'dev',$9,$5,$6,'container','stev',$7,$8,'ready')`,
      [seed.tenant_id, alias, seed.company_id, `cauce-${alias}`, stateDirectory, host, room, account, homeDirectory]);
    await pool.query('INSERT INTO agent_profiles(tenant_id,alias,role_summary) VALUES($1,$2,$3)',
      [seed.tenant_id, alias, `Synthetic ${side} isolation agent`]);
    const egressDestination = `${alias}.private`;
    await pool.query(`INSERT INTO egress_destinations(tenant_id,alias,handle,conversation_id,conversation_kind,allow_kinds)
      VALUES($1,'owner',$2,$3,'group',ARRAY['alert'])`, [seed.tenant_id, egressDestination, index === 0 ? '-10000001' : '-10000002']);
    const source: CompanyAuthoritySource = client => lockCompanyAuthority(client,
      { tenant: seed.tenant_id, alias: 'owner', humanId: seed.human_id });
    const invitation = await new HostEnrollmentRepository(pool).invite(source,
      { host_id: `${seed.company_id}-pending`, display_name: 'Pending synthetic host' });
    const environment = await insertId(pool, `INSERT INTO quota_environments(company_id,account_id,host_id,provider,label,
      container_name,status,idempotency_key,created_by) VALUES($1,$2,$3,'codex',$2,$4,'ready',$5,$6) RETURNING id`,
      [seed.company_id, account, host, `cauce-quota-${randomUUID().replaceAll('-', '')}`, `isolation-${side}-environment`, seed.human_id]);
    const quotaOperation = await insertId(pool, `INSERT INTO quota_environment_operations(environment_id,company_id,action,status,
      idempotency_key,requested_by,result) VALUES($1,$2,'query','done',$3,$4,'{"synthetic":true}') RETURNING id`,
      [environment, seed.company_id, `isolation-${side}-quota-query`, seed.human_id]);
    const context = await new ContextVersionStore(pool).write(source, seed.tenant_id, alias,
      { expected_version: 0, source: 'cli', files: [{ path: 'context/mission.md', content: `Private synthetic company ${side} context.` }] });
    const profileRevision = (await pool.query<{ revision: string }>('SELECT revision::text FROM agent_profiles WHERE tenant_id=$1 AND alias=$2',
      [seed.tenant_id, alias])).rows[0]?.revision;
    if (profileRevision === undefined) throw new Error('native isolation reservation requires a profile');
    const nativeOperation = randomUUID();
    await reserveAgentContextWrite(pool, { operationId: nativeOperation, token: randomUUID(), generation: randomUUID(),
      tenantId: seed.tenant_id, alias, writer: { runtimeGeneration: 'isolation-fixture', containerId: `cauce-${alias}`, writerInstanceId: randomUUID() },
      expectedRevision: Number(profileRevision), expectedExpectation: null,
      documents: [{ name: `native:skill:${nativePiece}`, path: nativePath, beforeSha: digest(nativeContent), targetSha: digest('Synthetic target skill.') }] });
    const trace = `isolation-${side}-${randomUUID()}`;
    const message = await insertId(pool, `INSERT INTO messages(request_id,trace_id,tenant_id,room_id,actor_alias,body,lane)
      VALUES($1,$2,$3,$4,'owner',$5::jsonb,'interactive') RETURNING id`,
      [randomUUID(), trace, seed.tenant_id, room, JSON.stringify({ type: 'command', text: `Private company ${side} message.` })]);
    const delivery = await insertId(pool, `INSERT INTO deliveries(message_id,recipient_tenant,recipient_alias)
      VALUES($1,$2,$3) RETURNING id`, [message, seed.tenant_id, alias]);
    const dlqEvidence = digest(`isolation-${side}-incident`);
    const dlq = await insertId(pool, `INSERT INTO dead_letters(delivery_id,tenant_id,reason,payload,attempts,disposition,disposition_at,evidence_sha256)
      VALUES($1,$2,'Synthetic classified incident','{}',1,'safe_retry',now(),$3) RETURNING id`, [delivery, seed.tenant_id, dlqEvidence]);
    const gate = await insertId(pool, `INSERT INTO agent_chain_gates(root_message_id,tenant_id,asked_by_alias,source_delivery_id,
      source_attempt,output_index,trace_id,question,correlation) VALUES($1,$2,$3,$4,1,0,$5,$7,$6::jsonb) RETURNING id`,
      [message, seed.tenant_id, alias, delivery, trace, JSON.stringify({ root_message_id: message, hop_count: 1, hop_budget: 16, visited_path: [] }),
        `Private company ${side} gate question.`]);
    const blobBytes = Buffer.from(`Private company ${side} synthetic attachment.`); const blob = digest(blobBytes);
    await pool.query(`INSERT INTO blobs(sha256,bytes,media_type,name,tenant_id,created_by)
      VALUES($1,$2,'text/plain','private.txt',$3,'owner')`, [blob, blobBytes.length, seed.tenant_id]);
    await pool.query(`INSERT INTO blob_delivery_grants(delivery_id,sha256,owner_tenant_id,source_tenant_id,source_alias,target_tenant_id,target_alias)
      VALUES($1,$2,$3,$3,'owner',$3,$4)`, [delivery, blob, seed.tenant_id, alias]);
    await writeFile(join(storageDirectory, 'blobs', blob), blobBytes, { mode: 0o600 });
    const target = { resource: 'agent', tenant_id: seed.tenant_id, alias };
    const request = { kind: 'stop', target, expected_revision: 0, idempotency_key: `isolation-${side}-stop`, parameters: {} };
    const operation = await insertId(pool, `INSERT INTO fleet_operations(actor_tenant,actor_alias,target,target_key,cohort_key,executor_host,
      kind,request,request_hash,idempotency_key,expected_revision,status,company_id)
      VALUES($1,'owner',$2::jsonb,$3,$3,$4,'stop',$5::jsonb,$6,$7,0,'succeeded',$8) RETURNING id`,
      [seed.tenant_id, JSON.stringify(target), digest(JSON.stringify(target)), host, JSON.stringify(request), digest(JSON.stringify(request)),
        request.idempotency_key, seed.company_id]);
    await pool.query(`INSERT INTO fleet_operation_events(operation_id,version,event,metadata) VALUES($1,0,'queued',$2::jsonb)`,
      [operation, JSON.stringify({ acting_company: seed.company_id, actor_subject: `console:${seed.human_id}`, synthetic: true })]);
    const mutation = { resource: 'room', action: 'update', tenant_id: seed.tenant_id, id: room, value: { enabled: true } };
    const revision = Number(await insertId(pool, `INSERT INTO config_revisions(actor_tenant,actor_alias,operation,inverse_operation,summary,
      scope,company_id,actor_human_id) VALUES($1,'owner',$2::jsonb,$2::jsonb,'Synthetic isolation revision','company',$3,$4) RETURNING id::text`,
      [seed.tenant_id, JSON.stringify(mutation), seed.company_id, seed.human_id]));
    const session = randomUUID();
    await pool.query(`INSERT INTO terminal_sessions(id,operator_id,attributed,console_subject,tenant_id,alias,container,runtime_user,
      mode,ticket_sha256,reason,expires_at,request_id,request_sha256,browser_owner_sha256,browser_owner_generation,relay_instance_id,closed_at)
      VALUES($1,$2,true,$3,$4,$5,$6,'dev','shell',$7,'Synthetic isolation terminal',now()+interval '1 hour',$8,$7,$7,1,$9,now())`,
      [session, email, `console:${seed.human_id}`, seed.tenant_id, alias, `cauce-${alias}`, randomBytes(32), randomUUID(), digest(`synthetic-relay-${side}`)]);
    const snapshot = { company_id: seed.company_id, tenant_id: seed.tenant_id, alias, runtime_key: alias, host_id: host,
      harness_id: 'codex', runtime_mode: 'container', container_name: `cauce-${alias}`, runtime_user: 'dev',
      home_directory: homeDirectory, state_directory: stateDirectory, systemd_user: 'stev' };
    const archive = await backupArchive(storageDirectory, { company_id: seed.company_id, tenant_id: seed.tenant_id, alias, runtime_key: alias });
    const backup = await insertId(pool, `INSERT INTO space_backups(company_id,tenant_id,alias,host_id,requested_by,idempotency_key,
      agent_snapshot,policy_sha256,status,received_bytes,bytes,sha256,manifest_sha256,id)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,'ready',$9,$9,$10,$11,$12) RETURNING id`,
      [seed.company_id, seed.tenant_id, alias, host, seed.human_id, `isolation-${side}-backup`, JSON.stringify(snapshot), 'a'.repeat(64),
        archive.bytes, archive.sha256, archive.manifest_sha256, archive.id]);
    companies.push({ company: seed.company_id, tenant: seed.tenant_id, alias, ownerAlias: 'owner', human: seed.human_id, email, password,
      room, host, invitation: invitation.enrollment_id, account, environment, quotaOperation, backup, message, delivery, blob,
      operation, session, contextVersion: context.version, trace, gate, revision, homeDirectory, stateDirectory,
      contextRepositoryPath, contextCommit, nativePiece, nativeOperation, egressDestination, dlq, dlqEvidence,
      privateSentinels: [`Private synthetic company ${side} context.`, `Private company ${side} message.`,
        `Private company ${side} synthetic attachment.`, `Private company ${side} gate question.`] });
  }
  const [a, b] = companies;
  if (a === undefined || b === undefined || companies.length !== 2) throw new Error('two isolation companies are required');
  return { a, b };
}
