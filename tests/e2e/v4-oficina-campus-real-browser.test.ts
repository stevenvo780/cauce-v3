import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  newTrustedPage, startConsoleFunctionalFixture, type BrowserResponse,
} from './console-functional-browser.fixtures.js';
import {
  apiGet, asV4Page, BrowserErrorLog, bodySnippet, fillRegistration, HERMETIC_INSTANCE_RULES, login,
  openRegistration, PATTERN_DEFECT_RULE, syntheticPerson, type IgnoredConsoleRule, type V4Page, type V4Person,
} from './v4-console-real-browser.helpers.js';
import { escapeRegex, expectCampusRoom } from './v4-office-real-browser.helpers.js';

const run = randomUUID().replaceAll('-', '').slice(0, 8);
const receipts = join(process.cwd(), '.delegados/v4/recibos/e2e-a5-oficina-1025b');
const owner: V4Person = {
  ...syntheticPerson('campus', run),
  email: `zz-canary-campus-${run}@example.test`,
  name: `zz-canary-campus-${run}`,
  company: { name: `zz-canary-campus-${run}`, slug: `zz-canary-campus-${run}` },
};
const agentAlias = `zz-canary-campus-agent-${run}`;
const accountId = `zz-canary-campus-quota-${run}`;
const terminalTargetsRule: IgnoredConsoleRule = {
  id: 'terminal-targets-404',
  reason: 'hermetic gateway without terminal relay',
  matches: (text: string, url: string) => {
    try { return text.includes('status of 404') && new URL(url).pathname === '/v3/console/terminal/targets'; }
    catch { return false; }
  },
};
const errors = new BrowserErrorLog([...HERMETIC_INSTANCE_RULES, PATTERN_DEFECT_RULE, terminalTargetsRule]);
const unexpectedHttp: string[] = [];
let fixture: Awaited<ReturnType<typeof startConsoleFunctionalFixture>> | undefined;
let pageA: V4Page | undefined;
let hub = '';

const active = () => { if (!fixture) throw new Error('V4 fixture is not initialized'); return fixture; };
const base = () => active().baseUrl;
const pool = () => active().database.pool;
const ownerPage = () => { if (!pageA) throw new Error('owner has no page yet'); return pageA; };

async function freshPage(label: string, viewport = { width: 1440, height: 900 }): Promise<V4Page> {
  const page = asV4Page(await newTrustedPage(active(), viewport));
  errors.watch(page, label);
  page.on('response', (value: unknown) => {
    const response = value as BrowserResponse;
    if (response.status() < 400) return;
    let path: string;
    try { path = new URL(response.url()).pathname; } catch { path = response.url(); }
    if ((response.status() === 501 && path === '/v3/console/terminal/capability')
      || (response.status() === 404 && path === '/v3/console/mcp/client-delegations')
      || (response.status() === 404 && path === '/v3/console/terminal/targets')) return;
    unexpectedHttp.push(`${label} ${String(response.status())} ${path}`);
  });
  return page;
}

async function step<T>(page: V4Page, name: string, action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch (cause) {
    throw new Error(`${name} failed at ${page.url()}: ${await bodySnippet(page)} || console=${JSON.stringify(errors.trace.slice(-12))}`, { cause });
  }
}

