import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COMPUTER_RUNTIME, FIXTURE_PROVIDER_IDENTITY, docker, dockerInventory, fleetCapability, hostEnrollments, startComputerHarness,
  type ComputerHarness } from './host-computer.fixtures.js';
import { inviteSetupHost, registerSetupOwner, type SetupOwnerSession } from './host-setup.fixtures.js';

const RESOURCE_PREFIX = `zz-canary-host-setup-${randomUUID().slice(0, 8)}`;
let harness: ComputerHarness | undefined;
function computer() { if (!harness) throw new Error('computer harness absent'); return harness; }

describe('a clean computer prepares its executor without the platform administrator', () => {
  let ownerA: SetupOwnerSession;
  beforeAll(async () => {
    const before = await dockerInventory(RESOURCE_PREFIX);
    expect(before).toEqual({ containers: '', volumes: '', images: '' });
    console.info('HOST_SETUP_DOCKER_BEFORE', RESOURCE_PREFIX, JSON.stringify(before));
    harness = await startComputerHarness({ prefix: RESOURCE_PREFIX, consoleOrigins: ['http://localhost'] });
    ownerA = await registerSetupOwner(harness.app, 'setupe2e');
  }, 600_000);
  afterAll(async () => {
    const after = await harness?.close();
    console.info('HOST_SETUP_DOCKER_AFTER', RESOURCE_PREFIX, JSON.stringify(after));
    expect(after).toEqual({ containers: '', volumes: '', images: '' });
  }, 120_000);

  it('enrolls with the console invitation, installs the user service and reports executor_ready', async () => {
    const { app, cli, onComputer, pool, packager, container, gatewayUrl, installRoot } = computer();
    const invitation = await inviteSetupHost(app, ownerA, 'setupe2e-laptop');
    expect(invitation.setup_signer_fingerprint).toBe(packager.signerFingerprint);
    const enrolled = await cli(['enroll', '--gateway', gatewayUrl, '--invitation-stdin'], JSON.stringify(invitation));
    expect(enrolled.code, enrolled.stderr).toBe(0);
    expect(JSON.parse(enrolled.stdout)).toMatchObject({ host_id: 'setupe2e-laptop', state: 'enrolled', executor_ready: false });
    const prepared = await cli(['setup', '--install-root', installRoot]);
    expect(prepared.code, prepared.stderr).toBe(0);
    expect(JSON.parse(prepared.stdout)).toMatchObject({ host_id: 'setupe2e-laptop', service_active: true, linger: true, templates: 1 });
    const unit = 'cauce-v3-host-executor-setupe2e-setupe2e-laptop.service';
    let ready = false;
    for (let attempt = 0; attempt < 90 && !ready; attempt++) {
      ready = (await hostEnrollments(computer(), ownerA)).enrollments.some(row => row.host_id === 'setupe2e-laptop' && row.executor_ready);
      if (!ready) await new Promise(resolve => setTimeout(resolve, 1000));
    }
    const journal = ready ? '' : (await onComputer(['journalctl', '--user', '-u', unit, '--no-pager', '-n', '50'])).stdout;
    expect(ready, journal).toBe(true);
    const status = await cli(['status', '--install-root', installRoot]);
    expect(status.code, status.stdout + status.stderr).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ executor_ready: true, service_active: true, templates: 1 });
    expect(await fleetCapability(computer(), ownerA)).toMatchObject({ available: true, placements: [{ host_id: 'setupe2e-laptop' }] });
    expect((await pool.query('SELECT 1 FROM platform_admins')).rowCount).toBe(0);
    expect((await onComputer(['systemctl', '--user', 'is-active', unit])).stdout.trim()).toBe('active');
    expect(await docker(['ps', '--format', '{{.Names}}', '--filter', `name=^/${container}$`])).toBe(container);
    const tenant = (await pool.query<{ tenant_id: string }>('SELECT tenant_id FROM console_users WHERE email=$1', ['setupe2e@example.test'])).rows[0]?.tenant_id;
    if (!tenant) throw new Error('registered company has no tenant');
    const room = (await pool.query<{ id: string }>('SELECT id FROM rooms WHERE tenant_id=$1 AND enabled ORDER BY id', [tenant])).rows[0]?.id;
    if (!room) throw new Error('registered company has no room');
    await pool.query(`INSERT INTO provider_accounts(id,provider,external_account_id,payer_tenant_id,credential_ref_kind,credential_ref,enabled)
      VALUES('host-setup-account','codex',$2,$1,'env_path','CAUCE_HOST_SETUP_PROFILE_PATH',true)`, [tenant, FIXTURE_PROVIDER_IDENTITY]);
    const runtimeKey = 'setup-agent'; const containerName = `${RESOURCE_PREFIX}-${runtimeKey}`;
    const response = await app.inject({ method: 'POST', url: '/v3/console/fleet/operations', headers: { ...ownerA }, payload: {
      kind: 'create', target: { resource: 'agent', tenant_id: tenant, alias: 'setup-worker' }, expected_revision: 0,
      idempotency_key: `${RESOURCE_PREFIX}-create`, parameters: { runtime_key: runtimeKey, harness_id: 'codex',
        primary_room_id: room, primary_account_id: 'host-setup-account', memberships: [{ room_id: room, role: 'agent' }],
        placement: { host_id: 'setupe2e-laptop', mode: 'container', container_name: containerName, runtime_user: COMPUTER_RUNTIME.user,
          systemd_user: 'cauce', home_directory: COMPUTER_RUNTIME.home, state_directory: `${COMPUTER_RUNTIME.stateRoot}/${runtimeKey}` } } } });
    expect(response.statusCode, response.body).toBe(202);
    const operationId = response.json<{ operation_id: string }>().operation_id;
    let operation: { status: string; error: unknown } = { status: 'queued', error: null };
    for (let attempt = 0; attempt < 90 && !['succeeded', 'failed', 'awaiting_auth'].includes(operation.status); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      const receipt = await app.inject({ method: 'GET', url: `/v3/console/fleet/operations/${operationId}`, headers: { ...ownerA } });
      expect(receipt.statusCode, receipt.body).toBe(200); operation = receipt.json<typeof operation>();
    }
    const operationJournal = operation.status === 'succeeded' ? '' : (await onComputer(['journalctl', '--user', '-u', unit, '--no-pager', '-n', '60'])).stdout;
    expect(operation.status, JSON.stringify(operation.error) + operationJournal).toBe('succeeded');
    const observed = await docker(['ps', '--format', '{{.Names}}', '--filter', `name=^/${containerName}$`]);
    expect(observed).toBe(containerName);
    const probes = await pool.query<{ phase: string; state: string; reply: string | null; nonce: string }>(`SELECT DISTINCT ON (metadata->'bootstrap_probe'->'probe'->>'probe_id')
      metadata->'bootstrap_probe'->'probe'->>'phase' AS phase, metadata->'bootstrap_probe'->>'state' AS state,
      metadata->'bootstrap_probe'->'proof'->>'reply' AS reply, metadata->'bootstrap_probe'->'probe'->>'nonce' AS nonce
      FROM fleet_operation_events WHERE operation_id=$1 AND metadata ? 'bootstrap_probe'
      ORDER BY metadata->'bootstrap_probe'->'probe'->>'probe_id', created_at DESC`, [operationId]);
    for (const phase of ['bootstrap', 'normal']) expect(probes.rows.some(probe => probe.phase === phase && probe.state === 'succeeded'
      && probe.reply === `CAUCE_BOOTSTRAP_${probe.nonce}`)).toBe(true);
    console.info('HOST_SETUP_CREATE', JSON.stringify({ operation_id: operationId, status: operation.status, container: observed,
      bootstrap_nonce_verified: true, normal_nonce_verified: true, provider: 'pinned-fixture-cli', runtime: 'real-sdk-bootstrap' }));
  }, 300_000);

  it('another company neither sees that computer nor lets it ask for its setup package', async () => {
    const { app, onComputer, pool } = computer();
    const ownerB = await registerSetupOwner(app, 'setupe2eb');
    await inviteSetupHost(app, ownerB, 'setupe2eb-desk');
    expect((await hostEnrollments(computer(), ownerB)).enrollments.map(row => row.host_id)).toEqual(['setupe2eb-desk']);
    expect((await fleetCapability(computer(), ownerB)).placements.map(row => row.host_id)).not.toContain('setupe2e-laptop');
    const forged = 'import pathlib,sys\nsys.path.insert(0,"/opt/cauce-cli")\nfrom host_channel_client import HostChannel,HostFailure,post_json\n'
      + 'channel=HostChannel(pathlib.Path("/home/cauce/.local/state/cauce-v3/hosts/setupe2e/setupe2e-laptop"))\n'
      + 'path="/v3/fleet/hosts/setupe2eb-desk/setup"\ntry:\n post_json(channel.gateway,path,channel.packet("POST",path,{"action":"package"}))\n'
      + ' print("accepted")\nexcept HostFailure as error:\n print(error)\n';
    const attempt = await onComputer(['python3', '-c', forged]);
    expect(attempt.stdout, attempt.stderr).toContain('HTTP 403');
    expect((await pool.query("SELECT 1 FROM audit_events WHERE action='fleet_host.setup.package' AND company_id='setupe2eb'")).rowCount).toBe(0);
  }, 120_000);
});
