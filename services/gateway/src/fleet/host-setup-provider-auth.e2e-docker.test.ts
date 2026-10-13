import { createHash, randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COMPUTER_RUNTIME, FIXTURE_DEVICE_CODE, FIXTURE_LOGIN_DONE, FIXTURE_PROVIDER_IDENTITY, docker, dockerInventory, enrollComputer,
  startComputerHarness, type ComputerHarness } from './host-computer.fixtures.js';
import { registerSetupOwner, type SetupOwnerSession } from './host-setup.fixtures.js';

const RESOURCE_PREFIX = `zz-canary-host-auth-${randomUUID().slice(0, 8)}`;
const COMPANY = 'authe2e'; const HOST = 'authe2e-server'; const ACCOUNT = 'host-auth-account';
let harness: ComputerHarness | undefined;
function computer() { if (!harness) throw new Error('computer harness absent'); return harness; }
interface Operation { status: string; version: number; error: unknown; steps: { name: string; status: string }[] }

/** The console provider terminal: the same session, ticket and WebSocket the browser uses. */
async function openTerminal(gatewayUrl: string, owner: SetupOwnerSession, sessionId: string, ticket: string) {
  const socket = new WebSocket(`${gatewayUrl.replace(/^http/u, 'ws')}/v3/console/provider-auth/sessions/${sessionId}/stream`,
    { origin: owner.origin, headers: { cookie: owner.cookie } });
  let output = '';
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => { socket.send(JSON.stringify({ type: 'auth', ticket })); });
    socket.on('message', (data, binary) => {
      const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
      if (binary) output += bytes.toString('utf8');
      else if ((JSON.parse(bytes.toString('utf8')) as { type?: string }).type === 'ready') resolve();
    });
    socket.once('close', (code, reason) => { reject(new Error(`provider terminal closed (${String(code)} ${reason.toString()})`)); });
    socket.once('error', reject);
  });
  return { output: () => output, type: (text: string) => { socket.send(Buffer.from(text), { binary: true }); }, close: () => { socket.close(); } };
}

