import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newTrustedPage, startConsoleFunctionalFixture } from './console-functional-browser.fixtures.js';
import {
  apiGet, asV4Page, bodySnippet, BrowserErrorLog, fillRegistration, HERMETIC_INSTANCE_RULES, login,
  openRegistration, PATTERN_DEFECT_RULE, syntheticPerson, type V4Page,
} from './v4-console-real-browser.helpers.js';

const run = randomUUID().replaceAll('-', '').slice(0, 8);
const owner = syntheticPerson('a', run);
const otherCompanyOwner = syntheticPerson('b', run);
const sameCompanyPerson = syntheticPerson('mate', run);
const teammateAlias = `testigo-${run}`;
const agentAlias = `contexto-${run}`;
const initialMission = 'Misión inicial del agente de prueba.';
const updatedMission = 'Misión revisada por la persona dueña.';
const secretMission = 'No guardar esta directiva.\npassword: hunter2hunter2';
const errors = new BrowserErrorLog([...HERMETIC_INSTANCE_RULES, PATTERN_DEFECT_RULE]);
let fixture: Awaited<ReturnType<typeof startConsoleFunctionalFixture>> | undefined;
let tenant = '';
let ownerId = '';

const active = () => { if (!fixture) throw new Error('V4 fixture is not initialized'); return fixture; };
const pool = () => active().database.pool;
const base = () => active().baseUrl;
const contextPath = () => `/v3/console/context/agents/${tenant}/${agentAlias}`;
const agentPageUrl = () => `${base()}/messages/${tenant}/${agentAlias}?view=context`;

async function freshPage(label: string): Promise<V4Page> {
  const page = asV4Page(await newTrustedPage(active(), { width: 1440, height: 1000 }));
  errors.watch(page, label);
  return page;
}

async function step<T>(page: V4Page, name: string, action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch (cause) {
    throw new Error(`${name} failed at ${page.url()}: ${await bodySnippet(page)} || console=${JSON.stringify(errors.trace.slice(-12))}`, { cause });
  }
}

async function register(page: V4Page, person: typeof owner): Promise<void> {
  const form = await openRegistration(page, base());
  await fillRegistration(form, person);
  await form.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
  await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });
}

