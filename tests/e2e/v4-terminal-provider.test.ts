import { beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startRealPtyFixture, type RealPtyFixture } from './real-pty-agent.fixtures.js';
import { asV4Page, type V4Page } from './v4-console-real-browser.helpers.js';
import { openclawFixtureDiagnostics, providerTuiVersion, readShellCanary, type RealTuiHarness } from './v4-terminal-provider.fixtures.js';

const owner = 'h8-tui-v4-1025';
const runId = randomUUID();
const artifacts = join(process.cwd(), '.delegados/v4/recibos', owner, 'provider-runs', runId);
const harnesses: RealTuiHarness[] = ['codex', 'claude', 'grok', 'muse', 'openclaw'];
const cases = [...harnesses.map(harness => ({ harness, label: harness, gateway: false })),
  { harness: 'openclaw' as const, label: 'openclaw-gateway', gateway: true }];

beforeAll(async () => {
  await mkdir(artifacts, { recursive: true });
  const paths = ['tests/e2e/v4-terminal-provider.fixtures.ts', 'tests/e2e/v4-terminal-provider.test.ts',
    'tests/e2e/v4-terminal-runtime.fixtures.ts', 'tests/e2e/real-pty-agent.fixtures.ts'];
  const files = Object.fromEntries(await Promise.all(paths.map(async path =>
    [path, createHash('sha256').update(await readFile(path)).digest('hex')] as const)));
  await writeFile(join(artifacts, 'manifest.json'), JSON.stringify({ run_id: runId, directory: artifacts, files }, null, 2));
  process.stdout.write(`terminal-provider-artifacts ${JSON.stringify({ run_id: runId, directory: artifacts })}\n`);
});

async function captureTui(page: V4Page, fixture: RealPtyFixture, harness: RealTuiHarness): Promise<string> {
  return harness === 'openclaw' ? page.locator('.xterm-rows').innerText() : fixture.captureTmux();
}

function requiresExternalApproval(text: string): boolean {
  return /Waiting for approval|Approve in your browser|Make sure your browser shows|device_code|user_code/iu.test(text);
}

async function screenshot(page: V4Page, name: string): Promise<void> {
  if (requiresExternalApproval(await page.locator('body').innerText())) throw new Error('provider authentication requires external approval; capture omitted');
  await page.screenshot({ path: join(artifacts, name), fullPage: true });
}

async function attached(page: V4Page): Promise<string> {
  await page.locator('[data-pty-shell][data-state="open"]').waitFor({ timeout: 30_000 });
  return page.locator('[data-session-id]').evaluate(element => element.getAttribute('data-session-id') ?? '');
}

