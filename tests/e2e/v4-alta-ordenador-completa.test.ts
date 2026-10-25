import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FleetCapability, FleetOperation, FleetOperationRequest, FleetOperationPreview } from '@cauce/protocol';
import type { FleetHost } from '@cauce/protocol/fleet-hosts';
import { newTrustedPage } from './console-functional-browser.fixtures.js';
import { asV4Page, BrowserErrorLog, fillRegistration, HERMETIC_INSTANCE_RULES, openRegistration, syntheticPerson, type V4Page } from './v4-console-real-browser.helpers.js';
import { startCompleteComputer, type CompleteComputer, type ComputerCommandResult } from './v4-alta-ordenador-completa.host.js';
import { buildCompleteRelease, COMPLETE_RELEASE_PROVIDER_IDENTITY, COMPLETE_RELEASE_REVISION } from './v4-alta-ordenador-completa.release.js';
import { startCompleteGateway } from './v4-alta-ordenador-completa.gateway.js';

const execute = promisify(execFile);
const task = 'h11-alta-ordenador-completa-1025';
const runId = randomUUID().slice(0, 8);
const person = syntheticPerson('h11', runId);
const hostId = `${person.company.slug}-host`;
const alias = `zz-canary-${task}-${runId}`;
const evidence = join(process.cwd(), '.delegados/v4/recibos', task, `run-${runId}`);
const errors = new BrowserErrorLog(HERMETIC_INSTANCE_RULES);
let work = '';
let release: Awaited<ReturnType<typeof buildCompleteRelease>> | undefined;
let gateway: Awaited<ReturnType<typeof startCompleteGateway>> | undefined;
let computer: CompleteComputer | undefined;
let page: V4Page;
const secrets = [person.password];
interface Configuration {
  revision: number; capabilities: { actor: { tenant_id: string; alias: string } };
  rooms: { tenant_id: string; id: string; enabled: boolean }[];
}
const active = () => { if (!gateway) throw new Error('complete computer gateway unavailable'); return gateway; };
const host = () => { if (!computer) throw new Error('complete computer unavailable'); return computer; };
async function record(name: string, value: unknown) {
  const serialized = JSON.stringify(value, null, 2) + '\n';
  if (secrets.some(secret => serialized.includes(secret))) throw new Error('receipt contains private fixture material');
  await writeFile(join(evidence, `${name}.json`), serialized, { mode: 0o600 });
}
function checked(result: ComputerCommandResult, stage: string): string {
  if (secrets.some(secret => (result.stdout + result.stderr).includes(secret))) throw new Error(`${stage} exposed private fixture material`);
  if (result.code !== 0) {
    const diagnostic = (result.stderr + result.stdout).replace(/(?:Bearer\s+|token[=:]\s*)\S+/giu, '[redacted]').slice(-1500);
    throw new Error(`${stage} failed (${String(result.code)}): ${diagnostic}`);
  }
  return result.stdout.trim();
}
async function api<T>(method: string, path: string, payload?: unknown, expected = 200): Promise<T> {
  const result = await page.evaluate(async input => {
    const session = await (await fetch('/v3/auth/session', { credentials: 'include', cache: 'no-store' })).json() as { csrf_token: string };
    const response = await fetch(input.path, { method: input.method, credentials: 'include', cache: 'no-store',
      headers: { ...(input.payload === undefined ? {} : { 'Content-Type': 'application/json' }),
        'X-Cauce-Console': '1', 'X-CSRF-Token': session.csrf_token },
      ...(input.payload === undefined ? {} : { body: JSON.stringify(input.payload) }) });
    return { status: response.status, body: response.status === 204 ? null : await response.json() as unknown };
  }, { method, path, payload });
  const code = result.body !== null && typeof result.body === 'object' && 'error' in result.body
    && typeof result.body.error === 'string' ? result.body.error : '';
  expect(result.status, `${method} ${path} HTTP status ${code}`).toBe(expected);
  return result.body as T;
}
async function until<T>(name: string, read: () => Promise<T>, accepts: (value: T) => boolean, milliseconds = 120_000): Promise<T> {
  const deadline = performance.now() + milliseconds;
  while (performance.now() < deadline) {
    const value = await read();
    if (accepts(value)) return value;
    await pause(500);
  }
  throw new Error(`${name} did not settle within ${String(milliseconds)}ms`);
}
const hosts = async () => (await api<{ hosts: FleetHost[] }>('GET', '/v3/console/fleet/hosts')).hosts;
async function capture(name: string) {
  for (const [viewport, suffix] of [[{ width: 1440, height: 900 }, 'desktop'], [{ width: 390, height: 844 }, 'mobile']] as const) {
    await page.setViewportSize(viewport);
    await page.screenshot({ path: join(evidence, `${name}-${suffix}.png`), fullPage: true });
    const layout = await page.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth,
      overflowing: Array.from(document.querySelectorAll('body *')).filter(element => element.getBoundingClientRect().right > innerWidth)
        .slice(0, 30).map(element => ({ tag: element.tagName, classes: element.getAttribute('class'),
          right: element.getBoundingClientRect().right, width: element.getBoundingClientRect().width })) }));
    await record(`${name}-${suffix}-layout`, layout);
    expect(layout.width).toBeLessThanOrEqual(layout.viewport);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}
