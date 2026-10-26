import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startRealPtyFixture, type RealPtyFixture } from './real-pty-agent.fixtures.js';
import { asV4Page, apiGet, bodySnippet, type V4Page } from './v4-console-real-browser.helpers.js';

const OWNER = 'e2e-a8-terminal-1025';
const artifacts = join(process.cwd(), '.delegados/v4/recibos', OWNER);
let fixture: RealPtyFixture;
let closeFixture: () => Promise<void> = async () => undefined;

beforeAll(async () => {
  await mkdir(artifacts, { recursive: true });
  fixture = await startRealPtyFixture({ tui: true, owner: OWNER, maxSessionsPerOperator: 1, sessionTtlSeconds: 120 });
  closeFixture = () => fixture.close();
}, 600_000);
afterAll(async () => { await closeFixture(); }, 60_000);

async function screenshot(page: V4Page, name: string): Promise<void> {
  await page.screenshot({ path: join(artifacts, `${name}.png`), fullPage: true });
}

async function openPage(width = 1440, height = 900): Promise<V4Page> {
  const page = asV4Page(await fixture.browserPage({ width, height }, { isMobile: width < 500, hasTouch: width < 500 }));
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

async function terminal(page: V4Page, suffix = ''): Promise<void> {
  await page.goto(`${fixture.baseUrl}/terminal/${fixture.tenant}/${fixture.targetAlias}${suffix}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Terminal de agentes', exact: true }).waitFor({ timeout: 30_000 });
}

async function attached(page: V4Page): Promise<string> {
  await page.locator('[data-pty-shell][data-state="open"]').waitFor({ timeout: 30_000 });
  return page.locator('[data-session-id]').evaluate((element) => element.getAttribute('data-session-id') ?? '');
}

async function typeCommand(page: V4Page, command: string): Promise<void> {
  const input = page.locator('.xterm-helper-textarea');
  await input.type(command);
  await input.press('Enter');
}

async function output(page: V4Page, expected: string): Promise<void> {
  await expect.poll(() => page.locator('.xterm-rows').innerText(), { timeout: 20_000 }).toContain(expected);
}

async function menu(page: V4Page, action: string): Promise<void> {
  let closedStatus: number | undefined;
  if (action === 'Cerrar sesión de terminal') page.on('response', (response) => {
    if (response.request().method() === 'DELETE' && response.url().includes('/v3/console/terminal/sessions/')) closedStatus = response.status();
  });
  await page.getByRole('button', { name: 'Más acciones', exact: true }).click();
  await page.getByRole('menuitem', { name: action, exact: true }).click();
  if (action === 'Cerrar sesión de terminal') await expect.poll(() => closedStatus).toBe(204);
}

async function sessionClosed(id: string): Promise<void> {
  await expect.poll(async () => {
    const rows = await fixture.database.pool.query<{ closed: boolean; holds: string }>(
      `SELECT closed_at IS NOT NULL AS closed,
       (SELECT count(*)::text FROM terminal_control_holds WHERE session_id=$1 AND released_at IS NULL AND expires_at>clock_timestamp()) AS holds
       FROM terminal_sessions WHERE id=$1`, [id]);
    return rows.rows[0];
  }, { timeout: 20_000 }).toEqual({ closed: true, holds: '0' });
}

async function closePage(page: V4Page): Promise<void> {
  try {
    await page.getByRole('navigation', { name: 'Navegación principal', exact: true })
      .locator('a[href="/messages"], a[href^="/messages/"]').click();
  } finally { await page.context().close(); }
}

describe.sequential('terminal real desde Chromium, gateway, PostgreSQL, relay y Python', () => {
  it.each([{ width: 1440, height: 900 }, { width: 390, height: 844 }])(
    'inicio, destinos, TUI escribible, devolución, retoma, shell y cambio de modo en $width', async ({ width, height }) => {
      const page = await openPage(width, height);
      try {
        await page.goto(`${fixture.baseUrl}/terminal`, { waitUntil: 'domcontentloaded' });
        await page.getByRole('heading', { name: width < 500 ? 'Elige un agente para abrir su terminal' : 'Elige un agente en la barra lateral' })
          .waitFor({ timeout: 30_000 }).catch(async (cause: unknown) => {
            await screenshot(page, `${String(width)}-inicio-error`);
            throw new Error(`terminal home did not become ready: ${await bodySnippet(page)}`, { cause });
          });
        const targets = await apiGet(page, '/v3/console/terminal/targets');
        expect(targets.status).toBe(200);
        expect(targets.body.items).toEqual(expect.arrayContaining([expect.objectContaining({ alias: fixture.targetAlias, pty_state: 'online' })]));
        await screenshot(page, `${String(width)}-inicio`);
        await terminal(page);
        const tui = await attached(page);
        await page.getByRole('button', { name: 'Devolver el control', exact: true }).waitFor({ timeout: 20_000 });
        const nonce = randomUUID();
        await typeCommand(page, `printf 'TUI:%s\\n' '${nonce}'`);
        await output(page, `TUI:${nonce}`);
        await expect.poll(() => fixture.captureTmux(), { timeout: 10_000 }).toContain(`TUI:${nonce}`);
        const hold = await fixture.database.pool.query('SELECT id FROM terminal_control_holds WHERE session_id=$1 AND released_at IS NULL', [tui]);
        expect(hold.rows).toHaveLength(1);
        await screenshot(page, `${String(width)}-tui-control`);
        await page.getByRole('button', { name: 'Devolver el control', exact: true }).click();
        await page.getByRole('button', { name: 'Tomar el control', exact: true }).waitFor();
        const release = await fixture.database.pool.query('SELECT id FROM terminal_control_holds WHERE session_id=$1 AND released_at IS NULL', [tui]);
        expect(release.rows).toHaveLength(0);
        expect(await page.locator('[data-pty-shell]').evaluate((element) => element.getAttribute('data-read-only'))).toBe('true');
        const forbidden = `FORBIDDEN-${randomUUID()}`;
        await typeCommand(page, `printf '${forbidden}\\n'`);
        await page.waitForTimeout(300);
        expect(await fixture.captureTmux()).not.toContain(forbidden);
        await screenshot(page, `${String(width)}-tui-devuelta`);
        await page.getByRole('button', { name: 'Tomar el control', exact: true }).click();
        await page.getByRole('button', { name: 'Devolver el control', exact: true }).waitFor({ timeout: 20_000 });
        const retaken = await attached(page);
        expect(retaken).not.toBe(tui);
        await sessionClosed(tui);
        await page.getByRole('group', { name: 'Vista de la sesión', exact: true }).getByRole('button', { name: 'Terminal', exact: true }).click();
        const shell = await attached(page);
        expect(shell).not.toBe(retaken);
        await sessionClosed(retaken);
        await typeCommand(page, `printf 'SHELL:%s\\n' '${nonce}'; id -u; pwd`);
        await output(page, `SHELL:${nonce}`);
        expect(await fixture.captureTmux()).not.toContain(`SHELL:${nonce}`);
        await screenshot(page, `${String(width)}-shell`);
        await menu(page, 'Actualizar flota y permisos');
        expect(await attached(page)).toBe(shell);
        await menu(page, 'Cerrar sesión de terminal');
        await sessionClosed(shell);
        await page.getByRole('button', { name: 'Abrir terminal', exact: true }).waitFor();
        await page.getByRole('group', { name: 'Vista de la sesión', exact: true }).getByRole('button', { name: 'TUI', exact: true }).click();
        const reopened = await attached(page);
        expect(reopened).not.toBe(shell);
        await page.getByRole('button', { name: 'Devolver el control', exact: true }).waitFor({ timeout: 20_000 });
        await menu(page, 'Cerrar sesión de terminal');
        await sessionClosed(reopened);
      } finally { await closePage(page); }
    }, 180_000,
  );

  it('prorroga la sesión persistida y actualiza la ventana restante en pantalla', async () => {
    const page = await openPage();
    try {
      await terminal(page, '?modo=terminal');
      const id = await attached(page);
      await menu(page, 'Prorrogar sesión');
      const countdown = page.locator('[aria-label^="Ventana restante:"]');
      await countdown.waitFor();
      const first = await countdown.evaluate((element) => element.getAttribute('aria-label'));
      await screenshot(page, '1440-prorroga-inicial');
      await expect.poll(() => countdown.evaluate((element) => element.getAttribute('aria-label')), { timeout: 4_000 }).not.toBe(first);
      const rows = await fixture.database.pool.query<{ window_extended_to: Date | null }>('SELECT window_extended_to FROM terminal_sessions WHERE id=$1', [id]);
      expect(rows.rows[0]?.window_extended_to).toBeInstanceOf(Date);
      const audit = await fixture.database.pool.query("SELECT id FROM audit_events WHERE action='terminal.session.extended' AND metadata->>'session_id'=$1", [id]);
      expect(audit.rows).toHaveLength(1);
      await screenshot(page, '1440-prorroga');
      await menu(page, 'Cerrar sesión de terminal');
      await sessionClosed(id);
    } finally { await closePage(page); }
  }, 90_000);

  it.each([1440, 390])('visor de solo lectura sin transmitir teclado ni tomar control en %i', async (width) => {
    const grantsPath = join(fixture.directory, 'grants.json');
    const original = await readFile(grantsPath, 'utf8');
    const grants = JSON.parse(original) as { grants: { modes: string[] }[] };
    for (const grant of grants.grants) grant.modes = ['shell', 'harness'];
    let page: V4Page | undefined;
    try {
      await writeFile(grantsPath, JSON.stringify(grants));
      page = await openPage(width, width === 390 ? 844 : 900);
      await terminal(page);
      const id = await attached(page);
      expect(await page.locator('[data-pty-shell]').evaluate((element) => element.getAttribute('data-read-only'))).toBe('true');
      const rows = await fixture.database.pool.query<{ mode: string }>('SELECT mode FROM terminal_sessions WHERE id=$1', [id]);
      expect(rows.rows[0]?.mode).toBe('harness');
      expect(await page.getByRole('button', { name: 'Tomar el control', exact: true }).count()).toBe(0);
      const marker = `READONLY-${randomUUID()}`;
      await typeCommand(page, `printf '${marker}\\n'`);
      await page.waitForTimeout(300);
      const barrier = randomUUID();
      await fixture.sendTmux(`printf 'VIEWER:%s\\n' '${barrier}'`);
      await output(page, `VIEWER:${barrier}`);
      expect(await fixture.captureTmux()).not.toContain(marker);
      await screenshot(page, `${String(width)}-visor`);
      await menu(page, 'Cerrar sesión de terminal');
      await sessionClosed(id);
    } finally {
      await writeFile(grantsPath, original);
      if (page) await closePage(page);
    }
  }, 90_000);

  it.each([1440, 390])('login por PTY ejecuta el descriptor una sola vez en %i', async (width) => {
    const page = await openPage(width, width === 390 ? 844 : 900);
    try {
      await terminal(page, '?modo=terminal&accion=autenticar');
      const id = await attached(page);
      await output(page, 'CAUCE-E2E-CODEX-LOGIN');
      await page.getByText('Se ejecutó', { exact: false }).waitFor();
      await typeCommand(page, "printf 'LOGIN-STATE:%s\\n' \"$(cat /tmp/cauce-e2e-login-state)\"");
      await output(page, 'LOGIN-STATE:AUTHENTICATED');
      await menu(page, 'Actualizar flota y permisos');
      expect((await page.locator('.xterm-rows').innerText()).match(/CAUCE-E2E-CODEX-LOGIN/gu)).toHaveLength(1);
      await screenshot(page, `${String(width)}-login-pty`);
      await menu(page, 'Cerrar sesión de terminal');
      await sessionClosed(id);
    } finally { await closePage(page); }
  }, 90_000);

  it('muestra y descarta la negativa real si se retira la concesión después de leer el destino', async () => {
    const page = await openPage();
    const grantsPath = join(fixture.directory, 'grants.json');
    const original = await readFile(grantsPath, 'utf8');
    try {
      await terminal(page, '?modo=terminal');
      const id = await attached(page);
      await menu(page, 'Cerrar sesión de terminal');
      await sessionClosed(id);
      await writeFile(grantsPath, JSON.stringify({ version: 1, grants: [] }));
      await page.waitForTimeout(1_100);
      const denied: number[] = [];
      page.on('response', (response) => {
        if (response.request().method() === 'POST' && response.url().endsWith('/v3/console/terminal/sessions')) denied.push(response.status());
      });
      await page.getByRole('button', { name: 'Abrir terminal', exact: true }).click();
      await page.locator('[data-negativa][data-codigo="no_grant"]').waitFor();
      expect(denied).toContain(403);
      await screenshot(page, '1440-negativa-concesion');
      await page.getByRole('button', { name: 'Descartar', exact: true }).click();
      expect(await page.locator('[data-negativa]').count()).toBe(0);
      expect((await apiGet(page, '/v3/console/terminal/sessions')).status).toBe(200);
    } finally {
      await writeFile(grantsPath, original);
      await page.waitForTimeout(1_100);
      await closePage(page);
    }
  }, 90_000);

  it('identifica plazas de otra pestaña, respeta la autoridad original y relee su liberación', async () => {
    const human = await fixture.login();
    const reserved: Record<string, string>[] = [];
    let page: V4Page | undefined;
    try {
      for (let index = 0; index < 1; index += 1) {
        const requestId = randomUUID();
        const ownerToken = randomUUID();
        const admission = await fixture.request('/v3/console/terminal/sessions', {
          method: 'POST', headers: { cookie: human.cookie, 'x-csrf-token': human.csrf, origin: fixture.gatewayUrl },
          body: { tenant_id: fixture.tenant, alias: fixture.targetAlias, mode: 'shell', cols: 80, rows: 24, request_id: requestId, owner_token: ownerToken },
        });
        expect(admission.status).toBe(201);
        reserved.push({ ...JSON.parse(admission.body) as Record<string, string>, owner_token: ownerToken });
      }
      page = await openPage(390, 844);
      await terminal(page, '?modo=terminal');
      const seats = page.getByRole('region', { name: 'Sesiones de terminal que siguen ocupando plaza', exact: true });
      await seats.waitFor();
      await page.locator('[data-negativa][data-codigo="session_limit"]').waitFor();
      expect(await seats.getByRole('button', { name: 'Cerrar ahora', exact: true }).count()).toBe(1);
      await seats.getByRole('button', { name: 'Cerrar ahora', exact: true }).first().click();
      await seats.getByText('Esta pestaña no conserva la prueba original', { exact: false }).waitFor();
      await screenshot(page, '390-plazas-autoridad');
      for (const grant of reserved) {
        const response = await fixture.request(`/v3/console/terminal/sessions/${grant.session_id ?? ''}`, {
          method: 'DELETE', headers: { cookie: human.cookie, 'x-csrf-token': human.csrf, origin: fixture.gatewayUrl },
          body: { request_id: grant.request_id, owner_generation: grant.owner_generation, owner_token: grant.owner_token },
        });
        expect(response.status).toBe(204);
      }
      await seats.getByRole('button', { name: 'Revisar', exact: true }).click();
      await page.getByText('El tope se liberó antes de terminar la verificación', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Descartar', exact: true }).click();
      await page.getByRole('button', { name: 'Abrir terminal', exact: true }).click();
      const id = await attached(page);
      await menu(page, 'Cerrar sesión de terminal');
      await sessionClosed(id);
    } finally {
      for (const grant of reserved) await fixture.request(`/v3/console/terminal/sessions/${grant.session_id ?? ''}`, {
        method: 'DELETE', headers: { cookie: human.cookie, 'x-csrf-token': human.csrf, origin: fixture.gatewayUrl },
        body: { request_id: grant.request_id, owner_generation: grant.owner_generation, owner_token: grant.owner_token },
      });
      if (page) await closePage(page);
    }
  }, 120_000);

  it('explica un destino inexistente y permite volver al inicio', async () => {
    const page = await openPage(390, 844);
    try {
      await page.goto(`${fixture.baseUrl}/terminal/${fixture.tenant}/zz-canary-missing`, { waitUntil: 'domcontentloaded' });
      await page.getByText('El servidor no observa al agente', { exact: false }).waitFor();
      expect(await page.locator('[data-pty-shell]').count()).toBe(0);
      await screenshot(page, '390-destino-inexistente');
      await page.getByRole('link', { name: 'Elegir otro agente', exact: true }).click();
      await page.getByRole('heading', { name: 'Elige un agente para abrir su terminal' }).waitFor();
    } finally { await closePage(page); }
  }, 60_000);
});