async function openOffice(page: V4Page): Promise<void> {
  await page.goto(`${base()}/live`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('region', { name: 'Oficina', exact: true }).waitFor({ timeout: 30_000 });
  await page.getByRole('toolbar', { name: 'Edificios del campus', exact: true }).waitFor({ timeout: 20_000 });
}

async function box(page: V4Page, selector: string): Promise<{ x: number; y: number; width: number; height: number } | null> {
  return page.evaluate((target: string) => {
    const element = document.querySelector(target);
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;
  }, selector);
}

function overlaps(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

beforeAll(async () => {
  if (process.env.CAUCE_TEST_DATABASE_URL) throw new Error('this E2E requires its own Testcontainers PostgreSQL');
  if (process.env.VITE_USE_MOCKS === 'true') throw new Error('mocks=false is required');
  await mkdir(receipts, { recursive: true });
  fixture = await startConsoleFunctionalFixture();
}, 600_000);

afterAll(async () => { await fixture?.close(); }, 180_000);

describe('Oficina V4: campus, HUD y ficha en Chromium real', () => {
  it('prepara la empresa, el agente y su cuota disponible', async () => {
    pageA = await freshPage('campus-owner');
    const page = ownerPage();
    await step(page, 'company registration', async () => {
      const form = await openRegistration(page, base());
      await fillRegistration(form, owner);
      await form.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
      await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });
    });
    const registered = await pool().query<{ tenant_id: string }>(
      'SELECT tenant_id FROM console_users WHERE email_normalized=$1', [owner.email]);
    hub = registered.rows[0]?.tenant_id ?? '';
    expect(hub).not.toBe('');
    await pool().query(`INSERT INTO agents(tenant_id,alias,harness_id,display_name,enabled,container_name,runtime_user,
        home_directory,state_directory,company_id)
      VALUES($1,$2,'codex',$2,true,$3,'dev',$4,$5,$6)`,
    [hub, agentAlias, `zz-canary-${run}`, `/srv/zz-canary-${run}`, `/srv/zz-canary-${run}/state`, owner.company.slug]);
    await pool().query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES($1,'office',$2,'agent')", [hub, agentAlias]);
    await pool().query("UPDATE agents SET primary_room_id='office' WHERE tenant_id=$1 AND alias=$2", [hub, agentAlias]);
    await pool().query(`INSERT INTO provider_accounts(id,provider,external_account_id,payer_tenant_id,label,
        credential_ref_kind,credential_ref,enabled,company_id)
      VALUES($1,'codex',$1,$2,$1,'secret_manager',$3,true,$4)`,
    [accountId, hub, `op:zz-canary/${run}`, owner.company.slug]);
    await pool().query(`INSERT INTO alias_routing_ceiling(tenant_id,alias,account_id,account_payer_tenant,created_by_tenant)
      VALUES($1,$2,$3,$1,$1)`, [hub, agentAlias, accountId]);
    await pool().query('INSERT INTO agent_account_bindings(tenant_id,agent_alias,account_id,priority,enabled) VALUES($1,$2,$3,1,true)',
      [hub, agentAlias, accountId]);
    const now = new Date().toISOString();
    await pool().query(`INSERT INTO quota_window_state(collector_tenant,host,provider,group_key,window_key,
        captured_at,received_at,remaining_percent,reset_at,status,model,account_id,company_id)
      VALUES($1,$2,'codex','default','week',$3,$3,80,now()+interval '1 hour','ok',NULL,$4,$5)`,
    [hub, `zz-canary-host-${run}`, now, accountId, owner.company.slug]);
    const accounts = await apiGet(page, '/v3/console/quota-accounts');
    expect(accounts.status).toBe(200);
    expect((accounts.body.accounts as { id: string }[]).some((account) => account.id === accountId)).toBe(true);
  });

  it('campus de escritorio: HUD, equipo con barra de vida, tubos, hotbar y enlace de gestión', async () => {
    const page = ownerPage();
    await step(page, 'desktop campus', async () => {
      await openOffice(page);
      await expectCampusRoom(page, 'office', 2);
      const team = page.getByRole('region', { name: 'Equipo', exact: true });
      await team.getByRole('button', { name: new RegExp(escapeRegex(agentAlias), 'u') }).waitFor({ timeout: 20_000 });
      await page.getByRole('button', { name: 'Actualizar', exact: true }).waitFor();
      await page.getByRole('button', { name: /Frecuencia de lectura/u }).waitFor();
      await page.getByText(/Leído/u).first().waitFor();
      await page.screenshot({ path: join(receipts, 'campus-1440x900.png') });
      await page.getByRole('button', { name: 'Plano editable', exact: true }).click();
      await page.getByRole('heading', { name: 'Plano de oficina', exact: true }).waitFor({ timeout: 20_000 });
      await page.screenshot({ path: join(receipts, 'plano-1440x900.png') });
      const link = page.getByRole('link', { name: 'Gestionar salas y asignaciones', exact: true });
      await link.waitFor();
      await link.click();
      await page.getByRole('heading', { name: 'Ajustes', exact: true }).waitFor({ timeout: 20_000 });
      expect(page.url()).toContain('seccion=espacios');
      await page.screenshot({ path: join(receipts, 'gestion-salas-1440x900.png') });
    });
  });

  it('a 840 px los tubos abiertos no tapan la ayuda ni el equipo, y a 390 px el equipo es un cajón', async () => {
    const page = await freshPage('campus-840', { width: 840, height: 1400 });
    await step(page, '840px tubes geometry', async () => {
      await login(page, base(), owner);
      await openOffice(page);
      await page.getByRole('button', { name: /Tubos/u }).first().click();
      await page.getByText(/Todavía no viajó ningún tubo/u).waitFor({ timeout: 20_000 });
      const hint = await page.evaluate(() => {
        const element = Array.from(document.querySelectorAll('p')).find((candidate) => candidate.textContent.includes('P: paseo'));
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;
      });
      const tubes = await box(page, 'section[aria-label="Tubos"]');
      const team = await box(page, 'section[aria-label="Equipo"]');
      const side = await box(page, 'section[aria-label="Tubos"]');
      expect(hint).not.toBeNull();
      expect(tubes).not.toBeNull();
      if (hint && tubes) expect(overlaps(hint, tubes)).toBe(false);
      if (team && side) expect(overlaps(team, side)).toBe(false);
      await page.screenshot({ path: join(receipts, 'campus-840x1400-tubos.png') });
    });
    await step(page, '390px team drawer', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`${base()}/live`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('region', { name: 'Oficina', exact: true }).waitFor({ timeout: 30_000 });
      const opener = page.getByRole('button', { name: /Equipo/u }).first();
      await opener.waitFor({ timeout: 20_000 });
      await opener.click();
      const team = page.getByRole('region', { name: 'Equipo', exact: true });
      await team.getByRole('button', { name: new RegExp(escapeRegex(agentAlias), 'u') }).waitFor({ timeout: 20_000 });
      await page.screenshot({ path: join(receipts, 'campus-390x844-equipo.png') });
      await team.getByRole('button', { name: 'Cerrar el panel de equipo', exact: true }).click();
    });
  });

  it('controles del campus: zoom, paseo, mapa, tubos, hotbar, teclas y frecuencia de lectura', async () => {
    const page = ownerPage();
    await step(page, 'campus controls', async () => {
      await openOffice(page);
      await page.getByRole('button', { name: 'Acercar', exact: true }).click();
      await page.getByRole('button', { name: 'Alejar', exact: true }).click();
      await page.getByRole('button', { name: 'Ver todo el campus', exact: true }).click();
      const paseo = page.getByRole('button', { name: 'Modo paseo', exact: true });
      await paseo.click();
      await expect.poll(async () => paseo.evaluate((element) => element.getAttribute('aria-pressed'))).toBe('true');
      await paseo.click();
      await expect.poll(async () => paseo.evaluate((element) => element.getAttribute('aria-pressed'))).toBe('false');
      const mapToggle = page.getByRole('button', { name: /el mapa/u }).first();
      await mapToggle.click();
      await mapToggle.click();
      const tubesToggle = page.getByRole('button', { name: /Tubos/u }).first();
      await tubesToggle.click();
      await page.getByText(/Todavía no viajó ningún tubo/u).waitFor({ timeout: 20_000 });
      await tubesToggle.click();
      const listbox = page.getByRole('listbox').first();
      await listbox.click();
      await listbox.press('1');
      const frame = page.locator('[data-nivel]').first();
      await expect.poll(async () => frame.evaluate((element) => element.getAttribute('data-nivel'))).toBe('campus');
      await page.evaluate(() => {
        const canvas = document.querySelector('canvas');
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const down = new PointerEvent('pointerdown', { bubbles: true, clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2, pointerId: 1 });
        const move = new PointerEvent('pointermove', { bubbles: true, clientX: rect.x + rect.width / 2 + 60, clientY: rect.y + rect.height / 2, pointerId: 1 });
        const up = new PointerEvent('pointerup', { bubbles: true, clientX: rect.x + rect.width / 2 + 60, clientY: rect.y + rect.height / 2, pointerId: 1 });
        canvas.dispatchEvent(down);
        canvas.dispatchEvent(move);
        canvas.dispatchEvent(up);
        canvas.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'd' }));
        canvas.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'd' }));
      });
      await page.getByRole('button', { name: /Frecuencia de lectura/u }).click();
      await page.getByRole('menuitemradio', { name: 'Cada 5 s', exact: true }).click();
      await page.getByRole('button', { name: /Frecuencia de lectura: cada 5 s/u }).waitFor({ timeout: 20_000 });
      await page.getByRole('button', { name: 'Actualizar', exact: true }).click();
      await page.screenshot({ path: join(receipts, 'campus-controles-1440x900.png') });
    });
  });

  it('el equipo se pliega con persistencia y su clic abre la tarjeta y la ficha con barra de vida', async () => {
    const page = ownerPage();
    await step(page, 'party fold and sheet', async () => {
      await openOffice(page);
      const team = page.getByRole('region', { name: 'Equipo', exact: true });
      await team.getByRole('button', { name: new RegExp(escapeRegex(agentAlias), 'u') }).waitFor({ timeout: 20_000 });
      await team.getByRole('button', { name: 'Plegar el panel de equipo', exact: true }).click();
      await team.getByRole('button', { name: 'Desplegar el panel de equipo', exact: true }).waitFor();
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByRole('region', { name: 'Oficina', exact: true }).waitFor({ timeout: 30_000 });
      const folded = page.getByRole('region', { name: 'Equipo', exact: true });
      await folded.getByRole('button', { name: 'Desplegar el panel de equipo', exact: true }).waitFor({ timeout: 20_000 });
      await folded.getByRole('button', { name: 'Desplegar el panel de equipo', exact: true }).click();
      await folded.getByRole('button', { name: new RegExp(escapeRegex(agentAlias), 'u') }).click();
      const summary = page.getByRole('region', { name: `Cuota de ${agentAlias}`, exact: true });
      await summary.getByText(/Disponible/u).waitFor({ timeout: 20_000 });
      await page.screenshot({ path: join(receipts, 'tarjeta-agente-1440x900.png') });
      await page.getByRole('button', { name: 'Ficha', exact: true }).click();
      const sheet = page.getByRole('dialog');
      await sheet.getByText(agentAlias, { exact: true }).first().waitFor({ timeout: 20_000 });
      const detail = sheet.getByRole('region', { name: `Disponibilidad de ${agentAlias}`, exact: true });
      await detail.getByText('Disponible', { exact: true }).first().waitFor({ timeout: 20_000 });
      await expect.poll(() => detail.locator('[data-fatigue]').first().evaluate((element) => (element as HTMLElement).dataset.fatigue)).toBe('available');
      expect(await detail.locator('[data-fatigue] span').first().evaluate((element) => element.className)).toContain('border');
      await sheet.getByRole('tab', { name: 'Conexión', exact: true }).click();
      await sheet.getByText('Epoch', { exact: true }).waitFor();
      await sheet.getByRole('tab', { name: /Entregas/u }).click();
      await sheet.getByText('Ninguna entrega en vuelo.', { exact: true }).waitFor();
      await sheet.getByRole('tab', { name: 'Ahora', exact: true }).click();
      await sheet.getByRole('button', { name: 'Releer cuota', exact: true }).waitFor();
      await sheet.getByRole('button', { name: `Acciones de ${agentAlias}`, exact: true }).click();
      await page.getByRole('menuitem', { name: 'Copiar alias', exact: true }).waitFor({ timeout: 20_000 });
      await page.getByRole('menuitem', { name: /favoritos/u }).waitFor();
      await page.getByRole('menuitem', { name: 'Personalizar icono…', exact: true }).waitFor();
      await page.screenshot({ path: join(receipts, 'ficha-agente-1440x900.png') });
      await sheet.getByRole('button', { name: 'Cerrar el detalle', exact: true }).click();
    });
  });

  it('sin errores de consola ni respuestas HTTP inesperadas', () => {
    errors.assertClean();
    expect(unexpectedHttp).toEqual([]);
  });
});
