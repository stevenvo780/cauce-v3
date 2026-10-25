import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newTrustedPage } from './console-functional-browser.fixtures.js';
import { startContextBackupFixture } from './context-backup-browser.fixtures.js';
import { browserDocker } from './browser-owned-lifecycle.js';
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
const artifactDirectory = join('.delegados/v4/recibos/e2e-copias-404-1025', run, 'contexts');
const secretMission = 'No guardar esta directiva.\npassword: hunter2hunter2';
const errors = new BrowserErrorLog([...HERMETIC_INSTANCE_RULES, PATTERN_DEFECT_RULE]);
const originalDeadlineFactor = process.env.CAUCE_PLAZOS_FACTOR;
let fixture: Awaited<ReturnType<typeof startContextBackupFixture>> | undefined;
let tenant = '';
let ownerId = '';

const active = () => { if (!fixture) throw new Error('V4 fixture is not initialized'); return fixture; };
const pool = () => active().database.pool;
const base = () => active().baseUrl;
const contextPath = () => `/v3/console/context/agents/${tenant}/${agentAlias}`;
const agentPageUrl = () => `${base()}/messages/${tenant}/${agentAlias}?view=context`;

async function freshPage(label: string): Promise<V4Page> {
  const page = asV4Page(await newTrustedPage(active(), { width: 1440, height: 900 }));
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
     WHERE tenant_id=$1 AND alias=$2 ORDER BY agent_context_versions.version`, [tenant, agentAlias]);
  return result.rows.map(row => ({ version: Number(row.version), source: row.source,
    restored_from: row.restored_from === null ? null : Number(row.restored_from),
    actor_human_id: row.actor_human_id, actor_alias: row.actor_alias }));
}

beforeAll(async () => {
  process.env.CAUCE_PLAZOS_FACTOR ??= '3';
  if (process.env.CAUCE_TEST_DATABASE_URL) throw new Error('this E2E requires its own Testcontainers PostgreSQL');
  if (process.env.VITE_USE_MOCKS === 'true') throw new Error('mocks=false is required');
  const repositoryRoot = process.env.CAUCE_CONTEXT_REPOSITORY_ROOT;
  delete process.env.CAUCE_CONTEXT_REPOSITORY_ROOT;
  try {
    fixture = await startContextBackupFixture();
    await mkdir(artifactDirectory, { recursive: true });
    await writeFile(`${artifactDirectory}/versiones-volumenes.json`,
      (await browserDocker(['inspect', '--format', '{{json .Mounts}}', fixture.database.container.getId()])).stdout, { mode: 0o600 });
  }
  finally {
    if (repositoryRoot !== undefined) process.env.CAUCE_CONTEXT_REPOSITORY_ROOT = repositoryRoot;
  }
}, 600_000);

afterAll(async () => {
  try { await fixture?.close(); }
  finally {
    if (originalDeadlineFactor === undefined) delete process.env.CAUCE_PLAZOS_FACTOR;
    else process.env.CAUCE_PLAZOS_FACTOR = originalDeadlineFactor;
  }
}, 180_000);

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
      (human_id,tenant_id,actor_alias,permissions,enabled,company_id)
      VALUES($1,$2,$3,ARRAY['route','read','control','notify']::text[],true,$4)`,
    [teammateId, tenant, teammateAlias, owner.company.slug]);
    await pool().query(`INSERT INTO company_admins(company_id,human_id,role,source,granted_by)
      VALUES($1,$2,'admin','import',$3)`, [owner.company.slug, teammateId, ownerId]);

    await step(page, 'la dueña abre la ficha del agente', async () => {
      await openAgentContext(page);
      await page.getByRole('heading', { name: 'Contexto versionado', exact: true }).waitFor({ timeout: 20_000 });
    });
    const versions = page.getByRole('region', { name: 'Versiones de contexto', exact: true });
    await mkdir(artifactDirectory, { recursive: true });
    await step(page, 'acreditar el espacio sin copias guardadas', async () => {
      const emptyBackups = page.getByRole('region', { name: 'Copia de seguridad del espacio', exact: true })
        .getByText('No hay copias guardadas de este espacio.', { exact: true });
      await emptyBackups.waitFor({ timeout: 20_000 });
      const backupPath = `/v3/console/spaces/${tenant}/${agentAlias}/backups`;
      const backups = await apiGet(page, backupPath);
      expect(backups).toEqual({ status: 200, body: { backups: [] } });
      const storedBackups = await pool().query<{ count: number }>(
        'SELECT count(*)::integer AS count FROM space_backups WHERE tenant_id=$1 AND alias=$2', [tenant, agentAlias]);
      expect(storedBackups.rows).toEqual([{ count: 0 }]);
      const screenshots: string[] = [];
      for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
        await page.setViewportSize(viewport);
        await emptyBackups.evaluate(element => { element.scrollIntoView({ block: 'center' }); });
        expect(await emptyBackups.isVisible()).toBe(true);
        const file = `empty-backups-${String(viewport.width)}x${String(viewport.height)}.png`;
        await page.screenshot({ path: join(artifactDirectory, file) });
        screenshots.push(file);
      }
      await page.setViewportSize({ width: 1440, height: 900 });
      await writeFile(join(artifactDirectory, 'empty-backups.json'), JSON.stringify({
        run, tenant, alias: agentAlias, request: { method: 'GET', path: backupPath, ...backups },
        postgres: { table: 'space_backups', count: storedBackups.rows[0]?.count },
        ui: 'No hay copias guardadas de este espacio.', screenshots,
      }, null, 2), { mode: 0o600 });
    });
    await versions.getByText('No hay contextos guardados. Añade un archivo para comenzar.', { exact: true }).waitFor();
    await page.screenshot({ path: `${artifactDirectory}/versiones-vacias-desktop.png`, fullPage: true });
    await step(page, 'crear versión base de la misión', async () => {
      await versions.getByLabel('Nuevo archivo', { exact: true }).fill('context/mission.md');
      await versions.getByRole('button', { name: 'Añadir archivo', exact: true }).click();
      await versions.getByLabel('Contenido de context/mission.md', { exact: true }).fill(initialMission);
      await versions.getByRole('button', { name: 'Guardar nueva versión', exact: true }).click();
      await versions.getByText(/Versión 1 · Consola · Persona V4 A/u).waitFor({ timeout: 20_000 });
    });
    await step(page, 'editar la misión y confirmar autoría en el historial', async () => {
      const missionEditor = versions.locator('textarea').first();
      expect(await versions.locator('textarea').count()).toBe(1);
      await expect.poll(() => missionEditor.isDisabled(), { timeout: 15_000 }).toBe(false);
      await missionEditor.fill(updatedMission);
      await versions.getByRole('button', { name: 'Guardar nueva versión', exact: true }).click();
      await versions.getByText(/Versión 2 · Consola · Persona V4 A/u).waitFor({ timeout: 20_000 });
      await page.screenshot({ path: `${artifactDirectory}/versiones-guardadas-desktop.png`, fullPage: true });
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
      await versions.getByText(/Versión 3 · Restauración · Persona V4 A/u).waitFor({ timeout: 20_000 });
      expect(await versions.locator('textarea').first().inputValue()).toBe(initialMission);
      expect(await historyRows()).toEqual([
        { version: 1, source: 'ui', restored_from: null, actor_human_id: ownerId, actor_alias: 'owner' },
        { version: 2, source: 'ui', restored_from: null, actor_human_id: ownerId, actor_alias: 'owner' },
        { version: 3, source: 'restore', restored_from: 1, actor_human_id: ownerId, actor_alias: 'owner' },
      ]);
      await versions.getByText('Aplicación pendiente', { exact: true }).waitFor({ timeout: 15_000 });
      await page.screenshot({ path: `${artifactDirectory}/version-restaurada-desktop.png`, fullPage: true });
    });

    await step(page, 'mostrar en español por qué no se pudo aplicar', async () => {
      errors.expectHttpError(`${contextPath()}/apply`, 503);
      await versions.getByRole('button', { name: 'Aplicar al agente', exact: true }).click();
      await versions.getByRole('alert').getByText('El servicio que aplica el contexto al agente no está disponible. La versión quedó pendiente.', { exact: true })
        .waitFor({ timeout: 15_000 });
      await page.screenshot({ path: `${artifactDirectory}/aplicacion-pendiente-desktop.png`, fullPage: true });
    });

    const teammatePage = await freshPage('same-company-person');
    await step(teammatePage, 'otra persona de la empresa lee el historial', async () => {
      await login(teammatePage, base(), { ...sameCompanyPerson, password: owner.password, company: owner.company });
      await openAgentContext(teammatePage);
      const teammateVersions = teammatePage.getByRole('region', { name: 'Versiones de contexto', exact: true });
      await teammateVersions.getByText(/Versión 3 · Restauración · Persona V4 A/u).waitFor({ timeout: 20_000 });
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

  it('conserva borradores concurrentes, permite descartarlos o reintentarlos y valida rutas en móvil', async () => {
    const first = await freshPage('cas-first');
    const second = await freshPage('cas-second');
    for (const page of [first, second]) {
      await login(page, base(), owner);
      await page.goto(agentPageUrl(), { waitUntil: 'domcontentloaded' });
      await page.getByRole('tab', { name: 'Versiones y aplicación', exact: true }).click();
      await page.getByText(/Versión 3 · Restauración · Persona V4 A/u).waitFor({ timeout: 20_000 });
    }
    const left = first.getByRole('region', { name: 'Versiones de contexto', exact: true });
    const right = second.getByRole('region', { name: 'Versiones de contexto', exact: true });
    const baseline = await apiGet(first, contextPath());
    expect(baseline.status).toBe(200);
    if (!Array.isArray(baseline.body.files)) throw new Error('context snapshot omitted its files');
    const baselineFiles = baseline.body.files.map((file: unknown) => {
      if (typeof file !== 'object' || file === null || !('path' in file) || !('content' in file)
        || typeof file.path !== 'string' || typeof file.content !== 'string') throw new Error('context file is incomplete');
      return { path: file.path, content: file.content };
    });
    const saved = 'Edición confirmada en la primera pestaña.';
    const stale = 'Borrador que sobrevive al conflicto.';
    await right.locator('textarea').fill(stale);
    await left.locator('textarea').fill(saved);
    await left.getByRole('button', { name: 'Guardar nueva versión', exact: true }).click();
    await left.getByText(/Versión 4 · Consola · Persona V4 A/u).waitFor({ timeout: 20_000 });
    errors.expectHttpError(contextPath(), 409);
    await right.getByRole('button', { name: 'Guardar nueva versión', exact: true }).click();
    const conflict = right.getByRole('group', { name: 'Conflicto de versión', exact: true });
    await conflict.waitFor({ timeout: 20_000 });
    expect(await right.locator('textarea').inputValue()).toBe(stale);
    expect(await conflict.innerText()).toContain(saved);
    expect(await conflict.innerText()).toContain(stale);
    expect((await historyRows()).map(row => row.version)).toEqual([1, 2, 3, 4]);
    await second.screenshot({ path: `${artifactDirectory}/versiones-cas-desktop.png`, fullPage: true });
    await conflict.getByRole('button', { name: 'Descartar mis cambios', exact: true }).click();
    expect(await right.locator('textarea').inputValue()).toBe(saved);

    await right.locator('textarea').fill(stale);
    await left.locator('textarea').fill('Segunda edición concurrente.');
    await left.getByRole('button', { name: 'Guardar nueva versión', exact: true }).click();
    await left.getByText(/Versión 5 · Consola · Persona V4 A/u).waitFor({ timeout: 20_000 });
    errors.expectHttpError(contextPath(), 409);
    await right.getByRole('button', { name: 'Guardar nueva versión', exact: true }).click();
    await conflict.waitFor({ timeout: 20_000 });
    await conflict.getByRole('button', { name: 'Releer y reintentar con mis cambios', exact: true }).click();
    await right.getByText(/Versión 6 · Consola · Persona V4 A/u).waitFor({ timeout: 20_000 });
    const snapshot = await apiGet(second, contextPath());
    expect(snapshot.status).toBe(200);
    expect(snapshot.body.files).toEqual(baselineFiles.map(file => file.path === 'context/mission.md' ? { ...file, content: stale } : file));
    expect((await historyRows()).map(row => row.version)).toEqual([1, 2, 3, 4, 5, 6]);

    await second.setViewportSize({ width: 390, height: 844 });
    await right.getByLabel('Nuevo archivo', { exact: true }).fill('../escape.md');
    await right.getByRole('button', { name: 'Añadir archivo', exact: true }).click();
    await right.getByText('Usa una ruta relativa nueva dentro del contexto.', { exact: true }).waitFor();
    expect((await historyRows()).length).toBe(6);
    await right.getByLabel('Nuevo archivo', { exact: true }).fill('context/mission.md');
    await right.getByRole('button', { name: 'Añadir archivo', exact: true }).click();
    expect(await right.locator('textarea').count()).toBe(1);
    expect(await right.locator('select').evaluate(element => Array.from(element.querySelectorAll('option')).map(option => option.value)))
      .toEqual(baselineFiles.map(file => file.path));
    expect((await apiGet(second, contextPath())).body.files).toEqual(snapshot.body.files);
    expect((await historyRows()).length).toBe(6);
    await right.getByRole('button', { name: 'Restaurar versión 1', exact: true }).click();
    await right.getByRole('region', { name: 'Confirmar restauración', exact: true })
      .getByRole('button', { name: 'Cancelar', exact: true }).click();
    expect((await apiGet(second, contextPath())).body.files).toEqual(snapshot.body.files);
    expect((await historyRows()).length).toBe(6);
    await right.getByRole('button', { name: 'Releer versiones', exact: true }).click();
    await right.getByText('Estado releído.', { exact: true }).waitFor();
    await second.screenshot({ path: `${artifactDirectory}/versiones-mobile.png`, fullPage: true });
    errors.assertClean();
  }, 180_000);

  it('pagina versiones anteriores en móvil sin duplicados ni pérdida de historial', async () => {
    const page = await freshPage('history-pagination');
    await login(page, base(), owner);
    await page.goto(agentPageUrl(), { waitUntil: 'domcontentloaded' });
    await page.getByRole('tab', { name: 'Versiones y aplicación', exact: true }).click();
    const versions = page.getByRole('region', { name: 'Versiones de contexto', exact: true });
    await versions.getByLabel('Archivo', { exact: true }).selectOption('context/mission.md');
    for (let version = 7; version <= 52; version += 1) {
      await versions.getByLabel('Contenido de context/mission.md', { exact: true }).fill(`Misión ${String(version)} para paginación real.`);
      await versions.getByRole('button', { name: 'Guardar nueva versión', exact: true }).click();
      await versions.getByText(new RegExp(`Versión ${String(version)} · Consola · Persona V4 A`, 'u')).waitFor({ timeout: 20_000 });
    }
    const history = versions.getByRole('region', { name: 'Historial de versiones', exact: true });
    expect(await history.locator('li').count()).toBe(50);
    expect(await history.getByRole('button', { name: 'Restaurar versión 1', exact: true }).count()).toBe(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await versions.getByRole('button', { name: 'Leer versiones anteriores', exact: true }).click();
    await history.getByRole('button', { name: 'Restaurar versión 1', exact: true }).waitFor({ timeout: 20_000 });
    expect(await history.locator('li').count()).toBe(52);
    expect(await history.getByRole('button', { name: /^Restaurar versión /u }).count()).toBe(52);
    expect(await history.locator('ul').evaluate(element => Array.from(element.querySelectorAll('button'))
      .map(button => button.textContent.trim()).filter(label => label.startsWith('Restaurar versión '))))
      .toEqual(Array.from({ length: 52 }, (_, index) => `Restaurar versión ${String(52 - index)}`));
    expect(await versions.getByRole('button', { name: 'Leer versiones anteriores', exact: true }).count()).toBe(0);
    expect((await historyRows()).map(row => row.version)).toEqual(Array.from({ length: 52 }, (_, index) => index + 1));
    await page.screenshot({ path: `${artifactDirectory}/historial-completo-mobile.png`, fullPage: true });
    await versions.getByRole('button', { name: 'Releer versiones', exact: true }).click();
    await versions.getByText('Estado releído.', { exact: true }).waitFor();
    expect(await history.locator('li').count()).toBe(50);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.screenshot({ path: `${artifactDirectory}/historial-paginado-desktop.png`, fullPage: true });
    errors.assertClean();
  }, 180_000);
});
