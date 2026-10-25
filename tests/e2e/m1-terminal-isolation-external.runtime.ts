import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { request } from 'node:https';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { CauceRepository } from '@cauce/store';
import type { ExternalResponse } from '../../services/gateway/src/security/route-isolation-external-client.js';
import { routingAuthority } from '../../services/gateway/src/terminal/authority.js';
import { deriveAliasKey } from '../../services/gateway/src/terminal/tickets.js';
import { dockerExecInput, type RealPtyFixture, type RealPtyGatewayContext } from './real-pty-agent.fixtures.js';
import { connectTerminalWire, type TerminalWireClient } from './terminal-authority-vertical.pty.js';
import { initializeTerminalTmux } from './v4-terminal-runtime.fixtures.js';

export const OWNER = 'm1-aislamiento-terminal-1025';
const execute = promisify(execFile);
export type Side = 'a' | 'b';
export interface PublicTarget { side: Side; company: string; tenant: string; alias: string; human: string }
interface Target extends PublicTarget { container: string; containerId: string; child?: ChildProcess; wire?: TerminalWireClient }
export interface RelayRequest {
  method: 'POST'; path: string; json: unknown;
  identity: 'valid' | 'no_certificate' | 'wrong_certificate' | 'wrong_bearer';
}
export interface AttachRequest { side: Side; sessionId: string; ticket: string; authorityProof: string }

export class TerminalIsolationRuntime {
  private readonly targets: Target[] = [];
  private runId: string | undefined;
  private lastClosedRunId: string | undefined;
  stage = 'idle';
  readonly proofs: Record<string, unknown>[] = [];
  constructor(private readonly fixture: RealPtyFixture, private readonly context: RealPtyGatewayContext) {}

