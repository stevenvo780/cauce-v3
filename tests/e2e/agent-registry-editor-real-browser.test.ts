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
let hub: { tenant: string; actor: string; alias: string; email: string; password: string } | undefined;
interface ConfigMutation {
  resource: 'agent'; action: 'update'; tenant_id: string; alias: string; value: Record<string, unknown>;
}
interface ChangeResponse { status: number; body: unknown }
interface ChangeRequest { expected_revision?: number; dry_run?: boolean; mutation?: unknown }
interface AgentRow {
  tenant_id: string; alias: string; display_name: string | null; enabled: boolean; harness_id: string | null;
  max_concurrent_deliveries: number | null; container_name: string | null; runtime_user: string | null;
  home_directory: string | null; state_directory: string | null;
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
}
async function openEditor(page: BrowserPage, tenant: string, alias: string): Promise<void> {
  await page.getByRole('button', { name: `Editar registro de ${tenant}/${alias}` }).click();
  await page.getByRole('heading', { name: `Registro · ${tenant}/${alias}` }).waitFor({ state: 'visible', timeout: 20_000 });
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
            container_name,runtime_user,home_directory,state_directory
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
async function applyDisabled(page: BrowserPage): Promise<boolean> {
  return page.evaluate(() => {
    const button = Array.from(document.querySelectorAll('button')).find((item) => item.textContent.trim() === 'Aplicar cambio');
    return button?.disabled ?? false;
  });
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
  await maintainConsoleUser(fixture.database.pool, {
    email, name: 'QA registry operator', role: 'operator', tenant, alias: actor, updateOnly: false, activate: true,
  }, await hashPassword(password));
  hub = { tenant, actor, alias, email, password };
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
    expect(await hubPage.getByLabel('Tenant').count()).toBe(0);
    expect(await hubPage.getByLabel('Alias').count()).toBe(0);
    const displayName = `QA registry updated ${identity.alias}`;
    const changedContainer = `updated-${identity.alias}`;
    const changedRuntimeUser = `runner-${identity.alias}`;
    const changedHome = `/home/${identity.alias}`;
    const changedState = `${changedHome}/.state`;
    await hubPage.getByLabel('Nombre visible').fill(displayName);
    await hubPage.getByLabel('Estado del registro').selectOption('false');
    await hubPage.getByLabel('Máximo de entregas concurrentes').fill('');
    await hubPage.getByRole('checkbox', { name: /Sin límite/ }).click();
    await hubPage.getByLabel('Nombre del contenedor').fill(changedContainer);
    await hubPage.getByLabel('Usuario de runtime').fill(changedRuntimeUser);
    await hubPage.getByLabel('Directorio home').fill(changedHome);
    await hubPage.getByLabel('Directorio de estado').fill(changedState);
    await assertAgentRegistryGeometry(hubPage, evidenceDirectory, 'desktop', `${identity.tenant}/${identity.alias}`);
    const mutation: ConfigMutation = {
      resource: 'agent', action: 'update', tenant_id: identity.tenant, alias: identity.alias,
      value: {
        display_name: displayName, enabled: false, max_concurrent_deliveries: null,
        container_name: changedContainer, runtime_user: changedRuntimeUser,
        home_directory: changedHome, state_directory: changedState,
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
    });
    expect(await hubPage.getByText(`Aplicado en revisión ${String(revision)}`).count()).toBeGreaterThan(0);
    expect(await readAgent(hubPage, identity.tenant, identity.alias)).toMatchObject({
      status: 200, revision,
      agent: {
        tenant_id: identity.tenant, alias: identity.alias, display_name: displayName, enabled: false,
        max_concurrent_deliveries: null, container_name: changedContainer,
        runtime_user: changedRuntimeUser, home_directory: changedHome, state_directory: changedState,
      },
    });
    const durableAfter = await durable(identity.tenant, identity.alias);
    expect(durableAfter).toMatchObject({
      tenant_id: identity.tenant, alias: identity.alias, display_name: displayName, enabled: false,
      max_concurrent_deliveries: null, container_name: changedContainer,
      runtime_user: changedRuntimeUser, home_directory: changedHome, state_directory: changedState,
    });
    expect(await revisionCounts(identity.tenant, identity.alias)).toBe(revisionBefore + 1);
    const revisionRow = await active.database.pool.query<{ actor_tenant: string; actor_alias: string; operation: unknown; inverse_operation: unknown }>(
      'SELECT actor_tenant,actor_alias,operation,inverse_operation FROM config_revisions WHERE id=$1', [revision],
    );
    expect(revisionRow.rows).toHaveLength(1);
    expect(revisionRow.rows[0]).toMatchObject({ actor_tenant: identity.tenant, actor_alias: identity.actor, operation: mutation, inverse_operation: inverse });
    const audit = await active.database.pool.query<{ tenant_id: string; actor_alias: string; action: string; decision: string; metadata: unknown }>(
      `SELECT tenant_id,actor_alias,action,decision,metadata FROM audit_events
       WHERE tenant_id=$1 AND actor_alias=$2 AND action='config.change' AND metadata->>'revision'=$3`,
      [identity.tenant, identity.actor, String(revision)],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ tenant_id: identity.tenant, actor_alias: identity.actor, action: 'config.change', decision: 'allow' });
    expect(object(audit.rows[0]?.metadata)).toMatchObject({ revision, mutation });
    await hubPage.screenshot({ path: `${evidenceDirectory}/hub-editor-mobile-applied.png` });
    expect(await hubPage.getByRole('heading', { name: `Registro · ${identity.tenant}/${identity.alias}` }).count()).toBe(1);
    expect(browserErrors).toEqual([]);
    await hubPage.setViewportSize({ width: 1440, height: 900 });
    await hubPage.getByRole('button', { name: `Cerrar registro de ${identity.tenant}/${identity.alias}` }).click();
    await assertAgentRegistryGeometry(hubPage, evidenceDirectory, 'desktop-closed', `${identity.tenant}/${identity.alias}`);
    const nonHubPage = await newTrustedPage(active, { width: 360, height: 800 });
    await login(nonHubPage, isaTenant.email, isaTenant.password);
    const ownTarget = { tenant: isaTenant.tenant, alias: isaTenant.target };
    const ownBefore = await durable(ownTarget.tenant, ownTarget.alias);
    const ownRevisions = await revisionCounts(ownTarget.tenant, ownTarget.alias);
    if (!ownBefore) throw new Error('negative case lacks registered own-tenant target');
    await openEditor(nonHubPage, ownTarget.tenant, ownTarget.alias);
    await nonHubPage.getByLabel('Nombre visible').fill(`forbidden-${ownTarget.alias}`);
    const deniedResponse = responseForChange(nonHubPage);
    const deniedRequest = requestForChange(nonHubPage);
    await nonHubPage.getByRole('button', { name: 'Previsualizar cambio' }).click();
    const deniedNotice = nonHubPage.getByRole('alert');
    await deniedNotice.waitFor({ state: 'visible', timeout: 20_000 });
    const denial = await deniedResponse;
    const denialText = await deniedNotice.innerText();
    const denialRequestBody = await deniedRequest;
    await nonHubPage.screenshot({ path: `${evidenceDirectory}/nonhub-own-denied-360.png` });
    const denialBody = object(denial.body);
    await writeFile(`${evidenceDirectory}/nonhub-own-403.json`, JSON.stringify({ status: denial.status,
      error: denialBody.error, message: typeof denialBody.message === 'string' ? denialBody.message.slice(0, 300) : '',
      request: denialRequestBody }, null, 2) + '\n', { mode: 0o600 });
    expect(denial.status).toBe(403);
    expect(denialText).toMatch(/forbidden|control|configuración|403|actor tenant/iu);
    expect(await applyDisabled(nonHubPage)).toBe(true);
    await assertNoMutation(nonHubPage, ownTarget.tenant, ownTarget.alias, ownBefore, ownRevisions);
    await nonHubPage.getByRole('button', { name: 'Cerrar editor' }).click();
    const foreign = { tenant: identity.tenant, alias: identity.alias };
    const foreignBefore = await durable(foreign.tenant, foreign.alias);
    const foreignRevisions = await revisionCounts(foreign.tenant, foreign.alias);
    const visibleSnapshot = await readAgent(nonHubPage, foreign.tenant, foreign.alias);
    expect(visibleSnapshot.status).toBe(200);
    expect(visibleSnapshot.agent).toBeUndefined();
    expect(await nonHubPage.getByRole('button', { name: `Editar registro de ${foreign.tenant}/${foreign.alias}` }).count()).toBe(0);
    const foreignDenial = await nonHubPage.evaluate(async ({ tenantId, agentAlias, expectedRevision }) => {
      const session = await fetch('/v3/auth/session', { credentials: 'include' }).then((response) => response.json()) as { csrf_token?: string };
      const response = await fetch('/v3/console/config/changes', { method: 'POST', credentials: 'include', headers: {
        Accept: 'application/json', 'Content-Type': 'application/json', 'X-Cauce-Console': '1',
        ...(session.csrf_token ? { 'X-CSRF-Token': session.csrf_token } : {}),
      }, body: JSON.stringify({ expected_revision: expectedRevision, dry_run: true, mutation: {
        resource: 'agent', action: 'update', tenant_id: tenantId, alias: agentAlias, value: { enabled: false },
      } }) });
      const body = await response.json() as Record<string, unknown>;
      return { status: response.status, body };
    }, { tenantId: foreign.tenant, agentAlias: foreign.alias, expectedRevision: visibleSnapshot.revision });
    await writeFile(`${evidenceDirectory}/nonhub-foreign-403.json`, JSON.stringify({ status: foreignDenial.status,
      error: foreignDenial.body.error, message: typeof foreignDenial.body.message === 'string' ? foreignDenial.body.message.slice(0, 300) : '',
      uiRowVisible: false }, null, 2) + '\n', { mode: 0o600 });
    expect(foreignDenial.status).toBe(403);
    expect(await durable(foreign.tenant, foreign.alias)).toEqual(foreignBefore);
    await assertNoMutation(nonHubPage, foreign.tenant, foreign.alias, undefined, foreignRevisions, foreignBefore);
  }, 240_000);
});
