import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { expect } from 'vitest';
import { docker, dockerInventory, enrollComputer, FIXTURE_PROVIDER_IDENTITY, startComputerHarness,
  type ComputerHarness, type ComputerRuntimeBundle } from '../../services/gateway/src/fleet/host-computer.fixtures.js';
import { createSelfSignedCert } from '../terminal-pty/certs.mjs';
import { browserDocker, browserResourcesRetained } from './browser-owned-lifecycle.js';
import { backupFailure } from '../../services/gateway/src/fleet/space-backup.failure.js';
import { startTrustedBrowser, type TrustedBrowser } from './console-functional-browser.fixtures.js';
import { reserveNamedLoopbackPorts } from './port-reservation.js';
import { cancelDeployRuntime } from './v4-fleet-cancel-deploy.runtime.js';
import { apiGet, asV4Page, BrowserErrorLog, fillRegistration, HERMETIC_INSTANCE_RULES, openRegistration,
  PATTERN_DEFECT_RULE, syntheticPerson, type V4Locator, type V4Page } from './v4-console-real-browser.helpers.js';

export const TASK = 'c171b-copias-grandes-1025';
export const RUN = randomUUID().replaceAll('-', '').slice(0, 6);
export const PREFIX = `zz-canary-${TASK}-${RUN}`;
export const ALIAS = `zz-canary-copy-${RUN}`;
export const EVIDENCE = resolve('.delegados/v4/recibos', TASK, RUN);
export const LARGE_BYTES = 1_000_000_000;
export const SMALL_FILES = 2048;
const root = process.cwd();
const consoleRequire = createRequire(join(root, 'console/package.json'));

// The provider is synthetic; its response must come from an actual read of the restored file.
const readerRuntime = (runtimeKey: string): ComputerRuntimeBundle => ({ ...cancelDeployRuntime, providerCli: `#!/usr/local/bin/python3
import hashlib,json,os,pathlib,re,resource,sys,uuid
if 'app-server' in sys.argv:
 for line in sys.stdin:
  packet=json.loads(line)
  if 'id' in packet:
   result={'account':{'type':'chatgpt','email':'${FIXTURE_PROVIDER_IDENTITY}'}} if packet['method']=='account/read' else {}
   print(json.dumps({'id':packet['id'],'result':result}),flush=True)
 sys.exit(0)
prompt=' '.join(sys.argv[1:]) if sys.argv[-1]!='-' else sys.stdin.read()
bootstrap=re.search(r'CAUCE_BOOTSTRAP_[a-f0-9]{64}',prompt)
if bootstrap:
 answer=bootstrap.group(0)
else:
 match=re.search(r'RESTORED_READ_PATH=([A-Za-z0-9_./-]+)',prompt)
 if match is None: sys.exit('restored file path is absent')
 requested=pathlib.Path(match.group(1))
 allowed=pathlib.Path('/home/cauce/.cauce/${runtimeKey}/restored-${RUN}')
 if not requested.is_absolute() or requested.is_symlink() or not requested.resolve().is_relative_to(allowed):
  sys.exit('restored file is outside the owned restoration')
 digest=hashlib.sha256();size=0
 with requested.open('rb') as stream:
  while chunk:=stream.read(1024*1024): digest.update(chunk);size+=len(chunk)
 reply={'reader':'synthetic-provider-real-filesystem','bytes':size,'sha256':digest.hexdigest(),
  'pid':os.getpid(),'peak_rss_kib':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss}
 output={'reply':json.dumps(reply,separators=(',',':')),'messages':[],'notify':[],'status':'done','retryable':False,'artifacts':[]}
 correlation=re.search(r'"cauce_correlation_id":"([a-f0-9]{64})"',prompt)
 if correlation: output['cauce_correlation_id']=correlation.group(1)
 answer=json.dumps(output)
native=sys.argv[sys.argv.index('resume')+2] if 'resume' in sys.argv and '--json' in sys.argv else str(uuid.uuid4())
print(json.dumps({'type':'thread.started','thread_id':native}),flush=True)
print(json.dumps({'type':'item.completed','item':{'type':'agent_message','text':answer}}),flush=True)
` });

export interface CopyAgent {
  tenant_id: string; alias: string; runtime_key: string; container_name: string;
  runtime_user: string; state_directory: string; home_directory: string;
}
export interface CopyRestorationFixture {
  scenario: 'large' | 'many'; alias: string; runtimeKey: string;
  computer: ComputerHarness; browser: TrustedBrowser; page: V4Page; baseUrl: string; directory: string;
  storage: string; tenant: string; room: string; company: string; host: string; agent: CopyAgent;
  errors: BrowserErrorLog;
  close(): Promise<void>;
}