  async prepare(runId: string, sides: PublicTarget[]): Promise<{ ready: true }> {
    assert.match(runId, /^[a-z0-9]{4,16}$/u);
    assert.equal(this.targets.length, 0);
    assert.equal(sides.length, 2);
    assert.deepEqual(sides.map(side => side.side).sort(), ['a', 'b']);
    const databaseId = this.fixture.database.container.getId();
    const database = await execute('docker', ['inspect', '--format',
      '{{.Id}} {{index .Config.Labels "cauce.e2e.owner"}} {{.State.Running}}', databaseId]);
    assert.equal(database.stdout.trim(), `${databaseId} ${OWNER} true`);
    this.runId = runId;
    const registryPath = join(this.context.directory, 'agent-registry.json');
    const registry = JSON.parse(await readFile(registryPath, 'utf8')) as { version: number; agents: Record<string, unknown>[] };
    for (const side of sides) {
      this.stage = `validate-${side.side}`;
      assert.equal(side.company, `zz-canary-${runId}-${side.side}`);
      assert.equal(side.alias, 'owner');
      const registered = await this.registeredTarget(side);
      assert.equal(registered.enabled, false);
      const otherAgents = await this.otherAgents(side);
      const name = `m1-${runId}-${side.side}`;
      this.stage = `certificate-${side.side}`;
      await writeFile(join(this.context.directory, `${name}.cnf`), 'extendedKeyUsage=clientAuth\n', { mode: 0o600 });
      await execute('openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=${name}`,
        '-keyout', `${name}.key`, '-out', `${name}.csr`], { cwd: this.context.directory, timeout: 30_000 });
      await chmod(join(this.context.directory, `${name}.key`), 0o600);
      await execute('openssl', ['x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.crt', '-CAkey', 'ca.key',
        '-CAcreateserial', '-out', `${name}.crt`, '-days', '1', '-sha256', '-extfile', `${name}.cnf`],
      { cwd: this.context.directory, timeout: 30_000 });
      const certificate = await readFile(join(this.context.directory, `${name}.crt`), 'utf8');
      registry.agents.push({ fingerprint_sha256: new X509Certificate(certificate).fingerprint256.replaceAll(':', '').toLowerCase(),
        tenant_id: side.tenant, alias: side.alias, expires_at: new Date(Date.now() + 1_800_000).toISOString() });
      await writeFile(registryPath, JSON.stringify(registry), { mode: 0o600 });
      const container = `zz-canary-${OWNER}-${side.side}-${randomUUID().slice(0, 8)}`;
      this.stage = `container-${side.side}`;
      const started = await execute('docker', ['run', '--rm', '--detach', '--name', container,
        '--label', `cauce.e2e.owner=${OWNER}`, '--network', 'host', '--user', 'node', '--read-only',
        '--memory', '256m', '--cpus', '1', '--pids-limit', '128',
        '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=32m,mode=1777',
        '--tmpfs', '/home/node:rw,nosuid,nodev,noexec,size=32m,mode=0700,uid=1000,gid=1000',
        '--entrypoint', 'sh', this.fixture.agentImage, '-lc', 'sleep 900'], { timeout: 30_000 });
      const containerId = started.stdout.trim();
      const runtime: Target = { ...side, container, containerId };
      this.targets.push(runtime);
      const socket = `m1-${runId}-${side.side}`;
      this.stage = `tmux-${side.side}`;
      await initializeTerminalTmux(container, socket, side.alias);
      await this.context.pool.query(`UPDATE agents SET container_name=$4,runtime_user='node',home_directory='/home/node',
        state_directory='/home/node/.cauce',harness_id='codex' WHERE tenant_id=$1 AND alias=$2 AND company_id=$3`,
      [side.tenant, side.alias, side.company, containerId]);
      const bundle = { tenant_id: side.tenant, alias: side.alias, container_id: containerId, generation: `g${randomUUID()}`,
        image_id: this.fixture.agentImageId, runtime_user: 'node', runtime_uid: 1000, runtime_gid: 1000,
        home: '/home/node', shell_candidates: ['/bin/sh'], harness: 'codex', tmux_tui: { path: '/usr/bin/tmux', socket },
        relay_host: '127.0.0.1', relay_port: this.fixture.relayPorts.agent, relay_server_name: 'localhost',
        alias_key_hex: deriveAliasKey(this.context.terminalConfig.ticketKey, side.tenant, side.alias).toString('hex'),
        client_cert_pem: certificate, client_key_pem: await readFile(join(this.context.directory, `${name}.key`), 'utf8'),
        ca_pem: await readFile(join(this.context.directory, 'ca.crt'), 'utf8'), agent_version: 'm1-real-pty', runtime_facts: {} };
      this.stage = `bundle-${side.side}`;
      await dockerExecInput(['exec', '-i', '--user', 'node', container, 'sh', '-c', 'umask 077; cat > /tmp/pty-bundle.json'], JSON.stringify(bundle));
      await execute('docker', ['exec', '--user', '0', container, 'sh', '-c',
        'chown node:node /tmp/pty-bundle.json && chmod 0400 /tmp/pty-bundle.json'], { timeout: 15_000 });
      const child = spawn('docker', ['exec', '--user', 'node', '--env', 'PYTHONPATH=/opt/cauce-pty-agent', container,
        'python3', '-m', 'cauce_pty_agent', '--bundle', '/tmp/pty-bundle.json'], { stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.resume(); child.stderr.resume();
      runtime.child = child;
      this.stage = `presence-${side.side}`;
      const deadline = Date.now() + 30_000;
      while (this.context.registry.state(side.tenant, side.alias, Date.now()) !== 'online') {
        if (Date.now() >= deadline || child.exitCode !== null) throw new Error('owned company PTY did not publish real relay presence');
        await delay(100);
      }
      this.stage = `initial-state-${side.side}`;
      const inspected = await execute('docker', ['inspect', '--format',
        '{{.Id}} {{index .Config.Labels "cauce.e2e.owner"}} {{.Config.User}} {{.State.Running}} {{.Image}}', container]);
      assert.equal(inspected.stdout.trim(), `${containerId} ${OWNER} node true ${this.fixture.agentImageId}`);
      const seeded = await this.context.pool.query(`UPDATE agents target SET enabled=true WHERE tenant_id=$1 AND alias=$2 AND company_id=$3
        AND NOT enabled AND retired_at IS NULL AND purged_at IS NULL AND container_name=$5
        AND EXISTS(SELECT 1 FROM console_users person JOIN companies company ON company.id=person.company_id
          JOIN tenants tenant ON tenant.id=person.tenant_id WHERE person.id=$4 AND person.company_id=$3
          AND person.tenant_id=$1 AND person.alias=$2 AND person.active AND company.enabled AND company.retired_at IS NULL
          AND tenant.company_id=$3 AND tenant.enabled AND tenant.retired_at IS NULL AND tenant.purged_at IS NULL)`,
      [side.tenant, side.alias, side.company, side.human, containerId]);
      assert.equal(seeded.rowCount, 1);
      assert.equal((await this.registeredTarget(side)).enabled, true);
      assert.deepEqual(await this.otherAgents(side), otherAgents);
      const visible = await new CauceRepository(this.context.pool).authorizeAgentTarget(side.tenant, side.alias, side.tenant, side.alias, 'control');
      assert.ok(visible);
      const routing = await routingAuthority(this.context.pool, side.tenant, side.alias, side.tenant, side.alias);
      assert.equal(routing.allowed, true);
      this.proofs.push({ runId, side: side.side, tenant: side.tenant, alias: side.alias, company: side.company,
        container, containerId, relayPresenceVerified: true, fixture_seed_active_agent: true, fleet_admission_tested: false,
        physical_presence_verified: true, registered_scope_verified: true, other_agent_flags_preserved: true,
        draft_agents_preserved: otherAgents.filter(agent => !agent.enabled).length, owned_database_verified: true,
        repositoryTargetVisible: true, routing });
    }
    this.stage = 'prepared';
    return { ready: true };
  }

  private async registeredTarget(side: PublicTarget): Promise<{ enabled: boolean }> {
    const rows = (await this.context.pool.query<{ enabled: boolean }>(`SELECT target.enabled FROM agents target
      JOIN companies company ON company.id=target.company_id JOIN tenants tenant ON tenant.id=target.tenant_id
      JOIN console_users person ON person.company_id=target.company_id AND person.tenant_id=target.tenant_id AND person.alias=target.alias
      WHERE target.tenant_id=$1 AND target.alias=$2 AND target.company_id=$3 AND person.id=$4 AND person.active
      AND target.retired_at IS NULL AND target.purged_at IS NULL AND tenant.company_id=$3 AND tenant.enabled
      AND tenant.retired_at IS NULL AND tenant.purged_at IS NULL AND company.enabled AND company.retired_at IS NULL`,
    [side.tenant, side.alias, side.company, side.human])).rows;
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.ok(row);
    return row;
  }

  private async otherAgents(side: PublicTarget): Promise<{ alias: string; enabled: boolean }[]> {
    return (await this.context.pool.query<{ alias: string; enabled: boolean }>(
      'SELECT alias,enabled FROM agents WHERE tenant_id=$1 AND company_id=$2 AND alias<>$3 ORDER BY alias',
      [side.tenant, side.company, side.alias])).rows;
  }

  async relay(input: RelayRequest): Promise<ExternalResponse> {
    assert.equal(input.method, 'POST');
    assert.match(input.path, /^\/v3\/terminal\/relay\/(?:agents|sessions\/[a-f0-9-]+\/(?:consume|resume|authz|close))$/u);
    const { directory, terminalConfig } = this.context;
    const certificate = input.identity === 'no_certificate' ? undefined
      : input.identity === 'wrong_certificate' ? 'console' : 'relay-client';
    const tls = certificate === undefined ? {} : { cert: await readFile(join(directory, `${certificate}.crt`)),
      key: await readFile(join(directory, `${certificate}.key`)) };
    const ca = await readFile(join(directory, 'ca.crt'));
    const body = JSON.stringify(input.json);
    return await new Promise<ExternalResponse>((resolve, reject) => {
      const outgoing = request(new URL(input.path, this.fixture.gatewayUrl), { method: 'POST', ...tls,
        ca, rejectUnauthorized: true, timeout: 15_000,
        headers: { authorization: `Bearer ${input.identity === 'wrong_bearer' ? randomUUID() : terminalConfig.relayToken}`,
          'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, incoming => {
        let result = '';
        incoming.setEncoding('utf8'); incoming.on('data', (chunk: string) => { result += chunk; });
        incoming.once('end', () => { resolve({ status: incoming.statusCode ?? 0, body: result, setCookies: [], retryAfter: null }); });
      });
      outgoing.once('timeout', () => { outgoing.destroy(new Error('owned relay request deadline')); });
      outgoing.once('error', error => {
        const code = 'code' in error ? error.code : undefined;
        if (input.identity === 'no_certificate' && code === 'ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED') {
          resolve({ status: 0, body: JSON.stringify({ error: 'TLS_CLIENT_CERT_REQUIRED', tls_code: code }), setCookies: [], retryAfter: null });
        }
        else reject(error);
      });
      outgoing.end(body);
    });
  }

  async attach(input: AttachRequest): Promise<Record<string, unknown>> {
    const target = this.targets.find(value => value.side === input.side);
    assert.ok(target);
    assert.equal(target.wire, undefined);
    const wire = await connectTerminalWire(this.fixture, { type: 'attach', session_id: input.sessionId,
      ticket: input.ticket, authority_proof: input.authorityProof, cols: 100, rows: 30 });
    target.wire = wire;
    const ready = await wire.waitControl(frame => frame.type === 'ready');
    for (const key of ['claim_token', 'claim_epoch', 'resume_token']) assert.equal(typeof ready[key], 'string');
    const nonce = `m1${randomUUID().replaceAll('-', '')}`;
    const encoded = Array.from(Buffer.from(nonce), byte => `\\${byte.toString(8).padStart(3, '0')}`).join('');
    wire.sendInput(`printf '${encoded}\\n'\r`);
    await wire.waitOutput(output => output.includes(nonce));
    const proof = { runId: this.runId, side: input.side, ready: true, ptyNonceVerified: true,
      outputBytes: wire.outputBytes(), nonceSha256: createHash('sha256').update(nonce).digest('hex') };
    this.proofs.push(proof);
    return { ...proof, claimToken: ready.claim_token, claimEpoch: ready.claim_epoch, resumeToken: ready.resume_token,
      relayInstanceId: this.fixture.relayInstanceId,
      relayBootId: this.context.registry.get(target.tenant, target.alias, Date.now())?.relay_boot_id };
  }

  async close(runId?: string): Promise<{ closed: true }> {
    if (runId !== undefined && this.runId === undefined && this.targets.length === 0 && runId === this.lastClosedRunId) return { closed: true };
    if (runId !== undefined) assert.equal(runId, this.runId);
    const closingRunId = this.runId;
    const failures: unknown[] = [];
    for (const target of [...this.targets]) {
      try { await target.wire?.close(); } catch (error) { failures.push(error); }
      try {
        try {
          const identity = await execute('docker', ['inspect', '--format', '{{.Id}} {{index .Config.Labels "cauce.e2e.owner"}}', target.container]);
          assert.equal(identity.stdout.trim(), `${target.containerId} ${OWNER}`);
          await execute('docker', ['rm', '--force', target.container], { timeout: 15_000 });
        } catch (error) {
          if (!(error instanceof Error && /No such (?:object|container)/u.test(error.message))) throw error;
        }
        const deadline = Date.now() + 5_000;
        while (target.child?.exitCode === null && target.child.signalCode === null) {
          if (Date.now() >= deadline) throw new Error('owned company PTY process remained after container cleanup');
          await delay(50);
        }
        this.targets.splice(this.targets.indexOf(target), 1);
      } catch (error) { failures.push(error); }
    }
    if (this.targets.length === 0) {
      this.lastClosedRunId = closingRunId ?? this.lastClosedRunId;
      this.runId = undefined;
    }
    if (failures.length) throw new AggregateError(failures, 'owned company PTY cleanup failed');
    return { closed: true };
  }
}