async function diagnoseSetup() {
  const script = `import json,pathlib,re,sys
root=pathlib.Path.home()/'.local/share/cauce-v3/hosts'
policies=list(root.glob('*/*/executor-policy.json'))
releases=list(root.glob('*/*/release/*/ops/cli/fleet-executor.py'))
result={'policy_count':len(policies),'release_count':len(releases)}
if len(policies)==1 and len(releases)==1:
 sys.path.insert(0,str(releases[0].parent))
 try:
  from fleet_executor_policy import load_policy
  from fleet_executor_templates import fleet_harnesses,runtime_candidates
  from fleet_executor_authority import signed_call
  policy=load_policy(policies[0]);result['policy_valid']=True
  result['harnesses']=sorted(fleet_harnesses(policy));result['runtimes']=len(runtime_candidates(policy))
  try: result['authority_ready']=signed_call(policy['authority'],{'action':'ready'}).get('ready') is True
  except Exception as error:
   text=str(error);result['authority_error']=text if re.fullmatch(r'signed authority (?:effect is unverified|rejected request: HTTP [0-9]{3} \\([A-Z_]+\\))',text) else type(error).__name__
 except Exception as error:
  text=str(error);result['policy_error']=text if re.fullmatch(r'(?:invalid|unsafe|ambiguous|approved|executor|central|provider|harness)[a-z -]{0,180}',text) else type(error).__name__
print(json.dumps(result))`;
  const diagnostic = await host().user(['python3', '-I', '-B', '-c', script], { timeout: 120_000 });
  await record('setup-diagnostic', { exit: diagnostic.code,
    result: diagnostic.code === 0 ? JSON.parse(diagnostic.stdout) as unknown : { unavailable: true } });
}
async function operation(request: FleetOperationRequest) {
  const preview = await api<FleetOperationPreview>('POST', '/v3/console/fleet/operations/preview', request);
  await record(`${request.kind}-preview`, { can_apply: preview.can_apply, request_sha256: preview.request_sha256 });
  expect(preview.can_apply).toBe(true);
  const queued = await api<{ operation: FleetOperation }>('POST', '/v3/console/fleet/operations', request, 202);
  expect(queued.operation.request_sha256).toBe(preview.request_sha256);
  const result = await until(`${request.kind} operation`, async () => {
    const current = await api<FleetOperation>('GET', `/v3/console/fleet/operations/${queued.operation.id}`);
    await record(`${request.kind}-operation`, { id: current.id, status: current.status,
      error_code: current.error?.code, error_reason: current.error?.reason, steps: current.steps.map(step => ({ name: step.name,
        status: step.status, evidence: { provider_verified: step.evidence?.provider_verified, profile_verified: step.evidence?.profile_verified,
          bootstrap_verified: step.evidence?.bootstrap_verified, roundtrip_verified: step.evidence?.roundtrip_verified,
          hello_verified: step.evidence?.hello_verified, authority_verified: step.evidence?.authority_verified,
          stopped_verified: step.evidence?.stopped_verified, revocation_verified: step.evidence?.revocation_verified,
          removed_types: step.evidence?.removed?.map(item => item.type) } })) });
    if (['failed', 'cancelled', 'awaiting_auth'].includes(current.status)) {
      throw new Error(`${request.kind} operation ${current.status}: ${current.error?.code ?? 'no-code'} ${current.error?.reason ?? ''}`);
    }
    return current;
  }, current => current.status === 'succeeded', 240_000);
  expect(result.kind).toBe(request.kind);
  expect(result.target).toEqual(request.target);
  return result;
}

