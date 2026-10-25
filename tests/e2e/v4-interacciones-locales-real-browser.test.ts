import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newTrustedPage, startConsoleFunctionalFixture } from './console-functional-browser.fixtures.js';
import { observeUiBootstrap } from './ui-bootstrap-diagnostics.js';
import {
  asV4Page, BrowserErrorLog, fillRegistration, HERMETIC_INSTANCE_RULES, login, openRegistration,
  PATTERN_DEFECT_RULE, syntheticPerson, type IgnoredConsoleRule, type V4Locator, type V4Page,
} from './v4-console-real-browser.helpers.js';

const run = randomUUID().replaceAll('-', '').slice(0, 8);
const receipts = join(process.cwd(), '.delegados/v4/recibos/x4-interacciones-locales-1025');
const person = {
  ...syntheticPerson('x4', run),
  company: { name: 'Empresa X4', slug: 'zz-canary-x4-locales-1025' },
};
const desktop = { width: 1440, height: 900 };
const phone = { width: 390, height: 844 };
const spaceBackup: IgnoredConsoleRule = {
  id: 'space-backup-404', reason: 'hermetic gateway does not mount space backups',
  matches: (text, url) => text.includes('status of 404') && /\/spaces\/[^/]+\/[^/]+\/backups$/u.test(url),
};
const terminalTargets: IgnoredConsoleRule = {
  id: 'terminal-targets-404', reason: 'hermetic gateway does not mount the terminal relay',
  matches: (text, url) => text.includes('status of 404') && url.endsWith('/v3/console/terminal/targets'),
};
const errors = new BrowserErrorLog([...HERMETIC_INSTANCE_RULES, PATTERN_DEFECT_RULE, spaceBackup, terminalTargets]);

let fixture: Awaited<ReturnType<typeof startConsoleFunctionalFixture>> | undefined;
let pageA: V4Page | undefined;
let hub = '';
const writes: string[] = [];

const active = () => { if (!fixture) throw new Error('fixture is not initialized'); return fixture; };
const base = () => active().baseUrl;
const pool = () => active().database.pool;
const ownerPage = () => { if (!pageA) throw new Error('owner has no page'); return pageA; };

interface Pose { x: number; y: number; zoom: number; ax: number; ay: number }
interface PointerPage {
  mouse: {
    move(x: number, y: number, options?: { steps?: number }): Promise<void>;
    down(): Promise<void>;
    up(): Promise<void>;
    wheel(dx: number, dy: number): Promise<void>;
  };
  keyboard: { down(key: string): Promise<void>; up(key: string): Promise<void> };
}

function watch(page: V4Page, label: string): void {
  errors.watch(page, label);
  page.on('request', (value: unknown) => {
    const request = value as { method(): string; url(): string };
    const method = request.method();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
    let path = request.url();
    try { path = new URL(request.url()).pathname; } catch { path = request.url(); }
    writes.push(`${label} ${method} ${path}`);
  });
}

function pressed(locator: V4Locator): Promise<string | null> {
  return locator.evaluate((element) => element.getAttribute('aria-pressed'));
}

function orbState(locator: V4Locator): Promise<string | null> {
  return locator.evaluate((element) => element.getAttribute('data-state'));
}

async function pose(page: V4Page): Promise<Pose | null> {
  return page.evaluate(() => {
    const frame = document.querySelector('[data-nivel]');
    if (!(frame instanceof HTMLElement) || frame.dataset.camZoom === undefined) return null;
    return {
      x: Number(frame.dataset.camX), y: Number(frame.dataset.camY), zoom: Number(frame.dataset.camZoom),
      ax: Number(frame.dataset.avatarX), ay: Number(frame.dataset.avatarY),
    };
  });
}

async function readyPose(page: V4Page): Promise<Pose> {
  await expect.poll(async () => (await pose(page))?.zoom ?? 0, { timeout: 20_000 }).toBeGreaterThan(0);
  const current = await pose(page);
  if (!current) throw new Error('office pose missing');
  return current;
}

