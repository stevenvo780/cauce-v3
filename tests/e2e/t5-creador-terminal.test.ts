import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startRealPtyFixture, type RealPtyFixture } from './real-pty-agent.fixtures.js';
import { asV4Page, type V4Page } from './v4-console-real-browser.helpers.js';

const OWNER = 't5-terminal-del-creador-1025';
const run = randomUUID().slice(0, 8);
const createdAlias = `zz-canary-creado-${run}`;
const artifacts = join(process.cwd(), '.delegados/v4/recibos', OWNER);
let fixture: RealPtyFixture;
let closeFixture: () => Promise<void> = async () => undefined;

beforeAll(async () => {
  await mkdir(artifacts, { recursive: true });
  fixture = await startRealPtyFixture({ tui: true, owner: OWNER, maxSessionsPerOperator: 1, sessionTtlSeconds: 120 });
  closeFixture = () => fixture.close();
  const person = await fixture.database.pool.query<{ id: string; company_id: string }>(
    `SELECT person.id, tenant.company_id FROM console_users person JOIN tenants tenant ON tenant.id=person.tenant_id
      WHERE person.email=$1`, [fixture.operatorEmail]);
  const row = person.rows[0];
  if (!row) throw new Error('fixture operator person missing');
  await fixture.database.pool.query(
    `INSERT INTO company_admins(company_id,human_id,role,source,granted_by) VALUES($1,$2,'owner','platform',$2)
     ON CONFLICT DO NOTHING`, [row.company_id, row.id]);
}, 600_000);
afterAll(async () => { await closeFixture(); }, 60_000);

