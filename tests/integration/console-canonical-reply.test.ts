import { execFile } from 'node:child_process';
import { randomBytes, randomUUID, X509Certificate } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { TLSSocket } from 'node:tls';
import { promisify } from 'node:util';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Tenant } from '@cauce/protocol';
import { buildGateway } from '../../services/gateway/src/app.js';
import { HashedMtlsIdentityFileProvider, MtlsAuthProvider } from '../../services/gateway/src/auth.js';
import { PostgresConsoleUserStore } from '../../services/gateway/src/console-users.js';
import { PasswordAuthProvider } from '../../services/gateway/src/password-auth.js';
import { dockerTestRequirement, resetTestDatabase, startTestDatabase, type TestDatabase } from '../helpers/postgres.js';

// Seeded read-model states do not certify materialization, ACK processing, or an external CLI agent.
const execute = promisify(execFile);
const sender = { tenant: 'Steven' as const, alias: 'canonical_sender', room: 'grp.steven' };
const recipient = { tenant: 'Steven' as const, alias: 'canonical_recipient', room: 'grp.steven' };
const cross = { tenant: 'Isa' as const, alias: 'canonical_cross', room: 'grp.isa' };
const outsider = { tenant: 'Jhon' as const, alias: 'canonical_outsider', room: 'grp.jhon' };
interface Identity { tenant: Tenant; alias: string; room: string }
type Account = 'operator' | 'reader' | 'recipient' | 'cross' | 'outsider';
type Actor = Account | 'agent';
type State = 'pending' | 'done' | 'failed';
interface Delivery { delivery_id: string; tenant_id: string; alias: string; status: State; reply?: string | null }
interface Detail { id: string; tenant_id: string; actor_alias: string; chain_open?: boolean; deliveries: Delivery[] }
interface HttpResult { status: number; body: Detail }
interface Root { id: string; trace: string; deliveries: string[] }
interface TlsFixture { ca: Buffer; key: Buffer; cert: Buffer; unmappedKey: Buffer; unmappedCert: Buffer; mapping: string }
const accounts: Record<Account, { identity: Identity; role: 'operator' | 'reader' }> = {
  operator: { identity: sender, role: 'operator' }, reader: { identity: sender, role: 'reader' },
  recipient: { identity: recipient, role: 'operator' }, cross: { identity: cross, role: 'operator' },
  outsider: { identity: outsider, role: 'operator' },
};
const requirement = dockerTestRequirement('canonical replies require disposable PostgreSQL and real password/mTLS listeners');
let database: TestDatabase | undefined;
let consoleApp: Awaited<ReturnType<typeof buildGateway>> | undefined;
let agentApp: Awaited<ReturnType<typeof buildGateway>> | undefined;
let consoleUrl = '';
let agentUrl = '';
let directory: string | undefined;
let tls: TlsFixture;
let setup: Promise<void> | undefined;
const cookies = new Map<Account, string>();

function db(): TestDatabase {
  if (!database) throw new Error('disposable database is not ready');
  return database;
}

async function assertLocalDatabase(): Promise<void> {
  if (process.env.CAUCE_TEST_DATABASE_URL !== undefined) {
    throw new Error('this suite rejects external database URLs and requires its own disposable container');
  }
  if (process.env.DOCKER_CONTEXT
    || (process.env.DOCKER_HOST && !process.env.DOCKER_HOST.startsWith('unix://'))) {
    throw new Error('this suite requires local Docker without context or remote host overrides');
  }
  const network = process.env.CAUCE_TEST_DOCKER_NETWORK;
  const owner = process.env.CAUCE_TEST_DOCKER_NETWORK_OWNER;
  if (network === undefined) {
    if (owner !== undefined) throw new Error('fixture network owner requires an explicit network');
    return;
  }
  if (!network || !owner || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(owner)) {
    throw new Error('fixture network requires an explicit UUIDv4 owner');
  }
  let inspected: unknown;
  try {
    const { stdout } = await execute('docker', ['network', 'inspect', '--format', '{{json .}}', '--', network], { timeout: 5_000 });
    inspected = JSON.parse(stdout) as unknown;
  } catch { throw new Error('fixture network inspection failed'); }
  if (typeof inspected !== 'object' || inspected === null || Array.isArray(inspected)) {
    throw new Error('invalid fixture network inspection');
  }
  const info = inspected as Record<string, unknown>;
  const labels = info.Labels;
  if (info.Driver !== 'bridge' || info.Scope !== 'local' || info.Internal !== false
    || typeof labels !== 'object' || labels === null || Array.isArray(labels)
    || (labels as Record<string, unknown>)['cauce.test.owner'] !== owner) {
    throw new Error('fixture network must be a local bridge owned by this test run');
  }
}

