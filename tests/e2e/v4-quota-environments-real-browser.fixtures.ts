import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { HostEnrollmentRepository, hostEnrollmentMessage, lockCompanyAuthority } from '@cauce/store';
import type { V4Person } from './v4-console-real-browser.helpers.js';
import type { startConsoleFunctionalFixture } from './console-functional-browser.fixtures.js';

type ConsoleFixture = Awaited<ReturnType<typeof startConsoleFunctionalFixture>>;
type DatabasePool = ConsoleFixture['database']['pool'];
export type QuotaAction = 'create' | 'authenticate' | 'query' | 'update_cli' | 'delete';
const execute = promisify(execFile);
const repository = process.cwd();
const executor = join(repository, 'ops/cli/fleet-executor.py');
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
export interface QuotaDockerImage {
  image: string; tag: string; versions: Record<string, string>; bundle_digest: string;
  bundles: Record<string, { directory: string; digest: string; executable: string; executable_sha256: string;
    argv: string[]; descriptor_sha256: string }>;
}
export interface QuotaOperationReceipt {
  id: string; environment_id: string; action: QuotaAction; status: string;
  result: Record<string, unknown>; error_code: string | null; worker_id: string | null;
}
interface QuotaEnvironmentIdentity {
  id: string; company_id: string; account_id: string; host_id: string; provider: string; container_name: string;
}
export interface QuotaContainerObservation {
  present: boolean; container_name: string; volume_present: boolean; image?: string; user?: string;
  readonly_rootfs?: boolean; privileged?: boolean; network?: string; memory?: number; pids_limit?: number;
  cap_drop?: string[]; cap_add?: string[]; security_opt?: string[]; tmpfs?: Record<string, string>;
  mounts?: { destination: string; source: string; type: string; writable: boolean }[];
}

async function command(filename: string, args: string[], input?: unknown, timeout = 180_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(filename, args, { cwd: repository, timeout, maxBuffer: 1_048_576,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', PYTHONDONTWRITEBYTECODE: '1' } }, (error, stdout) => {
      if (error) reject(new Error(`quota fixture command failed: ${filename}; exit=${String(error.code ?? 'unknown')}`));
      else resolve(stdout.trim());
    });
    if (input !== undefined) child.stdin?.end(JSON.stringify(input));
  });
}

export async function prepareQuotaDockerImage(evidenceDir: string): Promise<QuotaDockerImage> {
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
  const output = await command('/usr/bin/python3', [join(repository, 'ops/tests/test_quota_environment_docker.py'),
    '--prepare-image', '--evidence-dir', evidenceDir], undefined, 900_000);
  const metadata = JSON.parse(output) as QuotaDockerImage;
  if (!/^sha256:[a-f0-9]{64}$/u.test(metadata.image) || !/^zz-canary-quota-[a-f0-9]{32}:local$/u.test(metadata.tag)
      || !/^sha256:[a-f0-9]{64}$/u.test(metadata.bundle_digest) || !metadata.versions || !metadata.bundles
      || ['claude','codex','grok'].some(provider => !metadata.versions[provider] || !metadata.bundles[provider]
        || metadata.bundles[provider]?.digest !== metadata.bundle_digest)) {
    await removeQuotaDockerImage(evidenceDir);
    throw new Error('real quota image metadata is incomplete');
  }
  return metadata;
}

export async function removeQuotaDockerImage(evidenceDir: string): Promise<void> {
  await command('/usr/bin/python3', [join(repository, 'ops/tests/test_quota_environment_docker.py'),
    '--remove-image', '--evidence-dir', evidenceDir]);
}