async function closeSession(page: V4Page, fixture: RealPtyFixture, id: string): Promise<void> {
  await page.getByRole('button', { name: 'Más acciones', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Cerrar sesión PTY', exact: true }).click();
  await expect.poll(async () => {
    const rows = await fixture.database.pool.query<{ closed: boolean; holds: string }>(
      `SELECT closed_at IS NOT NULL AS closed,
       (SELECT count(*)::text FROM terminal_control_holds WHERE session_id=$1 AND released_at IS NULL) AS holds
       FROM terminal_sessions WHERE id=$1`, [id]);
    return rows.rows[0];
  }, { timeout: 20_000 }).toEqual({ closed: true, holds: '0' });
}

async function login(fixture: RealPtyFixture, width: number): Promise<V4Page> {
  const page = asV4Page(await fixture.browserPage({ width, height: width === 390 ? 844 : 900 }));
  await page.goto(fixture.baseUrl, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Correo', { exact: true }).fill(fixture.operatorEmail);
  await page.getByLabel('Contraseña', { exact: true }).fill(fixture.operatorPassword);
  await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
  await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });
  const cookie = (await page.context().cookies(fixture.baseUrl)).find(value => value.name === '__Host-cauce_session');
  if (!cookie) throw new Error('nominal browser login omitted its session');
  await fixture.waitForTarget(`${cookie.name}=${cookie.value}`);
  return page;
}

async function dismissOnboarding(page: V4Page, fixture: RealPtyFixture): Promise<void> {
  for (let step = 0; step < 6; step += 1) {
    const pane = await fixture.captureTmux();
    if (!/Choose the text style|Do you trust|Yes, I trust|Press Enter to continue|Do you want to use this API key/iu.test(pane)) return;
    if (/❯\s*No, exit/u.test(pane)) await page.locator('.xterm-helper-textarea').press('ArrowDown');
    await page.locator('.xterm-helper-textarea').press('Enter');
    await page.waitForTimeout(500);
  }
}

describe.sequential('TUI reales de proveedor sin credenciales ni inferencia', () => {
  it('explica en español el destino que solo publica Shell sin inventar una TUI', async () => {
    const fixture = await startRealPtyFixture({ owner });
    try {
      for (const width of [1440, 390]) {
        const page = await login(fixture, width);
        try {
          await page.goto(`${fixture.baseUrl}/terminal/${fixture.tenant}/${fixture.targetAlias}?modo=tui`, { waitUntil: 'domcontentloaded' });
          await page.getByText('su arnés puede no ofrecer una TUI o su sesión aún no está preparada', { exact: false }).waitFor({ timeout: 20_000 });
          expect(await page.locator('[data-pty-shell]').count()).toBe(0);
          expect(await page.getByRole('button', { name: 'Tomar el control', exact: true }).count()).toBe(0);
          await screenshot(page, `sin-tui-${String(width)}.png`);
        } finally { await page.context().close(); }
      }
      const sessions = await fixture.database.pool.query('SELECT id FROM terminal_sessions');
      expect(sessions.rows).toHaveLength(0);
    } finally { await fixture.close(); }
  }, 600_000);

  it.each(cases)('$label: shell, visor, control, borrador y devolución desde Chromium', async ({ harness, label, gateway }) => {
    const fixture = await startRealPtyFixture({ tui: true, realTuiHarness: harness, openclawGateway: gateway, owner, sessionTtlSeconds: 300 });
    try {
      const version = await providerTuiVersion(fixture.agentContainer, harness);
      await writeFile(join(artifacts, `${label}-version.txt`), version + '\n');
      for (const width of [1440, 390]) {
        const page = await login(fixture, width);
        const prefix = `${label}-${String(width)}`;
        const grantsPath = join(fixture.directory, 'grants.json');
        const grantsOriginal = await readFile(grantsPath, 'utf8');
        const snapshot = async (stage: string) => {
          if (harness === 'openclaw') await writeFile(join(artifacts, `${prefix}-${stage}-state.json`),
            await openclawFixtureDiagnostics(fixture.agentContainer).catch(() => '{"diagnostic":"unavailable"}\n'));
        };
        try {
          const route = `${fixture.baseUrl}/terminal/${fixture.tenant}/${fixture.targetAlias}`;
          await page.goto(`${route}?modo=terminal`, { waitUntil: 'domcontentloaded' });
          const shell = await attached(page);
          const nonce = `SHELL-${randomUUID()}`;
          await page.locator('.xterm-helper-textarea').type(`printf '${nonce}' > /tmp/${nonce}; printf '${nonce}\\n'`);
          await page.locator('.xterm-helper-textarea').press('Enter');
          await expect.poll(() => page.locator('.xterm-rows').innerText(), { timeout: 20_000 }).toContain(nonce);
          await expect.poll(() => readShellCanary(fixture.agentContainer, nonce), { timeout: 10_000 }).toBe(nonce);
          await screenshot(page, `${prefix}-shell.png`);
          await closeSession(page, fixture, shell);

          const grants = JSON.parse(grantsOriginal) as { grants: { modes: string[] }[] };
          for (const grant of grants.grants) grant.modes = ['shell', 'harness'];
          await writeFile(grantsPath, JSON.stringify(grants));
          await page.waitForTimeout(1_100);
          await snapshot('before-viewer');
          await page.goto(`${route}?modo=tui`, { waitUntil: 'domcontentloaded' });
          const viewer = await attached(page);
          expect(await page.locator('[data-pty-shell]').evaluate(element => element.getAttribute('data-read-only'))).toBe('true');
          const observed = await fixture.database.pool.query<{ mode: string }>('SELECT mode FROM terminal_sessions WHERE id=$1', [viewer]);
          expect(observed.rows[0]?.mode).toBe('harness');
          await snapshot('viewer-open');
          if (harness === 'openclaw') await expect.poll(() => captureTui(page, fixture, harness), { timeout: 20_000 }).toContain('CAUCE-CANARY-EXISTING-HISTORY');
          await snapshot('viewer-ready');
          await screenshot(page, `${prefix}-visor.png`);
          await writeFile(grantsPath, grantsOriginal);
          await page.waitForTimeout(1_100);
          await page.getByRole('button', { name: 'Más acciones', exact: true }).click();
          await page.getByRole('menuitem', { name: 'Actualizar flota y permisos', exact: true }).click();
          await page.getByRole('button', { name: 'Tomar el control', exact: true }).click();
          await page.getByRole('button', { name: 'Devolver el control', exact: true }).waitFor({ timeout: 20_000 });
          const controlled = await attached(page);
          await snapshot('control-open');
          if (harness === 'openclaw') {
            await expect.poll(() => captureTui(page, fixture, harness), { timeout: 30_000 }).toContain('CAUCE-CANARY-EXISTING-HISTORY');
            await expect.poll(() => captureTui(page, fixture, harness), { timeout: 30_000 }).toContain(gateway ? 'gateway connected' : 'local ready');
          }
          await snapshot('control-ready');
          if (harness !== 'openclaw') await dismissOnboarding(page, fixture);
          const draft = `CANARY-DRAFT-${randomUUID().slice(0, 8)}`;
          await page.locator('.xterm-helper-textarea').type(draft);
          await expect.poll(() => captureTui(page, fixture, harness), { timeout: 20_000 }).toContain(draft);
          const capture = await captureTui(page, fixture, harness);
          if (requiresExternalApproval(capture)) throw new Error('provider requires external authentication; terminal capture omitted');
          await writeFile(join(artifacts, `${prefix}-tui.txt`), capture);
          await screenshot(page, `${prefix}-control.png`);
          await page.locator('.xterm-helper-textarea').press('Control+u');
          await page.getByRole('button', { name: 'Devolver el control', exact: true }).click();
          await page.getByRole('button', { name: 'Tomar el control', exact: true }).waitFor();
          const holds = await fixture.database.pool.query('SELECT id FROM terminal_control_holds WHERE session_id=$1 AND released_at IS NULL', [controlled]);
          expect(holds.rows).toHaveLength(0);
          const forbidden = `READONLY-${randomUUID().slice(0, 8)}`;
          await page.locator('.xterm-helper-textarea').type(forbidden);
          await page.waitForTimeout(300);
          expect(await captureTui(page, fixture, harness)).not.toContain(forbidden);
          await screenshot(page, `${prefix}-devuelta.png`);
          await closeSession(page, fixture, controlled);
          await writeFile(join(artifacts, `${prefix}-resultado.json`), JSON.stringify({ harness, version, gateway, width, shell_effect_verified: true, viewer_mode: 'harness', draft_received: true, control_released: true, provider_authenticated: false, inference_requested: false }, null, 2));
        } catch (error) {
          await snapshot('failure');
          if (harness === 'openclaw') await writeFile(join(artifacts, `${prefix}-pty-relay.log`), `${fixture.agentLog()}\n${fixture.relayLog()}`);
          const capture = `${await page.locator('body').innerText()}\n${await captureTui(page, fixture, harness).catch(() => '<pane unavailable>')}`;
          if (!requiresExternalApproval(capture)) await screenshot(page, `${prefix}-fallo.png`);
          await writeFile(join(artifacts, `${prefix}-fallo.txt`), requiresExternalApproval(capture) ? 'La CLI requiere autorización externa. No se conserva el código temporal ni se autentica una cuenta.\n' : capture);
          throw error;
        } finally {
          await writeFile(grantsPath, grantsOriginal);
          await page.context().close();
        }
      }
    } finally { await fixture.close(); }
  }, 900_000);
});
