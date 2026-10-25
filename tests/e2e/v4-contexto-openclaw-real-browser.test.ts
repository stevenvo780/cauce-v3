import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FleetCapability } from '@cauce/protocol/fleet-operation';
import { newTrustedPage, startConsoleFunctionalFixture } from './console-functional-browser.fixtures.js';
import {
  apiGet, asV4Page, BrowserErrorLog, fillRegistration, HERMETIC_INSTANCE_RULES,
  openRegistration, syntheticPerson, type V4Page,
} from './v4-console-real-browser.helpers.js';

const task = 'p2-nativo-501-openclaw-1025';
const run = randomUUID().replaceAll('-', '').slice(0, 8);
const company = 'zz-canary-p2-nativo-501-openclaw-1025';
const hostId = `p2host${run}`;
const runtimeKey = `oc${run}`;
const runtimeUser = 'runner';
const home = '/tmp/cauce-p2-home';
const stateRoot = '/tmp/cauce-p2-state';
const prefix = 'zzp2';
const openclawAlias = `zzoc${run}`;
const codexAlias = `zzcx${run}`;
const accountId = `p2acct${run}`;
const directory = join(process.cwd(), '.delegados/v4/recibos', task);
const desktop = { width: 1440, height: 900 };
const phone = { width: 390, height: 844 };
const person = syntheticPerson('openclaw', run);
person.company = { name: 'Empresa P2', slug: company };
const fleet: FleetCapability = {
  available: true, actions: ['stop', 'start'], placements: [{
    host_id: hostId, modes: ['container'], runtime_users: [runtimeUser], systemd_users: [],
    home_roots: [home], state_roots: [stateRoot], runtimes: [{
      mode: 'container', harness_id: 'openclaw', provider: 'openclaw', runtime_user: runtimeUser,
      home_directory: home, state_root: stateRoot, container_prefix: prefix,
    }],
  }],
};
const errors = new BrowserErrorLog([...HERMETIC_INSTANCE_RULES, {
  id: 'space-backup-404', reason: 'hermetic gateway does not mount space backups',
  matches: (text, url) => text.includes('status of 404') && /\/spaces\/[^/]+\/[^/]+\/backups$/u.test(url),
}]);
const nativeHits: { status: number; path: string }[] = [];
const marks = { config: 0, capability: 0 };
let fixture: Awaited<ReturnType<typeof startConsoleFunctionalFixture>> | undefined;
let page: V4Page | undefined;
let tenant = '';

function active() { if (!fixture) throw new Error('openclaw context fixture is unavailable'); return fixture; }
function browser() { if (!page) throw new Error('openclaw context page is unavailable'); return page; }
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function watch(target: V4Page): void {
  target.on('response', (raw: unknown) => {
    const response = raw as { url(): string; status(): number };
    let path = '';
    try { path = new URL(response.url()).pathname; } catch { return; }
    if (path === '/v3/console/config') marks.config += 1;
    if (path === '/v3/console/fleet/capability') marks.capability += 1;
    if (path.includes('/native/')) nativeHits.push({ status: response.status(), path });
  });
}
async function shot(name: string): Promise<void> {
  await browser().locator('details.native-context-repository').evaluate((element) => { element.scrollIntoView({ block: 'center' }); });
  await browser().screenshot({ path: join(directory, `${name}.png`) });
}

beforeAll(async () => {
  if (process.env.CAUCE_REQUIRE_TESTCONTAINERS !== '1' || process.env.DATABASE_URL || process.env.CAUCE_TEST_DATABASE_URL) {
    throw new Error('openclaw context E2E requires isolated Testcontainers PostgreSQL');
  }
  await mkdir(directory, { recursive: true });
  fixture = await startConsoleFunctionalFixture({ fleetCapability: fleet });
  page = asV4Page(await newTrustedPage(active(), desktop));
  errors.watch(browser(), 'owner');
  watch(browser());
  const registration = await openRegistration(browser(), active().baseUrl);
  await fillRegistration(registration, person);
  await registration.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
  await browser().getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });
  const owner = await active().database.pool.query<{ tenant_id: string }>(
    'SELECT tenant_id FROM console_users WHERE email=$1', [person.email]);
  tenant = owner.rows[0]?.tenant_id ?? '';
  expect(tenant).toMatch(/^hub-/u);
  const pool = active().database.pool;
  await pool.query('INSERT INTO fleet_hosts(host_id,company_id,display_name) VALUES($1,$2,$3)', [hostId, company, 'Ordenador canario P2']);
  await pool.query(`INSERT INTO provider_accounts(id,provider,external_account_id,payer_tenant_id,credential_ref_kind,credential_ref,
    enabled,shared_with_pool,company_id) VALUES($1,'openclaw',$1,$2,'env_path','CAUCE_P2_OPENCLAW_PROFILE_PATH',true,false,$3)`,
  [accountId, tenant, company]);
  await pool.query(`INSERT INTO agents(tenant_id,alias,company_id,harness_id,host_id,runtime_mode,container_name,
    runtime_key,runtime_user,home_directory,state_directory,enabled,lifecycle_state,primary_account_id,display_name)
    VALUES($1,$2,$3,'openclaw',$4,'container',$5,$6,$7,$8,$9,true,'ready',$10,$2)`,
  [tenant, openclawAlias, company, hostId, `${prefix}${runtimeKey}`, runtimeKey, runtimeUser, home, `${stateRoot}/${runtimeKey}`, accountId]);
  await pool.query(`INSERT INTO agents(tenant_id,alias,company_id,harness_id,display_name,enabled,container_name,runtime_user,home_directory,state_directory)
    VALUES($1,$2,$3,'codex',$2,true,$4,$5,$6,$7)`,
  [tenant, codexAlias, company, `zzp2cx${run}`, runtimeUser, home, `${stateRoot}/codex-${run}`]);
  await pool.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES($1,'office',$2,'agent'),($1,'office',$3,'agent')",
    [tenant, openclawAlias, codexAlias]);
}, 600_000);