async function makeTlsFixture(path: string): Promise<TlsFixture> {
  const openssl = async (args: string[]): Promise<void> => {
    try { await execute('openssl', args, { cwd: path, timeout: 30_000 }); }
    catch { throw new Error('ephemeral TLS fixture generation failed'); }
  };
  await openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-keyout', 'ca.key', '-out', 'ca.pem', '-subj', '/CN=canonical-test-ca',
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  for (const name of ['server', 'client', 'unmapped']) {
    await openssl(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${name}.key`,
      '-out', `${name}.csr`, '-subj', `/CN=canonical-${name}`]);
    await writeFile(join(path, `${name}.ext`), 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\n'
      + (name === 'server' ? 'extendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n' : 'extendedKeyUsage=clientAuth\n'), { mode: 0o600 });
    await openssl(['x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.pem', '-CAkey', 'ca.key',
      '-set_serial', name === 'server' ? '2' : name === 'client' ? '3' : '4', '-days', '1',
      '-extfile', `${name}.ext`, '-out', `${name}.pem`]);
    await chmod(join(path, `${name}.key`), 0o600);
  }
  await chmod(join(path, 'ca.key'), 0o600);
  const cert = await readFile(join(path, 'client.pem'));
  const mapping = join(path, 'identities.json');
  await writeFile(mapping, JSON.stringify({ version: 1, identities: [{
    certificate_sha256: new X509Certificate(cert).fingerprint256.replaceAll(':', '').toLowerCase(),
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    principal: { tenant_id: sender.tenant, alias: sender.alias, session_id: randomUUID(),
      channel: 'canonical-test', roles: ['agent'], permissions: ['read', 'route'] },
  }] }), { mode: 0o600 });
  return { ca: await readFile(join(path, 'ca.pem')), key: await readFile(join(path, 'client.key')), cert,
    unmappedKey: await readFile(join(path, 'unmapped.key')), unmappedCert: await readFile(join(path, 'unmapped.pem')), mapping };
}

async function closeSuite(): Promise<void> {
  const failures: unknown[] = [];
  for (const close of [async () => { await consoleApp?.close(); }, async () => { await agentApp?.close(); },
    async () => { await database?.pool.end(); }, async () => { await database?.container.stop(); },
    async () => { if (directory) await rm(directory, { recursive: true, force: true }); }]) {
    try { await close(); } catch (error) { failures.push(error); }
  }
  consoleApp = undefined; agentApp = undefined; database = undefined; directory = undefined;
  cookies.clear();
  if (failures.length) throw new AggregateError(failures, 'fixture teardown failed; inspect local disposable resources');
}

async function startSuite(): Promise<void> {
  try {
    database = await startTestDatabase();
    directory = await mkdtemp(join(tmpdir(), 'cauce-canonical-'));
    await chmod(directory, 0o700);
    tls = await makeTlsFixture(directory);
    const password = new PasswordAuthProvider({ users: new PostgresConsoleUserStore(db().pool), signingKey: randomBytes(32) });
    await password.ready();
    consoleApp = await buildGateway({ pool: db().pool, authProvider: password });
    consoleUrl = await consoleApp.listen({ host: '127.0.0.1', port: 0 });
    agentApp = await buildGateway({ pool: db().pool,
      authProvider: new MtlsAuthProvider(new HashedMtlsIdentityFileProvider(tls.mapping)),
      https: { ca: tls.ca, key: await readFile(join(directory, 'server.key')),
        cert: await readFile(join(directory, 'server.pem')), requestCert: true, rejectUnauthorized: true } });
    agentUrl = await agentApp.listen({ host: '127.0.0.1', port: 0 });
  } catch (error) {
    try { await closeSuite(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'fixture setup and teardown failed'); }
    throw error;
  }
}

function consoleCliEnvironment(url: string, password: string): NodeJS.ProcessEnv {
  if (!directory) throw new Error('ephemeral fixture directory is not ready');
  return { PATH: dirname(process.execPath), TMPDIR: directory, NODE_ENV: 'test',
    DATABASE_URL: url, CAUCE_CONSOLE_USER_PASSWORD: password };
}

async function cookiePasswordAuth(account: Account): Promise<string> {
  const { identity, role } = accounts[account];
  const password = randomBytes(32).toString('base64url');
  const email = `${account}@canonical.test`;
  try {
    await execute(process.execPath, ['--import', createRequire(import.meta.url).resolve('tsx'), 'services/gateway/src/console-user-cli.ts',
      '--email', email, '--name', `Canonical ${account}`, '--role', role, '--tenant', identity.tenant, '--alias', identity.alias],
    { cwd: process.cwd(), env: consoleCliEnvironment(db().url, password), timeout: 30_000 });
  } catch { throw new Error('disposable console account provisioning failed'); }
  const login = await fetch(`${consoleUrl}/v3/auth/login`, { method: 'POST',
    headers: { 'content-type': 'application/json', origin: consoleUrl }, body: JSON.stringify({ email, password }) });
  expect(login.status).toBe(200);
  const cookie = login.headers.getSetCookie()[0]?.split(';', 1)[0];
  await login.arrayBuffer();
  if (!cookie) throw new Error('real login did not issue a session cookie');
  const session = await fetch(`${consoleUrl}/v3/auth/session`, { headers: { cookie } });
  expect(session.status).toBe(200);
  const { authenticated, subject, roles, permissions } = await session.json() as {
    authenticated: boolean; subject: string; roles: string[]; permissions: string[];
  };
  expect({ authenticated, subject, roles, permissions }).toMatchObject({ authenticated: true, subject: email,
    roles: role === 'reader' ? [] : ['operator'], ...(role === 'reader' ? { permissions: ['read'] } : {}) });
  const stored = await db().pool.query('SELECT tenant_id,alias,role,active FROM console_users WHERE email=$1', [email]);
  expect(stored.rows).toEqual([{ tenant_id: identity.tenant, alias: identity.alias, role, active: true }]);
  return cookie;
}

beforeEach(async ({ skip }) => {
  await assertLocalDatabase();
  if (!setup) {
    await requirement.skipIfUnavailable(skip);
    setup = startSuite();
  }
  await setup;
  await resetTestDatabase(db().pool);
  for (const identity of [sender, recipient, cross, outsider]) {
    await db().pool.query(`INSERT INTO memberships(tenant_id,room_id,alias,role,enabled) VALUES($1,$2,$3,'agent',true)
      ON CONFLICT (tenant_id,room_id,alias) DO UPDATE SET enabled=true`, [identity.tenant, identity.room, identity.alias]);
    await db().pool.query(`INSERT INTO agents(tenant_id,alias,harness_id,enabled,container_name,runtime_user,home_directory,state_directory)
      VALUES($1,$2,'claude',true,'canonical-test','dev','/tmp/canonical-test','/tmp/canonical-test/state')`, [identity.tenant, identity.alias]);
  }
  await db().pool.query(`UPDATE acl_edges SET enabled=true,allow_read=true WHERE from_tenant='Isa' AND to_tenant='Steven'`);
  for (const account of Object.keys(accounts) as Account[]) cookies.set(account, await cookiePasswordAuth(account));
}, 180_000);
afterAll(closeSuite);

function mtlsRead(path: string, credential: 'mapped' | 'unmapped' | 'none' = 'mapped'): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = request(`${agentUrl}${path}`, { ca: tls.ca, rejectUnauthorized: true, agent: false,
      ...(credential === 'none' ? {} : { key: credential === 'mapped' ? tls.key : tls.unmappedKey,
        cert: credential === 'mapped' ? tls.cert : tls.unmappedCert }) }, (response) => {
      const socket = response.socket;
      if (!(socket instanceof TLSSocket) || !socket.authorized) {
        response.resume(); reject(new Error('server TLS identity was not verified')); return;
      }
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => { body += chunk; });
      response.on('error', reject);
      response.on('end', () => {
        try { resolve({ status: response.statusCode ?? 0, body: JSON.parse(body) as Detail }); }
        catch { reject(new Error('invalid local gateway JSON')); }
      });
    });
    req.setTimeout(10_000, () => { req.destroy(new Error('local HTTPS request timed out')); });
    req.on('error', reject);
    req.end();
  });
}

async function readPair(actor: Actor, root: Root, status = 200): Promise<Detail[]> {
  const snapshot = await db().pool.query<{ id: string; deliveries: number }>(`SELECT m.id,count(d.id)::int AS deliveries
    FROM messages m JOIN deliveries d ON d.message_id=m.id WHERE m.id=$1 GROUP BY m.id`, [root.id]);
  expect(snapshot.rows).toEqual([{ id: root.id, deliveries: root.deliveries.length }]);
  const results: Detail[] = [];
  for (const prefix of ['/v3/console/messages/', '/v3/messages/']) {
    const response = actor === 'agent' ? await mtlsRead(prefix + root.id) : await (async () => {
      const cookie = cookies.get(actor);
      if (!cookie) throw new Error('missing authenticated test session');
      const value = await fetch(consoleUrl + prefix + root.id, { headers: { cookie } });
      return { status: value.status, body: await value.json() as Detail };
    })();
    expect(response.status, `${actor} ${prefix}`).toBe(status);
    results.push(response.body);
  }
  expect(results[0]).toEqual(results[1]);
  return results;
}

async function seedDelivery(message: string, identity: Identity, state: State, reply: string | null): Promise<string> {
  const id = randomUUID();
  await db().pool.query(`INSERT INTO deliveries(id,message_id,recipient_tenant,recipient_alias,status,attempt,result,terminal_at)
    VALUES($1,$2,$3,$4,$5,1,$6,CASE WHEN $5='pending' THEN NULL ELSE now() END)`,
  [id, message, identity.tenant, identity.alias, state, { output: { reply } }]);
  const stored = await db().pool.query(`SELECT status,result->'output'->>'reply' AS reply FROM deliveries WHERE id=$1`, [id]);
  expect(stored.rows).toEqual([{ status: state, reply }]);
  return id;
}

async function seedRoot(agentRoot = false, recipients: Identity[] = [recipient], probe = false): Promise<Root> {
  const id = randomUUID(); const trace = `canonical-${randomUUID()}`;
  await db().pool.query(`INSERT INTO messages(id,request_id,trace_id,tenant_id,room_id,actor_alias,body,lane)
    VALUES($1,$2,$3,$4,$5,$6,$7,'interactive')`, [id, randomUUID(), trace, sender.tenant, sender.room, sender.alias,
    probe ? { type: 'system.gate.probe', text: 'fixture probe' } : { text: 'fixture root' }]);
  await db().pool.query(`INSERT INTO audit_events(tenant_id,actor_alias,action,decision,message_id,trace_id,metadata)
    VALUES($1,$2,'message.publish','allow',$3,$4,$5)`, [sender.tenant, sender.alias, id, trace, { agent_root: agentRoot }]);
  const audit = await db().pool.query(`SELECT metadata->>'agent_root' AS agent_root FROM audit_events
    WHERE message_id=$1 AND trace_id=$2 AND action='message.publish' AND decision='allow'`, [id, trace]);
  expect(audit.rows).toEqual([{ agent_root: String(agentRoot) }]);
  const deliveries: string[] = [];
  for (const [index, identity] of recipients.entries()) deliveries.push(await seedDelivery(id, identity, 'done', `hop-${String(index)}`));
  return { id, trace, deliveries };
}

async function seedChild(root: Root, branch: number, type: 'agent.response' | 'agent.fanin', state: State,
  reply: string, identity: Identity = recipient, ageSeconds = 0): Promise<string> {
  const id = randomUUID();
  const rootDelivery = root.deliveries[branch];
  if (!rootDelivery) throw new Error('missing fixture root delivery');
  const correlation = { root_message_id: root.id, root_delivery_id: rootDelivery, hop_count: 1,
    hop_budget: 8, visited_path: [`${sender.tenant}/${sender.alias}`, `${identity.tenant}/${identity.alias}`] };
  await db().pool.query(`INSERT INTO messages(id,request_id,trace_id,tenant_id,room_id,actor_alias,body,lane)
    VALUES($1,$2,$3,$4,$5,$6,$7,'interactive')`, [id, randomUUID(), root.trace, sender.tenant, sender.room,
    sender.alias, { type, correlation, text: reply }]);
  const delivery = await seedDelivery(id, identity, state, reply);
  await db().pool.query(`UPDATE deliveries SET created_at=now()-($2::int * interval '1 second'),
    terminal_at=CASE WHEN status='pending' THEN NULL ELSE now()-($2::int * interval '1 second') END WHERE id=$1`, [delivery, ageSeconds]);
  const stored = await db().pool.query(`SELECT body->>'type' AS type,body->'correlation'->>'root_message_id' AS root_id,
    body->'correlation'->>'root_delivery_id' AS branch FROM messages WHERE id=$1`, [id]);
  expect(stored.rows).toEqual([{ type, root_id: root.id, branch: rootDelivery }]);
  return delivery;
}

function expectNoProjection(rows: Detail[], visible: string[]): void {
  for (const row of rows) {
    expect(row).not.toHaveProperty('chain_open');
    expect(row.deliveries.map((delivery) => delivery.delivery_id).sort()).toEqual([...visible].sort());
    for (const delivery of row.deliveries) expect(delivery).not.toHaveProperty('reply');
  }
}
function expectProjection(rows: Detail[], root: Root, replies: (string | null)[], open: boolean): void {
  for (const row of rows) {
    expect(row).toMatchObject({ id: root.id, tenant_id: sender.tenant, actor_alias: sender.alias, chain_open: open });
    expect(row.deliveries).toHaveLength(root.deliveries.length);
    for (const [index, id] of root.deliveries.entries()) {
      expect(row.deliveries.find((delivery) => delivery.delivery_id === id)).toHaveProperty('reply', replies[index]);
    }
  }
}

describe('canonical replies over real cookie and mTLS transports', () => {
  it('requires a client certificate and a mapped certificate identity', async () => {
    const root = await seedRoot(true);
    for (const prefix of ['/v3/console/messages/', '/v3/messages/']) {
      await expect(mtlsRead(prefix + root.id, 'none')).rejects.toBeDefined();
      expect((await mtlsRead(prefix + root.id, 'unmapped')).status).toBe(401);
    }
    expectProjection(await readPair('agent', root), root, ['hop-0'], false);
  });
  it('projects an operator root and falls back to the root hop when no response exists', async () => {
    const root = await seedRoot();
    expectProjection(await readPair('operator', root), root, ['hop-0'], false);
    expectNoProjection(await readPair('reader', root), root.deliveries);
    expectNoProjection(await readPair('agent', root), root.deliveries);
  });
  it('projects an audited agent root only to the agent principal kind', async () => {
    const root = await seedRoot(true);
    expectProjection(await readPair('agent', root), root, ['hop-0'], false);
    expectNoProjection(await readPair('operator', root), root.deliveries);
    expectNoProjection(await readPair('reader', root), root.deliveries);
  });
  it('returns 404 for both invisible and nonexistent messages to a nonparticipant tenant', async () => {
    const root = await seedRoot();
    await readPair('outsider', root, 404);
    const absent = randomUUID();
    expect((await db().pool.query('SELECT id FROM messages WHERE id=$1', [absent])).rows).toEqual([]);
    const cookie = cookies.get('outsider');
    if (!cookie) throw new Error('missing outsider cookie');
    for (const prefix of ['/v3/console/messages/', '/v3/messages/']) {
      expect((await fetch(consoleUrl + prefix + absent, { headers: { cookie } })).status).toBe(404);
    }
  });
  it('shows only the recipient delivery, including an authorized cross-tenant recipient', async () => {
    const root = await seedRoot(false, [recipient, cross]);
    expectNoProjection(await readPair('recipient', root), [root.deliveries[0] ?? 'missing']);
    expectNoProjection(await readPair('cross', root), [root.deliveries[1] ?? 'missing']);
    expectProjection(await readPair('operator', root), root, ['hop-0', 'hop-1'], false);
  });
  it('rechecks all read memberships while password sessions and certificates remain valid', async () => {
    const root = await seedRoot(true);
    await readPair('operator', root); await readPair('agent', root);
    await db().pool.query('UPDATE memberships SET enabled=false WHERE tenant_id=$1 AND alias=$2', [sender.tenant, sender.alias]);
    expect((await db().pool.query(`SELECT count(*)::int AS active FROM memberships m JOIN role_policies r ON r.role=m.role
      WHERE m.tenant_id=$1 AND m.alias=$2 AND m.enabled AND r.allow_read`, [sender.tenant, sender.alias])).rows).toEqual([{ active: 0 }]);
    const cookie = cookies.get('operator');
    if (!cookie) throw new Error('missing operator cookie');
    const session = await fetch(`${consoleUrl}/v3/auth/session`, { headers: { cookie } });
    expect(session.status).toBe(200);
    expect((await session.json() as { authenticated: boolean }).authenticated).toBe(true);
    await readPair('operator', root, 404); await readPair('reader', root, 404); await readPair('agent', root, 404);
  });
  it('uses the newest eligible intermediate response without a fan-in', async () => {
    const root = await seedRoot();
    await seedChild(root, 0, 'agent.response', 'done', 'older', recipient, 60);
    await seedChild(root, 0, 'agent.response', 'done', 'newest', recipient, 30);
    await seedChild(root, 0, 'agent.response', 'failed', 'ineligible');
    expectProjection(await readPair('operator', root), root, ['newest'], false);
  });
  it.each(['pending', 'done', 'failed'] as const)('fan-in %s takes precedence without leaking another branch', async (state) => {
    const root = await seedRoot(false, [recipient, cross]);
    await seedChild(root, 0, 'agent.response', 'done', 'intermediate');
    await seedChild(root, 0, 'agent.fanin', state, 'consolidated');
    await seedChild(root, 1, 'agent.fanin', 'done', 'other-branch', cross);
    expectProjection(await readPair('operator', root), root, [state === 'done' ? 'consolidated' : null, 'other-branch'], state === 'pending');
  });
  it.each(['done', 'failed'] as const)('keeps chain_open with a terminal %s fan-in and other open work', async (state) => {
    const root = await seedRoot(false, [recipient, cross]);
    await seedChild(root, 0, 'agent.fanin', state, 'consolidated');
    const open = await seedChild(root, 1, 'agent.response', 'pending', 'unfinished', cross);
    expectProjection(await readPair('operator', root), root, [state === 'done' ? 'consolidated' : null, 'hop-1'], true);
    await db().pool.query("UPDATE deliveries SET status='done',terminal_at=now() WHERE id=$1", [open]);
    await db().pool.query(`INSERT INTO agent_chain_gates(root_message_id,tenant_id,asked_by_alias,source_delivery_id,
      source_attempt,output_index,trace_id,question,correlation) VALUES($1,$2,$3,$4,1,0,$5,'fixture question',$6)`,
    [root.id, sender.tenant, recipient.alias, root.deliveries[0], root.trace, { root_message_id: root.id, root_delivery_id: root.deliveries[0] }]);
    expect((await db().pool.query('SELECT status FROM agent_chain_gates WHERE root_message_id=$1', [root.id])).rows).toEqual([{ status: 'open' }]);
    expectProjection(await readPair('operator', root), root, [state === 'done' ? 'consolidated' : null, 'unfinished'], true);
    await db().pool.query("UPDATE agent_chain_gates SET status='cancelled' WHERE root_message_id=$1", [root.id]);
    expectProjection(await readPair('operator', root), root, [state === 'done' ? 'consolidated' : null, 'unfinished'], false);
  });
  it.each([false, true])('never projects a system.gate.probe (agent root: %s)', async (agentRoot) => {
    const root = await seedRoot(agentRoot, [recipient], true);
    for (const actor of ['reader', 'operator', 'agent'] as const) expectNoProjection(await readPair(actor, root), root.deliveries);
  });
});
