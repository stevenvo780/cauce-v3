import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';
import { CauceRepository } from '@cauce/store';
import { PublishMessageSchema } from '@cauce/protocol';
import { docker, enrollComputer, FIXTURE_PROVIDER_IDENTITY, startComputerHarness,
  type ComputerHarness } from '../../services/gateway/src/fleet/host-computer.fixtures.js';
import { createSelfSignedCert } from '../terminal-pty/certs.mjs';
import { startTrustedBrowser, type TrustedBrowser } from './console-functional-browser.fixtures.js';
import { reserveNamedLoopbackPorts } from './port-reservation.js';
import { cancelDeployRuntime } from './v4-fleet-cancel-deploy.runtime.js';
import { installCancelDeploySetup } from './v4-fleet-cancel-deploy.setup.js';
import { apiGet, asV4Page, fillRegistration, openRegistration, syntheticPerson, type V4Locator, type V4Page } from './v4-console-real-browser.helpers.js';

export const OWNER = 'h9-contenedor-sustituido-1025';
export const RUN = randomUUID().slice(0, 4);
export const PREFIX = `zz-canary-${OWNER}-${RUN}`;
export const EVIDENCE = join(process.cwd(), '.delegados/v4/recibos', OWNER, `executor-${RUN}`);
export const ALIAS = `replace${RUN}`;
export const KEY = `replace-${RUN}`;
const consoleRequire = createRequire(join(process.cwd(), 'console/package.json'));

export interface Operation {
  id: string; kind: string; status: string; version: number; error: unknown;
  steps: { name: string; status: string; evidence?: Record<string, unknown> }[];
}
export interface ReplacementFixture {
  computer: ComputerHarness; page: V4Page; baseUrl: string; tenant: string; host: string; room: string; account: string;
  policyFile: string;
  close(): Promise<void>;
}