afterAll(async () => {
  await writeFile(join(directory, 'requests.json'), JSON.stringify({
    nativeHits, marks, unexpected: errors.unexpected,
  }, null, 2) + '\n').catch(() => undefined);
  await fixture?.close();
}, 120_000);

describe.sequential('contexto de un arnés sin edición nativa', () => {
  it('abre el contexto OpenClaw sin pedir piezas nativas y muestra el estado neutro', async () => {
    const access = await apiGet(browser(), '/v3/console/access');
    const configuration = await apiGet(browser(), '/v3/console/config');
    const capability = await apiGet(browser(), '/v3/console/fleet/capability');
    expect(access.status).toBe(200);
    expect(Array.isArray(access.body.permissions) && access.body.permissions.includes('config.write')).toBe(true);
    expect(configuration.status).toBe(200);
    expect(record(record(configuration.body.capabilities)?.actor)?.can_control).toBe(true);
    const agents = configuration.body.agents;
    expect(Array.isArray(agents)).toBe(true);
    const row = Array.isArray(agents) ? agents.map(record).find((item) => item?.alias === openclawAlias) : undefined;
    expect(row).toMatchObject({
      enabled: true, harness_id: 'openclaw', runtime_key: runtimeKey, primary_account_id: accountId,
      host_id: hostId, runtime_mode: 'container', container_name: `${prefix}${runtimeKey}`,
      runtime_user: runtimeUser, home_directory: home, state_directory: `${stateRoot}/${runtimeKey}`,
    });
    expect(row?.retired_at ?? null).toBeNull();
    expect(capability.status).toBe(200);
    expect(capability.body.available).toBe(true);
    const seen = { config: marks.config, capability: marks.capability };
    await browser().goto(`${active().baseUrl}/messages/${tenant}/${openclawAlias}?view=context&tab=versiones`, { waitUntil: 'domcontentloaded' });
    await browser().getByRole('heading', { name: `Perfil y contexto de ${openclawAlias}`, exact: true }).waitFor({ timeout: 30_000 });
    await expect.poll(() => marks.config > seen.config && marks.capability > seen.capability, { timeout: 30_000 }).toBe(true);
    await browser().waitForTimeout(1500);
    expect(nativeHits).toEqual([]);
    await browser().getByRole('tab', { name: /Perfil/u }).click();
    const notice = browser().locator('details.native-context-repository').getByRole('status');
    await notice.waitFor({ timeout: 20_000 });
    expect(await notice.innerText()).toContain('Este arnés no publica edición nativa de skills, MCP ni subagentes.');
    expect(await browser().locator('details.native-context-repository').getByRole('alert').count()).toBe(0);
    await shot('openclaw-1440');
    await browser().setViewportSize(phone);
    await shot('openclaw-390');
    await browser().setViewportSize(desktop);
    errors.assertClean();
  }, 120_000);

  it('el arnés que sí publica edición nativa sigue mostrando el editor', async () => {
    const before = nativeHits.length;
    await browser().goto(`${active().baseUrl}/messages/${tenant}/${codexAlias}?view=context`, { waitUntil: 'domcontentloaded' });
    await browser().getByRole('heading', { name: `Perfil y contexto de ${codexAlias}`, exact: true }).waitFor({ timeout: 30_000 });
    await browser().getByRole('tab', { name: /Perfil/u }).click();
    const details = browser().locator('details.native-context-repository');
    await details.getByText('Piezas nativas · MCP, skills y subagentes', { exact: true }).click();
    const editor = browser().getByRole('region', { name: 'Editor de piezas nativas', exact: true });
    await editor.waitFor({ timeout: 20_000 });
    await editor.getByRole('button', { name: 'Leer inventario nativo', exact: true }).waitFor();
    await editor.getByLabel('Contenido Markdown', { exact: true }).waitFor();
    await browser().waitForTimeout(1500);
    expect(nativeHits.slice(before)).toEqual([]);
    await shot('codex-editor-1440');
    errors.assertClean();
  }, 120_000);
});
