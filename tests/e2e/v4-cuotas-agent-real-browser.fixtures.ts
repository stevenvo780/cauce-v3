import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { Agent, request } from 'node:https';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { HostEnrollmentRepository, hostEnrollmentMessage, lockCompanyAuthority } from '@cauce/store';
import { AgentQuotaExecutor, HostChannelAgentQuotaRepository } from '../../services/gateway/src/fleet/agent-quota-executor.js';
import { performAgentQuotaHostCommand } from '../../services/gateway/src/fleet/agent-quota-host-command.js';
import { channelCapabilities, channelPacket } from '../../services/gateway/src/fleet/host-channel.fixtures.js';
import { maintainConsoleUser } from '../../services/gateway/src/console-user-maintenance.js';
import { hashPassword } from '../../services/gateway/src/password.js';
import type { startConsoleFunctionalFixture } from './console-functional-browser.fixtures.js';

type Fixture = Awaited<ReturnType<typeof startConsoleFunctionalFixture>>;
const execute = promisify(execFile);
/** Identity hash the synthetic reader of ops/tests/test_fleet_executor_agent_quota.py reports. */
const SYNTHETIC_READER_IDENTITY_HASH = 'cdec757647de138bf5c817110c408b6c8d7e995789a328b37527fb058416cf18';
export interface QuotaAgentPlacement {
  tenant_id: string; alias: string; host_id: string; harness_id: string; runtime_mode: string; container_name: string;
  runtime_key: string; runtime_user: string; home_directory: string; state_directory: string; systemd_user: string;
  primary_account_id?: string | null;
}