export async function startReplacementFixture(): Promise<ReplacementFixture> {
  await mkdir(EVIDENCE, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(tmpdir(), 'cauce-replacement-'));
  const tls = createSelfSignedCert({ directory });
  const ports = await reserveNamedLoopbackPorts(['frontend'] as const); await ports.releaseAll();
  const baseUrl = `https://localhost:${String(ports.ports.frontend)}`;
  let computer: ComputerHarness | undefined;
  let browser: TrustedBrowser | undefined;
  let vite: { close(): Promise<void>; listen(): Promise<void> } | undefined;
  const close = async () => {
    const failures: unknown[] = [];
    for (const action of [async () => browser?.close(), async () => vite?.close(), async () => {
      if (computer) {
        const inventory = await computer.close();
        await writeFile(join(EVIDENCE, 'cleanup.json'), JSON.stringify(inventory, null, 2) + '\n');
        expect(inventory).toEqual({ containers: '', volumes: '', images: '' });
      }
    }, async () => rm(directory, { recursive: true, force: true })]) {
      try { await action(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'replacement fixture cleanup incomplete');
  };
  try {
    computer = await startComputerHarness({ prefix: PREFIX, consoleOrigins: [baseUrl], workRoot: '/datos', resourceOwner: OWNER,
      runtimeBundle: cancelDeployRuntime,
      extraSourceFiles: ['ops/cli/fleet_executor_lifecycle.py', 'ops/cli/fleet_executor_replacement.py'] });
    vite = await (consoleRequire('vite') as { createServer(config: Record<string, unknown>): Promise<NonNullable<typeof vite>> }).createServer({
      configFile: join(process.cwd(), 'console/vite.config.ts'), root: join(process.cwd(), 'console'), envDir: directory,
      cacheDir: join(directory, 'vite-cache'), server: { host: '127.0.0.1', port: ports.ports.frontend, strictPort: true,
        watch: null, hmr: false, https: { key: await readFile(tls.key_path), cert: await readFile(tls.cert_path) },
        proxy: { '/v3': { target: computer.gatewayUrl, changeOrigin: false, ws: true } } },
    });
    await vite.listen();
    browser = await startTrustedBrowser(tls.cert_path, directory, [ports.ports.frontend, Number(new URL(computer.gatewayUrl).port)]);
    const context = await browser.browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: false, serviceWorkers: 'block' });
    const page = asV4Page(await context.newPage());
    const owner = syntheticPerson('replacement', RUN);
    owner.company = { name: `zz-canary replacement ${RUN}`, slug: `zz-replace-${RUN}` };
    const form = await openRegistration(page, baseUrl); await fillRegistration(form, owner);
    await form.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
    await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });
    const host = `${owner.company.slug}-pc`;
    await page.goto('about:blank', { waitUntil: 'domcontentloaded' });
    const installed = await installCancelDeploySetup(computer, baseUrl, owner.company.slug, host);
    computer = installed.computer;
    const configuration = installed.setup.approvedConfiguration();
    const templates = configuration.policy.container_templates;
    const original = templates[0];
    if (!original || templates.length !== 1) throw new Error('replacement fixture requires one original template');
    configuration.policy.container_templates = [...templates, { ...original, prefix: `${PREFIX}-n-` }];
    installed.setup.publish(configuration);
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });
    const login = await computer.app.inject({ method: 'POST', url: '/v3/auth/login', headers: { origin: baseUrl },
      payload: { email: owner.email, password: owner.password } });
    expect(login.statusCode).toBe(200);
    const header = login.headers['set-cookie'];
    const cookie = (Array.isArray(header) ? header : header === undefined ? [] : [header]).map(value => value.split(';', 1)[0]).join('; ');
    await enrollComputer(computer, { cookie, origin: baseUrl, 'x-csrf-token': login.json<{ csrf_token: string }>().csrf_token }, owner.company.slug, host);
    const tenant = (await computer.pool.query<{ tenant_id: string }>('SELECT tenant_id FROM console_users WHERE email=$1', [owner.email])).rows[0]?.tenant_id;
    if (!tenant) throw new Error('replacement fixture tenant absent');
    const room = (await computer.pool.query<{ id: string }>('SELECT id FROM rooms WHERE tenant_id=$1 AND enabled ORDER BY id', [tenant])).rows[0]?.id;
    if (!room) throw new Error('replacement fixture room absent');
    const account = `zz-replace-${RUN}`;
    await computer.pool.query(`INSERT INTO provider_accounts(id,provider,external_account_id,payer_tenant_id,credential_ref_kind,credential_ref,enabled)
      VALUES($1,'codex',$2,$3,'env_path','CAUCE_REPLACEMENT_FIXTURE_PROFILE_PATH',true)`, [account, FIXTURE_PROVIDER_IDENTITY, tenant]);
    await computer.pool.query("INSERT INTO agents(tenant_id,alias,harness_id,enabled) VALUES($1,$2,'codex',false)", [tenant, `sender${RUN}`]);
    await computer.pool.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES($1,$2,$3,'agent')", [tenant, room, `sender${RUN}`]);
    return { computer, page, tenant, host, room, account, baseUrl,
      policyFile: join(computer.installRoot, owner.company.slug, host, 'executor-policy.json'), close };
  } catch (error) { await close(); throw error; }
}

export async function operations(fixture: ReplacementFixture): Promise<Operation[]> {
  const response = await apiGet(fixture.page, `/v3/console/fleet/operations?resource=agent&tenant_id=${fixture.tenant}&alias=${ALIAS}`);
  expect(response.status).toBe(200);
  return response.body.operations as Operation[];
}

export async function waitOperation(fixture: ReplacementFixture, kind: string): Promise<Operation> {
  let last: Operation | undefined;
  await expect.poll(async () => {
    last = (await operations(fixture)).find(row => row.kind === kind);
    return last && ['succeeded', 'failed', 'cancelled', 'awaiting_auth'].includes(last.status);
  }, { timeout: 240_000, interval: 1_000 }).toBe(true);
  if (!last) throw new Error('replacement operation absent');
  return last;
}

export async function confirmReplacement(form: V4Locator): Promise<void> {
  const preview = form.getByRole('button', { name: 'Previsualizar operación', exact: true });
  await expect.poll(() => preview.isDisabled(), { timeout: 30_000 }).toBe(false); await preview.click();
  const apply = form.getByRole('button', { name: 'Confirmar operación', exact: true });
  await expect.poll(() => apply.isDisabled(), { timeout: 30_000 }).toBe(false); await apply.click();
}

