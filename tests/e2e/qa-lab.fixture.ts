import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, watch } from 'node:fs';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  FIXTURE_PROVIDER_IDENTITY, enrollComputer, startComputerHarness, type ComputerHarness,
} from '../../services/gateway/src/fleet/host-computer.fixtures.js';
import { startQaLabApplication, sha256, type QaLabApplication } from './qa-lab-app.js';
import { startQaDocker } from './qa-lab-docker.js';
import { QA_CODEX_QUOTA_PROBE, startQaLabQuota, type QaLabQuota } from './qa-lab-quota.js';
import { reserveNamedLoopbackPorts } from './port-reservation.js';
import { cancelDeployRuntime } from './v4-fleet-cancel-deploy.runtime.js';

const OWNER = 'qa0-entorno-exploracion-1025';

const qaRuntime = {
  ...cancelDeployRuntime,
  agentImageFiles: { '/usr/local/bin/codex-http-probe.py': QA_CODEX_QUOTA_PROBE },
  providerCli: cancelDeployRuntime.providerCli + `
import os,pathlib
if nonce is None:
 home=pathlib.Path(os.environ['CODEX_HOME'])
 directory=home/'sessions'
 directory.mkdir(parents=True,exist_ok=True,mode=0o700)
 transcript=directory/('rollout-qa-'+native+'.jsonl')
 turn=str(uuid.uuid4())
 entries=[] if transcript.exists() else [{'type':'session_meta','payload':{'id':native,'cwd':os.getcwd(),'source':'exec'}}]
 entries.extend([
  {'type':'response_item','payload':{'type':'message','role':'user','content':[{'type':'input_text','text':prompt}],
   'internal_chat_message_metadata_passthrough':{'turn_id':turn}}},
  {'type':'event_msg','payload':{'type':'task_complete','turn_id':turn,'last_agent_message':answer}}
 ])
 fd=os.open(transcript,os.O_WRONLY|os.O_APPEND|os.O_CREAT,0o600)
 with os.fdopen(fd,'a') as stream:
  for entry in entries: stream.write(json.dumps(entry)+'\\n')
`,
};

async function untrackedReleaseSources(): Promise<string[]> {
  const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
  const { stdout } = await promisify(execFile)('git', ['-C', projectRoot, 'ls-files', '--others', '--exclude-standard', '-z', '--',
    'services/gateway/src', 'packages/store/src', 'packages/protocol/src', 'ops/cli']);
  return stdout.split('\0').filter(path => /\.(?:ts|js|mjs|py|json)$/u.test(path)
    && !path.split('/').some(part => ['private', 'credentials', 'secrets', 'tokens', 'sessions', 'auth.json', 'settings.local.json'].includes(part)));
}

interface FailureDetail { name: string; message: string; cause?: FailureDetail; errors?: FailureDetail[] }