async function evidence(directory: string, name: string, value: unknown): Promise<void> {
  await writeFile(join(directory, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function publicReceipt(receipt: QuotaOperationReceipt): Record<string, unknown> {
  const input = receipt.result ?? {};
  const fields = ['runtime_verified','container_name','stopped_verified','profile_removed_verified','cli_updated_verified',
    'cli_version','captured_at','observation_status','authenticated_verified','account_id'];
  const result = Object.fromEntries(fields.filter(key => input[key] !== undefined).map(key => [key, input[key]]));
  const report = input.provider_report as { provider?: string; ok?: boolean; available?: boolean;
    effective_remaining_percent?: number; windows?: Record<string, unknown>[] } | undefined;
  if (report) result.provider_report = { provider: report.provider, ok: report.ok, available: report.available,
    effective_remaining_percent: report.effective_remaining_percent, windows: report.windows?.map(window =>
      Object.fromEntries(['group_key','window_key','used_percent','remaining_percent','used_units','limit_units','window_minutes',
        'reset_at','status','family','model','observed_at'].filter(key => window[key] !== undefined).map(key => [key, window[key]]))) };
  return { id: receipt.id, environment_id: receipt.environment_id, action: receipt.action, status: receipt.status,
    error_code: receipt.error_code, worker_id: receipt.worker_id, result };
}

async function stopHost(child: ChildProcess): Promise<void> {
  const exited = (timeout: number): Promise<boolean> => {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
    return new Promise(resolve => {
      const done = () => { clearTimeout(timer); resolve(true); };
      const timer = setTimeout(() => { child.off('exit', done); resolve(false); }, timeout);
      child.once('exit', done);
    });
  };
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  if (await exited(10_000)) return;
  child.kill('SIGKILL');
  if (!await exited(5_000)) throw new Error('owned quota host did not stop');
}

export async function startQuotaDockerHost(fixture: ConsoleFixture, owner: V4Person, hostId: string,
  image: QuotaDockerImage, evidenceDir: string) {
  const pool = fixture.database.pool;
  const person = (await pool.query<{ id: string; company_id: string; tenant_id: string; alias: string }>(
    'SELECT id::text,company_id,tenant_id,alias FROM console_users WHERE email=$1', [owner.email])).rows[0];
  if (!person) throw new Error('quota canary owner was not registered');
  const directory = await mkdtemp('/var/tmp/cauce-quota-browser-');
  const { policy, policyFile, receipt, identityDirectory } = await (async () => {
    try {
      const roots: Record<string, string> = Object.fromEntries(await Promise.all(['state','runtime','pki','tokens','identities'].map(async name => {
        const path = join(directory, name); await mkdir(path, { mode: 0o700 }); return [name, path] as const;
      })));
      await mkdir(join(roots.runtime ?? '', 'quota-login'), { mode: 0o700 });
      await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
      const policy = { schemaVersion: 1, host_id: hostId, executor_user: userInfo().username, roots,
        native: [], containers: {}, profiles: {}, hooks: {}, bundles: image.bundles,
        quota_environments: { image: image.image, network: 'bridge', providers: ['claude','codex','grok'] } };
      const policyFile = join(directory, 'policy.json');
      await writeFile(policyFile, JSON.stringify(policy), { mode: 0o600 });
      const keys = generateKeyPairSync('ed25519');
      const enrollment = new HostEnrollmentRepository(pool);
      const invitation = await enrollment.invite(client => lockCompanyAuthority(client,
        { tenant: person.tenant_id, alias: person.alias, humanId: person.id }), { host_id: hostId, display_name: hostId });
      const receipt = await enrollment.claim(invitation.enrollment_id, {
        invitation_token: invitation.invitation_token,
        public_key: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
        proof: sign(null, Buffer.from(hostEnrollmentMessage(invitation)), keys.privateKey).toString('base64'),
      });
      const identityDirectory = roots.identities ?? '';
      await writeFile(join(identityDirectory, 'identity.json'), JSON.stringify({ ...receipt, gateway: fixture.baseUrl }), { mode: 0o600 });
      await writeFile(join(identityDirectory, 'private.pem'), keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
      return { policy, policyFile, receipt, identityDirectory };
    } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  })();
  const args = ['--import', 'tsx', join(repository, 'services/gateway/src/fleet/main.ts')];
  const child = spawn(process.execPath, args, { cwd: repository, env: {
    PATH: process.env.PATH ?? '/usr/bin:/bin', NODE_ENV: 'test',
    XDG_CONFIG_HOME: join(directory, 'config'), XDG_DATA_HOME: join(directory, 'data'),
    NODE_EXTRA_CA_CERTS: fixture.pki.ca.cert, CAUCE_FLEET_PROJECT_ROOT: repository,
    CAUCE_FLEET_HOST: hostId, CAUCE_FLEET_WORKER_ID: `host-${hostId}`,
    CAUCE_FLEET_IDENTITY_DIRECTORY: identityDirectory, CAUCE_FLEET_PYTHON: '/usr/bin/python3',
    CAUCE_FLEET_EXECUTABLE: executor, CAUCE_FLEET_POLICY_FILE: policyFile,
    CAUCE_FLEET_POLL_MS: '100', CAUCE_FLEET_LEASE_MS: '120000', CAUCE_FLEET_COMMAND_TIMEOUT_MS: '300000',
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  let processError = false;
  child.on('error', () => { processError = true; });
  child.stdout?.resume(); child.stderr?.resume();
  const environment = async (id: string): Promise<QuotaEnvironmentIdentity> => {
    const row = (await pool.query<QuotaEnvironmentIdentity>(`SELECT id,company_id,account_id,host_id,provider,container_name
      FROM quota_environments WHERE id=$1 AND company_id=$2 AND host_id=$3`, [id, person.company_id, hostId])).rows[0];
    if (!row || row.container_name !== `cauce-quota-${id.replaceAll('-', '')}`) throw new Error('quota environment is outside the owned fixture');
    return row;
  };
  const host = {
    async waitOperation(environmentId: string, action: QuotaAction,
      options: { status?: 'done' | 'awaiting_auth' | 'failed'; afterId?: string; timeoutMs?: number } = {}): Promise<QuotaOperationReceipt> {
      await environment(environmentId);
      const deadline = Date.now() + (options.timeoutMs ?? 300_000);
      let recorded: string | undefined;
      while (Date.now() < deadline) {
        if (processError || child.exitCode !== null || child.signalCode !== null) throw new Error('owned enrolled quota host exited');
        const raw = (await pool.query<Omit<QuotaOperationReceipt, 'result'> & { result: Record<string, unknown> | null }>(`SELECT id,environment_id,action,status,result,error_code,worker_id
          FROM quota_environment_operations WHERE environment_id=$1 AND company_id=$2 AND action=$3
            AND ($4::uuid IS NULL OR created_at>(SELECT created_at FROM quota_environment_operations WHERE id=$4))
          ORDER BY created_at DESC,id DESC LIMIT 1`, [environmentId, person.company_id, action, options.afterId ?? null])).rows[0];
        const row = raw === undefined ? undefined : { ...raw, result: raw.result ?? {} };
        if (row && ['done','awaiting_auth','failed'].includes(row.status)) {
          if (recorded !== `${row.id}:${row.status}`) {
            const identity = (await pool.query<{ quota_identity_hash: string | null }>(`SELECT account.quota_identity_hash
              FROM provider_accounts account JOIN quota_environments environment
                ON account.id=environment.account_id AND account.company_id=environment.company_id
              WHERE environment.id=$1 AND environment.company_id=$2 AND environment.host_id=$3`,
            [environmentId, person.company_id, hostId])).rows[0];
            await evidence(evidenceDir, `operation-${row.id}-${row.status}`, { ...publicReceipt(row),
              provider_identity_hash: identity?.quota_identity_hash ?? null });
            recorded = `${row.id}:${row.status}`;
          }
          if (row.status === (options.status ?? 'done')) return row;
          if (row.status === 'failed') throw new Error(`real quota ${action} failed: ${row.error_code ?? 'unknown'}`);
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error(`real quota ${action} did not reach ${options.status ?? 'done'}`);
    },
    async inspect(environmentId: string): Promise<QuotaContainerObservation> {
      const row = await environment(environmentId);
      const names = (await command('/usr/bin/docker', ['ps', '-a', '--format', '{{.Names}}'])).split('\n');
      const volumes = (await command('/usr/bin/docker', ['volume', 'ls', '--format', '{{.Name}}'])).split('\n');
      let observed: QuotaContainerObservation = { present: names.includes(row.container_name), container_name: row.container_name,
        volume_present: volumes.includes(`${row.container_name}-profile`) };
      if (observed.present) {
        const data = JSON.parse(await command('/usr/bin/docker', ['inspect', row.container_name])) as {
          Image: string; Config: { User: string; Labels: Record<string, string> }; HostConfig: { ReadonlyRootfs: boolean;
            Privileged: boolean; NetworkMode: string; Memory: number; PidsLimit: number; CapDrop: string[]; CapAdd: string[];
            SecurityOpt: string[]; Tmpfs: Record<string, string> }; Mounts: { Destination: string; Source: string; Type: string; RW: boolean }[];
        }[];
        const container = data[0];
        if (!container || container.Config.Labels['cauce.quota.company'] !== person.company_id
          || container.Config.Labels['cauce.quota.host'] !== hostId || container.Config.Labels['cauce.quota.environment'] !== environmentId) {
          throw new Error('quota container ownership differs from its fixture');
        }
        observed = { ...observed, image: container.Image, user: container.Config.User,
          readonly_rootfs: container.HostConfig.ReadonlyRootfs, privileged: container.HostConfig.Privileged,
          network: container.HostConfig.NetworkMode, memory: container.HostConfig.Memory, pids_limit: container.HostConfig.PidsLimit,
          cap_drop: container.HostConfig.CapDrop, cap_add: container.HostConfig.CapAdd, security_opt: container.HostConfig.SecurityOpt,
          tmpfs: container.HostConfig.Tmpfs, mounts: container.Mounts.map(mount => ({ destination: mount.Destination,
            source: mount.Source, type: mount.Type, writable: mount.RW })) };
      }
      await evidence(evidenceDir, `inspect-${environmentId}-${observed.present ? 'running' : 'absent'}`, observed);
      return observed;
    },
    async close(): Promise<void> {
      const failures: unknown[] = [];
      await stopHost(child).catch(error => { failures.push(error); });
      const rows = (await pool.query<QuotaEnvironmentIdentity>(`SELECT id,company_id,account_id,host_id,provider,container_name
        FROM quota_environments WHERE company_id=$1 AND host_id=$2`, [person.company_id, hostId])).rows;
      for (const row of rows) {
        try {
          const result = JSON.parse(await command('/usr/bin/python3', ['-B', executor, '--policy', policyFile, '--quota'],
            { operation_id: randomUUID(), action: 'delete', consent: false, environment: await environment(row.id) })) as unknown;
          await evidence(evidenceDir, `cleanup-${row.id}`, result);
          const observed = await host.inspect(row.id);
          if (observed.present || observed.volume_present) throw new Error('owned quota resource remained after cleanup');
        } catch (error) { failures.push(error); }
      }
      if (failures.length === 0) await rm(directory, { recursive: true, force: true });
      else throw new AggregateError(failures, 'owned quota fixture cleanup was incomplete');
    },
  };
  try {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (processError || child.exitCode !== null || child.signalCode !== null) throw new Error('owned enrolled quota host failed to start');
      const row = (await pool.query<{ capabilities: Record<string, unknown> }>(`SELECT capabilities FROM fleet_host_identities
        WHERE host_id=$1 AND company_id=$2 AND capabilities_seen_at>now()-interval '120 seconds'`, [hostId, person.company_id])).rows[0];
      if (row?.capabilities.quota_executor === true) {
        const sha = (await execute('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: repository })).stdout.trim();
        const sources = Object.fromEntries(await Promise.all(['tests/e2e/v4-quota-environments-real-browser.fixtures.ts',
          'tests/e2e/v4-quota-environments-real-browser.test.ts','services/gateway/src/fleet/main.ts',
          'services/gateway/src/fleet/enrolled-main.ts','services/gateway/src/fleet/quota-host-command.ts',
          'services/gateway/src/fleet/quota-executor.ts','ops/cli/quota_runtime.py','ops/cuotas/Dockerfile'].map(async filename =>
          [filename, digest(await readFile(join(repository, filename)))] as const)));
        await evidence(evidenceDir, 'host', { sha, command: [process.execPath, ...args], company_id: person.company_id, host_id: hostId,
          identity_hash: receipt.key_fingerprint, policy_sha256: digest(JSON.stringify(policy)), image: image.image,
          versions: image.versions, bundle_digest: image.bundle_digest, sources, capabilities: row.capabilities });
        return host;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('owned enrolled quota host did not publish real capabilities');
  } catch (error) { await host.close(); throw error; }
}

export function quotaCanaryPerson(label: string, run: string, password?: string): V4Person {
  return {
    email: `zz-canary-${label}-${run}@example.test`,
    name: `zz-canary-${label}-${run}`,
    password: password ?? `Canary-${run}-${label}-passphrase-42`,
    company: { name: `zz-canary-${label}-${run}`, slug: `zz-canary-${label}-${run}` },
  };
}

export async function seedQuotaCompanyAdmin(pool: DatabasePool, owner: V4Person, run: string): Promise<V4Person> {
  const ownerRow = (await pool.query<{ id: string; tenant_id: string }>(
    'SELECT id::text,tenant_id FROM console_users WHERE email=$1', [owner.email])).rows[0];
  if (!ownerRow) throw new Error('quota canary owner was not registered');

  const admin = quotaCanaryPerson('admin', run, owner.password);
  const alias = `zz-canary-admin-${run}`;
  const runtimeUser = `zz-canary-${run}`;
  const adminRow = (await pool.query<{ id: string }>(`INSERT INTO console_users
    (email,email_normalized,password_hash,display_name,role,tenant_id,alias,company_id)
    SELECT $1,lower($1),owner.password_hash,$2,'operator',owner.tenant_id,$3,owner.company_id
      FROM console_users owner WHERE owner.id=$4 RETURNING id::text`,
  [admin.email, admin.name, alias, ownerRow.id])).rows[0];
  if (!adminRow) throw new Error('quota canary administrator was not created');

  await pool.query(`INSERT INTO agents
    (tenant_id,alias,harness_id,display_name,enabled,container_name,runtime_user,home_directory,state_directory,company_id)
    SELECT tenant_id,$2,'codex',$2,true,$3,$4,$5,$6,company_id FROM console_users WHERE id=$1`,
  [adminRow.id, alias, `zz-canary-agent-${run}`, runtimeUser, `/srv/zz-canary-${run}`, `/srv/zz-canary-${run}/state`]);
  await pool.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES($1,'office',$2,'operator')", [ownerRow.tenant_id, alias]);
  await pool.query(`INSERT INTO human_tenant_memberships
    (human_id,tenant_id,actor_alias,permissions,enabled,company_id)
    SELECT $1,$2,$3,ARRAY['route','read','control','notify']::text[],true,company_id
      FROM console_users WHERE id=$1`, [adminRow.id, ownerRow.tenant_id, alias]);
  await pool.query(`INSERT INTO company_admins(company_id,human_id,role,source,granted_by)
    SELECT company_id,$1,'admin','import',$2 FROM console_users WHERE id=$2`, [adminRow.id, ownerRow.id]);
  return admin;
}