export async function createReplacementAgent(fixture: ReplacementFixture): Promise<Operation> {
  const { page, baseUrl, tenant, room, host, account } = fixture;
  await page.goto(`${baseUrl}/config?seccion=agentes`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Añadir agente', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Añadir agente' });
  await dialog.getByText('Solo preparar, sin desplegar', { exact: true }).click();
  const form = dialog.getByRole('region', { name: 'Alta operativa de agente', exact: true });
  await form.getByLabel('Espacio de trabajo operativo').selectOption(tenant);
  await form.getByLabel('Alias operativo').fill(ALIAS);
  await form.getByLabel('Nombre visible operativo').fill('Canario sustitución');
  await form.getByLabel('Clave física de ejecución').fill(KEY);
  await form.getByRole('checkbox', { name: new RegExp(`· "${room}"$`, 'u') }).check();
  await form.getByLabel('Grupo primario').selectOption(room);
  await form.getByLabel('Host operativo').selectOption(host);
  await form.getByLabel('Plantilla de ejecución').selectOption('0');
  await form.getByLabel('Cuenta principal de ejecución').selectOption(account);
  await confirmReplacement(form);
  const created = await waitOperation(fixture, 'create');
  expect(created.status, JSON.stringify(created)).toBe('succeeded');
  return created;
}

export async function replacementUpdatePanel(fixture: ReplacementFixture): Promise<V4Locator> {
  const { page, baseUrl, tenant } = fixture;
  await page.goto(`${baseUrl}/config?seccion=agentes&agente=${encodeURIComponent(`${tenant}/${ALIAS}`)}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('tab', { name: 'Ejecución', exact: true }).click();
  const panel = page.getByRole('region', { name: `Operación de ${tenant}/${ALIAS}`, exact: true });
  await panel.getByLabel('¿Qué quieres hacer?').selectOption('update');
  await panel.getByLabel('Plantilla de ejecución').selectOption('1');
  expect(await panel.getByLabel('Contenedor operativo').inputValue()).toBe(`${PREFIX}-n-${KEY}`);
  try {
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await page.screenshot({ path: join(EVIDENCE, `update-preview-${String(viewport.width)}x${String(viewport.height)}.png`) });
    }
  } finally { await page.setViewportSize({ width: 1440, height: 900 }); }
  return panel;
}

export async function reply(fixture: ReplacementFixture, text: string): Promise<unknown> {
  const marker = `FLEET-DEPLOY-DELIVERY-${randomUUID()}`;
  const message = await new CauceRepository(fixture.computer.pool).publish(PublishMessageSchema.parse({
    request_id: randomUUID(), trace_id: randomUUID(), tenant_id: fixture.tenant, room_id: fixture.room, actor_alias: `sender${RUN}`,
    recipients: [{ tenant_id: fixture.tenant, alias: ALIAS }], body: { type: 'text', text: `${text} ${marker}` }, idempotency_key: randomUUID(),
  }));
  let result: { status: string; reply: string | null; last_error: string | null } | undefined;
  await expect.poll(async () => {
    result = (await fixture.computer.pool.query<NonNullable<typeof result>>(
      "SELECT status,result->'output'->>'reply' AS reply,last_error FROM deliveries WHERE message_id=$1 AND recipient_alias=$2",
      [message.message_id, ALIAS])).rows[0];
    return result?.status;
  }, { timeout: 90_000, interval: 500 }).toBe('done');
  expect(result?.reply).toBe(`DELIVERED:${marker}`);
  return { message: message.message_id, ...result };
}

export async function snapshot(name: string): Promise<{ id: string; running: boolean; volumes: string[] } | null> {
  const names = await docker(['ps', '-a', '--filter', `name=^/${name}$`, '--format', '{{.Names}}']);
  if (!names) return null;
  const observed = JSON.parse(await docker(['inspect', name])) as { Id: string; State: { Running: boolean }; Mounts: { Type: string; Name: string }[] }[];
  const row = observed[0];
  if (!row) throw new Error('replacement container inspection ambiguous');
  return { id: row.Id, running: row.State.Running, volumes: row.Mounts.filter(mount => mount.Type === 'volume').map(mount => mount.Name) };
}