function shifted(before: Pose, after: Pose): boolean {
  return Math.abs(after.x - before.x) > 1 || Math.abs(after.y - before.y) > 1;
}

async function openOffice(page: V4Page): Promise<void> {
  await page.goto(`${base()}/live`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('region', { name: 'Oficina', exact: true }).waitFor({ timeout: 30_000 });
  await page.locator('[data-nivel] [role="listbox"] > canvas').waitFor({ timeout: 20_000 });
  await readyPose(page);
}

async function canvasBox(page: V4Page): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await page.locator('[data-nivel] [role="listbox"] > canvas').boundingBox();
  if (!box || box.width < 40 || box.height < 40) throw new Error('office canvas has no box');
  return box;
}

async function drag(page: V4Page, pointer: 'mouse' | 'touch'): Promise<void> {
  const box = await canvasBox(page);
  const x = box.x + box.width / 2;
  const y = box.y + Math.min(box.height / 2, 180);
  if (pointer === 'mouse') {
    const mouse = (page as unknown as PointerPage).mouse;
    await mouse.move(x, y);
    await mouse.down();
    await mouse.move(x + 90, y + 40, { steps: 8 });
    await mouse.up();
    return;
  }
  await page.evaluate(({ x: startX, y: startY }) => {
    const canvas = document.querySelector('[data-nivel] [role="listbox"] > canvas');
    if (!(canvas instanceof HTMLCanvasElement)) return;
    const fire = (type: string, clientX: number, clientY: number) => {
      canvas.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, clientX, clientY, pointerId: 7, pointerType: 'touch', isPrimary: true, buttons: type === 'pointerup' ? 0 : 1,
      }));
    };
    fire('pointerdown', startX, startY);
    fire('pointermove', startX + 30, startY + 12);
    fire('pointermove', startX + 70, startY + 28);
    fire('pointerup', startX + 90, startY + 40);
  }, { x, y });
}

async function holdKey(page: V4Page, key: string): Promise<void> {
  await page.evaluate(() => {
    const list = document.querySelector('[data-nivel] [role="listbox"]');
    if (list instanceof HTMLElement) list.focus();
  });
  const keyboard = (page as unknown as PointerPage).keyboard;
  await keyboard.down(key);
  await page.waitForTimeout(500);
  await keyboard.up(key);
}

async function holdPad(page: V4Page, name: string): Promise<void> {
  const pad = page.getByRole('button', { name, exact: true });
  await pad.waitFor({ timeout: 10_000 });
  const box = await pad.boundingBox();
  if (!box) throw new Error('walk pad has no box');
  const mouse = (page as unknown as PointerPage).mouse;
  await mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await mouse.down();
  await page.waitForTimeout(500);
  await mouse.up();
}

async function shot(page: V4Page, name: string): Promise<void> {
  await page.screenshot({ path: join(receipts, `${name}.png`) });
}

async function openAppearance(page: V4Page): Promise<ReturnType<V4Page['getByRole']>> {
  await page.goto(`${base()}/live?agente=${encodeURIComponent(`${hub}/owner`)}&ficha=1`, { waitUntil: 'domcontentloaded' });
  const sheet = page.locator('[role="dialog"]:has(button[aria-label="Cerrar el detalle"])');
  await sheet.waitFor({ timeout: 30_000 });
  await sheet.getByRole('button', { name: 'Acciones de owner', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Personalizar icono…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Personalizar icono de owner', exact: true });
  await dialog.waitFor({ timeout: 20_000 });
  return dialog;
}

beforeAll(async () => {
  if (process.env.CAUCE_REQUIRE_TESTCONTAINERS !== '1' || process.env.DATABASE_URL || process.env.CAUCE_TEST_DATABASE_URL) {
    throw new Error('this suite runs only through scripts/e2e-lab.sh');
  }
  await mkdir(receipts, { recursive: true });
  fixture = await startConsoleFunctionalFixture();
  pageA = asV4Page(await newTrustedPage(active(), desktop));
  watch(pageA, 'desktop');
  const form = await openRegistration(pageA, base());
  await fillRegistration(form, person);
  await form.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
  await pageA.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });
  const registered = await pool().query<{ tenant_id: string }>(
    'SELECT tenant_id FROM console_users WHERE email_normalized=$1', [person.email]);
  hub = registered.rows[0]?.tenant_id ?? '';
  expect(hub.startsWith('hub-')).toBe(true);
}, 600_000);

