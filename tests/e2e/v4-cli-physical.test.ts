import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMPUTER_RUNTIME, FIXTURE_PROVIDER_IDENTITY, docker, dockerInventory, hostEnrollments, startComputerHarness,
  type ComputerHarness } from '../../services/gateway/src/fleet/host-computer.fixtures.js';
import { inviteSetupHost, registerSetupOwner } from '../../services/gateway/src/fleet/host-setup.fixtures.js';
import { runCli } from './v4-rupturas-terminal-cli.fixtures.js';
import { checkedJson, PHYSICAL_OWNER, physicalReceipt, startCliContextApplication } from './v4-cli-physical.helpers.js';

interface Operation { id: string; status: string; kind: string; error: unknown; steps: { name: string; status: string }[] }
interface Inventory { revision: number; agents: { alias: string; display_name: string | null }[]; operations: Operation[] }
interface RuntimeObservation {
  present: boolean; running: boolean; labels: Record<string, string>; credentials: boolean | null;
  processes: { model: string | null; effort: string | null; bootstrap: string | null }[];
}
const run = randomUUID().slice(0, 8);
const prefix = `zz-canary-${PHYSICAL_OWNER}-physical-${run}`;

async function observeRuntime(container: string, key: string): Promise<RuntimeObservation> {
  const names = await docker(['ps', '-a', '--format', '{{.Names}}', '--filter', `name=^/${container}$`]);
  if (!names) return { present: false, running: false, labels: {}, processes: [], credentials: false };
  expect(names).toBe(container);
  const running = await docker(['inspect', '--format', '{{.State.Running}}', container]) === 'true';
  const labels = JSON.parse(await docker(['inspect', '--format', '{{json .Config.Labels}}', container])) as Record<string, string>;
  const probe = `import json,os,pathlib,sys
processes=[]
for pid in filter(str.isdigit,os.listdir('/proc')):
 try:
  env=dict(item.decode(errors='replace').split('=',1) for item in open('/proc/'+pid+'/environ','rb').read().split(b'\\0') if b'=' in item)
  if env.get('CAUCE_RUNTIME_KEY')==sys.argv[1]:
   processes.append({'model':env.get('CAUCE_MODEL_ID'),'effort':env.get('CAUCE_REASONING_EFFORT'),'bootstrap':env.get('CAUCE_BOOTSTRAP')})
 except OSError: pass
print(json.dumps({'processes':processes,'credentials':(pathlib.Path('/run/cauce-credentials')/sys.argv[1]).exists()}))
`;
  const observed = running ? JSON.parse(await docker(['exec', '--user', COMPUTER_RUNTIME.user, container, 'python3', '-c', probe, key])) as
    Pick<RuntimeObservation, 'processes' | 'credentials'> : { processes: [], credentials: null };
  return { present: true, running, labels, ...observed };
}

async function waitOperation(computer: ComputerHarness, id: string): Promise<Operation> {
  let latest: Operation | undefined;
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    const row = (await computer.pool.query<Operation>(`SELECT id,kind,status,error FROM fleet_operations WHERE id=$1`, [id])).rows[0];
    if (row) latest = row;
    if (latest && ['succeeded', 'failed', 'cancelled', 'awaiting_auth'].includes(latest.status)) {
      expect(latest.status, JSON.stringify(latest.error)).toBe('succeeded');
      return latest;
    }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new Error(`physical CLI operation expired: ${JSON.stringify(latest)}`);
}