function failureDetail(error: unknown): FailureDetail {
  let remaining = 4_000;
  const seen = new WeakSet<Error>();
  const redact = (value: string): string => {
    const safe = value
      .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/gu, '[private key redacted]')
      .replace(/\bpostgres(?:ql)?:\/\/[^\s"'<>]+/giu, '[database URL redacted]')
      .replace(/\bBearer\s+[^\s,"';]+/giu, 'Bearer [redacted]')
      .replace(/(["']?(?:password|token|private[_-]?key|client[_-]?secret|authorization|cookie|set-cookie)["']?\s*[:=]\s*)(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s,;}]+)/giu, '$1[redacted]')
      .replace(/((?:--)?(?:password|token|private[_-]?key)\s+)[^\s,;]+/giu, '$1[redacted]')
      .replace(/\b[A-Za-z0-9_+/=-]{40,}\b/gu, '[opaque value redacted]');
    const result = safe.slice(0, Math.min(1_500, remaining));
    remaining -= result.length;
    return result;
  };
  const visit = (value: unknown, depth: number): FailureDetail => {
    if (!(value instanceof Error)) return { name: 'NonError', message: typeof value === 'string' ? redact(value) : 'Non-error exception' };
    if (seen.has(value) || depth >= 5) return { name: value.name.slice(0, 80), message: 'Nested exception omitted' };
    seen.add(value);
    const result: FailureDetail = { name: value.name.slice(0, 80), message: redact(value.message) };
    if (value.cause !== undefined && remaining > 0) result.cause = visit(value.cause, depth + 1);
    if (value instanceof AggregateError && remaining > 0) {
      result.errors = (value.errors as unknown[]).slice(0, 8).map(item => visit(item, depth + 1));
    }
    return result;
  };
  return visit(error, 0);
}

function configuration() {
  const name = process.env.QA_LAB_NAME ?? '', directory = process.env.QA_LAB_DIRECTORY ?? '';
  const url = new URL(process.env.QA_LAB_URL ?? '');
  if (!/^[a-z][a-z0-9-]{0,18}$/u.test(name) || !isAbsolute(directory)
      || url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('QA laboratory name, directory or URL is invalid');
  }
  if (process.env.DATABASE_URL || process.env.CAUCE_TEST_DATABASE_URL || process.env.VITE_USE_MOCKS === 'true') {
    throw new Error('QA laboratory requires its own database and the real console');
  }
  return { name, directory, url: url.origin, prefix: `zz-canary-qa-${name}` };
}

async function receipt(directory: string, data: Record<string, unknown>): Promise<void> {
  const pending = join(directory, 'ready.pending.json');
  await writeFile(pending, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  await rename(pending, join(directory, 'ready.json'));
}

function waitForFile(directory: string, name: string, signal: AbortSignal, timeout?: number): Promise<'file' | 'stopped' | 'timeout'> {
  if (signal.aborted) return Promise.resolve('stopped');
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const watcher = watch(directory, (_event, filename) => {
      if (filename === name && existsSync(join(directory, name))) finish('file');
    });
    const finish = (value: 'file' | 'stopped' | 'timeout') => {
      if (timer) clearTimeout(timer);
      clearInterval(poll);
      watcher.close(); signal.removeEventListener('abort', stopped); resolve(value);
    };
    const stopped = () => { finish('stopped'); };
    watcher.once('error', error => {
      if (timer) clearTimeout(timer);
      clearInterval(poll);
      watcher.close(); signal.removeEventListener('abort', stopped); reject(error);
    });
    signal.addEventListener('abort', stopped, { once: true });
    const poll = setInterval(() => { if (existsSync(join(directory, name))) finish('file'); }, 500);
    if (timeout !== undefined) timer = setTimeout(() => { finish('timeout'); }, timeout);
    if (existsSync(join(directory, name))) finish('file');
    else if (signal.aborted) finish('stopped');
  });
}

async function registerOwner(computer: ComputerHarness, prefix: string, email: string, password: string, origin: string) {
  const registered = await computer.app.inject({ method: 'POST', url: '/v3/auth/register', headers: { origin },
    payload: { email, name: prefix, password, company: { name: prefix, slug: prefix } } });
  if (registered.statusCode !== 201) throw new Error(`QA owner registration failed (${String(registered.statusCode)})`);
  const login = await computer.app.inject({ method: 'POST', url: '/v3/auth/login', headers: { origin }, payload: { email, password } });
  if (login.statusCode !== 200) throw new Error(`QA owner login failed (${String(login.statusCode)})`);
  const header = login.headers['set-cookie'];
  const cookie = (Array.isArray(header) ? header : header === undefined ? [] : [header]).map(value => value.split(';', 1)[0]).join('; ');
  const hostId = `${prefix}-pc`;
  await enrollComputer(computer, { cookie, origin, 'x-csrf-token': login.json<{ csrf_token: string }>().csrf_token }, prefix, hostId);
  const tenantId = (await computer.pool.query<{ tenant_id: string }>('SELECT tenant_id FROM console_users WHERE email=$1', [email])).rows[0]?.tenant_id;
  if (!tenantId) throw new Error('QA owner has no company');
  const accountId = `${prefix}-provider`;
  await computer.pool.query(`INSERT INTO provider_accounts(id,provider,external_account_id,payer_tenant_id,credential_ref_kind,credential_ref,enabled)
    VALUES($1,'codex',$2,$3,'env_path','CAUCE_QA_LAB_PROFILE_PATH',true)`, [accountId, FIXTURE_PROVIDER_IDENTITY, tenantId]);
  return { tenantId, hostId, accountId };
}

async function main(): Promise<void> {
  const { directory, prefix, url, name } = configuration();
  const privateDirectory = join(directory, 'private'), workRoot = join('/datos', `${prefix}-work`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await mkdir(privateDirectory, { recursive: true, mode: 0o700 });
  await chmod(privateDirectory, 0o700);
  await mkdir(workRoot, { mode: 0o755 });
  const stop = new AbortController();
  const stopNow = () => { stop.abort(); };
  process.on('SIGTERM', stopNow); process.on('SIGINT', stopNow);
  const stopped = new Promise<void>(resolve => { stop.signal.addEventListener('abort', () => { resolve(); }, { once: true }); });
  const ports = await reserveNamedLoopbackPorts(['gateway', 'browser', 'agent', 'health'] as const);
  let proxy: Awaited<ReturnType<typeof startQaDocker>> | undefined;
  let computer: ComputerHarness | undefined, application: QaLabApplication | undefined, quota: QaLabQuota | undefined;
  let current: Record<string, unknown> = { status: 'starting', name, prefix, owner: OWNER, url };
  let failed = false;
  let stage = 'docker_proxy';
  const checkStop = () => { if (stop.signal.aborted) throw new Error('QA laboratory startup was interrupted'); };
  try {
    await receipt(directory, current);
    proxy = await startQaDocker(prefix, directory);
    process.env.DOCKER_HOST = `unix://${proxy.socket}`;
    process.env.TESTCONTAINERS_RYUK_DISABLED = 'true';
    process.env.CAUCE_REQUIRE_TESTCONTAINERS = '1';
    process.env.CAUCE_SPACE_BACKUP_DIRECTORY = join(privateDirectory, 'space-backups');
    await mkdir(process.env.CAUCE_SPACE_BACKUP_DIRECTORY, { mode: 0o700 });
    checkStop();
    const ticketKey = randomBytes(32), masterFile = join(privateDirectory, 'terminal-master.key');
    const master = ticketKey.toString('hex');
    await writeFile(masterFile, master, { mode: 0o600 });
    const origins = [url, 'https://localhost:4443'];
    stage = 'computer_harness';
    computer = await startComputerHarness({ prefix, consoleOrigins: origins, resourceOwner: OWNER,
      dockerSocket: proxy.socket, workRoot, runtimeBundle: qaRuntime, extraSourceFiles: await untrackedReleaseSources(),
      terminal: { masterFile, masterSha256: sha256(master), relayHost: '127.0.0.1', relayPort: ports.ports.agent, serverName: 'localhost' } });
    checkStop();
    const email = `${prefix}@example.test`, password = `Qa-${randomBytes(24).toString('hex')}`;
    await writeFile(join(directory, 'password'), password + '\n', { mode: 0o600 });
    await chmod(join(directory, 'password'), 0o600);
    stage = 'owner_and_enrollment';
    const owner = await registerOwner(computer, prefix, email, password, url);
    checkStop();
    stage = 'application_and_relay';
    application = await startQaLabApplication({ computer, directory: privateDirectory, prefix, email, origins, url, ticketKey,
      ports: ports.ports, releasePorts: () => ports.releaseAll() });
    checkStop();
    stage = 'quota_readers';
    quota = await startQaLabQuota({ prefix, pool: computer.pool, email, accountId: owner.accountId, origin: 'https://localhost:4443',
      ca: join(dirname(computer.installRoot), 'authority/ca.crt'), directory: join(privateDirectory, 'quota'),
      computerImage: `${prefix}:computer`, rawDockerSocket: process.env.QA_LAB_RAW_SOCKET ?? '' });
    checkStop();
    current = { ...current, ...owner, email, quotaHost: quota.hostId, computer: computer.container,
      database: { container: `zz-canary-qa-0db-${name}`, name: new URL(computer.databaseUrl).pathname.slice(1) },
      relay: application.relay, status: 'ready' };
    await receipt(directory, current);
    stage = 'up_confirmation';
    const confirmation = await waitForFile(directory, 'confirmed', stop.signal, 60_000);
    if (confirmation !== 'file') throw new Error(`QA laboratory startup ${confirmation === 'timeout' ? 'was not confirmed' : 'was interrupted'}`);
    await stopped;
  } catch (error) {
    failed = !stop.signal.aborted;
    const detail = failureDetail(error);
    current = { ...current, status: failed ? 'failed' : 'stopping', stage,
      reason: failed ? 'startup_or_runtime_failed' : 'stop_requested', failureClass: detail.name, errorDetail: detail };
    await writeFile(join(directory, 'startup-failure.json'), JSON.stringify({ owner: OWNER, name, prefix, stage, errorDetail: detail }, null, 2) + '\n', { mode: 0o600 });
    await receipt(directory, current);
    if (failed) process.stderr.write('QA laboratory failed; inspect startup-failure.json for the redacted causes.\n');
  } finally {
    stop.abort();
    await stopped;
    const cleanup: unknown[] = [];
    for (const action of [async () => quota?.close(), async () => application?.close(), async () => computer?.close(), async () => proxy?.close(),
      async () => ports.releaseAll(), async () => rm(privateDirectory, { recursive: true, force: true }),
      async () => rm(workRoot, { recursive: true, force: true })]) {
      try { await action(); } catch (error) { cleanup.push(error); }
    }
    await receipt(directory, { ...current, status: cleanup.length ? 'cleanup_failed' : 'down', cleanupScope: 'fixture_handles',
      cleanupErrors: cleanup.length, cleanupErrorDetails: cleanup.map(failureDetail) });
    process.removeListener('SIGTERM', stopNow); process.removeListener('SIGINT', stopNow);
    if (failed || cleanup.length) process.exitCode = 1;
  }
}

await main();