afterAll(async () => { await fixture?.close(); }, 180_000);

describe('interacciones locales de la oficina y del icono', () => {
  it('mueve la cámara con el ratón, la rueda y el teclado, y camina, sin escribir', async () => {
    const page = ownerPage();
    writes.length = 0;
    await openOffice(page);
    writes.length = 0;
    const fitted = await readyPose(page);
    await page.getByRole('button', { name: 'Acercar', exact: true }).click();
    await expect.poll(async () => (await pose(page))?.zoom ?? 0, { timeout: 10_000 }).toBeGreaterThan(fitted.zoom);
    const zoomed = await readyPose(page);
    const box = await canvasBox(page);
    const mouse = (page as unknown as PointerPage).mouse;
    await mouse.move(box.x + box.width / 2, box.y + Math.min(box.height / 2, 180));
    await mouse.wheel(0, -240);
    await expect.poll(async () => (await pose(page))?.zoom ?? 0, { timeout: 10_000 }).not.toBe(zoomed.zoom);
    const beforeDrag = await readyPose(page);
    await drag(page, 'mouse');
    await expect.poll(async () => {
      const next = await pose(page);
      return next ? shifted(beforeDrag, next) : false;
    }, { timeout: 10_000 }).toBe(true);
    const beforeKeys = await readyPose(page);
    await holdKey(page, 'd');
    await expect.poll(async () => {
      const next = await pose(page);
      return next ? shifted(beforeKeys, next) : false;
    }, { timeout: 10_000 }).toBe(true);
    await shot(page, 'oficina-camara-1440');
    const beforeWalk = await readyPose(page);
    await page.getByRole('button', { name: 'Modo paseo', exact: true }).click();
    await expect.poll(async () => pressed(page.getByRole('button', { name: 'Modo paseo', exact: true }))).toBe('true');
    await holdKey(page, 'd');
    await expect.poll(async () => {
      const next = await pose(page);
      return next ? Math.hypot(next.ax - beforeWalk.ax, next.ay - beforeWalk.ay) > 1 : false;
    }, { timeout: 10_000 }).toBe(true);
    await shot(page, 'oficina-paseo-1440');
    expect(writes).toEqual([]);
    errors.assertClean();
  }, 120_000);

  it('en el móvil acerca, arrastra con el dedo y camina con el pad, sin escribir', async () => {
    const context = await active().browser.newContext({
      viewport: phone, ignoreHTTPSErrors: false, serviceWorkers: 'block', isMobile: true, hasTouch: true,
    });
    active().contexts.push(context);
    const page = asV4Page(await context.newPage());
    observeUiBootstrap(page);
    watch(page, 'phone');
    await login(page, base(), person);
    await openOffice(page);
    writes.length = 0;
    const show = page.getByRole('button', { name: 'Mostrar panel', exact: true });
    if (await show.count() > 0) await show.click();
    const fitted = await readyPose(page);
    const more = page.getByRole('button', { name: 'Más controles', exact: true });
    if (await more.count() > 0) await more.click();
    await page.getByRole('button', { name: 'Acercar', exact: true }).click();
    await expect.poll(async () => (await pose(page))?.zoom ?? 0, { timeout: 10_000 }).toBeGreaterThan(fitted.zoom);
    const beforeDrag = await readyPose(page);
    await drag(page, 'touch');
    await expect.poll(async () => {
      const next = await pose(page);
      return next ? shifted(beforeDrag, next) : false;
    }, { timeout: 10_000 }).toBe(true);
    await shot(page, 'oficina-camara-390');
    const beforeWalk = await readyPose(page);
    await page.getByRole('button', { name: 'Modo paseo', exact: true }).click();
    await holdPad(page, 'Caminar a la derecha');
    await expect.poll(async () => {
      const next = await pose(page);
      return next ? Math.hypot(next.ax - beforeWalk.ax, next.ay - beforeWalk.ay) > 1 : false;
    }, { timeout: 10_000 }).toBe(true);
    await shot(page, 'oficina-toque-390');
    expect(writes).toEqual([]);
    errors.assertClean();
  }, 120_000);

  it('probar con el estado cambia la vista previa y cerrar sin guardar deja el icono anterior', async () => {
    for (const [label, viewport, shotName] of [
      ['preview-desktop', desktop, 'icono-1440'],
      ['preview-phone', phone, 'icono-390'],
    ] as const) {
      const page = label === 'preview-desktop' ? ownerPage() : await (async () => {
        const context = await active().browser.newContext({
          viewport, ignoreHTTPSErrors: false, serviceWorkers: 'block', isMobile: true, hasTouch: true,
        });
        active().contexts.push(context);
        const created = asV4Page(await context.newPage());
        observeUiBootstrap(created);
        watch(created, label);
        await login(created, base(), person);
        return created;
      })();
      if (label === 'preview-desktop') await page.setViewportSize(desktop);
      const dialog = await openAppearance(page);
      writes.length = 0;
      const preview = dialog.getByRole('img', { name: 'Vista previa del icono de owner', exact: true });
      expect(await orbState(preview)).toBe('idle');
      const states = dialog.getByRole('group', { name: 'Probar con el estado', exact: true });
      await states.getByRole('button', { name: 'Caído', exact: true }).click();
      expect(await orbState(preview)).toBe('down');
      expect(await pressed(states.getByRole('button', { name: 'Caído', exact: true }))).toBe('true');
      expect(await preview.evaluate((element) => getComputedStyle(element).filter)).toContain('grayscale');
      await dialog.getByRole('button', { name: 'Emoji o letra', exact: true }).click();
      await dialog.getByRole('button', { name: 'Icono 🦊', exact: true }).click();
      await expect.poll(async () => preview.innerText()).toContain('🦊');
      const outside = await page.evaluate((): string => {
        const previewNode = document.querySelector('[aria-label^="Vista previa del icono"]');
        const ownerDialog = previewNode instanceof Element ? previewNode.closest('[role="dialog"]') : null;
        let text = '';
        for (const node of Array.from(document.querySelectorAll('.agent-orb'))) {
          if (!(node instanceof HTMLElement) || ownerDialog?.contains(node)) continue;
          text += node.textContent;
        }
        return text;
      });
      expect(outside).not.toContain('🦊');
      await shot(page, `${shotName}-probar`);
      expect(writes).toEqual([]);
      await dialog.getByRole('button', { name: 'Cancelar', exact: true }).click();
      const confirm = dialog.getByRole('group', { name: 'Confirmar', exact: true });
      await confirm.waitFor({ timeout: 10_000 });
      await confirm.getByRole('button', { name: 'Descartar', exact: true }).click();
      await dialog.waitFor({ state: 'hidden', timeout: 15_000 });
      expect(await page.evaluate((): string => {
        let text = '';
        for (const node of Array.from(document.querySelectorAll('.agent-orb'))) {
          if (node instanceof HTMLElement) text += node.textContent;
        }
        return text;
      })).not.toContain('🦊');
      expect((await pool().query('SELECT 1 FROM agent_appearances')).rowCount).toBe(0);
      expect(writes).toEqual([]);
      const again = await openAppearance(page);
      const restored = again.getByRole('img', { name: 'Vista previa del icono de owner', exact: true });
      expect(await orbState(restored)).toBe('idle');
      expect(await again.getByRole('button', { name: 'Icono 🦊', exact: true }).count()).toBe(0);
      await again.getByRole('button', { name: 'Cancelar', exact: true }).click();
      await again.waitFor({ state: 'hidden', timeout: 15_000 });
      await shot(page, `${shotName}-cerrado`);
      errors.assertClean();
    }
  }, 180_000);
});