export async function receipt(name: string, value: unknown): Promise<void> {
  await mkdir(EVIDENCE, { recursive: true, mode: 0o700 });
  await writeFile(join(EVIDENCE, `${name}.json`), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}

export async function capture(page: V4Page, phase: string, target: V4Locator): Promise<void> {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await target.evaluate(element => { element.scrollIntoView({ block: 'center' }); });
    expect(await target.isVisible()).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.screenshot({ path: join(EVIDENCE, `${phase}-${String(viewport.width)}x${String(viewport.height)}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

export async function agentPython(fixture: CopyRestorationFixture, program: string, args: string[] = []): Promise<string> {
  return docker(['exec', '--user', fixture.agent.runtime_user, fixture.agent.container_name, 'python3', '-I', '-B', '-c', program, ...args]);
}

async function verifyOwnedResources(computer: ComputerHarness, tenant: string, host: string, alias: string, containerId?: string) {
  const prefix = `${PREFIX}-${alias.endsWith('-large') ? 'large' : 'many'}`;
  const inventory = await dockerInventory(prefix);
  const agentName = `${prefix}-${alias}`;
  for (const name of inventory.containers.split('\n').filter(Boolean)) {
    expect([prefix, agentName]).toContain(name);
    const info = JSON.parse(await docker(['inspect', '--format', '{{json .}}', name])) as {
      Id: string; Config: { Labels: Record<string, string> };
    };
    if (name === prefix) expect(info.Config.Labels['cauce.e2e.owner']).toBe(TASK);
    else {
      if (containerId !== undefined) expect(info.Id).toBe(containerId);
      expect(info.Config.Labels).toMatchObject({ 'cauce.fleet.tenant': tenant, 'cauce.fleet.alias': alias,
        'cauce.fleet.runtime_key': alias, 'cauce.fleet.host': host, 'cauce.fleet.owner': 'cauce' });
    }
  }
  for (const name of inventory.volumes.split('\n').filter(Boolean)) {
    expect([`${agentName}-state`, `${agentName}-provider-profiles`]).toContain(name);
    const labels = JSON.parse(await docker(['volume', 'inspect', '--format', '{{json .Labels}}', name])) as Record<string, string>;
    expect(labels).toMatchObject({ 'cauce.fleet.tenant': tenant, 'cauce.fleet.alias': alias,
      'cauce.fleet.runtime_key': alias, 'cauce.fleet.host': host, 'cauce.fleet.owner': 'cauce' });
  }
  for (const image of inventory.images.split('\n').filter(Boolean)) expect([`${prefix}:computer`, `${prefix}:agent`]).toContain(image);
  expect(computer.prefix).toBe(prefix);
  return { prefix, tenant, host, containerId, inventory, browser: 'separate-owned-browser-lifecycle' };
}

async function createAgent(page: V4Page, computer: ComputerHarness, baseUrl: string, tenant: string, room: string,
  host: string, account: string, scenario: 'large' | 'many', company: string): Promise<CopyAgent> {
  const alias = `${ALIAS}-${scenario}`;
  const waitUntil = async (condition: () => Promise<boolean | undefined>, timeout: number, label: string, interval = 250) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await condition()) return;
      await sleep(Math.min(interval, Math.max(1, deadline - Date.now())));
    }
    throw new Error(`copy fixture timed out waiting for ${label}`);
  };
  await page.goto(`${baseUrl}/config?seccion=agentes`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Añadir agente', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Añadir agente' });
  await dialog.getByText('Solo preparar, sin desplegar', { exact: true }).click();
  const form = dialog.getByRole('region', { name: 'Alta operativa de agente', exact: true });
  await form.getByLabel('Espacio de trabajo operativo').selectOption(tenant);
  await form.getByLabel('Alias operativo').fill(alias);
  await form.getByLabel('Nombre visible operativo').fill(`Canario copias ${RUN}`);
  await form.getByLabel('Clave física de ejecución').fill(alias);
  await form.getByRole('checkbox', { name: new RegExp(`· "${room}"$`, 'u') }).check();
  await form.getByLabel('Grupo primario').selectOption(room);
  await form.getByLabel('Host operativo').locator(`option[value="${host}"]`).waitFor({ state: 'attached', timeout: 30_000 });
  await form.getByLabel('Host operativo').selectOption(host);
  await form.getByLabel('Plantilla de ejecución').selectOption('0');
  await form.getByLabel('Cuenta principal de ejecución').selectOption(account);
  expect(await form.getByLabel('Contenedor operativo').inputValue()).toBe(`${PREFIX}-${scenario}-${alias}`);
  const preview = form.getByRole('button', { name: 'Previsualizar operación', exact: true });
  await waitUntil(async () => !await preview.isDisabled(), 30_000, 'preview button');
  expect(await preview.isDisabled()).toBe(false);
  await preview.click();
  const confirm = form.getByRole('button', { name: 'Confirmar operación', exact: true });
  await waitUntil(async () => !await confirm.isDisabled(), 30_000, 'confirmation button');
  expect(await confirm.isDisabled()).toBe(false);
  await confirm.click();
  const operationPath = `/v3/console/fleet/operations?resource=agent&tenant_id=${tenant}&alias=${alias}`;
  let operation: { id: string; status: string; error: unknown } | undefined;
  await waitUntil(async () => {
    const response = await apiGet(page, operationPath);
    expect(response.status).toBe(200);
    operation = (response.body.operations as { id: string; status: string; error: unknown }[])[0];
    return operation && ['succeeded', 'failed', 'cancelled', 'awaiting_auth'].includes(operation.status);
  }, 240_000, 'terminal create operation', 1_000);
  if (operation?.status !== 'succeeded') {
    const diagnostics: Record<string, unknown> = { id: operation?.id, status: operation?.status };
    try {
      const journal = await browserDocker(['exec', '--user', 'cauce', '-e', 'HOME=/home/cauce',
        '-e', 'XDG_RUNTIME_DIR=/run/user/1500', computer.prefix, 'timeout', '15s', 'journalctl', '--user', '-u',
        `cauce-v3-host-executor-${company}-${host}.service`, '--no-pager', '-o', 'cat', '-n', '1000'],
      { timeout: 25_000, maxBuffer: 512 * 1024 });
      diagnostics.journal = journal.stdout.split('\n').filter(line => operation?.id !== undefined
        && line.includes(`operation_id=${operation.id}`) && line.includes('fleet host command failed'))
        .map(line => backupFailure(new Error(line.split(' stderr=').at(-1) ?? 'unverified runtime failure')));
    } catch (error) { diagnostics.journal_error = backupFailure(error); }
    await receipt(`${scenario}-agent-startup-failure`, diagnostics);
  }
  expect(operation, JSON.stringify(operation)).toMatchObject({ status: 'succeeded' });
  const agent = (await computer.pool.query<CopyAgent>(`SELECT tenant_id,alias,runtime_key,container_name,runtime_user,state_directory,home_directory
    FROM agents WHERE tenant_id=$1 AND alias=$2`, [tenant, alias])).rows[0];
  if (!agent) throw new Error('copy canary agent is absent');
  await receipt(`${scenario}-agent-created`, { operation, agent, synthetic_provider: true, commercial_provider: false });
  return agent;
}

export async function startCopyRestorationFixture(scenario: 'large' | 'many'): Promise<CopyRestorationFixture> {
  const prefix = `${PREFIX}-${scenario}`;
  if (prefix.length > 48) throw new Error('copy fixture prefix exceeds the approved container-prefix contract');
  const alias = `${ALIAS}-${scenario}`;
  if (process.env.CAUCE_TEST_DATABASE_URL || process.env.VITE_USE_MOCKS === 'true') throw new Error('owned PostgreSQL and mocks=false required');
  await mkdir(EVIDENCE, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(tmpdir(), `${prefix}-`));
  await chmod(directory, 0o700);
  const storage = join(directory, 'copies');
  const tls = createSelfSignedCert({ directory });
  const reserved = await reserveNamedLoopbackPorts(['frontend'] as const);
  const baseUrl = `https://localhost:${String(reserved.ports.frontend)}`;
  let computer: ComputerHarness | undefined;
  let browser: TrustedBrowser | undefined;
  let vite: { close(): Promise<void>; listen(): Promise<void> } | undefined;
  let tenant = '';
  let host = '';
  let agentId: string | undefined;
  const nativeCapability = {
    native_administration: false, reason: 'fixture-native-facts-probe-not-installed',
    path: '', probe_installed: undefined as boolean | undefined, facts_available: undefined as boolean | undefined,
    contract_verified: false, checks: [] as { stage: string; status: number; body: unknown }[],
    observations: [] as { caller: string; path: string; console: string; contract_verified: boolean }[],
  };
  const nativeRuleId = 'owned-copy-native-skill-unavailable';
  let verifyNativeCapability: ((stage: string) => Promise<void>) | undefined;
  const errors = new BrowserErrorLog([...HERMETIC_INSTANCE_RULES, PATTERN_DEFECT_RULE, {
    id: nativeRuleId, reason: nativeCapability.reason,
    matches: (text, url) => {
      if (nativeCapability.probe_installed !== false || nativeCapability.facts_available !== false
        || computer?.app.sondaDeDocumentos?.instalada !== false
        || !/^Failed to load resource: the server responded with a status of 501(?: \((?:Not Implemented)?\))?$/u.test(text)) return false;
      let location: URL;
      try { location = new URL(url); } catch { return false; }
      if (location.origin !== baseUrl || location.pathname !== nativeCapability.path || location.search !== '') return false;
      nativeCapability.observations.push({ caller: 'copy-restoration-owner', path: location.pathname, console: text,
        contract_verified: nativeCapability.contract_verified });
      return true;
    },
  }]);
  const close = async () => {
    const failures: unknown[] = [];
    const cleanup: Record<string, unknown> = {};
    let retainBrowserResources = false;
    for (const [name, action] of [
      ['native-capability', async () => {
        try { await verifyNativeCapability?.('cleanup'); }
        finally { await receipt(`${scenario}-native-capability`, { ...nativeCapability,
          ignored_console_count: errors.ignored.get(nativeRuleId) ?? 0 }); }
      }],
      ['browser', async () => { await browser?.close(); }], ['frontend', async () => { await vite?.close(); }],
      ['computer', async () => {
        if (computer) {
          cleanup.ownership = await verifyOwnedResources(computer, tenant, host, alias, agentId);
          cleanup.inventory = await computer.close();
          expect(cleanup.inventory).toEqual({ containers: '', volumes: '', images: '' });
        }
      }], ['ports', async () => { await reserved.releaseAll(); }],
    ] as const) {
      try { await action(); cleanup[name] = 'closed'; }
      catch (error) {
        failures.push(error); cleanup[name] = error instanceof Error ? error.message : String(error);
        if (name === 'browser') retainBrowserResources = browserResourcesRetained(error);
      }
    }
    if (retainBrowserResources) cleanup.temporary_directory = 'retained-for-unresolved-owned-browser';
    else {
      try { await rm(directory, { recursive: true, force: true }); cleanup.temporary_directory = 'removed'; }
      catch (error) { failures.push(error); cleanup.temporary_directory = error instanceof Error ? error.message : String(error); }
    }
    try { await receipt(`${scenario}-cleanup`, { run: RUN, prefix, ...cleanup, complete: failures.length === 0 }); }
    catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'copy restoration fixture cleanup incomplete');
  };
  try {
    const untracked = await promisify(execFile)('git', ['ls-files', '--others', '--exclude-standard', '-z', '--',
      'packages/protocol/src', 'packages/store/src', 'services/gateway/src', 'ops/cli']);
    const extraSourceFiles = untracked.stdout.split('\0').filter(path => /\.(?:ts|py)$/u.test(path) && !path.includes('.test.'));
    const previous = { directory: process.env.CAUCE_SPACE_BACKUP_DIRECTORY, root: process.env.CAUCE_PROJECT_ROOT };
    process.env.CAUCE_SPACE_BACKUP_DIRECTORY = storage;
    process.env.CAUCE_PROJECT_ROOT = root;
    try { computer = await startComputerHarness({ prefix, consoleOrigins: [baseUrl], workRoot: '/datos',
      resourceOwner: TASK, runtimeBundle: readerRuntime(alias), extraSourceFiles }); }
    finally {
      if (previous.directory === undefined) delete process.env.CAUCE_SPACE_BACKUP_DIRECTORY;
      else process.env.CAUCE_SPACE_BACKUP_DIRECTORY = previous.directory;
      if (previous.root === undefined) delete process.env.CAUCE_PROJECT_ROOT;
      else process.env.CAUCE_PROJECT_ROOT = previous.root;
    }
    vite = await (consoleRequire('vite') as { createServer(config: Record<string, unknown>): Promise<NonNullable<typeof vite>> }).createServer({
      configFile: join(root, 'console/vite.config.ts'), root: join(root, 'console'), envDir: directory, cacheDir: join(directory, 'vite-cache'),
      server: { host: '127.0.0.1', port: reserved.ports.frontend, strictPort: true, watch: null, hmr: false,
        https: { key: await readFile(tls.key_path), cert: await readFile(tls.cert_path) },
        proxy: { '/v3': { target: computer.gatewayUrl, changeOrigin: false, ws: true } } },
    });
    await reserved.releaseAll();
    await vite.listen();
    browser = await startTrustedBrowser(tls.cert_path, directory, [reserved.ports.frontend, Number(new URL(computer.gatewayUrl).port)], 1800);
    const context = await browser.browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: false, serviceWorkers: 'block' });
    const page = asV4Page(await context.newPage()); errors.watch(page, 'copy-restoration-owner');
    const owner = syntheticPerson('copyrestore', RUN);
    owner.company = { name: `zz-canary copias ${RUN} ${scenario}`, slug: `zz-canary-copy-${RUN}-${scenario}` };
    const registration = await openRegistration(page, baseUrl); await fillRegistration(registration, owner);
    await registration.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
    await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });
    const login = await computer.app.inject({ method: 'POST', url: '/v3/auth/login', headers: { origin: baseUrl },
      payload: { email: owner.email, password: owner.password } });
    expect(login.statusCode).toBe(200);
    const setCookie = login.headers['set-cookie'];
    const session = { origin: baseUrl,
      cookie: (Array.isArray(setCookie) ? setCookie : setCookie === undefined ? [] : [setCookie]).map(value => value.split(';', 1)[0]).join('; '),
      'x-csrf-token': login.json<{ csrf_token: string }>().csrf_token };
    host = `${owner.company.slug}-pc`;
    await enrollComputer(computer, session, owner.company.slug, host);
    tenant = (await computer.pool.query<{ tenant_id: string }>('SELECT tenant_id FROM console_users WHERE email=$1', [owner.email])).rows[0]?.tenant_id ?? '';
    expect(tenant).not.toBe('');
    const room = (await computer.pool.query<{ id: string }>('SELECT id FROM rooms WHERE tenant_id=$1 AND enabled ORDER BY id', [tenant])).rows[0]?.id;
    if (!room) throw new Error('copy company has no active room');
    const account = `zz-canary-copy-${RUN}`;
    await computer.pool.query(`INSERT INTO provider_accounts(id,provider,external_account_id,payer_tenant_id,credential_ref_kind,credential_ref,enabled)
      VALUES($1,'codex',$2,$3,'env_path','CAUCE_COPY_RESTORATION_SYNTHETIC_PROFILE_PATH',true)`, [account, FIXTURE_PROVIDER_IDENTITY, tenant]);
    const probe = computer.app.sondaDeDocumentos;
    expect(probe, 'copy fixture must expose its actual native facts probe slot').toBeDefined();
    const verifyMissingNativeProbe = async () => {
      expect(probe?.instalada).toBe(false);
      const facts = await probe?.actual().factsFor(tenant, alias);
      expect(facts).toBeUndefined();
      expect(typeof probe?.actual().nativeAdmin).toBe('undefined');
      nativeCapability.probe_installed = false;
      nativeCapability.facts_available = false;
    };
    await verifyMissingNativeProbe();
    nativeCapability.path = `/v3/console/tenants/${tenant}/agents/${alias}/native/skill`;
    const nativeGateway = computer;
    verifyNativeCapability = async (stage) => {
      await verifyMissingNativeProbe();
      const response = await nativeGateway.app.inject({ method: 'GET', url: nativeCapability.path, headers: session });
      expect(response.statusCode).toBe(501);
      const body: unknown = response.json();
      expect(body).toEqual({ error: 'unsupported', message: 'Este arnés no publica edición nativa para este tipo o esta cuenta.' });
      nativeCapability.checks.push({ stage, status: response.statusCode, body });
      nativeCapability.contract_verified = true;
    };
    const agent = await createAgent(page, computer, baseUrl, tenant, room, host, account, scenario, owner.company.slug);
    await verifyNativeCapability('agent-created');
    await receipt(`${scenario}-native-capability`, { ...nativeCapability, ignored_console_count: errors.ignored.get(nativeRuleId) ?? 0 });
    agentId = await docker(['inspect', '--format', '{{.Id}}', agent.container_name]);
    await receipt(`${scenario}-resources`, { run: RUN, prefix, postgres_environment: 'owned-testcontainers', agent_container: agent.container_name,
      agent_container_id: agentId, browser_container: browser.container, browser_container_id: browser.containerId,
      browser_image: browser.runtime.image, browser_image_id: browser.runtime.imageId, tls_verified: true,
      extra_source_files: extraSourceFiles, synthetic_provider: true, commercial_provider: false, native_administration: false });
    return { scenario, alias, runtimeKey: alias, computer, browser, page, baseUrl, directory, storage, tenant, room,
      company: owner.company.slug, host, agent, errors, close };
  } catch (error) {
    try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'copy fixture startup and cleanup failed'); }
    throw error;
  }
}