beforeAll(async () => {
  if (process.env.CAUCE_TEST_DATABASE_URL || process.env.VITE_USE_MOCKS === 'true') throw new Error('complete host requires isolated PostgreSQL and real routes');
  await mkdir(evidence, { recursive: true, mode: 0o700 });
  work = await mkdtemp(join(tmpdir(), 'h11-complete-'));
  const revision = COMPLETE_RELEASE_REVISION;
  expect((await execute('git', ['rev-parse', revision])).stdout.trim()).toBe(revision);
  const inputs = [...['test.ts', 'host.ts', 'gateway.ts', 'release.ts', 'Dockerfile'].map(part => `tests/e2e/v4-alta-ordenador-completa.${part}`),
    'console/src/features/config/ComputadoraCard.tsx'];
  await record('source', { revision, inputs: Object.fromEntries(await Promise.all(inputs.map(async filename => {
    return [filename, createHash('sha256').update(await readFile(filename)).digest('hex')] as const;
  }))) });
  console.info('H11_STAGE release');
  release = await buildCompleteRelease({ revision, directory: join(work, 'release'), runId });
  await record('release-source', release.sourceManifest);
  await record('release-manifest', release.manifest);
  console.info('H11_STAGE gateway');
  gateway = await startCompleteGateway(release);
  await record('gateway-resources', { database: gateway.database.container.getId(), browser: gateway.browserContainer,
    browser_image: gateway.browserRuntime.image, release_image: release.image });
  console.info('H11_STAGE computer');
  computer = await startCompleteComputer({ runId, evidenceDirectory: evidence, gatewayUrl: active().baseUrl,
    additionalGatewayUrls: [active().bootstrapUrl] });
  await record('computer-proof', await host().proof());
  page = asV4Page(await newTrustedPage(active(), { width: 1440, height: 900 }));
  errors.watch(page, 'owner');
  const registration = await openRegistration(page, active().baseUrl);
  await fillRegistration(registration, person);
  await registration.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
  await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });
}, 1_800_000);

afterAll(async () => {
  const failures: unknown[] = [];
  for (const [label, action] of [
    ['computer', async () => { if (computer) await record('cleanup', await computer.close()); }],
    ['gateway', async () => { await gateway?.close(); }],
    ['release', async () => {
      if (release) {
        await release.close();
        await record('release-image-cleanup', JSON.parse(await readFile(join(work, 'release/image-cleanup.json'), 'utf8')) as unknown);
      }
    }],
    ['resource absence', async () => {
      const known = [gateway?.database.container.getId(), gateway?.browserContainer, computer?.containerId].filter((value): value is string => Boolean(value));
      for (const id of known) {
        try { await execute('docker', ['container', 'inspect', id]); throw new Error('owned container remains after cleanup'); }
        catch (error) {
          if (!(error instanceof Error) || !('stderr' in error) || typeof error.stderr !== 'string'
            || !/No such (?:object|container)/iu.test(error.stderr)) throw error;
        }
      }
      await record('outer-containers-absent', { containers: known, absent: true });
    }],
    ['temporary files', () => work ? rm(work, { recursive: true, force: true }) : Promise.resolve()],
  ] as const) {
    try { await action(); } catch (error) { failures.push(error); console.error(`H11 cleanup failed: ${label}`); }
  }
  if (failures.length) throw new AggregateError(failures, 'complete computer teardown failed');
}, 240_000);