async function openAgentContext(page: V4Page): Promise<void> {
  await page.goto(`${base()}/live`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Plano editable', exact: true }).click();
  await page.getByRole('region', { name: `Sala ${tenant}/office`, exact: true }).getByRole('button').first().click();
  await page.getByRole('region', { name: `Agentes de sala ${tenant}/office`, exact: true })
    .getByRole('button', { name: new RegExp(agentAlias, 'u') }).click();
  const sheet = page.getByRole('dialog');
  await sheet.getByRole('link', { name: 'Perfil y contexto', exact: true }).click();
  await page.getByRole('heading', { name: `Perfil y contexto de ${agentAlias}`, exact: true }).waitFor({ timeout: 20_000 });
  await page.getByRole('tab', { name: 'Versiones y aplicación', exact: true }).click();
}

async function historyRows(): Promise<{ version: number; source: string; restored_from: number | null; actor_human_id: string; actor_alias: string }[]> {
  const result = await pool().query<{ version: string; source: string; restored_from: string | null; actor_human_id: string; actor_alias: string }>(
    `SELECT version::text,source,restored_from::text,actor_human_id::text,actor_alias FROM agent_context_versions
     WHERE tenant_id=$1 AND alias=$2 ORDER BY version`, [tenant, agentAlias]);
  return result.rows.map(row => ({ version: Number(row.version), source: row.source,
    restored_from: row.restored_from === null ? null : Number(row.restored_from),
    actor_human_id: row.actor_human_id, actor_alias: row.actor_alias }));
}

beforeAll(async () => {
  if (process.env.CAUCE_TEST_DATABASE_URL) throw new Error('this E2E requires its own Testcontainers PostgreSQL');
  if (process.env.VITE_USE_MOCKS === 'true') throw new Error('mocks=false is required');
  const repositoryRoot = process.env.CAUCE_CONTEXT_REPOSITORY_ROOT;
  delete process.env.CAUCE_CONTEXT_REPOSITORY_ROOT;
  try { fixture = await startConsoleFunctionalFixture(); }
  finally {
    if (repositoryRoot !== undefined) process.env.CAUCE_CONTEXT_REPOSITORY_ROOT = repositoryRoot;
  }
}, 600_000);

afterAll(async () => { await fixture?.close(); }, 180_000);

describe('contextos versionados en navegador real contra gateway y PostgreSQL reales', () => {
  it('edita, rechaza secretos, restaura y aplica aislamiento entre personas y empresas', async () => {
    const page = await freshPage('owner');
    await step(page, 'registro de empresa y dueña', async () => register(page, owner));

    const identity = await pool().query<{ id: string; tenant_id: string }>(
      'SELECT id::text,tenant_id FROM console_users WHERE email=$1', [owner.email]);
    ownerId = identity.rows[0]?.id ?? '';
    tenant = identity.rows[0]?.tenant_id ?? '';
    expect(ownerId).not.toBe('');
    expect(tenant).not.toBe('');

    await pool().query(`INSERT INTO agents(tenant_id,alias,harness_id,display_name,enabled,container_name,runtime_user,home_directory,state_directory,company_id)
      VALUES($1,$2,'codex',$2,true,$3,'stev',$4,$5,$6),
        ($1,$7,'codex',$7,true,$8,'stev',$9,$10,$6)`,
    [tenant, agentAlias, `cauce-e2e-${run}`, `/srv/cauce-e2e/${run}`, `/srv/cauce-e2e/${run}/state`, owner.company.slug,
      teammateAlias, `cauce-e2e-witness-${run}`, `/srv/cauce-e2e/witness/${run}`, `/srv/cauce-e2e/witness/${run}/state`]);
    await pool().query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES($1,'office',$2,'agent'),($1,'office',$3,'operator')",
      [tenant, agentAlias, teammateAlias]);
    await pool().query('INSERT INTO agent_profiles(tenant_id,alias,role_summary) VALUES($1,$2,$3)',
      [tenant, agentAlias, 'Agente para comprobar el historial de contexto.']);

    const teammate = await pool().query<{ id: string }>(`INSERT INTO console_users
      (email,email_normalized,password_hash,display_name,role,tenant_id,alias,company_id)
      SELECT $1,lower($1),owner.password_hash,$2,'operator',$3,$4,$5 FROM console_users owner WHERE owner.id=$6
      RETURNING id::text`, [sameCompanyPerson.email, sameCompanyPerson.name, tenant, teammateAlias, owner.company.slug, ownerId]);
    const teammateId = teammate.rows[0]?.id;
    if (teammateId === undefined) throw new Error('same-company person was not provisioned');
    await pool().query(`INSERT INTO human_tenant_memberships
      (human_id,tenant_id,actor_alias,role,permissions,enabled,company_id)
      VALUES($1,$2,$3,'operator',ARRAY['route','read','control','notify']::text[],true,$4)`,
    [teammateId, tenant, teammateAlias, owner.company.slug]);
    await pool().query(`INSERT INTO company_admins(company_id,human_id,role,source,granted_by)
      VALUES($1,$2,'admin','import',$3)`, [owner.company.slug, teammateId, ownerId]);

    await step(page, 'la dueña abre la ficha del agente', async () => {
      await openAgentContext(page);
      await page.getByRole('heading', { name: 'Contexto versionado', exact: true }).waitFor({ timeout: 20_000 });
    });
    const versions = page.getByRole('region', { name: 'Versiones de contexto', exact: true });
    await step(page, 'crear versión base de la misión', async () => {
      await versions.getByLabel('Nuevo archivo', { exact: true }).fill('context/mission.md');
      await versions.getByRole('button', { name: 'Añadir archivo', exact: true }).click();
      await versions.getByLabel('Contenido de context/mission.md', { exact: true }).fill(initialMission);
      await versions.getByRole('button', { name: 'Guardar nueva versión', exact: true }).click();
      await versions.getByText(/Versión 1 · Consola · owner/u).waitFor({ timeout: 20_000 });
    });
    await step(page, 'editar la misión y confirmar autoría en el historial', async () => {
      const missionEditor = versions.locator('textarea').first();
      expect(await versions.locator('textarea').count()).toBe(1);
      await expect.poll(() => missionEditor.isDisabled(), { timeout: 15_000 }).toBe(false);
      await missionEditor.fill(updatedMission);
      await versions.getByRole('button', { name: 'Guardar nueva versión', exact: true }).click();
      await versions.getByText(/Versión 2 · Consola · owner/u).waitFor({ timeout: 20_000 });
      const rows = await historyRows();
      expect(rows).toEqual([
        { version: 1, source: 'ui', restored_from: null, actor_human_id: ownerId, actor_alias: 'owner' },
        { version: 2, source: 'ui', restored_from: null, actor_human_id: ownerId, actor_alias: 'owner' },
      ]);
    });

    await step(page, 'rechazar un secreto sin crear una versión', async () => {
      errors.expectHttpError(contextPath(), 422);
      await versions.locator('textarea').first().fill(secretMission);
      await versions.getByRole('button', { name: 'Guardar nueva versión', exact: true }).click();
      const alert = versions.getByRole('alert');
      await alert.waitFor({ timeout: 15_000 });
      expect(await alert.innerText()).toContain('El contenido parece contener una credencial o secreto y no se puede versionar.');
      expect((await historyRows()).map(row => row.version)).toEqual([1, 2]);
      const current = await pool().query<{ desired_version: number }>(
        'SELECT desired_version::integer FROM agent_context_state WHERE tenant_id=$1 AND alias=$2', [tenant, agentAlias]);
      expect(current.rows[0]?.desired_version).toBe(2);
      await versions.getByRole('button', { name: 'Descartar borrador', exact: true }).click();
    });

    await step(page, 'restaurar una versión anterior conservando el historial', async () => {
      await versions.getByRole('button', { name: 'Restaurar versión 1', exact: true }).click();
      const confirmation = versions.getByRole('region', { name: 'Confirmar restauración', exact: true });
      await confirmation.getByRole('button', { name: 'Confirmar restauración', exact: true }).click();
      await versions.getByText('Restauración guardada como una versión nueva.', { exact: true }).waitFor({ timeout: 20_000 });
      await versions.getByText(/Versión 3 · Restauración · owner/u).waitFor({ timeout: 20_000 });
      expect(await versions.locator('textarea').first().inputValue()).toBe(initialMission);
      expect(await historyRows()).toEqual([
        { version: 1, source: 'ui', restored_from: null, actor_human_id: ownerId, actor_alias: 'owner' },
        { version: 2, source: 'ui', restored_from: null, actor_human_id: ownerId, actor_alias: 'owner' },
        { version: 3, source: 'restore', restored_from: 1, actor_human_id: ownerId, actor_alias: 'owner' },
      ]);
      await versions.getByText('Aplicación pendiente', { exact: true }).waitFor({ timeout: 15_000 });
    });

    await step(page, 'mostrar en español por qué no se pudo aplicar', async () => {
      errors.expectHttpError(`${contextPath()}/apply`, 503);
      await versions.getByRole('button', { name: 'Aplicar al agente', exact: true }).click();
      await versions.getByRole('alert').getByText('El servicio que aplica el contexto al agente no está disponible. La versión quedó pendiente.', { exact: true })
        .waitFor({ timeout: 15_000 });
    });

    const teammatePage = await freshPage('same-company-person');
    await step(teammatePage, 'otra persona de la empresa lee el historial', async () => {
      await login(teammatePage, base(), { ...sameCompanyPerson, password: owner.password, company: owner.company });
      await openAgentContext(teammatePage);
      const teammateVersions = teammatePage.getByRole('region', { name: 'Versiones de contexto', exact: true });
      await teammateVersions.getByText(/Versión 3 · Restauración · owner/u).waitFor({ timeout: 20_000 });
      expect((await apiGet(teammatePage, `${contextPath()}/history`)).status).toBe(200);
    });

    const outsidePage = await freshPage('other-company-person');
    await step(outsidePage, 'otra empresa no puede consultar la ficha ni el endpoint', async () => {
      await register(outsidePage, otherCompanyOwner);
      await outsidePage.goto(agentPageUrl(), { waitUntil: 'domcontentloaded' });
      await outsidePage.getByText('No encontramos esa conversación', { exact: true }).waitFor({ timeout: 20_000 });
      const body = await outsidePage.locator('body').innerText();
      expect(body).not.toContain(initialMission);
      expect(body).not.toContain(updatedMission);
      expect(body).not.toMatch(/Versión [123] ·/u);
      errors.expectHttpError(`${contextPath()}/history`, 404);
      const directHistory = await apiGet(outsidePage, `${contextPath()}/history`);
      expect(directHistory.status).toBe(404);
      expect(JSON.stringify(directHistory.body)).not.toContain(initialMission);
    });

    errors.assertClean();
  }, 180_000);
});
