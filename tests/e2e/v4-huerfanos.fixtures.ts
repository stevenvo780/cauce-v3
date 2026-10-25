import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { expect } from 'vitest';
import { companyRevision, CauceRepository, withTransaction } from '@cauce/store';
import { PublishMessageSchema, sha256Hex, type FleetOperationRequest } from '@cauce/protocol';
import { COMPUTER_RUNTIME, docker, dockerInventory, enrollComputer, FIXTURE_PROVIDER_IDENTITY, startComputerHarness,
  type ComputerHarness, type CommandResult } from '../../services/gateway/src/fleet/host-computer.fixtures.js';
import { registerSetupOwner, type SetupOwnerSession } from '../../services/gateway/src/fleet/host-setup.fixtures.js';
import { cancelDeployRuntime } from './v4-fleet-cancel-deploy.runtime.js';

export const OWNER = 'h10b-huerfanos-retirada-1025';
export const RUN = randomUUID().slice(0, 8);
export const PREFIX = `zz-canary-${OWNER}-${RUN}`;
export const EVIDENCE = join(process.cwd(), '.delegados/v4/recibos', OWNER, `e2e-${RUN}`);
export const NATIVE_ALIAS = `zz-canary-${RUN}-native`;
export const LIVE_ALIAS = `zz-canary-${RUN}-live`;
export const LIVE_KEY = `live-${RUN}`;
export interface NativeManifest {
  key: string; unit: string; files: string[]; state: string; control: string; adoption: string;
  home: string; user: string; host: string; active: string; enabled: string;
}
export interface NativeObservation {
  properties: { LoadState?: string; ActiveState?: string; MainPID?: string };
  paths: Record<string, boolean>; enabled_link: boolean; adoption_policy_preserved: boolean;
}
export interface OrphansFixture {
  computer: ComputerHarness; session: SetupOwnerSession; company: string; tenant: string; host: string; room: string;
  directory: string; native: NativeManifest; liveContainer: string; retainedVolume: string; retainedNetwork: { name: string; id: string };
  request(method: string, path: string, body?: unknown): Promise<Record<string, unknown>>;
  trackImage(tag: string, id: string): void;
  trackNetwork(name: string, id: string): void;
  close(): Promise<void>;
}
export interface AgentPlanItem { id: string; kind: 'agent'; request: FleetOperationRequest; preview_sha256: string }
export interface ResourcePlanItem {
  id: string; kind: 'resource'; resource_type: string; name: string; reason: string;
  scope: { company_id: string; tenant_id?: string; host_id?: string };
}
export interface TestVolumePlanItem {
  id: string; kind: 'test_volume'; name: string; scope: { company_id: string }; location: { kind: 'lab_socket' };
  pin: { daemon_id: string; volume_sha256: string | null; preview_sha256: string | null };
}
export interface TestDockerPlanItem {
  id: string; kind: 'test_container' | 'test_network' | 'test_image'; name: string;
  scope: { company_id: string }; location: { kind: 'lab_socket' };
  pin: { daemon_id: string; resource_sha256: string | null; preview_sha256: string | null };
}
export interface TestContextPlanItem {
  id: string; kind: 'test_context'; company_id: string; action: 'retire' | 'restore';
  pin: { head: string | null; preview_sha256: string | null }; retirement_commit?: string;
}
export interface OrphansPlan {
  version: 1; company_id: string; expected_revision: number;
  items: (AgentPlanItem | ResourcePlanItem | TestVolumePlanItem | TestDockerPlanItem | TestContextPlanItem)[];
}

