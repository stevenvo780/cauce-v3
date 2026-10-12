import { randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../../services/gateway/src/password.js';
import { maintainConsoleUser } from '../../services/gateway/src/console-user-maintenance.js';
import {
  isaTenant, newTrustedPage, startConsoleFunctionalFixture, type BrowserPage,
} from './console-functional-browser.fixtures.js';
import { assertAgentRegistryGeometry } from './agent-registry-editor.geometry.js';
const execute = promisify(execFile);
const evidenceSetting = 'CAUCE_AGENT_REGISTRY_EVIDENCE_DIR';
let evidenceDirectory: string | undefined;
let fixture: Awaited<ReturnType<typeof startConsoleFunctionalFixture>> | undefined;
let resources: { postgres: string; browser: string; network: string; volume: string; image: string } | undefined;
let hub: { tenant: string; actor: string; alias: string; email: string; password: string; humanId: string } | undefined;
interface ConfigMutation {
  resource: 'agent'; action: 'update'; tenant_id: string; alias: string; value: Record<string, unknown>;
}
interface ChangeResponse { status: number; body: unknown }
interface ChangeRequest { expected_revision?: number; dry_run?: boolean; mutation?: unknown }
interface AgentRow {
  tenant_id: string; alias: string; display_name: string | null; enabled: boolean; harness_id: string | null;
  max_concurrent_deliveries: number | null; container_name: string | null; runtime_user: string | null;
  home_directory: string | null; state_directory: string | null; host_id: string | null;
}
async function docker(args: string[]): Promise<string> {
  return (await execute('docker', args, { timeout: 20_000, maxBuffer: 1024 * 1024 })).stdout.trim();
}
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected an object receipt');
  return value as Record<string, unknown>;
}
function responseForChange(page: BrowserPage): Promise<ChangeResponse> {
  return new Promise((resolve) => {
    let pending = true;
    page.on('response', (value) => {
      if (!pending) return;
      const response = value as typeof value & { json(): Promise<unknown> };
      if (new URL(response.url()).pathname !== '/v3/console/config/changes' || response.request().method() !== 'POST') return;
      pending = false;
      void response.json().then((body) => { resolve({ status: response.status(), body }); })
        .catch(() => { resolve({ status: response.status(), body: { error: 'response_json_unavailable' } }); });
    });
  });
}
function requestForChange(page: BrowserPage): Promise<ChangeRequest> {
  return new Promise((resolve) => {
    let pending = true;
    page.on('request', (value) => {
      if (!pending) return;
      const request = value as { url(): string; method(): string; postData(): string | null };
      if (new URL(request.url()).pathname !== '/v3/console/config/changes' || request.method() !== 'POST') return;
      pending = false;
      try { resolve(JSON.parse(request.postData() ?? 'null') as ChangeRequest); }
      catch { resolve({}); }
    });
  });
}
async function login(page: BrowserPage, email: string, password: string): Promise<void> {
  const response = await page.goto(fixture?.baseUrl ?? '', { waitUntil: 'domcontentloaded' });
  expect(response?.status()).toBe(200);
  await page.getByLabel('Correo').waitFor({ timeout: 20_000 });
  await page.getByLabel('Correo').fill(email);
  await page.getByLabel('Contraseña').fill(password);
  await page.getByRole('button', { name: 'Iniciar sesión' }).click();
  await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).locator('a[href="/messages"], a[href^="/messages/"]').waitFor({ state: 'visible', timeout: 20_000 });
  await page.goto(`${fixture?.baseUrl ?? ''}/config`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('tab', { name: 'Agentes', exact: true }).click();
}
async function openEditor(page: BrowserPage, tenant: string, alias: string): Promise<void> {
  await page.getByLabel('Buscar agente o grupo').fill(tenant === 'Steven' ? 'QA' : alias);
  await page.getByRole('button', { name: `Acciones de ${tenant}/${alias}`, exact: true }).click();
  await page.getByRole('menuitem', { name: 'Editar registro', exact: true }).click();
  await page.getByRole('region', { name: `Registro de ${tenant}/${alias}`, exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
}
async function closeEditor(page: BrowserPage): Promise<void> {
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Cerrar', exact: true }).click();
  await dialog.waitFor({ state: 'hidden', timeout: 20_000 });
}
async function authenticatedChange(page: BrowserPage, request: ChangeRequest): Promise<ChangeResponse> {
  return page.evaluate(async (payload) => {
    const sessionResponse = await fetch('/v3/auth/session', { credentials: 'include' });
    const session = await sessionResponse.json() as { csrf_token?: string };
    if (sessionResponse.status !== 200 || !session.csrf_token) throw new Error('authenticated browser session is unavailable');
    const response = await fetch('/v3/console/config/changes', {
      method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', 'x-csrf-token': session.csrf_token },
      body: JSON.stringify(payload),
    });
    return { status: response.status, body: await response.json() as unknown };
  }, request);
}
async function openMutationEditor(page: BrowserPage) {
  await page.getByRole('tab', { name: 'Avanzado', exact: true }).click();
  const editor = page.locator('details').filter({ hasText: 'Editor de mutaciones JSON' });
  await editor.locator('summary').click();
  await editor.getByRole('textbox', { name: 'Mutación JSON', exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
  return editor;
}
async function readAgent(page: BrowserPage, tenant: string, alias: string): Promise<{
  status: number; revision: number; agent: AgentRow | undefined;
}> {
  return page.evaluate(async ({ tenantId, agentAlias }) => {
    const response = await fetch('/v3/console/config', { credentials: 'include' });
    const body = await response.json() as { revision?: number; agents?: AgentRow[] };
    return {
      status: response.status, revision: body.revision ?? -1,
      agent: body.agents?.find((row) => row.tenant_id === tenantId && row.alias === agentAlias),
    };
  }, { tenantId: tenant, agentAlias: alias });
}
async function durable(tenant: string, alias: string): Promise<AgentRow | undefined> {
  if (!fixture) throw new Error('fixture is unavailable');
  const rows = await fixture.database.pool.query<AgentRow>(
    `SELECT tenant_id,alias,display_name,enabled,harness_id,max_concurrent_deliveries,
            container_name,runtime_user,home_directory,state_directory,host_id
     FROM agents WHERE tenant_id=$1 AND alias=$2`, [tenant, alias],
  );
  return rows.rows[0];
}
async function revisionCounts(tenant: string, alias: string): Promise<number> {
  if (!fixture) throw new Error('fixture is unavailable');
  const result = await fixture.database.pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM config_revisions
     WHERE operation->>'resource'='agent' AND operation->>'tenant_id'=$1 AND operation->>'alias'=$2`,
    [tenant, alias],
  );
  return result.rows[0]?.count ?? 0;
}
async function assertNoMutation(page: BrowserPage, tenant: string, alias: string, expected: AgentRow | undefined, revisions: number, durableExpected: AgentRow | undefined = expected): Promise<void> {
  expect(await durable(tenant, alias)).toEqual(durableExpected);
  expect(await revisionCounts(tenant, alias)).toBe(revisions);
  const remote = (await readAgent(page, tenant, alias)).agent;
  if (expected) expect(remote).toMatchObject(expected);
  else expect(remote).toBeUndefined();
}
async function captureOwnedResources(): Promise<void> {
  if (!fixture || !evidenceDirectory) throw new Error('owned fixture/evidence path is unavailable');
  const postgres = fixture.database.container.getId();
  const postgresRow = JSON.parse(await docker(['inspect', '--format', '{{json .}}', postgres])) as {
    Id: string; Config: { Labels: Record<string, string> }; Mounts: { Name?: string }[];
  };
  const volumes = postgresRow.Mounts.map((mount) => mount.Name).filter((name): name is string => Boolean(name));
  const browserRow = JSON.parse(await docker(['inspect', '--format', '{{json .}}', fixture.browserContainer])) as {
    Id: string; Config: { Labels: Record<string, string> };
    NetworkSettings: { Networks: Record<string, { NetworkID: string }> };
  };
  const browser = browserRow.Id;
  const owner = browserRow.Config.Labels['cauce.e2e.owner'];
  const networks = Object.values(browserRow.NetworkSettings.Networks);
  const image = fixture.browserRuntime.imageId;
  const imageRow = JSON.parse(await docker(['image', 'inspect', '--format', '{{json .}}', image])) as {
    Id: string; Config: { Labels: Record<string, string> };
  };
  if (postgresRow.Id !== postgres || postgresRow.Config.Labels['org.testcontainers'] !== 'true'
      || volumes.length !== 1 || !browser || owner !== 'ui-functional' || networks.length !== 1
      || imageRow.Id !== image || imageRow.Config.Labels['cauce.e2e.owner'] !== 'ui-functional'
      || !fixture.browserRuntime.owned) throw new Error('Testcontainers/browser ownership was not exact and independently verifiable');
  const network = networks[0]?.NetworkID;
  const volume = volumes[0];
  if (!network || !volume) throw new Error('owned network or volume identity is missing');
  const networkRow = JSON.parse(await docker(['network', 'inspect', '--format', '{{json .}}', network])) as {
    Id: string; Internal: boolean; Labels: Record<string, string>; Containers: Record<string, unknown>;
  };
  const networkOwner = networkRow.Labels['cauce.e2e.owner'];
  if (networkRow.Id !== network || !networkRow.Internal || !/^[0-9a-f-]{36}$/iu.test(networkOwner ?? '')
      || Object.keys(networkRow.Containers).length !== 1 || !networkRow.Containers[browser]) {
    throw new Error('private browser network identity or owner label differs');
  }
  resources = { postgres, browser, network, volume, image };
  await writeFile(`${evidenceDirectory}/resources-before.json`, JSON.stringify({
    postgres: { id: postgres, label: postgresRow.Config.Labels['org.testcontainers'], mounts: volumes },
    browser: { id: browser, owner, network }, networkOwner, volume, image,
  }, null, 2) + '\n', { mode: 0o600 });
}
async function exists(kind: 'container' | 'network' | 'volume' | 'image', id: string): Promise<boolean> {
  const args = kind === 'container' ? ['inspect', '--format', '{{.Id}}', id]
    : kind === 'network' ? ['network', 'inspect', '--format', '{{.Id}}', id]
      : kind === 'volume' ? ['volume', 'inspect', '--format', '{{.Name}}', id]
        : ['image', 'inspect', '--format', '{{.Id}}', id];
  try { await docker(args); return true; }
  catch (cause) {
    if (cause instanceof Error && /no such (?:object|container|network|volume|image)|not found/iu.test(cause.message)) return false;
    throw new Error(`could not verify owned ${kind} cleanup`);
  }
}
async function verifyCleanup(): Promise<void> {
  if (!resources || !evidenceDirectory) throw new Error('owned resource IDs were not captured');
  const absent = {
    postgres: !(await exists('container', resources.postgres)), browser: !(await exists('container', resources.browser)),
    network: !(await exists('network', resources.network)), volume: !(await exists('volume', resources.volume)),
    image: !(await exists('image', resources.image)),
  };
  await writeFile(`${evidenceDirectory}/resources-after.json`, JSON.stringify({ resources, absent }, null, 2) + '\n', { mode: 0o600 });
  expect(absent).toEqual({ postgres: true, browser: true, network: true, volume: true, image: true });
}
beforeAll(async () => {
  if (process.env.CAUCE_REQUIRE_TESTCONTAINERS !== '1' || process.env.CAUCE_TEST_DATABASE_URL !== undefined
      || process.env.DATABASE_URL !== undefined || process.env.CAUCE_TEST_DOCKER_NETWORK !== undefined
      || process.env.CAUCE_TEST_DOCKER_NETWORK_OWNER !== undefined || process.env.VITE_USE_MOCKS === 'true') {
    throw new Error('agent registry E2E requires its own Testcontainers fixture and rejects external DB/network/mock mode');
  }
  const configured = process.env[evidenceSetting];
  evidenceDirectory = configured ?? await mkdtemp(join(tmpdir(), 'cauce-agent-reg-'));
  if (evidenceDirectory.trim().length === 0) throw new Error(`${evidenceSetting} must not be empty`);
  await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
  await chmod(evidenceDirectory, 0o700);
  fixture = await startConsoleFunctionalFixture();
  if (!fixture.browserRuntime.owned) throw new Error('external browser images are not accepted');
  await captureOwnedResources();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
  const tenant = 'Steven';
  const room = `grp.${suffix}`;
  const actor = `operator${suffix}`;
  const alias = `managed${suffix}`;
  const email = `hub-${suffix}@cauce.test`;
  const password = randomBytes(24).toString('base64url');
  const directory = `/home/qa-${suffix}`;
  await fixture.database.pool.query('INSERT INTO rooms(id,tenant_id) VALUES($1,$2)', [room, tenant]);
  await fixture.database.pool.query(
    `INSERT INTO agents(tenant_id,alias,harness_id,display_name,enabled,container_name,runtime_user,
                        home_directory,state_directory,max_concurrent_deliveries)
     VALUES($1,$2,'fake',$3,true,$4,'runner',$5,$6,1)`,
    [tenant, actor, 'QA operator', `operator-${suffix}`, directory, `${directory}/.state`],
  );
  await fixture.database.pool.query(
    `INSERT INTO agents(tenant_id,alias,harness_id,display_name,enabled,container_name,runtime_user,
                        home_directory,state_directory,max_concurrent_deliveries)
     VALUES($1,$2,'fake',$3,true,$4,'runner',$5,$6,1)`,
    [tenant, alias, 'QA managed agent', `managed-${suffix}`, directory, `${directory}/.state`],
  );
  await fixture.database.pool.query(
    "INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES($1,$2,$3,'operator'),($1,$2,$4,'agent')",
    [tenant, room, actor, alias],
  );
  const person = await maintainConsoleUser(fixture.database.pool, {
    email, name: 'QA registry operator', role: 'operator', tenant, alias: actor, updateOnly: false, activate: true,
  }, await hashPassword(password));
  await fixture.database.pool.query(
    "INSERT INTO company_admins(company_id,human_id,role,source,granted_by) VALUES('humanizar',$1,'admin','platform',$1)", [person.id],
  );
  hub = { tenant, actor, alias, email, password, humanId: person.id };
  await writeFile(`${evidenceDirectory}/fixture.json`, JSON.stringify({ tenant, actor, alias, viewport: [1440, 360] }, null, 2) + '\n', { mode: 0o600 });
}, 10 * 60_000);
afterAll(async () => {
  const errors: unknown[] = [];
  if (fixture) {
    const active = fixture;
    try { await active.close(); } catch (cause) { errors.push(cause); }
    fixture = undefined;
  }
  if (resources) {
    try { await verifyCleanup(); } catch (cause) { errors.push(cause); }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'agent registry browser fixture cleanup was incomplete');
});
describe('V1 tipada de edición del registro de agentes', () => {
  it('actualiza por fila a 1440 y 360; el control no-hub recibe 403 en su tenant y en el hub', async () => {
    if (!fixture || !hub || !evidenceDirectory) throw new Error('isolated fixture or hub identity is unavailable');
    const active = fixture;
    const identity = hub;
    const hubPage = await newTrustedPage(active, { width: 1440, height: 900 });
    const browserErrors: string[] = [];
    hubPage.on('pageerror', (error) => { browserErrors.push(String(error)); });
    await login(hubPage, identity.email, identity.password);
    const initial = await readAgent(hubPage, identity.tenant, identity.alias);
    expect(initial.status).toBe(200);
    expect(initial.agent).toMatchObject({ display_name: 'QA managed agent', max_concurrent_deliveries: 1 });
    const before = await durable(identity.tenant, identity.alias);
    const revisionBefore = await revisionCounts(identity.tenant, identity.alias);
    if (!before) throw new Error('hub target row was not seeded');
    await openEditor(hubPage, identity.tenant, identity.alias);
    const registryEditor = hubPage.getByRole('region', { name: `Registro de ${identity.tenant}/${identity.alias}`, exact: true });
    const displayName = `QA registry updated ${identity.alias}`;
    for (const label of ['Tenant', 'Alias', 'Nombre del contenedor', 'Usuario de runtime', 'Directorio home', 'Directorio de estado', 'ID del arnés', 'Cuenta principal']) {
      for (const role of ['textbox', 'combobox', 'spinbutton']) expect(await registryEditor.getByRole(role, { name: label, exact: true }).count()).toBe(0);
    }
    await registryEditor.getByRole('textbox', { name: 'Nombre visible', exact: true }).fill(displayName);
    await registryEditor.getByRole('combobox', { name: 'Estado del registro', exact: true }).selectOption('false');
    await registryEditor.getByRole('spinbutton', { name: 'Máximo de entregas concurrentes', exact: true }).fill('');
    await registryEditor.getByRole('checkbox', { name: /Sin límite/ }).click();
    await assertAgentRegistryGeometry(hubPage, evidenceDirectory, 'desktop', `${identity.tenant}/${identity.alias}`);
    const mutation: ConfigMutation = {
      resource: 'agent', action: 'update', tenant_id: identity.tenant, alias: identity.alias,
      value: {
        display_name: displayName, enabled: false, max_concurrent_deliveries: null,
      },
    };
    await hubPage.evaluate(() => document.querySelector('section[aria-label^="Registro de "]')?.scrollIntoView({ block: 'start' }));
    await hubPage.screenshot({ path: `${evidenceDirectory}/hub-editor-desktop-before-preview.png` });
    await hubPage.setViewportSize({ width: 360, height: 800 });
    await assertAgentRegistryGeometry(hubPage, evidenceDirectory, 'mobile', `${identity.tenant}/${identity.alias}`);
    await hubPage.evaluate(() => document.querySelector('section[aria-label^="Registro de "]')?.scrollIntoView({ block: 'start' }));
    await hubPage.screenshot({ path: `${evidenceDirectory}/hub-editor-mobile-before-apply.png` });
    const previewResponse = responseForChange(hubPage);
    const previewRequest = requestForChange(hubPage);
    await hubPage.getByRole('button', { name: 'Previsualizar cambio' }).click();
    const preview = hubPage.getByLabel('Preview del registro de agente');
    await preview.waitFor({ state: 'visible', timeout: 20_000 });
    expect(object(JSON.parse(await preview.innerText())).mutation).toEqual(mutation);
    const previewNetwork = await previewResponse;
    expect(previewNetwork.status).toBe(200);
    expect(object(previewNetwork.body)).toMatchObject({ applied: false, dry_run: true, mutation });
    expect(await previewRequest).toMatchObject({ dry_run: true, expected_revision: initial.revision, mutation });
    expect(await durable(identity.tenant, identity.alias)).toEqual(before);
    expect(await revisionCounts(identity.tenant, identity.alias)).toBe(revisionBefore);
    const applyResponse = responseForChange(hubPage);
    const applyRequest = requestForChange(hubPage);
    await hubPage.getByRole('button', { name: 'Aplicar cambio' }).click();
    const appliedNotice = hubPage.getByRole('status').filter({ hasText: `Aplicado en revisión` });
    await appliedNotice.waitFor({ state: 'visible', timeout: 20_000 });
    const applyNetwork = await applyResponse;
    expect(applyNetwork.status).toBe(201);
    expect(await applyRequest).toMatchObject({ dry_run: false, expected_revision: initial.revision, mutation });
    const receipt = object(applyNetwork.body);
    expect(receipt).toMatchObject({ applied: true, dry_run: false, mutation, rolled_back_revision_id: null });
    expect(Number.isSafeInteger(receipt.revision)).toBe(true);
    const revision = Number(receipt.revision);
    const inverse = object(receipt.inverse_mutation);
    expect(inverse).toMatchObject({ resource: 'agent', action: 'update', tenant_id: identity.tenant, alias: identity.alias });
    expect(object(inverse.value)).toEqual({
      harness_id: before.harness_id, display_name: before.display_name, enabled: before.enabled,
      container_name: before.container_name, runtime_user: before.runtime_user, home_directory: before.home_directory,
      state_directory: before.state_directory, max_concurrent_deliveries: before.max_concurrent_deliveries,
      primary_room_id: null, host_id: before.host_id,
    });
    expect(await hubPage.getByText(`Aplicado en revisión ${String(revision)}`).count()).toBeGreaterThan(0);
    expect(await readAgent(hubPage, identity.tenant, identity.alias)).toMatchObject({
      status: 200, revision,
      agent: {
        tenant_id: identity.tenant, alias: identity.alias, display_name: displayName, enabled: false,
        max_concurrent_deliveries: null, harness_id: before.harness_id, container_name: before.container_name,
        runtime_user: before.runtime_user, home_directory: before.home_directory, state_directory: before.state_directory, host_id: before.host_id,
      },
    });
    const durableAfter = await durable(identity.tenant, identity.alias);
    expect(durableAfter).toMatchObject({
      tenant_id: identity.tenant, alias: identity.alias, display_name: displayName, enabled: false,
      max_concurrent_deliveries: null, harness_id: before.harness_id, container_name: before.container_name,
      runtime_user: before.runtime_user, home_directory: before.home_directory, state_directory: before.state_directory, host_id: before.host_id,
    });
    expect(await revisionCounts(identity.tenant, identity.alias)).toBe(revisionBefore + 1);
    const revisionRow = await active.database.pool.query<{ actor_tenant: string; actor_alias: string; operation: unknown; inverse_operation: unknown }>(
      'SELECT actor_tenant,actor_alias,actor_human_id::text,company_id,operation,inverse_operation FROM config_revisions WHERE id=$1', [revision],
    );
    expect(revisionRow.rows).toHaveLength(1);
    expect(revisionRow.rows[0]).toMatchObject({ actor_tenant: identity.tenant, actor_alias: identity.actor, actor_human_id: identity.humanId, company_id: 'humanizar', operation: mutation, inverse_operation: inverse });
    const audit = await active.database.pool.query<{ tenant_id: string; actor_alias: string; action: string; decision: string; metadata: unknown }>(
      `SELECT tenant_id,actor_alias,action,decision,metadata FROM audit_events
       WHERE tenant_id=$1 AND actor_alias=$2 AND action='config.change' AND metadata->>'revision'=$3`,
      [identity.tenant, identity.actor, String(revision)],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ tenant_id: identity.tenant, actor_alias: identity.actor, action: 'config.change', decision: 'allow' });
    expect(object(audit.rows[0]?.metadata)).toMatchObject({ revision, mutation });
    await hubPage.screenshot({ path: `${evidenceDirectory}/hub-editor-mobile-applied.png` });
    expect(await registryEditor.count()).toBe(1);
    expect(browserErrors).toEqual([]);
    await hubPage.setViewportSize({ width: 1440, height: 900 });
    await closeEditor(hubPage);
    await assertAgentRegistryGeometry(hubPage, evidenceDirectory, 'desktop-closed', `${identity.tenant}/${identity.alias}`);
    const jsonEditor = await openMutationEditor(hubPage);
    let diagnosticPosts = 0;
    hubPage.on('request', (value) => {
      const request = value as { url(): string; method(): string };
      if (new URL(request.url()).pathname === '/v3/console/config/changes' && request.method() === 'POST') diagnosticPosts += 1;
    });
    await hubPage.getByLabel('Mutación JSON', { exact: true }).fill(JSON.stringify({
      resource: 'agent', action: 'update', tenant_id: identity.tenant, alias: identity.alias, value: { role_brief: 'forbidden diagnostic write' },
    }));
    await hubPage.getByRole('button', { name: 'Preview / dry-run', exact: true }).click();
    await jsonEditor.getByRole('alert').waitFor({ timeout: 20_000 });
    expect(await jsonEditor.getByRole('alert').innerText()).toMatch(/sólo lectura/u);
    expect(diagnosticPosts).toBe(0);
    await assertNoMutation(hubPage, identity.tenant, identity.alias, durableAfter, revisionBefore + 1);
    await hubPage.getByLabel('Mutación JSON', { exact: true }).fill(JSON.stringify({
      resource: 'agent', action: 'update', tenant_id: identity.tenant, alias: identity.alias, value: { runtime_key: 'forbidden-runtime' },
    }));
    await hubPage.getByRole('button', { name: 'Preview / dry-run', exact: true }).click();
    await jsonEditor.getByRole('alert').filter({ hasText: 'runtime_key' }).waitFor({ timeout: 20_000 });
    expect(diagnosticPosts).toBe(0);
    await assertNoMutation(hubPage, identity.tenant, identity.alias, durableAfter, revisionBefore + 1);
    await writeFile(`${evidenceDirectory}/json-write-boundaries.json`, JSON.stringify({ roleBrief: { rejectedLocally: true, posts: 0 }, runtimeKey: { rejectedLocally: true, posts: 0 }, writes: 0 }, null, 2) + '\n', { mode: 0o600 });
    const nonHubPage = await newTrustedPage(active, { width: 360, height: 800 });
    await login(nonHubPage, isaTenant.email, isaTenant.password);
    const ownTarget = { tenant: isaTenant.tenant, alias: isaTenant.target };
    const ownBefore = await durable(ownTarget.tenant, ownTarget.alias);
    const ownRevisions = await revisionCounts(ownTarget.tenant, ownTarget.alias);
    if (!ownBefore) throw new Error('negative case lacks registered own-tenant target');
    let negativePosts = 0;
    nonHubPage.on('request', (value) => {
      const request = value as { url(): string; method(): string };
      if (new URL(request.url()).pathname === '/v3/console/config/changes' && request.method() === 'POST') negativePosts += 1;
    });
    await openEditor(nonHubPage, ownTarget.tenant, ownTarget.alias);
    const disabledControls = await nonHubPage.evaluate((target) => {
      const section = Array.from(document.querySelectorAll('section[aria-label]')).find((item) => item.getAttribute('aria-label') === `Registro de ${target}`);
      return Array.from(section?.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button') ?? [])
        .map((control) => ({ label: control.getAttribute('aria-label') ?? control.textContent.trim(), disabled: control.disabled }));
    }, `${ownTarget.tenant}/${ownTarget.alias}`);
    expect(disabledControls.length).toBeGreaterThanOrEqual(6);
    expect(disabledControls.every((control) => control.disabled)).toBe(true);
    expect(negativePosts).toBe(0);
    await assertNoMutation(nonHubPage, ownTarget.tenant, ownTarget.alias, ownBefore, ownRevisions);
    const denialRequestBody = { expected_revision: (await readAgent(nonHubPage, ownTarget.tenant, ownTarget.alias)).revision,
      dry_run: true, mutation: { resource: 'agent', action: 'update', tenant_id: ownTarget.tenant, alias: ownTarget.alias, value: { display_name: `forbidden-${ownTarget.alias}` } } };
    const denial = await authenticatedChange(nonHubPage, denialRequestBody);
    await nonHubPage.screenshot({ path: `${evidenceDirectory}/nonhub-own-denied-360.png` });
    const denialBody = object(denial.body);
    await writeFile(`${evidenceDirectory}/nonhub-own-403.json`, JSON.stringify({ status: denial.status,
      error: denialBody.error, message: typeof denialBody.message === 'string' ? denialBody.message.slice(0, 300) : '',
      request: denialRequestBody, disabledControls, uiPosts: 0, authenticatedPosts: negativePosts, writes: 0 }, null, 2) + '\n', { mode: 0o600 });
    expect(denial.status).toBe(403);
    expect(denialBody.error).toBe('forbidden');
    expect(denialBody.message).not.toMatch(/CSRF|sesión|session/iu);
    expect(negativePosts).toBe(1);
    await assertNoMutation(nonHubPage, ownTarget.tenant, ownTarget.alias, ownBefore, ownRevisions);
    await closeEditor(nonHubPage);
    const foreign = { tenant: identity.tenant, alias: identity.alias };
    const foreignBefore = await durable(foreign.tenant, foreign.alias);
    const foreignRevisions = await revisionCounts(foreign.tenant, foreign.alias);
    const visibleSnapshot = await readAgent(nonHubPage, foreign.tenant, foreign.alias);
    expect(visibleSnapshot.status).toBe(200);
    expect(visibleSnapshot.agent).toBeUndefined();
    expect(await nonHubPage.getByRole('button', { name: `Acciones de ${foreign.tenant}/${foreign.alias}`, exact: true }).count()).toBe(0);
    const foreignMutation = { resource: 'agent', action: 'update', tenant_id: foreign.tenant, alias: foreign.alias, value: { enabled: false } };
    const foreignRequest = { expected_revision: visibleSnapshot.revision, dry_run: true, mutation: foreignMutation };
    const foreignNetwork = await authenticatedChange(nonHubPage, foreignRequest);
    const foreignDenial = { status: foreignNetwork.status, body: object(foreignNetwork.body) };
    await writeFile(`${evidenceDirectory}/nonhub-foreign-403.json`, JSON.stringify({ status: foreignDenial.status,
      error: foreignDenial.body.error, message: typeof foreignDenial.body.message === 'string' ? foreignDenial.body.message.slice(0, 300) : '',
      request: foreignRequest, uiRowVisible: false, uiPosts: 0, authenticatedPosts: negativePosts, writes: 0 }, null, 2) + '\n', { mode: 0o600 });
    expect(foreignDenial.status).toBe(403);
    expect(foreignDenial.body.error).toBe('forbidden');
    expect(foreignDenial.body.message).not.toMatch(/CSRF|sesión|session/iu);
    expect(negativePosts).toBe(2);
    expect(await durable(foreign.tenant, foreign.alias)).toEqual(foreignBefore);
    await assertNoMutation(nonHubPage, foreign.tenant, foreign.alias, undefined, foreignRevisions, foreignBefore);
  }, 240_000);
});