async function openPage(): Promise<V4Page> {
  const page = asV4Page(await fixture.browserPage({ width: 1440, height: 900 }, { isMobile: false, hasTouch: false }));
  await page.goto(fixture.baseUrl, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Correo', { exact: true }).fill(fixture.operatorEmail);
  await page.getByLabel('Contraseña', { exact: true }).fill(fixture.operatorPassword);
  await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
  await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });
  const cookies = await page.context().cookies(fixture.baseUrl);
  const cookie = cookies.find((value) => value.name === '__Host-cauce_session');
  if (!cookie) throw new Error('browser login omitted its nominal session');
  await fixture.waitForTarget(`${cookie.name}=${cookie.value}`);
  return page;
}
async function terminal(page: V4Page): Promise<void> {
  await page.goto(`${fixture.baseUrl}/terminal/${fixture.tenant}/${fixture.targetAlias}?modo=terminal`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Terminal de agentes', exact: true }).waitFor({ timeout: 30_000 });
}
async function attached(page: V4Page, phase = ''): Promise<string> {
  await page.locator('[data-pty-shell][data-state="open"]').waitFor({ timeout: 30_000 }).catch(async (error: unknown) => {
    await page.screenshot({ path: join(artifacts, `attached-fallo-${phase}-${run}.png`), fullPage: true }).catch(() => undefined);
    throw new Error(`attached[${phase}]: ${error instanceof Error ? error.message : String(error)}`);
  });
  return page.locator('[data-session-id]').evaluate((element) => element.getAttribute('data-session-id') ?? '');
}
async function closeSession(page: V4Page): Promise<void> {
  await page.getByRole('button', { name: 'Más acciones', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Cerrar sesión PTY', exact: true }).click();
  await page.getByRole('button', { name: 'Abrir terminal', exact: true }).waitFor({ timeout: 20_000 });
}

describe.sequential('terminal del creador: alta, panel, negativa con botón y reentrada', () => {
  it('crear el agente por la ruta de consola deja la concesión del creador auditada', async () => {
    const human = await fixture.login();
    const snapshot = await fixture.request('/v3/console/config', {
      headers: { cookie: human.cookie, origin: fixture.gatewayUrl },
    });
    expect(snapshot.status).toBe(200);
    const revision = (JSON.parse(snapshot.body) as { revision?: number }).revision ?? 0;
    const created = await fixture.request('/v3/console/config/changes', {
      method: 'POST',
      headers: { cookie: human.cookie, 'x-csrf-token': human.csrf, origin: fixture.gatewayUrl, 'content-type': 'application/json' },
      body: {
        mutation: { resource: 'agent', action: 'create', tenant_id: fixture.tenant, alias: createdAlias,
          value: { enabled: false, harness_id: 'codex' } },
        dry_run: false, expected_revision: revision,
      },
    });
    expect(created.status).toBe(201);
    const grants = await fixture.database.pool.query<{ modes: string[]; granted: string }>(
      `SELECT modes, granted_by_human_id::text AS granted FROM terminal_grants
        WHERE tenant_id=$1 AND alias=$2 AND revoked_at IS NULL`, [fixture.tenant, createdAlias]);
    expect(grants.rows).toHaveLength(1);
    expect(grants.rows[0]?.modes).toEqual(['shell', 'harness', 'harness_rw']);
    const people = await fixture.database.pool.query<{ id: string }>('SELECT id FROM console_users WHERE email=$1', [fixture.operatorEmail]);
    expect(grants.rows[0]?.granted).toBe(people.rows[0]?.id);
    const audits = await fixture.database.pool.query<{ reason: string }>(
      `SELECT metadata->>'reason' AS reason FROM audit_events
        WHERE action='terminal.grant.create' AND metadata->>'target_alias'=$1`, [createdAlias]);
    expect(audits.rows).toEqual([{ reason: 'creator' }]);
  }, 120_000);

  it('abrir con la concesión, revocarla en el panel, conceder desde la negativa y reentrar', async () => {
    const human = await fixture.login();
    const grantsList = await fixture.request('/v3/console/terminal/grants', {
      headers: { cookie: human.cookie, origin: fixture.gatewayUrl },
    });
    expect(grantsList.status, grantsList.body).toBe(200);
    const peopleList = await fixture.request('/v3/console/people', {
      headers: { cookie: human.cookie, origin: fixture.gatewayUrl },
    });
    expect(peopleList.status, peopleList.body).toBe(200);
    const page = await openPage();
    const grantsPath = join(fixture.directory, 'grants.json');
    const original = await readFile(grantsPath, 'utf8');
    try {
      await terminal(page);
      await attached(page, 'inicial');
      await closeSession(page);
      await page.goto(`${fixture.baseUrl}/config?seccion=acceso`, { waitUntil: 'domcontentloaded' });
      const panel = page.getByRole('region', { name: 'Concesiones de terminal', exact: true });
      await panel.getByRole('heading', { name: 'Concesiones de terminal', exact: true }).waitFor({ timeout: 30_000 });
      const peopleRows = await fixture.database.pool.query<{ id: string }>(
        'SELECT id FROM console_users WHERE email=$1', [fixture.operatorEmail]);
      await panel.getByLabel('Persona').selectOption(peopleRows.rows[0]?.id ?? '');
      await panel.getByLabel('Agente').selectOption(`${fixture.tenant}\0${fixture.targetAlias}`);
      await panel.getByLabel('Shell', { exact: true }).check();
      await panel.getByLabel('TUI escribible', { exact: true }).check();
      await panel.getByRole('button', { name: 'Crear concesión', exact: true }).click();
      await panel.getByText('Concesión de terminal creada.', { exact: true }).waitFor({ timeout: 20_000 });
      await writeFile(grantsPath, JSON.stringify({ version: 1, grants: [] }));
      await page.waitForTimeout(1_100);
      await terminal(page);
      await attached(page, 'solo-db');
      await closeSession(page);
      await page.goto(`${fixture.baseUrl}/config?seccion=acceso`, { waitUntil: 'domcontentloaded' });
      await panel.locator(`div.border-b:has-text("${fixture.tenant}:${fixture.targetAlias}")`)
        .getByRole('button', { name: 'Revocar', exact: true }).click();
      await panel.getByRole('button', { name: 'Confirmar revocación', exact: true }).click();
      await panel.getByText('Concesión revocada. Sus sesiones abiertas se cerraron.', { exact: true }).waitFor({ timeout: 20_000 });
      await terminal(page);
      await page.getByText('Sin autoridad', { exact: true }).waitFor({ timeout: 20_000 });
      const conceder = page.getByRole('button', { name: 'Conceder acceso', exact: true });
      await conceder.waitFor({ timeout: 20_000 });
      const visibleText = await page.locator('body').innerText();
      expect(visibleText).not.toContain('no_grant');
      await page.screenshot({ path: join(artifacts, `negativa-boton-${run}.png`), fullPage: true });
      await conceder.click();
      await panel.getByRole('heading', { name: 'Concesiones de terminal', exact: true }).waitFor({ timeout: 30_000 });
      await expect.poll(async () => panel.getByLabel('Persona').inputValue(), { timeout: 20_000 }).not.toBe('');
      await expect.poll(async () => panel.getByLabel('Agente').inputValue(), { timeout: 20_000 })
        .toContain(fixture.targetAlias);
      await panel.getByLabel('Shell', { exact: true }).check();
      await panel.getByLabel('TUI escribible', { exact: true }).check();
      await panel.getByRole('button', { name: 'Crear concesión', exact: true }).click();
      await panel.getByText('Concesión de terminal creada.', { exact: true }).waitFor({ timeout: 20_000 });
      await terminal(page);
      await attached(page, 'reentrada');
      await page.screenshot({ path: join(artifacts, `creador-reentrada-${run}.png`), fullPage: true });
    } finally {
      await writeFile(grantsPath, original);
      await page.context().close();
    }
  }, 300_000);
});