export async function nativeObservation(fixture: OrphansFixture): Promise<NativeObservation> {
  const source = await readFile(join(process.cwd(), 'tests/e2e/v4-purga-nativos-systemd.fixture.py'), 'utf8');
  const result = await fixture.computer.onComputer(['python3', '-I', '-B', '-c', source, 'observe', JSON.stringify(fixture.native)]);
  expect(result.code, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as NativeObservation;
}

export async function waitOperation(fixture: OrphansFixture, id: string): Promise<Record<string, unknown>> {
  let operation: Record<string, unknown> = {};
  await expect.poll(async () => {
    operation = await fixture.request('GET', `/v3/console/fleet/operations/${id}`);
    return ['succeeded', 'failed', 'cancelled', 'awaiting_auth'].includes(String(operation.status));
  }, { timeout: 240_000, interval: 500 }).toBe(true);
  expect(operation.status, JSON.stringify(operation.error)).toBe('succeeded');
  return operation;
}

export async function startOrphansFixture(options: { contextRepository?: string } = {}): Promise<OrphansFixture> {
  await mkdir(EVIDENCE, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(tmpdir(), 'cauce-h10-'));
  let computer: ComputerHarness;
  const previousRepository = process.env.CAUCE_CONTEXT_REPOSITORY_ROOT;
  if (options.contextRepository !== undefined) process.env.CAUCE_CONTEXT_REPOSITORY_ROOT = options.contextRepository;
  try {
    computer = await startComputerHarness({ prefix: PREFIX, consoleOrigins: ['http://localhost'], workRoot: '/datos',
      resourceOwner: OWNER, runtimeBundle: cancelDeployRuntime,
      extraSourceFiles: ['packages/protocol/src/context-retirement.ts', 'packages/store/src/context-git-retirement.ts',
        'packages/store/src/context-retirement.ts', 'services/gateway/src/console/context-repository/retirement-routes.ts',
        'services/gateway/src/fleet/recovery-host-command.ts', 'services/gateway/src/fleet/agent-recovery-preflight.ts',
        'packages/store/src/context-version-reevaluation.ts'] });
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  finally {
    if (previousRepository === undefined) delete process.env.CAUCE_CONTEXT_REPOSITORY_ROOT;
    else process.env.CAUCE_CONTEXT_REPOSITORY_ROOT = previousRepository;
  }
  const company = `zz-canary-h10-${RUN}`;
  const host = `${company}-pc`;
  let retainedNetwork: { name: string; id: string } | undefined;
  const images = new Map<string, string>(), networks = new Map<string, string>();
  const close = async () => {
    const failures: unknown[] = [];
    try { await computer.close(); } catch (error) { failures.push(error); }
    for (const [name, id] of networks) {
      try {
        const current = await docker(['network', 'ls', '--no-trunc', '--filter', `name=^${name}$`, '--format', '{{.ID}}']);
        if (current === '') continue;
        expect(current).toBe(id);
        expect(await docker(['network', 'inspect', '--format', '{{index .Labels "cauce.e2e.owner"}}', id])).toBe(OWNER);
        await docker(['network', 'rm', id]);
      } catch (error) { failures.push(error); }
    }
    for (const [tag, id] of images) {
      try {
        const current = await docker(['images', '-q', '--no-trunc', '--filter', `reference=${tag}`]);
        if (current === '') continue;
        expect(current).toBe(id);
        expect(await docker(['image', 'inspect', '--format', '{{index .Config.Labels "cauce.e2e.owner"}}', id])).toBe(OWNER);
        expect(await docker(['ps', '-a', '--filter', `ancestor=${id}`, '--format', '{{.ID}}'])).toBe('');
        await docker(['image', 'rm', id]);
      } catch (error) { failures.push(error); }
    }
    try {
      const inventory = await dockerInventory(PREFIX);
      await writeFile(join(EVIDENCE, 'cleanup.json'), JSON.stringify(inventory, null, 2) + '\n', { mode: 0o600 });
      expect(inventory).toEqual({ containers: '', volumes: '', images: '' });
    } catch (error) { failures.push(error); }
    try { await rm(directory, { recursive: true, force: true }); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'orphan fixture cleanup incomplete');
  };
  try {
    const session = await registerSetupOwner(computer.app, company);
    await enrollComputer(computer, session, company, host);
    const tenant = (await computer.pool.query<{ tenant_id: string }>('SELECT tenant_id FROM console_users WHERE email=$1', [`${company}@example.test`])).rows[0]?.tenant_id;
    if (!tenant) throw new Error('orphan fixture company has no tenant');
    const room = (await computer.pool.query<{ id: string }>('SELECT id FROM rooms WHERE tenant_id=$1 AND enabled ORDER BY id', [tenant])).rows[0]?.id;
    if (!room) throw new Error('orphan fixture company has no room');
    const request = async (method: string, path: string, body?: unknown): Promise<Record<string, unknown>> => {
      const response = await fetch(computer.gatewayUrl + path, { method,
        headers: { origin: session.origin, cookie: session.cookie, 'x-csrf-token': session['x-csrf-token'], 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error' });
      const result = await response.json() as Record<string, unknown>;
      if (!response.ok) throw new Error(`orphan fixture API ${method} ${path} returned ${String(response.status)}: ${JSON.stringify(result)}`);
      return result;
    };
    const source = await readFile(join(process.cwd(), 'tests/e2e/v4-purga-nativos-systemd.fixture.py'), 'utf8');
    const prepared = await computer.onComputer(['python3', '-I', '-B', '-c', source, 'prepare', computer.installRoot,
      tenant, NATIVE_ALIAS, `zz-canary-h10-native-${RUN}`, 'managed']);
    expect(prepared.code, prepared.stderr).toBe(0);
    const native = JSON.parse(prepared.stdout) as NativeManifest;
    await computer.pool.query(`INSERT INTO agents(tenant_id,alias,harness_id,display_name,enabled,lifecycle_state,
      company_id,runtime_key,host_id,runtime_mode,container_name,runtime_user,home_directory,state_directory,systemd_user)
      VALUES($1,$2,'codex',$2,true,'ready',$3,$4,$5,'native',$6,$7,$8,$9,$7)`,
    [tenant, NATIVE_ALIAS, company, native.key, host, `host:${host}`, native.user, native.home, native.state]);
    await computer.pool.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES($1,$2,$3,'agent')", [tenant, room, NATIVE_ALIAS]);
    await computer.pool.query('UPDATE agents SET primary_room_id=$3 WHERE tenant_id=$1 AND alias=$2', [tenant, NATIVE_ALIAS, room]);
    const restarted = await computer.onComputer(['systemctl', '--user', 'restart', `cauce-v3-host-executor-${company}-${host}.service`]);
    expect(restarted.code, restarted.stderr).toBe(0);
    const account = `zz-h10-${RUN}`;
    await computer.pool.query(`INSERT INTO provider_accounts(id,provider,external_account_id,payer_tenant_id,credential_ref_kind,credential_ref,enabled)
      VALUES($1,'codex',$2,$3,'env_path','CAUCE_H10_FIXTURE_PROFILE_PATH',true)`, [account, FIXTURE_PROVIDER_IDENTITY, tenant]);
    await computer.pool.query("INSERT INTO agents(tenant_id,alias,harness_id,enabled) VALUES($1,$2,'codex',false)", [tenant, `sender${RUN}`]);
    await computer.pool.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES($1,$2,$3,'agent')", [tenant, room, `sender${RUN}`]);
    const liveContainer = `${PREFIX}-${LIVE_KEY}`;
    const create: FleetOperationRequest = { kind: 'create', target: { resource: 'agent', tenant_id: tenant, alias: LIVE_ALIAS },
      expected_revision: await withTransaction(computer.pool, client => companyRevision(client, company)), idempotency_key: `h10-create-${RUN}`,
      parameters: { runtime_key: LIVE_KEY, harness_id: 'codex', primary_room_id: room, primary_account_id: account,
        memberships: [{ room_id: room, role: 'agent' }], placement: { host_id: host, mode: 'container', container_name: liveContainer,
          runtime_user: COMPUTER_RUNTIME.user, systemd_user: 'cauce', home_directory: COMPUTER_RUNTIME.home,
          state_directory: `${COMPUTER_RUNTIME.stateRoot}/${LIVE_KEY}` } } };
    const queued = await request('POST', '/v3/console/fleet/operations', create);
    if (typeof queued.operation_id !== 'string') throw new Error('live reference create operation absent');
    const retainedVolume = `${PREFIX}-praxis-retained-state`;
    await docker(['volume', 'create', '--label', `cauce.e2e.owner=${OWNER}`, '--label', 'cauce.fleet.tenant=Hospital',
      '--label', 'cauce.fleet.alias=teseo', '--label', 'cauce.fleet.host=server2-praxis', retainedVolume]);
    const networkName = `${PREFIX}-retained-network`;
    const networkId = await docker(['network', 'create', '--internal', '--label', `cauce.e2e.owner=${OWNER}`, networkName]);
    retainedNetwork = { name: networkName, id: networkId };
    networks.set(networkName, networkId);
    const fixture: OrphansFixture = { computer, session, company, tenant, host, room, directory, native, liveContainer,
      retainedVolume, retainedNetwork, request, close,
      trackImage: (tag, id) => { images.set(tag, id); }, trackNetwork: (name, id) => { networks.set(name, id); } };
    await waitOperation(fixture, queued.operation_id);
    return fixture;
  } catch (error) { await close(); throw error; }
}

export async function agentPlan(fixture: OrphansFixture, kind: 'retire' | 'purge'): Promise<OrphansPlan> {
  const revision = await withTransaction(fixture.computer.pool, client => companyRevision(client, fixture.company));
  const request: FleetOperationRequest = { kind, target: { resource: 'agent', tenant_id: fixture.tenant, alias: NATIVE_ALIAS },
    expected_revision: revision, idempotency_key: `h10-${kind}-${RUN}`, parameters: kind === 'purge' ? { confirm_alias: NATIVE_ALIAS } : {} };
  const preview = await fixture.request('POST', '/v3/console/fleet/operations/preview', request);
  expect(preview.can_apply, JSON.stringify(preview)).toBe(true);
  return { version: 1, company_id: fixture.company, expected_revision: revision,
    items: [{ id: `native-${kind}`, kind: 'agent', request, preview_sha256: sha256Hex(preview) }] };
}

export async function runCleanup(fixture: OrphansFixture, plan: OrphansPlan, name: string,
  mode?: '--simular' | '--aplicar', withAuthority = true): Promise<CommandResult> {
  const planFile = join(fixture.directory, `${name}.json`);
  await writeFile(planFile, JSON.stringify(plan), { mode: 0o600 });
  await chmod(planFile, 0o600);
  const receipt = join(fixture.directory, `${name}-receipt.json`);
  const args = [join(process.cwd(), '.delegados/v4/limpiar-huerfanos.sh'), '--ops-root', join(process.cwd(), 'ops'),
    '--plan', planFile, '--recibo', receipt, ...(withAuthority ? ['--authority-fd', '3'] : []), ...(mode ? [mode] : [])];
  return new Promise((resolve, reject) => {
    const child = spawn('bash', args, { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    if (!child.stdout || !child.stderr) { child.kill(); reject(new Error('cleanup output descriptors unavailable')); return; }
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.once('error', reject);
    child.once('close', code => { resolve({ code: code ?? 1, stdout, stderr }); });
    const authority = child.stdio[3];
    if (!(authority instanceof Writable)) { child.kill(); reject(new Error('cleanup authority descriptor unavailable')); return; }
    authority.on('error', () => undefined);
    authority.end(withAuthority ? JSON.stringify({ version: 1, gateway: fixture.computer.gatewayUrl, origin: fixture.session.origin,
      cookie: fixture.session.cookie, csrf_token: fixture.session['x-csrf-token'] }) : '');
  });
}

export async function liveReply(fixture: OrphansFixture): Promise<unknown> {
  const marker = `FLEET-DEPLOY-DELIVERY-${randomUUID()}`;
  const message = await new CauceRepository(fixture.computer.pool).publish(PublishMessageSchema.parse({
    request_id: randomUUID(), trace_id: randomUUID(), tenant_id: fixture.tenant, room_id: fixture.room, actor_alias: `sender${RUN}`,
    recipients: [{ tenant_id: fixture.tenant, alias: LIVE_ALIAS }], body: { type: 'text', text: marker }, idempotency_key: randomUUID(),
  }));
  let row: { status: string; reply: string | null } | undefined;
  await expect.poll(async () => {
    row = (await fixture.computer.pool.query<NonNullable<typeof row>>(
      "SELECT status,result->'output'->>'reply' AS reply FROM deliveries WHERE message_id=$1 AND recipient_alias=$2",
      [message.message_id, LIVE_ALIAS])).rows[0];
    return row?.status;
  }, { timeout: 90_000, interval: 500 }).toBe('done');
  expect(row?.reply).toBe(`DELIVERED:${marker}`);
  return { message_id: message.message_id, ...row };
}
