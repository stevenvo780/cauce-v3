import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  functionalTenants, isaTenant, jhonTenant, newTrustedPage, startConsoleFunctionalFixture,
  type BrowserPage, type FunctionalTenant,
} from './console-functional-browser.fixtures.js';

export const CONTEXT_RUN = `context-multiuser-${randomUUID()}`;
export const CONTEXT_ARTIFACT_DIR = join(tmpdir(), `cauce-context-multiuser-${randomUUID()}`);

export async function startContextFixture() {
  if (process.env.CAUCE_TEST_DATABASE_URL) throw new Error('este E2E exige Testcontainers; CAUCE_TEST_DATABASE_URL no se acepta');
  const fixture = await startConsoleFunctionalFixture();
  try {
    await mkdir(CONTEXT_ARTIFACT_DIR, { recursive: true, mode: 0o700 });
    for (const tenant of functionalTenants) {
      await fixture.database.pool.query(
        `INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES($1,$2,$3,'agent')`,
        [tenant.tenant, tenant.room, tenant.target],
      );
    }
    const memberships = await fixture.database.pool.query<{
      tenant_id: string; room_id: string; alias: string; role: string; enabled: boolean;
    }>(`SELECT tenant_id,room_id,alias,role,enabled FROM memberships
         WHERE (tenant_id=$1 AND room_id=$2 AND alias=$3)
            OR (tenant_id=$4 AND room_id=$5 AND alias=$6) ORDER BY tenant_id`,
      [isaTenant.tenant, isaTenant.room, isaTenant.target, jhonTenant.tenant, jhonTenant.room, jhonTenant.target]);
    if (memberships.rows.length !== 2 || memberships.rows.some((row) => row.role !== 'agent' || !row.enabled)) {
      throw new Error('synthetic adapter fixture has no enabled room membership');
    }
    await writeFile(join(CONTEXT_ARTIFACT_DIR, `${CONTEXT_RUN}-setup.json`),
      JSON.stringify({ memberships: memberships.rows, authority: 'owned fixture room memberships' }, null, 2), { mode: 0o600 });
    return fixture;
  } catch (error) {
    try { await fixture.close(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'context fixture setup and cleanup failed'); }
    throw error;
  }
}

