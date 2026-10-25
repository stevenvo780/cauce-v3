import { execFile, spawn } from 'node:child_process';
import { randomBytes, X509Certificate } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { applyMigrations, createPool, type DatabasePool } from '@cauce/store';
import { buildGateway } from '../../services/gateway/src/app.js';
import { HashedMtlsIdentityFileProvider, MtlsAuthProvider } from '../../services/gateway/src/auth.js';
import { PostgresConsoleUserStore } from '../../services/gateway/src/console-users.js';
import { PasswordAuthProvider } from '../../services/gateway/src/password-auth.js';
import { DeliveryContextRuntimeSink } from '../../services/gateway/src/context-version-runtime.js';
import { createSelfSignedCert } from '../terminal-pty/certs.mjs';
import { arrancarPostgresDePrueba, COMANDO_POSTGRES_DE_PRUEBA, saludDePostgresDePrueba } from '../helpers/contenedor-de-prueba.js';
import { runCli, type CliResult } from './v4-rupturas-terminal-cli.fixtures.js';

export const PHYSICAL_OWNER = 'e2e-a9-commit-1025';
export const PHYSICAL_RECEIPTS = join(process.cwd(), '.delegados/v4/recibos', PHYSICAL_OWNER, 'physical');
const execute = promisify(execFile);