describe('a computer prepared with setup logs its agents into the provider from the console', () => {
  let owner: SetupOwnerSession;
  beforeAll(async () => {
    const before = await dockerInventory(RESOURCE_PREFIX);
    expect(before).toEqual({ containers: '', volumes: '', images: '' });
    console.info('HOST_AUTH_DOCKER_BEFORE', RESOURCE_PREFIX, JSON.stringify(before));
    harness = await startComputerHarness({ prefix: RESOURCE_PREFIX, consoleOrigins: ['http://localhost'], providerLogin: true });
    owner = await registerSetupOwner(harness.app, COMPANY);
  }, 600_000);
  afterAll(async () => {
    const after = await harness?.close();
    console.info('HOST_AUTH_DOCKER_AFTER', RESOURCE_PREFIX, JSON.stringify(after));
    expect(after).toEqual({ containers: '', volumes: '', images: '' });
  }, 120_000);

  it('setup loads the served image, create awaits auth, console login, resume, succeeded and the agent answers its nonce', async () => {
    const { app, cli, onComputer, pool, gatewayUrl, installRoot, agentImage } = computer();
    expect((await onComputer(['docker', 'image', 'inspect', agentImage])).code).not.toBe(0);
    const unit = await enrollComputer(computer(), owner, COMPANY, HOST);
    expect(await docker(['image', 'inspect', '--format', '{{.Id}}', agentImage])).toBe(agentImage);
    const downloads = await pool.query<{ name: string }>(`SELECT metadata->>'name' AS name FROM audit_events
      WHERE action='fleet_host.setup.artifact' AND company_id=$1 ORDER BY metadata->>'name'`, [COMPANY]);
    expect(downloads.rows.map(row => row.name)).toEqual(['agent-image', 'fleet-ca', 'release']);
    const policy = JSON.parse((await onComputer(['cat', `${installRoot}/${COMPANY}/${HOST}/executor-policy.json`])).stdout) as {
      profile_templates: { command: string; command_sha256: string; login?: unknown }[] };
    const template = policy.profile_templates[0];
    expect(template?.command).toMatch(/^\/usr\/local\/bin\//u);
    expect(template?.login).toEqual({ method: 'device', command: [template?.command, 'login', '--device-auth'], sha256: template?.command_sha256 });
    const status = await cli(['status', '--install-root', installRoot]);
    expect(status.code, status.stdout + status.stderr).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ executor_ready: true, provider_auth: true });
    const authFile = `${installRoot}/${COMPANY}/${HOST}/provider-auth-policy.json`;
    expect((await onComputer(['stat', '-c', '%a %U', authFile, `${installRoot}/${COMPANY}/${HOST}/provider-login`])).stdout.trim().split('\n'))
      .toEqual(['600 cauce', '700 cauce']);
    expect((await onComputer(['cat', `/home/cauce/.config/systemd/user/${unit}`])).stdout).toContain(`CAUCE_FLEET_ENROLLED_AUTH_POLICY_FILE=${authFile}\n`);
    expect((await onComputer(['journalctl', '--user', '-u', unit, '--no-pager'])).stdout).not.toContain('Host provider authentication policy is unusable');

    const tenant = (await pool.query<{ tenant_id: string }>('SELECT tenant_id FROM console_users WHERE email=$1', [`${COMPANY}@example.test`])).rows[0]?.tenant_id;
    const room = tenant === undefined ? undefined
      : (await pool.query<{ id: string }>('SELECT id FROM rooms WHERE tenant_id=$1 AND enabled ORDER BY id', [tenant])).rows[0]?.id;
    if (!tenant || !room) throw new Error('registered company has no tenant or room');
    await pool.query(`INSERT INTO provider_accounts(id,provider,external_account_id,payer_tenant_id,credential_ref_kind,credential_ref,enabled)
      VALUES($3,'codex',$2,$1,'env_path','CAUCE_HOST_AUTH_PROFILE_PATH',true)`, [tenant, FIXTURE_PROVIDER_IDENTITY, ACCOUNT]);
    const runtimeKey = 'auth-agent'; const containerName = `${RESOURCE_PREFIX}-${runtimeKey}`;
    const created = await app.inject({ method: 'POST', url: '/v3/console/fleet/operations', headers: { ...owner }, payload: {
      kind: 'create', target: { resource: 'agent', tenant_id: tenant, alias: 'auth-worker' }, expected_revision: 0,
      idempotency_key: `${RESOURCE_PREFIX}-create`, parameters: { runtime_key: runtimeKey, harness_id: 'codex',
        primary_room_id: room, primary_account_id: ACCOUNT, memberships: [{ room_id: room, role: 'agent' }],
        placement: { host_id: HOST, mode: 'container', container_name: containerName, runtime_user: COMPUTER_RUNTIME.user,
          systemd_user: 'cauce', home_directory: COMPUTER_RUNTIME.home, state_directory: `${COMPUTER_RUNTIME.stateRoot}/${runtimeKey}` } } } });
    expect(created.statusCode, created.body).toBe(202);
    const operationId = created.json<{ operation_id: string }>().operation_id;
    const read = async (): Promise<Operation> => {
      const receipt = await app.inject({ method: 'GET', url: `/v3/console/fleet/operations/${operationId}`, headers: { ...owner } });
      expect(receipt.statusCode, receipt.body).toBe(200); return receipt.json<Operation>();
    };
    const settle = async (terminal: string[]): Promise<Operation> => {
      let operation = await read();
      for (let attempt = 0; attempt < 120 && !terminal.includes(operation.status); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 1000)); operation = await read();
      }
      const journal = operation.status === terminal[0] ? '' : (await onComputer(['journalctl', '--user', '-u', unit, '--no-pager', '-n', '80'])).stdout;
      expect(operation.status, JSON.stringify(operation.error) + journal).toBe(terminal[0]);
      return operation;
    };
    const waiting = await settle(['awaiting_auth', 'succeeded', 'failed']);
    expect(waiting.steps.find(step => step.name === 'authenticate')?.status).toBe('waiting');
    expect(await docker(['ps', '--format', '{{.Names}}', '--filter', `name=^/${containerName}$`])).toBe(containerName);

    const scope = await app.inject({ method: 'GET', url: `/v3/console/provider-auth/operations/${operationId}/scope`, headers: { ...owner } });
    expect(scope.statusCode, scope.body).toBe(200);
    expect(scope.json()).toMatchObject({ operation_id: operationId, provider_id: 'codex', account_id: ACCOUNT, host_id: HOST,
      harness_id: 'codex', runtime_user: COMPUTER_RUNTIME.user, profile_id: ACCOUNT });
    const started = await app.inject({ method: 'POST', url: '/v3/console/provider-auth/sessions', headers: { ...owner }, payload: scope.json() });
    expect(started.statusCode, started.body).toBe(202);
    const session = started.json<{ session_id: string; status: string; method: string }>();
    expect(session, started.body).toMatchObject({ status: 'awaiting_login', method: 'device' });
    const ticket = await app.inject({ method: 'POST', url: `/v3/console/provider-auth/sessions/${session.session_id}/ticket`,
      headers: { ...owner }, payload: {} });
    expect(ticket.statusCode, ticket.body).toBe(200);
    const terminal = await openTerminal(gatewayUrl, owner, session.session_id, ticket.json<{ ticket: string }>().ticket);
    try {
      await expect.poll(terminal.output, { timeout: 30_000 }).toContain(`enter the code ${FIXTURE_DEVICE_CODE}`);
      terminal.type(`${FIXTURE_DEVICE_CODE}\n`);
      await expect.poll(terminal.output, { timeout: 30_000 }).toContain(`${FIXTURE_LOGIN_DONE} ${FIXTURE_PROVIDER_IDENTITY}`);
      const verified = await app.inject({ method: 'POST', url: `/v3/console/provider-auth/sessions/${session.session_id}/verify`,
        headers: { ...owner }, payload: {} });
      expect(verified.statusCode, verified.body).toBe(200);
      expect(verified.json()).toMatchObject({ status: 'authenticated', error: null, cleanup_pending: false });
    } finally { terminal.close(); }
    const profile = `${COMPUTER_RUNTIME.home}/.cauce-profiles/${runtimeKey}/${createHash('sha256').update(ACCOUNT).digest('hex')}/auth.json`;
    expect(await docker(['exec', '--user', COMPUTER_RUNTIME.user, containerName, '/bin/cat', profile])).toContain(FIXTURE_PROVIDER_IDENTITY);

    const pending = await read();
    expect(pending.status).toBe('awaiting_auth');
    const resumed = await app.inject({ method: 'POST', url: `/v3/console/fleet/operations/${operationId}/resume`, headers: { ...owner },
      payload: { expected_version: pending.version } });
    expect(resumed.statusCode, resumed.body).toBeLessThan(300);
    await settle(['succeeded', 'failed', 'awaiting_auth', 'cancelled']);
    const probes = await pool.query<{ phase: string; state: string; reply: string | null; nonce: string }>(`SELECT DISTINCT ON (metadata->'bootstrap_probe'->'probe'->>'probe_id')
      metadata->'bootstrap_probe'->'probe'->>'phase' AS phase, metadata->'bootstrap_probe'->>'state' AS state,
      metadata->'bootstrap_probe'->'proof'->>'reply' AS reply, metadata->'bootstrap_probe'->'probe'->>'nonce' AS nonce
      FROM fleet_operation_events WHERE operation_id=$1 AND metadata ? 'bootstrap_probe'
      ORDER BY metadata->'bootstrap_probe'->'probe'->>'probe_id', created_at DESC`, [operationId]);
    for (const phase of ['bootstrap', 'normal']) expect(probes.rows.some(probe => probe.phase === phase && probe.state === 'succeeded'
      && probe.reply === `CAUCE_BOOTSTRAP_${probe.nonce}`), JSON.stringify(probes.rows)).toBe(true);
    const events = JSON.stringify((await pool.query('SELECT metadata FROM fleet_operation_events WHERE operation_id=$1', [operationId])).rows);
    expect(events).toContain('"provider_auth_status"');
    expect(events).not.toContain(FIXTURE_DEVICE_CODE);
    console.info('HOST_AUTH_CREATE', JSON.stringify({ operation_id: operationId, status: 'succeeded', container: containerName,
      provider_login: 'console-terminal', session_id: session.session_id, bootstrap_nonce_verified: true, normal_nonce_verified: true,
      agent_image: agentImage, image_source: 'gateway-served docker save, loaded by setup', login_cli: template?.command }));
  }, 420_000);
});