export async function login(page: BrowserPage, fixture: Awaited<ReturnType<typeof startConsoleFunctionalFixture>>, user: FunctionalTenant): Promise<void> {
  await page.goto(fixture.baseUrl, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Correo').waitFor({ timeout: 15_000 });
  await page.getByLabel('Correo').fill(user.email);
  await page.getByLabel('Contraseña').fill(user.password);
  await page.getByRole('button', { name: 'Iniciar sesión' }).click();
  await page.getByRole('navigation', { name: 'Navegación principal', exact: true })
    .locator('a[href="/messages"], a[href^="/messages/"]').waitFor({ state: 'visible', timeout: 20_000 });
}

export async function addConversationRoom(fixture: Awaited<ReturnType<typeof startConsoleFunctionalFixture>>): Promise<string> {
  const room = `${CONTEXT_RUN}-new-room`;
  await fixture.database.pool.query('INSERT INTO rooms(id,tenant_id) VALUES($1,$2)', [room, isaTenant.tenant]);
  await fixture.database.pool.query(
    `INSERT INTO memberships(tenant_id,room_id,alias,role)
     VALUES($1,$2,$3,'operator'),($1,$2,$4,'agent')`,
    [isaTenant.tenant, room, isaTenant.operator, isaTenant.target],
  );
  return room;
}

export async function publish(page: BrowserPage, fixture: Awaited<ReturnType<typeof startConsoleFunctionalFixture>>,
  tenant: FunctionalTenant, room: string, text: string): Promise<{ messageId: string; deliveryId: string }> {
  const result = await page.evaluate(async (input) => {
    const sessionResponse = await fetch('/v3/auth/session', { credentials: 'include' });
    const session = await sessionResponse.json() as { csrf_token?: string };
    if (!sessionResponse.ok || typeof session.csrf_token !== 'string') throw new Error(`auth session HTTP ${String(sessionResponse.status)}`);
    const command = { room_id: input.room, recipients: [{ tenant_id: input.tenant, alias: input.alias }],
      body: { text: input.text }, lane: 'interactive', priority: 10 };
    const headers = { 'content-type': 'application/json', 'x-csrf-token': session.csrf_token };
    const intent = await fetch('/v3/console/publish-intents', { method: 'POST', credentials: 'include', headers,
      body: JSON.stringify({ ...command, intent_nonce: crypto.randomUUID() }) });
    const intentBody = await intent.json() as { state?: string; idempotency_key?: string };
    if (intent.status !== 200 || intentBody.state !== 'prepared' || typeof intentBody.idempotency_key !== 'string') {
      throw new Error(`publish intent HTTP ${String(intent.status)}: ${JSON.stringify(intentBody)}`);
    }
    const published = await fetch('/v3/console/messages', { method: 'POST', credentials: 'include', headers,
      body: JSON.stringify({ ...command, idempotency_key: intentBody.idempotency_key }) });
    const receipt = await published.json() as { message_id?: string; delivery_ids?: string[]; causal_hash?: string };
    if (published.status !== 202 || typeof receipt.message_id !== 'string' || typeof receipt.causal_hash !== 'string'
        || !Array.isArray(receipt.delivery_ids) || typeof receipt.delivery_ids[0] !== 'string') {
      throw new Error(`publish HTTP ${String(published.status)}: ${JSON.stringify(receipt)}`);
    }
    const confirmed = await fetch('/v3/console/publish-intents/confirm', { method: 'POST', credentials: 'include', headers,
      body: JSON.stringify({ idempotency_key: intentBody.idempotency_key, message_id: receipt.message_id, causal_hash: receipt.causal_hash }) });
    const confirmation = await confirmed.json() as { confirmed?: boolean };
    if (confirmed.status !== 200 || confirmation.confirmed !== true) throw new Error(`intent confirm HTTP ${String(confirmed.status)}`);
    return { messageId: receipt.message_id, deliveryId: receipt.delivery_ids[0] };
  }, { room, tenant: tenant.tenant, alias: tenant.target, text });
  if (!result.messageId || !result.deliveryId) throw new Error('browser API returned incomplete durable receipt');
  const persisted = await fixture.database.pool.query<{ auth_channel: string; actor_alias: string; tenant_id: string }>(
    `SELECT auth_channel,actor_alias,tenant_id FROM messages WHERE id=$1`, [result.messageId],
  );
  if (persisted.rows.length !== 1 || persisted.rows[0]?.auth_channel !== 'console'
      || persisted.rows[0].tenant_id !== tenant.tenant || persisted.rows[0].actor_alias !== tenant.operator) {
    throw new Error(`durable message authority mismatch: ${JSON.stringify(persisted.rows)}`);
  }
  return result;
}

export async function newPage(fixture: Awaited<ReturnType<typeof startConsoleFunctionalFixture>>) {
  return newTrustedPage(fixture, { width: 1280, height: 900 });
}

export interface SyntheticAdapter {
  readonly child: ChildProcess;
  readonly home: string;
  readonly codexHome: string;
  readonly stateDir: string;
  readonly witnessPath: string;
  readonly diagnosticsPath: string;
}

export async function startSyntheticAdapter(fixture: Awaited<ReturnType<typeof startConsoleFunctionalFixture>>,
  tenant: FunctionalTenant): Promise<SyntheticAdapter> {
  const suffix = tenant.tenant.toLowerCase();
  const home = join(fixture.directory, `context-${suffix}-home`);
  const codexHome = join(fixture.directory, `context-${suffix}-codex-home`);
  const stateDir = join(fixture.directory, `context-${suffix}-sid-state`);
  const witnessPath = join(fixture.directory, `context-${suffix}-witness.jsonl`);
  const adapterStateDir = join(fixture.directory, `${suffix}-s`);
  const endpointBytes = Buffer.byteLength(join(adapterStateDir, 'e-00000000-0000-0000-0000-000000000000.sock'));
  if (endpointBytes > 107) throw new Error('owned synthetic adapter endpoint exceeds Unix socket limit');
  await mkdir(adapterStateDir, { mode: 0o700 });
  await writeFile(join(CONTEXT_ARTIFACT_DIR, `${CONTEXT_RUN}-${suffix}-endpoint.json`),
    JSON.stringify({ tenant: tenant.tenant, alias: tenant.target, adapterStateDir, endpointBytes, limit: 107 }, null, 2), { mode: 0o600 });
  const index = functionalTenants.indexOf(tenant);
  const tls = fixture.pki.adapterCerts[index];
  if (index < 0 || tls === undefined) throw new Error(`missing owned TLS identity for ${tenant.tenant}`);
  await Promise.all([home, codexHome, stateDir].map((path) => mkdir(path, { recursive: true, mode: 0o700 })));
  const harness = join(fixture.directory, `context-${suffix}-kernel.mjs`);
  const script = `#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const args=process.argv.slice(2); const resumeIndex=args.indexOf('resume');
const resumed=resumeIndex<0?null:(args[resumeIndex+2]??null);
if(resumeIndex>=0&&(args[resumeIndex+1]!=='--json'||args[resumeIndex+3]!=='-'||typeof resumed!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(resumed))){process.stderr.write('SYNTHETIC_RESUME_ID_INVALID\\n');process.exit(86);}
const chunks=[];for await(const part of process.stdin){chunks.push(Buffer.from(part));if(Buffer.concat(chunks).length>1048576){process.stderr.write('SYNTHETIC_PROMPT_LIMIT\\n');process.exit(86);}}
const prompt=Buffer.concat(chunks).toString('utf8');
const match=/--- BEGIN TRUSTED DELIVERY CONTEXT ---\\n([\\s\\S]*?)\\n--- END TRUSTED DELIVERY CONTEXT ---/u.exec(prompt);
if(!match)throw new Error('trusted delivery context missing'); const context=JSON.parse(match[1]);
const sid=resumed??randomUUID(); const statePath=join(${JSON.stringify(stateDir)},sid+'.json');
let state={memory:''};try{state=JSON.parse(await readFile(statePath,'utf8'));}catch{}
const mark=/STORE:([A-Z0-9_-]+)/u.exec(prompt)?.[1]; if(mark)state.memory=mark;
await writeFile(statePath,JSON.stringify(state),{mode:0o600});
await appendFile(${JSON.stringify(witnessPath)},JSON.stringify({argv:args,session_id:sid,resumed:resumed!==null,
 home:process.env.HOME,codex_home:process.env.CODEX_HOME,context,input:prompt})+'\\n',{mode:0o600});
const answer=/RECALL/u.test(prompt)?(state.memory||'EMPTY_MEMORY'):('ACK '+(mark??'TURN'));
const result=JSON.stringify({reply:answer,messages:[],notify:[],status:'done',retryable:false,artifacts:[]});
process.stdout.write(JSON.stringify({type:'thread.started',thread_id:sid})+'\\n');
process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:result}})+'\\n');
`;
  await writeFile(harness, script, { mode: 0o700 });
  await chmod(harness, 0o700);
  const child = spawn(process.execPath, ['packages/adapter-sdk/dist/src/bin/codex.js'], { cwd: process.cwd(), env: {
    PATH: process.env.PATH ?? '/usr/bin:/bin', NODE_ENV: 'test', HOME: home, CODEX_HOME: codexHome,
    XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local', 'share'),
    CAUCE_TENANT: tenant.tenant, CAUCE_ROOM: tenant.room, CAUCE_ALIAS: tenant.target,
    CAUCE_INSTANCE_ID: `${CONTEXT_RUN}-${suffix}`, CAUCE_STATE_DIR: adapterStateDir,
    CAUCE_RELAY_URL: `${fixture.gatewayUrl.replace('https:', 'wss:')}/v3/ws`, CAUCE_ENVIRONMENT: 'test',
    CAUCE_HARNESS_COMMAND: harness,
    CAUCE_HEARTBEAT_MS: '250', CAUCE_NO_PROGRESS_TIMEOUT_MS: '120000',
    CAUCE_TLS_CERT_FILE: tls.cert, CAUCE_TLS_KEY_FILE: tls.key, CAUCE_TLS_CA_FILE: fixture.pki.ca.cert,
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  const diagnosticsPath = join(CONTEXT_ARTIFACT_DIR, `${CONTEXT_RUN}-${suffix}-adapter.json`);
  const diagnostics: { pid: number | undefined; stdout: string; stderr: string;
    events: { event: string; at: string; code?: number | null; signal?: string | null; message?: string }[] } = {
      pid: child.pid, stdout: '', stderr: '', events: [],
    };
  const persist = (): void => { writeFileSync(diagnosticsPath, JSON.stringify(diagnostics, null, 2), { mode: 0o600 }); };
  const record = (event: (typeof diagnostics.events)[number]): void => {
    diagnostics.events = [...diagnostics.events, event].slice(-20);
    persist();
  };
  const capture = (stream: 'stdout' | 'stderr', chunk: Buffer): void => {
    diagnostics[stream] = (diagnostics[stream] + chunk.toString('utf8')).slice(-64 * 1024);
    persist();
  };
  child.stdout.on('data', (chunk: Buffer) => { capture('stdout', chunk); });
  child.stderr.on('data', (chunk: Buffer) => { capture('stderr', chunk); });
  child.on('spawn', () => { record({ event: 'spawn', at: new Date().toISOString() }); });
  child.on('error', (error) => { record({ event: 'error', at: new Date().toISOString(), message: error.message.slice(0, 1500) }); });
  child.on('exit', (code, signal) => { record({ event: 'exit', at: new Date().toISOString(), code, signal }); });
  fixture.adapters.push(child);
  return { child, home, codexHome, stateDir, witnessPath, diagnosticsPath };
}

export async function waitForLease(fixture: Awaited<ReturnType<typeof startConsoleFunctionalFixture>>, tenant: FunctionalTenant): Promise<void> {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const lease = await fixture.database.pool.query(
      'SELECT tenant_id,alias,instance_id,epoch,lease_until FROM connection_leases WHERE tenant_id=$1 AND alias=$2 AND lease_until>now()', [tenant.tenant, tenant.target],
    );
    if (lease.rowCount === 1) {
      await writeFile(join(CONTEXT_ARTIFACT_DIR, `${CONTEXT_RUN}-${tenant.tenant.toLowerCase()}-lease.json`),
        JSON.stringify(lease.rows[0], null, 2), { mode: 0o600 });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`synthetic SDK failed to acquire its own fenced lease for ${tenant.tenant}:${tenant.target}`);
}

export async function waitForDone(fixture: Awaited<ReturnType<typeof startConsoleFunctionalFixture>>,
  deliveryId: string): Promise<{ result: unknown; claim_token: string; consumer_epoch: number }> {
  const deadline = Date.now() + 35_000;
  while (Date.now() < deadline) {
    const result = await fixture.database.pool.query<{ status: string; result: unknown; claim_token: string; consumer_epoch: number }>(
      `SELECT d.status,d.result,d.claim_token,d.consumer_epoch FROM deliveries d WHERE d.id=$1`, [deliveryId],
    );
    const row = result.rows[0];
    if (row?.status === 'done') {
      const ack = await fixture.database.pool.query<{ status: string; applied: boolean; claim_token: string; epoch: number }>(
        `SELECT status,applied,claim_token,epoch FROM delivery_acks WHERE delivery_id=$1 ORDER BY id DESC LIMIT 1`, [deliveryId],
      );
      if (ack.rows[0]?.status !== 'done' || !ack.rows[0].applied
          || ack.rows[0].claim_token !== row.claim_token || ack.rows[0].epoch !== row.consumer_epoch) {
        throw new Error(`fenced ACK does not match terminal delivery: ${JSON.stringify({ delivery: row, ack: ack.rows })}`);
      }
      return row;
    }
    if (result.rows[0]?.status === 'dead') throw new Error(`delivery entered dead state: ${JSON.stringify(result.rows[0])}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`delivery ${deliveryId} did not reach done before deadline`);
}

export async function readWitness(path: string): Promise<Record<string, unknown>[]> {
  const content = await readFile(path, 'utf8').catch((error: unknown) => {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return '';
    throw error;
  });
  return content.split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

export function doneReply(value: { result: unknown } | undefined): string {
  const result = value?.result;
  if (result === null || typeof result !== 'object' || !('output' in result)) {
    throw new Error('terminal delivery result has no structured output');
  }
  const output = result.output;
  if (output === null || typeof output !== 'object' || !('reply' in output)
      || typeof output.reply !== 'string') {
    throw new Error('terminal delivery output has no textual reply');
  }
  return output.reply;
}

export { isaTenant, jhonTenant };