export async function physicalReceipt(name: string, value: unknown): Promise<void> {
  await mkdir(PHYSICAL_RECEIPTS, { recursive: true, mode: 0o700 });
  await writeFile(join(PHYSICAL_RECEIPTS, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

export function checkedJson(result: CliResult): unknown {
  if (result.code !== 0) throw new Error(`real CLI returned ${String(result.code)}: ${result.stderr}`);
  return JSON.parse(result.stdout) as unknown;
}

const CONTEXT_KERNEL = `#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
const chunks=[];for await(const chunk of process.stdin)chunks.push(Buffer.from(chunk));
const prompt=Buffer.concat(chunks).toString('utf8');
const raw=/--- BEGIN VERSIONED AGENT CONTEXT ---\\n([\\s\\S]*?)\\n--- END VERSIONED AGENT CONTEXT ---/u.exec(prompt)?.[1];
if(!raw)throw new Error('versioned context absent from native input');
const context=JSON.parse(raw);const file=context.files.find(file=>file.path==='context/mission.md');
if(!file)throw new Error('mission absent from native input');
const content=await readFile(join(process.cwd(),file.path),'utf8');
const native=await readFile(join(process.cwd(),'AGENTS.md'),'utf8');
if(content!==file.content||!native.includes(content))throw new Error('native files differ from context input');
const sid=randomUUID();const turn=randomUUID();
const output={reply:'SYNTHETIC_CONTEXT_CONSUMED',messages:[],notify:[],status:'done',retryable:false,artifacts:[]};
await appendFile(process.env.CAUCE_CLI_CONTEXT_WITNESS,JSON.stringify({version:context.version,digest:context.digest,session_id:sid,content,native_contains_current:true})+'\\n',{mode:0o600});
const directory=join(process.env.CODEX_HOME,'sessions');await mkdir(directory,{recursive:true,mode:0o700});
const records=[{type:'session_meta',payload:{id:sid,cwd:process.cwd(),source:'exec'}},
 {type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:prompt}],internal_chat_message_metadata_passthrough:{turn_id:turn}}},
 {type:'event_msg',payload:{type:'task_complete',turn_id:turn,last_agent_message:JSON.stringify(output)}}];
await appendFile(join(directory,'rollout-cli-'+sid+'.jsonl'),records.map(row=>JSON.stringify(row)).join('\\n')+'\\n',{mode:0o600});
process.stdout.write(JSON.stringify({type:'thread.started',thread_id:sid})+'\\n');
process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(output)}})+'\\n');
`;

export async function startCliContextApplication(run: string) {
  if (process.env.CAUCE_TEST_DATABASE_URL) throw new Error('CLI context E2E requires owned PostgreSQL');
  const directory = await mkdtemp(join(tmpdir(), 'zz-cli-ctx-'));
  const space = join(directory, 'space'), state = join(directory, 'state'), home = join(directory, 'home');
  const tls = createSelfSignedCert({ directory });
  await chmod(tls.cert_path, 0o600); await chmod(tls.key_path, 0o600);
  const company = `zz-cli-${run}`;
  const alias = `worker${run}`;
  const runtimeKey = `cli-context-${run}`;
  const password = randomBytes(24).toString('base64url');
  const email = `${company}@example.test`;
  const origin = 'http://localhost';
  const databasePassword = randomBytes(24).toString('base64url');
  let database: StartedTestContainer | undefined;
  let pool: DatabasePool | undefined;
  let app: Awaited<ReturnType<typeof buildGateway>> | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  let diagnostics = '';
  const secrets = [password, databasePassword];
  const close = async () => {
    if (child?.exitCode === null && child.signalCode === null) {
      const stopped = new Promise<void>(resolve => { child?.once('exit', () => { resolve(); }); });
      child.kill('SIGTERM');
      const timer = setTimeout(() => { child?.kill('SIGKILL'); }, 5_000);
      try { await stopped; } finally { clearTimeout(timer); }
    }
    try { await app?.close(); }
    finally {
      try { await pool?.end(); }
      finally {
        try { await database?.stop(); }
        finally { await rm(directory, { recursive: true, force: true }); }
      }
    }
  };
  try {
    database = await arrancarPostgresDePrueba(() => new GenericContainer('postgres:16-alpine')
      .withName(`zz-canary-${PHYSICAL_OWNER}-context-${run}`).withLabels({ 'cauce.e2e.owner': PHYSICAL_OWNER })
      .withCommand([...COMANDO_POSTGRES_DE_PRUEBA])
      .withEnvironment({ POSTGRES_DB: 'cauce_test', POSTGRES_USER: 'cauce_test', POSTGRES_PASSWORD: databasePassword })
      .withExposedPorts(5432).withHealthCheck(saludDePostgresDePrueba('cauce_test', 'cauce_test'))
      .withWaitStrategy(Wait.forHealthCheck()).start());
    const databaseId = database.getId();
    const url = `postgresql://cauce_test:${encodeURIComponent(databasePassword)}@${database.getHost()}:${String(database.getMappedPort(5432))}/cauce_test`;
    pool = createPool(url); await applyMigrations(pool);
    const identityFile = join(directory, 'mtls.json');
    await writeFile(identityFile, JSON.stringify({ version: 1, identities: [{
      certificate_sha256: new X509Certificate(tls.cert).fingerprint256.replaceAll(':', '').toLowerCase(),
      expires_at: new Date(Date.now() + 600_000).toISOString(),
      principal: { tenant_id: 'ContextCli', alias, session_id: `cli:${run}`, channel: 'agent', roles: ['agent'], permissions: ['route', 'read'] },
    }] }), { mode: 0o600 });
    const auth = new PasswordAuthProvider({ users: new PostgresConsoleUserStore(pool), signingKey: randomBytes(32),
      fallback: new MtlsAuthProvider(new HashedMtlsIdentityFileProvider(identityFile)) });
    app = await buildGateway({ pool, logger: false, authProvider: auth, consoleOrigins: [origin],
      https: { key: tls.key, cert: tls.cert, ca: tls.cert, requestCert: true, rejectUnauthorized: false },
      contextVersion: { runtime: new DeliveryContextRuntimeSink(pool) } });
    const gateway = await app.listen({ host: '127.0.0.1', port: 0 });
    const registered = await app.inject({ method: 'POST', url: '/v3/auth/register', headers: { origin },
      payload: { email, name: company, password, company: { name: company, slug: company } } });
    if (registered.statusCode !== 201) throw new Error(`context company registration returned ${String(registered.statusCode)}`);
    const tenantRow = (await pool.query<{ tenant_id: string; room_id: string }>(`SELECT user_record.tenant_id,room.id AS room_id
      FROM console_users user_record JOIN rooms room ON room.tenant_id=user_record.tenant_id
      WHERE user_record.email=$1 ORDER BY room.id LIMIT 1`, [email])).rows[0];
    if (!tenantRow) throw new Error('context company has no tenant/room');
    const tenant = tenantRow.tenant_id;
    const adapterCert = join(directory, 'adapter.crt');
    const certificateConfig = join(directory, 'adapter.cnf');
    const csr = join(directory, 'adapter.csr');
    await writeFile(certificateConfig, `[req]\ndistinguished_name=dn\nprompt=no\nreq_extensions=ext\n[dn]\nCN=${runtimeKey}\n`
      + `[ext]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=clientAuth\n`
      + `subjectAltName=URI:urn:cauce:runtime:${runtimeKey}\n`, { mode: 0o600 });
    await execute('openssl', ['req', '-new', '-key', tls.key_path, '-out', csr, '-config', certificateConfig]);
    await execute('openssl', ['x509', '-req', '-in', csr, '-CA', tls.cert_path, '-CAkey', tls.key_path,
      '-set_serial', `0x${randomBytes(16).toString('hex')}`, '-out', adapterCert, '-days', '2', '-sha256', '-extfile', certificateConfig, '-extensions', 'ext']);
    await chmod(adapterCert, 0o600);
    const identity = { version: 1, identities: [{
      certificate_sha256: new X509Certificate(await readFile(adapterCert)).fingerprint256.replaceAll(':', '').toLowerCase(),
      expires_at: new Date(Date.now() + 600_000).toISOString(), principal: { tenant_id: tenant, alias, channel: 'adapter',
        session_id: `adapter-${runtimeKey}`, roles: ['adapter'], permissions: ['read', 'route'] },
    }] };
    await writeFile(identityFile, JSON.stringify(identity), { mode: 0o600 });
    await pool.query(`INSERT INTO agents(tenant_id,alias,harness_id,enabled,container_name,runtime_user,home_directory,state_directory,runtime_key,runtime_mode)
      VALUES($1,$2,'codex',true,$3,$4,$5,$6,$7,'native')`, [tenant, alias, `zz-canary-${PHYSICAL_OWNER}-${run}`, userInfo().username, home, state, runtimeKey]);
    if ((await pool.query('SELECT 1 FROM fleet_runtime_identities WHERE runtime_key=$1 AND tenant_id=$2 AND alias=$3 AND NOT baseline AND baseline_state IS NULL',
      [runtimeKey, tenant, alias])).rowCount !== 1) throw new Error('standard agent trigger did not reserve the synthetic context runtime');
    await pool.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES($1,$2,$3,'agent')", [tenant, tenantRow.room_id, alias]);
    const sessionFile = join(directory, 'session.json');
    const login = await runCli(['login', '--gateway', gateway, '--origin', origin, '--ca-file', tls.cert_path, '--email', email,
      '--password-stdin', '--session-file', sessionFile], `${password}\n`);
    checkedJson(login);
    const session = JSON.parse(await readFile(sessionFile, 'utf8')) as { cookie: string; csrf_token: string };
    secrets.push(session.cookie, session.csrf_token);
    await Promise.all([space, state, home].map(path => mkdir(path, { mode: 0o700 })));
    await mkdir(join(home, '.codex'), { mode: 0o700 });
    const witness = join(directory, 'witness.jsonl');
    const kernel = join(directory, 'kernel.mjs');
    await writeFile(kernel, CONTEXT_KERNEL.replace('process.env.CAUCE_CLI_CONTEXT_WITNESS', JSON.stringify(witness))
      .replace('join(process.cwd(),file.path)', `join(${JSON.stringify(space)},file.path)`)
      .replace("join(process.cwd(),'AGENTS.md')", `join(${JSON.stringify(space)},'AGENTS.md')`), { mode: 0o700 });
    child = spawn(process.execPath, ['packages/adapter-sdk/dist/src/bin/codex.js'], { cwd: process.cwd(), env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin', NODE_ENV: 'test', HOME: home, CODEX_HOME: join(home, '.codex'),
      CAUCE_TENANT: tenant, CAUCE_ROOM: tenantRow.room_id, CAUCE_ALIAS: alias, CAUCE_INSTANCE_ID: `cli-context-${run}`,
      CAUCE_STATE_DIR: state, CAUCE_SPACE_ROOT: space, CAUCE_RELAY_URL: `${gateway.replace('https:', 'wss:')}/v3/ws`,
      CAUCE_ENVIRONMENT: 'test', CAUCE_HARNESS_COMMAND: kernel, CAUCE_HEARTBEAT_MS: '250',
      CAUCE_TLS_CERT_FILE: adapterCert, CAUCE_TLS_KEY_FILE: tls.key_path, CAUCE_TLS_CA_FILE: tls.cert_path,
    }, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [child.stdout, child.stderr]) stream?.on('data', (chunk: Buffer) => { diagnostics = (diagnostics + chunk.toString()).slice(-16_384); });
    const activePool = pool;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if ((await activePool.query('SELECT 1 FROM connection_leases WHERE tenant_id=$1 AND alias=$2 AND lease_until>now()', [tenant, alias])).rowCount) break;
      if (child.exitCode !== null) {
        const safeDiagnostics = secrets.reduce((text, secret) => text.replaceAll(secret, '[REDACTED]'), diagnostics);
        await physicalReceipt('context-lease-failure', { run, postgres: databaseId, diagnostics: safeDiagnostics });
        throw new Error('real SDK exited before acquiring its context lease; see context-lease-failure.json');
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (!(await activePool.query('SELECT 1 FROM connection_leases WHERE tenant_id=$1 AND alias=$2 AND lease_until>now()', [tenant, alias])).rowCount) {
      const safeDiagnostics = secrets.reduce((text, secret) => text.replaceAll(secret, '[REDACTED]'), diagnostics);
      await physicalReceipt('context-lease-failure', { run, postgres: databaseId, diagnostics: safeDiagnostics });
      throw new Error('real SDK did not acquire its context lease; see context-lease-failure.json');
    }
    return { pool: activePool, databaseId, tenant, alias, space, witness, directory, secrets, diagnostics: () => diagnostics,
      args: ['context', '--gateway', gateway, '--origin', origin, '--ca-file', tls.cert_path, '--session-file', sessionFile,
        '--tenant', tenant, '--alias', alias], close };
  } catch (error) { await close(); throw error; }
}