describe('complete computer installation through the released CLI and signed host setup', () => {
  it('installs a user executor, runs an agent in its own dockerd, purges it and deregisters the host', async () => {
    if (!release) throw new Error('committed host release unavailable');
    console.info('H11_STAGE invite');
    const invitation = await api<{ invitation_token: string; setup_signer_fingerprint: string }>('POST',
      '/v3/console/fleet/hosts/enrollments', { host_id: hostId, display_name: `Ordenador H11 ${runId}` }, 201);
    secrets.push(invitation.invitation_token);
    expect(invitation.setup_signer_fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    await host().copyIn(active().pki.ca.cert, '/usr/local/share/ca-certificates/h11-gateway.crt');
    await host().copyIn(active().authorityCa, '/usr/local/share/ca-certificates/h11-authority.crt');
    checked(await host().root(['update-ca-certificates']), 'install public laboratory CAs');
    checked(await host().user(['systemctl', '--user', 'set-environment',
      'NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt']), 'trust public laboratory CAs in the Node executor');
    const manifest = JSON.parse(await readFile(join(release.releaseDirectory, 'host-release.json'), 'utf8')) as { release: { file: string } };
    await host().copyIn(join(release.releaseDirectory, manifest.release.file), '/home/cauce/h11-release.tar');
    checked(await host().root(['chmod', '0644', '/home/cauce/h11-release.tar']), 'public release readability');
    checked(await host().user(['mkdir', '-p', '/home/cauce/h11-installer']), 'installer directory');
    checked(await host().user(['tar', '-xf', '/home/cauce/h11-release.tar', '-C', '/home/cauce/h11-installer']), 'extract committed installer');
    checked(await host().user(['env', `CAUCE_DESTINO_AVISO_INICIAL=${alias}`, 'bash',
      '/home/cauce/h11-installer/ops/scripts/install-cauce-cli.sh', '/home/cauce/.local/bin']), 'install released CLI');
    console.info('H11_STAGE enroll');
    const enrolled = JSON.parse(checked(await host().user(['cauce', 'hosts', 'enroll', '--gateway', active().baseUrl,
      '--invitation-stdin'], { input: JSON.stringify(invitation) }), 'released CLI enrollment')) as { host_id: string };
    expect(enrolled.host_id).toBe(hostId);
    console.info('H11_STAGE setup');
    const installed = await host().user(['cauce', 'hosts', 'setup'], { timeout: 600_000 });
    if (installed.code !== 0) await diagnoseSetup();
    const setup = JSON.parse(checked(installed, 'released CLI setup')) as {
      service_active: boolean; release_installed: boolean; unit: string; local_image_id: string;
    };
    expect(setup.service_active).toBe(true); expect(setup.release_installed).toBe(true);
    const unit = setup.unit.split('/').at(-1);
    if (!unit || !/^cauce-v3-host-executor-[a-z0-9_-]+\.service$/u.test(unit)) throw new Error('installed executor unit is invalid');
    expect(checked(await host().user(['systemctl', '--user', 'is-active', unit]), 'executor systemd state')).toBe('active');
    const status = JSON.parse(checked(await host().user(['cauce', 'hosts', 'status']), 'released CLI status')) as Record<string, unknown>;
    expect(status).toMatchObject({ host_id: hostId, service_active: true, executor_ready: true, linger: true });
    await record('installed', { host_id: hostId, unit, status, signer_fingerprint: invitation.setup_signer_fingerprint });
    const readyHost = (await until('signed host heartbeat', hosts, list => list.some(item => item.host_id === hostId
      && item.status === 'reachable' && item.status_source === 'controller' && item.approved))).find(item => item.host_id === hostId);
    await record('host-online', readyHost);
    await page.goto(`${active().baseUrl}/config?seccion=computadoras`, { waitUntil: 'domcontentloaded' });
    const card = page.getByRole('article').filter({ hasText: `Ordenador H11 ${runId}` });
    await card.getByText('Conectada', { exact: true }).waitFor({ timeout: 30_000 });
    await capture('computer-online');
    console.info('H11_STAGE create');
    const configuration = await api<Configuration>('GET', '/v3/console/config');
    const tenant = configuration.capabilities.actor.tenant_id;
    const room = configuration.rooms.find(item => item.tenant_id === tenant && item.enabled);
    if (!room) throw new Error('owner has no enabled room');
    const capability = await api<FleetCapability>('GET', '/v3/console/fleet/capability');
    const runtime = capability.placements.find(item => item.host_id === hostId)?.runtimes?.find(item => item.harness_id === 'codex' && item.mode === 'container');
    if (!runtime) throw new Error('signed computer capability has no codex runtime');
    const measured = JSON.parse(await host().dockercmd(['run', '--rm', '-i', '--network', 'none', setup.local_image_id,
      '/usr/local/bin/codex', 'app-server'], { input: JSON.stringify({ id: 1, method: 'account/read' }) + '\n' })) as {
      result: { account: { email: string } };
    };
    expect(measured.result.account.email).toBe(COMPLETE_RELEASE_PROVIDER_IDENTITY);
    const accountId = `zz-canary-${task}-account-${runId}`;
    const mutation = { resource: 'provider_account', action: 'create', id: accountId, value: { provider: 'codex',
      external_account_id: measured.result.account.email, payer_tenant_id: tenant, label: `Cuenta sintética H11 ${runId}`,
      credential_ref_kind: 'secret_manager', credential_ref: `op:h11/${runId}`, shared_with_pool: false, enabled: true } };
    const accountRevision = (await api<Configuration>('GET', '/v3/console/config')).revision;
    const accountPreview = await api<{ applied: boolean; mutation_sha256: string }>('POST', '/v3/console/config/changes',
      { mutation, expected_revision: accountRevision, dry_run: true });
    expect(accountPreview.applied).toBe(false);
    const accountApplied = await api<{ applied: boolean; mutation_sha256: string }>('POST', '/v3/console/config/changes',
      { mutation, expected_revision: accountRevision, dry_run: false }, 201);
    expect(accountApplied.applied).toBe(true);
    expect(accountApplied.mutation_sha256).toBe(accountPreview.mutation_sha256);
    await record('synthetic-account', { account_id: accountId, provider: 'codex', identity_measured_in_inner_image: true,
      synthetic: true, vendor_login: false, mutation_sha256: accountApplied.mutation_sha256 });
    const target = { resource: 'agent' as const, tenant_id: tenant, alias };
    const containerName = runtime.container_name ?? `${runtime.container_prefix ?? ''}${alias}`;
    const fresh = await api<Configuration>('GET', '/v3/console/config');
    await operation({ kind: 'create', target, expected_revision: fresh.revision, idempotency_key: `h11-create-${runId}`,
      parameters: { runtime_key: alias, harness_id: 'codex', display_name: `Canario H11 ${runId}`,
        primary_room_id: room.id, memberships: [{ room_id: room.id, role: 'agent', enabled: true }],
        primary_account_id: accountId, extensions: [], placement: { host_id: hostId, mode: 'container', container_name: containerName,
          runtime_user: runtime.runtime_user, home_directory: runtime.home_directory, state_directory: `${runtime.state_root}/${alias}`,
          ...(runtime.systemd_user ? { systemd_user: runtime.systemd_user } : {}) } } });
    const physical = JSON.parse(await host().dockercmd(['inspect', '--format', '{{json .}}', containerName])) as {
      Id: string; Image: string; State: { Running: boolean }; HostConfig: { NetworkMode: string };
    };
    expect(physical.State.Running).toBe(true);
    expect(physical.Image).toBe(setup.local_image_id);
    await record('inner-agent', { daemon_id: host().innerDaemonId, id: physical.Id, image: physical.Image, running: physical.State.Running,
      network: physical.HostConfig.NetworkMode });
    const online = await until('real SDK agent lease', hosts, list => list.some(item => item.host_id === hostId
      && item.agents.some(agent => agent.alias === alias && agent.online)));
    await record('agent-online', online.find(item => item.host_id === hostId));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await card.getByText(alias, { exact: true }).waitFor({ timeout: 30_000 });
    await card.locator('li[title$=" · en línea"]').filter({ hasText: alias }).waitFor({ timeout: 30_000 });
    await capture('agent-online');
    console.info('H11_STAGE retire-purge');
    for (const kind of ['retire', 'purge'] as const) {
      const current = await api<Configuration>('GET', '/v3/console/config');
      const result = await operation({ kind, target, expected_revision: current.revision, idempotency_key: `h11-${kind}-${runId}`,
        parameters: kind === 'purge' ? { confirm_alias: alias } : {} });
      if (kind === 'retire') {
        expect(result.steps.find(step => step.name === 'stop')?.evidence?.stopped_verified).toBe(true);
        expect(result.steps.find(step => step.name === 'revoke')?.evidence?.revocation_verified).toBe(true);
      }
    }
    expect(await host().dockercmd(['ps', '-aq', '--filter', `name=^/${containerName}$`])).toBe('');
    const retiringHost = (await hosts()).find(item => item.host_id === hostId);
    if (!retiringHost) throw new Error('host disappeared before public deregistration');
    expect(retiringHost.agents).toEqual([]);
    await api<null>('DELETE', `/v3/console/fleet/hosts/${hostId}?expected_version=${String(retiringHost.version)}`, undefined, 204);
    expect((await hosts()).some(item => item.host_id === hostId)).toBe(false);
    expect((await api<FleetCapability>('GET', '/v3/console/fleet/capability')).placements.some(item => item.host_id === hostId)).toBe(false);
    await record('public-cleanup', { purged: true, host_deleted: true, agent_container_absent: true });
    errors.assertClean();
    console.info('H11_STAGE complete');
  }, 1_200_000);
});