describe.sequential('CLI physical execution and context application in the real laboratory', () => {
  it('applies context through the real broker and SDK and verifies its native files and fenced consumption', async () => {
    const context = await startCliContextApplication(run);
    try {
      const marker = `CLI_CONTEXT_${run.toUpperCase()}`;
      const input = join(context.directory, 'context.json');
      await writeFile(input, JSON.stringify([{ path: 'context/mission.md', content: marker }]), { mode: 0o600 });
      const edit = checkedJson(await runCli([
        ...context.args, 'edit', '--expected-version', '0', '--input', input])) as { version: number; applied_version: number; digest: string };
      expect(edit).toMatchObject({ version: 1, applied_version: 0 });
      expect(checkedJson(await runCli([...context.args, 'apply']))).toMatchObject({ desired_version: 1,
        operation: { version: 1 } });
      await expect.poll(async () => (await context.pool.query<{ applied_version: string }>(`SELECT applied_version::text
        FROM agent_context_state WHERE tenant_id=$1 AND alias=$2`, [context.tenant, context.alias])).rows[0]?.applied_version,
      { timeout: 90_000 }).toBe('1');
      expect(checkedJson(await runCli([...context.args, 'status']))).toMatchObject({ desired_version: 1, applied_version: 1, digest: edit.digest });
      expect(await readFile(join(context.space, 'context/mission.md'), 'utf8')).toBe(marker);
      expect(await readFile(join(context.space, 'AGENTS.md'), 'utf8')).toContain(marker);
      const witnesses = (await readFile(context.witness, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as unknown);
      expect(witnesses).toEqual([expect.objectContaining({ version: 1, digest: edit.digest, content: marker, native_contains_current: true })]);
      const consumed = await context.pool.query<{ status: string; ack_applied: boolean; matching_fence: boolean; adopted: boolean; witnessed: boolean }>(
        `SELECT delivery.status,ack.applied AS ack_applied,
          ack.claim_token=delivery.claim_token AND ack.epoch=delivery.consumer_epoch AS matching_fence,
          delivery.result->'context_adoption'->>'digest'=$3 AS adopted,
          delivery.result->'harness_consumption_v1'->>'evidence_kind'='canonical_final_response' AS witnessed
        FROM deliveries delivery JOIN messages message ON message.id=delivery.message_id
        JOIN LATERAL (SELECT applied,claim_token,epoch FROM delivery_acks
          WHERE delivery_id=delivery.id AND status='done' ORDER BY id DESC LIMIT 1) ack ON true
        WHERE delivery.recipient_tenant=$1 AND delivery.recipient_alias=$2 AND message.auth_channel='context-broker'`,
      [context.tenant, context.alias, edit.digest]);
      expect(consumed.rows).toEqual([{ status: 'done', ack_applied: true, matching_fence: true, adopted: true, witnessed: true }]);
      const diagnostics = context.diagnostics();
      expect(context.secrets.some(secret => diagnostics.includes(secret))).toBe(false);
      await physicalReceipt('context-apply', { run, postgres: context.databaseId, gateway: 'real-https', runtime: 'real-sdk-codex',
        provider: 'synthetic-kernel', version: 1, applied_version: 1, digest: edit.digest, materialized: true,
        native_document_contains_current: true, fenced_consumption: consumed.rows });
    } finally { await context.close(); }
  }, 300_000);

  it('installs a signed executor and creates, edits and retires a CLI space with persistent Docker effects', async () => {
    let computer: ComputerHarness | undefined;
    let workDirectory = '';
    try {
      workDirectory = await mkdtemp('/datos/zz-canary-');
      await chmod(workDirectory, 0o755);
      computer = await startComputerHarness({ prefix, consoleOrigins: ['http://localhost'], workRoot: workDirectory, resourceOwner: PHYSICAL_OWNER });
      const current = computer;
      const company = `zz-physical-${run}`;
      const host = `${company}-pc`;
      const session = await registerSetupOwner(current.app, company);
      const invitation = await inviteSetupHost(current.app, session, host);
      const hostCli = (args: string[], input?: string) => current.onComputer(['bash', '/opt/cauce-cli/cauce', 'hosts', ...args], input);
      expect(checkedJson(await hostCli(['enroll', '--gateway', current.gatewayUrl, '--invitation-stdin'], JSON.stringify(invitation))))
        .toMatchObject({ host_id: host, executor_ready: false });
      const dryRun = checkedJson(await hostCli(['setup', '--install-root', current.installRoot, '--dry-run'])) as { release: string; policy_file: string; unit: string };
      expect(dryRun).toMatchObject({ host_id: host, dry_run: true, release_installed: false, image_present: false });
      const untouched = await current.onComputer(['python3', '-c',
        'import json,pathlib,sys; print(json.dumps({"untouched":all(not pathlib.Path(path).exists() for path in sys.argv[1:])}))',
        dryRun.release, dryRun.policy_file, dryRun.unit]);
      expect(checkedJson(untouched)).toEqual({ untouched: true });
      const installed = await hostCli(['setup', '--install-root', current.installRoot]);
      if (installed.code !== 0) {
        const diagnostic = await current.onComputer(['python3', `${dryRun.release}/ops/cli/fleet-executor.py`, '--policy', dryRun.policy_file, '--capabilities']);
        await physicalReceipt('host-setup-failure', { run, code: installed.code, diagnostic_code: diagnostic.code,
          missing_module: /ModuleNotFoundError: No module named '([a-z_]+)'/u.exec(diagnostic.stderr)?.[1] ?? null });
      }
      expect(checkedJson(installed))
        .toMatchObject({ service_active: true, release_installed: true, templates: 1, image_loaded: true });
      await expect.poll(async () => (await hostEnrollments(current, session)).enrollments.some(row => row.host_id === host && row.executor_ready),
        { timeout: 90_000 }).toBe(true);
      expect(checkedJson(await hostCli(['status', '--install-root', current.installRoot])))
        .toMatchObject({ executor_ready: true, service_active: true, templates: 1 });
      expect(checkedJson(await hostCli(['setup', '--install-root', current.installRoot])))
        .toMatchObject({ image_present: true, image_loaded: false, policy_changed: false });
      await physicalReceipt('hosts-setup', { run, host, dry_run_without_installation: true, signed_release_installed: true,
        docker_image_loaded: true, service_active: true, executor_ready: true, repeated_without_changes: true });

      const tenant = (await current.pool.query<{ tenant_id: string }>('SELECT tenant_id FROM console_users WHERE email=$1', [`${company}@example.test`])).rows[0]?.tenant_id;
      if (!tenant) throw new Error('registered physical company has no tenant');
      const room = (await current.pool.query<{ id: string }>('SELECT id FROM rooms WHERE tenant_id=$1 AND enabled ORDER BY id LIMIT 1', [tenant])).rows[0]?.id;
      if (!room) throw new Error('registered physical company has no room');
      const account = `zz-account-${run}`;
      await current.pool.query(`INSERT INTO provider_accounts(id,provider,external_account_id,payer_tenant_id,credential_ref_kind,credential_ref,enabled)
        VALUES($1,'codex',$2,$3,'env_path','CAUCE_PHYSICAL_FIXTURE_PROFILE_PATH',true)`, [account, FIXTURE_PROVIDER_IDENTITY, tenant]);
      const sessionFile = `/home/cauce/physical-${run}.session`;
      const sessionWritten = await current.onComputer(['python3', '-c', 'import os,sys; f=os.open(sys.argv[1],os.O_WRONLY|os.O_CREAT|os.O_EXCL,384); os.write(f,sys.stdin.buffer.read()); os.close(f)', sessionFile],
        JSON.stringify({ gateway: current.gatewayUrl, origin: session.origin, cookie: session.cookie, csrf_token: session['x-csrf-token'] }));
      expect(sessionWritten.code, sessionWritten.stderr).toBe(0);
      const spaces = async <T>(operation: string, args: string[] = []) => checkedJson(await current.onComputer([
        'bash', '/opt/cauce-cli/cauce', 'spaces', operation, '--json', '--tenant', tenant, '--session-file', sessionFile, ...args])) as T;
      const alias = `physical${run}`;
      const runtimeKey = `physical-${run}`;
      const containerName = `${prefix}-${runtimeKey}`;
      const parameters = { runtime_key: runtimeKey, harness_id: 'codex', display_name: 'Synthetic physical space',
        primary_room_id: room, primary_account_id: account, memberships: [{ room_id: room, role: 'agent' }],
        placement: { host_id: host, mode: 'container', container_name: containerName, runtime_user: COMPUTER_RUNTIME.user,
          systemd_user: 'cauce', home_directory: COMPUTER_RUNTIME.home, state_directory: `${COMPUTER_RUNTIME.stateRoot}/${runtimeKey}` } };
      const operations: { operation: string; id: string; status: string }[] = [];
      for (const operation of ['create', 'edit', 'retire']) {
        const inventory = await spaces<Inventory>('list');
        const inputFile = `/home/cauce/physical-${run}-${operation}.json`;
        if (operation !== 'retire') {
          const written = await current.onComputer(['python3', '-c',
            'import os,sys; f=os.open(sys.argv[1],os.O_WRONLY|os.O_CREAT|os.O_EXCL,384); os.write(f,sys.stdin.buffer.read()); os.close(f)', inputFile],
          JSON.stringify({ ...parameters, ...(operation === 'edit' ? { model_id: 'gpt-5.5', reasoning_effort: 'high' } : {}) }));
          expect(written.code, written.stderr).toBe(0);
        }
        const args = ['--alias', alias, '--expected-revision', String(inventory.revision), '--idempotency-key', `${prefix}-${operation}`,
          ...(operation === 'retire' ? [] : ['--input', inputFile])];
        expect(await spaces(operation, args)).toMatchObject({ state: 'preview', preview: { can_apply: true } });
        const accepted = await spaces<{ operation: Operation }>(operation, [...args, '--apply']);
        const done = await waitOperation(current, accepted.operation.id);
        expect((await spaces<{ operation: Operation }>(operation, [...args, '--apply'])).operation.id).toBe(done.id);
        const observed = await spaces<Inventory>('list', ['--alias', alias]);
        expect(observed.operations).toEqual(expect.arrayContaining([expect.objectContaining({ id: done.id, status: 'succeeded' })]));
        const runtime = await observeRuntime(containerName, runtimeKey);
        if (runtime.present) expect(runtime.labels).toMatchObject({ 'cauce.fleet.alias': alias, 'cauce.fleet.runtime_key': runtimeKey,
          'cauce.fleet.tenant': tenant, 'cauce.fleet.host': host });
        if (operation === 'retire') {
          const row: unknown = (await current.pool.query('SELECT enabled,lifecycle_state,retired_at IS NOT NULL AS retired FROM agents WHERE tenant_id=$1 AND alias=$2', [tenant, alias])).rows[0];
          expect(row).toEqual({ enabled: false, lifecycle_state: 'retired', retired: true });
          const probe = await current.onComputer(['systemctl', '--user', 'is-active', `cauce-v3-container-${runtimeKey}.service`]);
          expect(probe.stdout.trim()).not.toBe('active');
          expect(runtime).toMatchObject({ processes: [], credentials: false });
        } else {
          expect(runtime).toMatchObject({ present: true, running: true, credentials: true });
          expect(runtime.processes.length).toBeGreaterThan(0);
          if (operation === 'edit') expect(runtime.processes.every(process => process.model === 'gpt-5.5' && process.effort === 'high'
            && process.bootstrap === '0')).toBe(true);
          const state: unknown = (await current.pool.query('SELECT enabled,lifecycle_state,model_id,reasoning_effort FROM agents WHERE tenant_id=$1 AND alias=$2', [tenant, alias])).rows[0];
          expect(state).toMatchObject({ enabled: true, lifecycle_state: 'ready', ...(operation === 'edit' ? { model_id: 'gpt-5.5', reasoning_effort: 'high' } : {}) });
        }
        operations.push({ operation, id: done.id, status: done.status });
        await physicalReceipt('spaces-cycle', { run, container: containerName, operations, runtime, physical_effect_verified: true });
      }
    } catch (error) {
      await physicalReceipt('physical-failure', { run,
        after: await dockerInventory(prefix),
        error: error instanceof Error && error.message.includes("No such file or directory: '/usr/bin/docker'")
          ? "host-release: [Errno 2] No such file or directory: '/usr/bin/docker'" : 'physical CLI failed; see suite log' });
      throw error;
    } finally {
      try {
        if (computer) {
          const after = await computer.close();
          await physicalReceipt('cleanup', { run, prefix, after });
          expect(after).toEqual({ containers: '', volumes: '', images: '' });
        }
      } finally { if (workDirectory) await rm(workDirectory, { recursive: true, force: true }); }
    }
  }, 1_200_000);
});
