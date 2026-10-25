import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { startRealPtyFixture, type RealPtyFixture } from './real-pty-agent.fixtures.js';
import { asV4Page } from './v4-console-real-browser.helpers.js';

const artifacts = join(process.cwd(), '.delegados/v4/recibos/e2e-a8-terminal-1025');
let fixture: RealPtyFixture;
let closeFixture: () => Promise<void> = async () => undefined;

beforeAll(async () => {
  await mkdir(artifacts, { recursive: true });
  fixture = await startRealPtyFixture({ tui: true, owner: 'e2e-a8-terminal-1025', idleTimeoutSeconds: 8 });
  closeFixture = () => fixture.close();
}, 600_000);
afterAll(async () => { await closeFixture(); }, 60_000);

describe.sequential('inactividad real de la TUI', () => {
  it.each([1440, 390])('libera control, explica el cierre y permite una sesión nueva en %i', async (width) => {
    const page = asV4Page(await fixture.browserPage({ width, height: width === 390 ? 844 : 900 }));
    try {
      await page.goto(fixture.baseUrl, { waitUntil: 'domcontentloaded' });
      await page.getByLabel('Correo', { exact: true }).fill(fixture.operatorEmail);
      await page.getByLabel('Contraseña', { exact: true }).fill(fixture.operatorPassword);
      await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
      await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });
      await page.goto(`${fixture.baseUrl}/terminal/${fixture.tenant}/${fixture.targetAlias}`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: 'Devolver el control', exact: true }).waitFor({ timeout: 30_000 });
      const id = await page.locator('[data-session-id]').evaluate((element) => element.getAttribute('data-session-id'));
      await page.locator('[data-pty-shell][data-state="closed"]').waitFor({ timeout: 20_000 });
      await page.screenshot({ path: join(artifacts, `${String(width)}-inactividad.png`), fullPage: true });
      const closedText = await page.locator('[data-pty-shell]').innerText();
      expect(closedText).toContain('4408');
      expect(closedText).toContain('inactividad');
      await page.getByRole('button', { name: 'Tomar el control', exact: true }).waitFor();
      expect(await page.getByRole('button', { name: 'Devolver el control', exact: true }).count()).toBe(0);
      await expect.poll(async () => {
        const rows = await fixture.database.pool.query<{ closed_at: Date | null }>('SELECT closed_at FROM terminal_sessions WHERE id=$1', [id]);
        return rows.rows[0]?.closed_at instanceof Date;
      }, { timeout: 10_000 }).toBe(true);
      const holds = await fixture.database.pool.query<{ released_at: Date | null }>('SELECT released_at FROM terminal_control_holds WHERE session_id=$1', [id]);
      expect(holds.rows).toHaveLength(1);
      expect(holds.rows[0]?.released_at).toBeInstanceOf(Date);
      await page.getByRole('button', { name: 'Pedir sesión nueva', exact: true }).click();
      await page.locator('[data-pty-shell][data-state="open"]').waitFor({ timeout: 30_000 });
      await page.getByRole('button', { name: 'Devolver el control', exact: true }).waitFor({ timeout: 20_000 });
      const next = await page.locator('[data-session-id]').evaluate((element) => element.getAttribute('data-session-id'));
      expect(next).not.toBe(id);
      await page.getByRole('button', { name: 'Más acciones', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Cerrar sesión PTY', exact: true }).click();
      await expect.poll(async () => {
        const rows = await fixture.database.pool.query<{ revoked_at: Date | null }>('SELECT revoked_at FROM terminal_sessions WHERE id=$1', [next]);
        return rows.rows[0]?.revoked_at instanceof Date;
      }).toBe(true);
    } finally {
      await page.getByRole('navigation', { name: 'Navegación principal', exact: true })
        .locator('a[href="/messages"], a[href^="/messages/"]').click();
      await page.context().close();
    }
  }, 90_000);
});