async function bounded<T>(work: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { reject(new Error(`${label} timed out`)); }, milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

function isRunning(child: ChildProcessWithoutNullStreams | undefined): child is ChildProcessWithoutNullStreams {
  return child?.exitCode === null && child.signalCode === null;
}

export async function startAgentQuotaDocker(fixture: Fixture, email: string, evidenceDirectory: string,
  reader?: { email: string; name: string; password: string }, options?: { dynamicAccount?: string }) {
  await mkdir(evidenceDirectory, { recursive: true });
  const pool = fixture.database.pool;
  const person = (await pool.query<{ id: string; company_id: string; tenant_id: string; alias: string }>(
    'SELECT id::text,company_id,tenant_id,alias FROM console_users WHERE email=$1', [email])).rows[0];
  if (!person) throw new Error('quota browser owner is missing');
  if (reader) await maintainConsoleUser(pool, { email: reader.email, name: reader.name, role: 'reader',
    tenant: person.tenant_id, alias: person.alias, updateOnly: false, activate: false }, await hashPassword(reader.password));
  const keys = generateKeyPairSync('ed25519');
  const host = { host_id: `${person.company_id}-host`, company_id: person.company_id, keys };
  const enrollment = new HostEnrollmentRepository(pool);
  const invitation = await enrollment.invite(client => lockCompanyAuthority(client,
    { tenant: person.tenant_id, alias: person.alias, humanId: person.id }), { host_id: host.host_id, display_name: 'Cuotas E2E' });
  await enrollment.claim(invitation.enrollment_id, {
    invitation_token: invitation.invitation_token,
    public_key: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    proof: sign(null, Buffer.from(hostEnrollmentMessage(invitation)), keys.privateKey).toString('base64'),
  });
  const tls = new Agent({ ca: await readFile(fixture.pki.ca.cert), cert: await readFile(fixture.pki.consoleClient.cert),
    key: await readFile(fixture.pki.consoleClient.key), rejectUnauthorized: true });
  const channel = { request: async (_method: 'POST', path: string, payload: Record<string, unknown>): Promise<unknown> => {
    const body = JSON.stringify(channelPacket(host, payload));
    return new Promise((resolveResponse, reject) => {
      const outgoing = request(`${fixture.gatewayUrl}${path}`, { agent: tls, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, incoming => {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk: Buffer) => { chunks.push(chunk); });
        incoming.on('error', reject);
        incoming.on('end', () => {
          try {
            if (incoming.statusCode !== 200) throw new Error(`signed quota host returned ${String(incoming.statusCode)}`);
            resolveResponse(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
          } catch (cause) { reject(cause instanceof Error ? cause : new Error('invalid signed quota response')); }
        });
      });
      outgoing.on('error', reject);
      outgoing.setTimeout(30_000, () => { outgoing.destroy(new Error('signed quota host timed out')); });
      outgoing.end(body);
    });
  } };
  await channel.request('POST', `/v3/fleet/hosts/${host.host_id}/channel`, channelCapabilities());
  let helper: ChildProcessWithoutNullStreams | undefined;
  const close = async () => {
    try {
      if (!helper) return;
      const child = helper;
      const exited = child.exitCode === null && child.signalCode === null
        ? once(child, 'exit').then(() => child.exitCode) : Promise.resolve(child.exitCode);
      if (child.exitCode === null && child.signalCode === null) child.stdin.end('close\n');
      const code = await bounded(exited, 120_000, 'quota Docker cleanup');
      if (code !== 0) throw new Error(`quota Docker fixture cleanup failed: ${String(code)}`);
      helper = undefined;
      await writeFile(join(evidenceDirectory, 'docker-cleanup.json'), JSON.stringify({ containers_removed: true, volumes_removed: true }));
    } catch (cause) {
      const child = helper;
      if (isRunning(child)) {
        const exited = once(child, 'exit');
        child.kill('SIGTERM');
        try { await bounded(exited, 5_000, 'quota helper termination'); }
        catch {
          if (isRunning(child)) child.kill('SIGKILL');
          await bounded(exited, 5_000, 'quota helper kill');
        }
      }
      throw cause;
    } finally { tls.destroy(); }
  };
  try {
    try { await execute('docker', ['image', 'inspect', 'python:3.12-slim'], { timeout: 30_000 }); }
    catch { await execute('docker', ['pull', 'python:3.12-slim'], { timeout: 180_000, maxBuffer: 1024 * 1024 }); }
    helper = spawn('/usr/bin/python3', ['-B', resolve('ops/tests/agent_quota_durable_fixture.py')], { stdio: 'pipe' });
    const child = helper;
    child.stdin.on('error', () => undefined);
    let diagnostic = '';
    child.stderr.on('data', (bytes: Buffer) => { diagnostic = (diagnostic + bytes.toString()).slice(-8192); });
    const lines = createInterface({ input: child.stdout });
    const physical = await bounded(new Promise<{ policy_file: string; agents: QuotaAgentPlacement[] }>((resolvePhysical, reject) => {
      child.once('error', reject);
      child.once('exit', code => { reject(new Error(`quota Docker fixture exited: ${String(code)} ${diagnostic}`)); });
      lines.once('line', line => {
        try { resolvePhysical(JSON.parse(line) as { policy_file: string; agents: QuotaAgentPlacement[] }); }
        catch { reject(new Error('invalid quota Docker fixture setup')); }
        finally { lines.close(); }
      });
      child.stdin.write(JSON.stringify({ host_id: host.host_id, tenant_id: person.tenant_id,
        dynamic_account: options?.dynamicAccount }) + '\n');
    }), 240_000, 'quota Docker setup');
    const policy = JSON.parse(await readFile(physical.policy_file, 'utf8')) as { bundles: { codex: { directory: string } } };
    await writeFile(join(evidenceDirectory, 'docker-resources.json'), JSON.stringify(physical.agents.map(agent => ({
      container: agent.container_name, volumes: [`${agent.container_name}-state`, `${agent.container_name}-provider-profiles`],
    })), null, 2));
    const descriptors = join(policy.bundles.codex.directory, 'packages/adapter-sdk/dist/descriptors');
    const approvals: Record<string, string> = {};
    for (const harness of ['codex', 'openclaw']) approvals[harness] = createHash('sha256')
      .update(await readFile(join(descriptors, `${harness}.json`))).digest('hex');
    const approvalsFile = join(fixture.directory, 'agent-quota-approvals.json');
    await writeFile(approvalsFile, JSON.stringify(approvals), { mode: 0o600 });
    if (options?.dynamicAccount) {
      await pool.query(`INSERT INTO provider_accounts(id,provider,external_account_id,payer_tenant_id,credential_ref_kind,credential_ref,
        enabled,shared_with_pool,company_id,quota_identity_hash)
        VALUES($1,'codex',$1,$2,'env_path','CAUCE_TEST_DYNAMIC_ACCOUNT_PROFILE_PATH',true,false,$3,$4)`,
      [options.dynamicAccount, person.tenant_id, person.company_id, SYNTHETIC_READER_IDENTITY_HASH]);
    }
    for (const agent of physical.agents) {
      await pool.query(`INSERT INTO agents(tenant_id,alias,company_id,harness_id,host_id,runtime_mode,container_name,
        runtime_key,runtime_user,home_directory,state_directory,systemd_user,enabled,lifecycle_state,primary_account_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,true,'ready',$13)`,
      [agent.tenant_id, agent.alias, person.company_id, agent.harness_id, agent.host_id, agent.runtime_mode, agent.container_name,
        agent.runtime_key, agent.runtime_user, agent.home_directory, agent.state_directory, agent.systemd_user, agent.primary_account_id ?? null]);
      await pool.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES($1,'office',$2,'agent')", [agent.tenant_id, agent.alias]);
    }
    let executionGate: Promise<void> | undefined;
    const holdExecution = () => {
      if (executionGate) throw new Error('quota execution is already held');
      let release: () => void = () => undefined;
      executionGate = new Promise<void>(resolveGate => { release = resolveGate; });
      return () => { release(); executionGate = undefined; };
    };
    const executor = new AgentQuotaExecutor(new HostChannelAgentQuotaRepository(channel, host.host_id), {
      worker: `host-${host.host_id}`, host: host.host_id,
      perform: async (execution, signal) => {
        await executionGate;
        signal.throwIfAborted();
        return performAgentQuotaHostCommand({ python: '/usr/bin/python3',
          executable: resolve('ops/cli/fleet-executor.py'), policyFile: physical.policy_file, timeoutMs: 60_000 }, execution, signal);
      },
    });
    const docker = async (args: string[]) => {
      await execute('docker', args, { timeout: 30_000, maxBuffer: 1024 * 1024 });
    };
    const setReaderMode = async (agent: QuotaAgentPlacement, mode: 'normal' | 'invalid' | 'token_expired') => {
      if (!physical.agents.some(candidate => candidate.container_name === agent.container_name)) throw new Error('unowned quota container');
      const program = 'import json,pathlib,sys;p=pathlib.Path("/nonexistent/.codex/fixture.json");d=json.loads(p.read_text());'
        + 'd["mode"]=sys.argv[1];d["error"]="expired" if sys.argv[1]=="token_expired" else None;'
        + 'd["error_code"]="token_expired" if sys.argv[1]=="token_expired" else None;p.write_text(json.dumps(d))';
      await docker(['exec', '--user', 'nobody', agent.container_name, '/usr/local/bin/python3.12', '-B', '-c', program, mode]);
    };
    return { agents: physical.agents, approvalsFile, descriptors, executor, close, docker, setReaderMode, holdExecution,
      announce: () => channel.request('POST', `/v3/fleet/hosts/${host.host_id}/channel`, channelCapabilities()) };
  } catch (cause) {
    try { await close(); }
    catch (cleanupError) { throw new AggregateError([cause, cleanupError], 'quota setup and cleanup failed'); }
    throw cause;
  }
}
