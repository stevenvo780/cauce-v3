import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  isaTenant,
  newTrustedPage,
  startConsoleFunctionalFixture,
  type BrowserPage,
} from './console-functional-browser.fixtures.js';
import {
  asV4Page,
  login,
  type V4Person,
} from './v4-console-real-browser.helpers.js';
import { seedQuotaHost } from './v4-console-real-browser.quotas.js';

type Fixture = Awaited<ReturnType<typeof startConsoleFunctionalFixture>>;

const ISA_PERSON: V4Person = {
  email: isaTenant.email,
  password: isaTenant.password,
  name: 'Isa E2E operator',
  company: { name: 'Humanizar', slug: 'humanizar' },
};

async function loginOperator(page: BrowserPage): Promise<void> {
  await login(asV4Page(page), active().baseUrl, ISA_PERSON);
}

async function spaNavigate(page: BrowserPage, path: string): Promise<void> {
  await page.evaluate((targetPath: string) => {
    if (`${window.location.pathname}${window.location.search}` === targetPath) return;
    window.history.pushState({}, '', targetPath);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
}

async function switchConfigSection(
  page: BrowserPage,
  viewport: ViewportSpec,
  sectionId: string,
  sectionLabel: string,
): Promise<void> {
  if (viewport.width < 768) {
    await page.locator('label:has-text("Sección") select').selectOption(sectionId);
  } else {
    await page.getByRole('tablist', { name: 'Secciones de ajustes', exact: true }).getByRole('tab', { name: sectionLabel, exact: true }).click();
  }
}

interface ViewportSpec {
  readonly label: '390x844' | '768x1024' | '1440x900';
  readonly width: number;
  readonly height: number;
}

const VP_MOBILE: ViewportSpec = { label: '390x844', width: 390, height: 844 };
const VP_TABLET: ViewportSpec = { label: '768x1024', width: 768, height: 1024 };
const VP_DESKTOP: ViewportSpec = { label: '1440x900', width: 1440, height: 900 };

const VIEWPORTS: readonly ViewportSpec[] = [VP_MOBILE, VP_TABLET, VP_DESKTOP];

const RECEIPTS_DIR = resolve(process.cwd(), '.delegados/v4/recibos/e2e-a13-movil-1025');

interface LayoutAuditRecord {
  stateId: string;
  viewport: ViewportSpec['label'];
  width: number;
  height: number;
  url: string;
  overflowPx: number;
  culprits?: string[];
  rootTag?: string;
  dialogTags?: string[];
  clippedTexts: string[];
  overlaps: string[];
  unreachableControls: string[];
  shellCollision: string | null;
  textFragments: number;
  interactiveControls: number;
  screenshot?: string;
}

const auditRecords: LayoutAuditRecord[] = [];
let fixture: Fixture | undefined;
let seeded: { pendingDeliveryId: string; deadLetterId: string } | undefined;

function active(): Fixture {
  if (!fixture) throw new Error('functional fixture is not initialized');
  return fixture;
}

function activeSeeded(): { pendingDeliveryId: string; deadLetterId: string } {
  if (!seeded) throw new Error('responsive seed data is not initialized');
  return seeded;
}

async function seedResponsiveData(): Promise<{ pendingDeliveryId: string; deadLetterId: string }> {
  const pool = active().database.pool;
  const userRow = (await pool.query<{ id: string }>('SELECT id FROM console_users WHERE email=$1', [isaTenant.email])).rows[0];
  if (!userRow) throw new Error('isaTenant console user missing');
  await active().database.adminPool.query('INSERT INTO platform_admins(human_id) VALUES($1) ON CONFLICT DO NOTHING', [userRow.id]);
  await pool.query(
    `INSERT INTO company_admins(company_id,human_id,role,source,granted_by)
     VALUES('humanizar',$1,'owner','platform',$1) ON CONFLICT DO NOTHING`,
    [userRow.id],
  );
  await seedQuotaHost(pool, { companyId: 'humanizar', ownerEmail: isaTenant.email, hostId: 'humanizar-kratos' });
  await pool.query(
    `INSERT INTO provider_accounts(id,provider,external_account_id,payer_tenant_id,label,credential_ref_kind,credential_ref,shared_with_pool,enabled)
     VALUES('codex-ops-movil','codex','codex-ops-movil-ext',$1,'Codex Operación Móvil','env_path','CAUCE_TEST_MOVIL_PATH',true,true)
     ON CONFLICT (id) DO NOTHING`,
    [isaTenant.tenant],
  );
  const msg = await pool.query<{ id: string }>(
    `INSERT INTO messages(request_id,trace_id,tenant_id,room_id,actor_alias,body,lane)
     VALUES($1,'movil-e2e-trace',$2,$3,$4,$5::jsonb,'batch') RETURNING id`,
    [randomUUID(), isaTenant.tenant, isaTenant.room, isaTenant.operator, JSON.stringify({ text: 'Mensaje adaptable E2E' })],
  );
  const deadMsg = await pool.query<{ id: string }>(
    `INSERT INTO messages(request_id,trace_id,tenant_id,room_id,actor_alias,body,lane)
     VALUES($1,'movil-e2e-trace-dead',$2,$3,$4,$5::jsonb,'batch') RETURNING id`,
    [randomUUID(), isaTenant.tenant, isaTenant.room, isaTenant.operator, JSON.stringify({ text: 'Mensaje muerto adaptable E2E' })],
  );
  const messageId = msg.rows[0]?.id;
  const deadMessageId = deadMsg.rows[0]?.id;
  if (!messageId || !deadMessageId) throw new Error('failed to seed message for responsive E2E');
  const pending = await pool.query<{ id: string }>(
    `INSERT INTO deliveries(message_id,recipient_tenant,recipient_alias,status,attempt,max_attempts,last_error)
     VALUES($1,$2,$3,'failed',1,3,'Fallo temporal de red en prueba adaptable') RETURNING id`,
    [messageId, isaTenant.tenant, isaTenant.target],
  );
  const dead = await pool.query<{ id: string }>(
    `INSERT INTO deliveries(message_id,recipient_tenant,recipient_alias,status,attempt,max_attempts,terminal_at,last_error)
     VALUES($1,$2,$3,'dead',3,3,now(),'Agotó reintentos en prueba adaptable') RETURNING id`,
    [deadMessageId, isaTenant.tenant, isaTenant.target],
  );
  const pendingDeliveryId = pending.rows[0]?.id;
  const deadDeliveryId = dead.rows[0]?.id;
  if (!pendingDeliveryId || !deadDeliveryId) throw new Error('failed to seed deliveries for responsive E2E');
  const dlq = await pool.query<{ id: string }>(
    `INSERT INTO dead_letters(delivery_id,tenant_id,reason,payload,attempts,disposition,disposition_at,evidence_sha256)
     VALUES($1,$2,'Incidencia sintética para diálogo DLQ adaptable','{}'::jsonb,3,'safe_retry',now(),repeat('a',64)) RETURNING id`,
    [deadDeliveryId, isaTenant.tenant],
  );
  const deadLetterId = dlq.rows[0]?.id;
  if (!deadLetterId) throw new Error('failed to seed dead_letter for responsive E2E');
  return { pendingDeliveryId, deadLetterId };
}

async function auditLayout(
  page: BrowserPage,
  viewport: ViewportSpec,
  stateId: string,
  captureScreenshot = false,
): Promise<LayoutAuditRecord> {
  await page.evaluate(async () => {
    await document.fonts.ready;
    const finiteAnimations = document.getAnimations().filter((anim) => {
      const timing = anim.effect?.getTiming();
      return timing && timing.iterations !== Infinity;
    });
    await Promise.all(finiteAnimations.map((anim) => anim.finished.catch(() => undefined)));
    await new Promise<void>((done) => {
      setTimeout(done, 150);
    });
    await new Promise<void>((done) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => { done(); });
      });
    });
  });

  const measured = await page.evaluate((expected: { width: number; height: number; stateId: string }) => {
    const visible = (element: Element | null): element is HTMLElement => {
      if (!(element instanceof HTMLElement)) return false;
      if (!element.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
      if (element.closest('[hidden], [inert]')) return false;
      for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        if (style.getPropertyValue('clip') === 'rect(0px, 0px, 0px, 0px)' || style.clipPath === 'inset(50%)') return false;
      }
      return true;
    };

    const identify = (element: Element): string => {
      const id = element.id ? `#${element.id}` : '';
      const label = element.getAttribute('aria-label');
      return `${element.tagName.toLowerCase()}${id}${label ? `[aria-label="${label}"]` : ''}`;
    };

    const paintedBox = (element: HTMLElement, rect: DOMRect) => {
      const painted = { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
      for (let ancestor = element.parentElement; ancestor && ancestor !== document.body; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        const box = ancestor.getBoundingClientRect();
        if (/hidden|clip|auto|scroll/u.test(style.overflowX)) {
          painted.left = Math.max(painted.left, box.left);
          painted.right = Math.min(painted.right, box.right);
        }
        if (/hidden|clip|auto|scroll/u.test(style.overflowY)) {
          painted.top = Math.max(painted.top, box.top);
          painted.bottom = Math.min(painted.bottom, box.bottom);
        }
      }
      return painted;
    };

    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]')).filter(visible);
    const activeDialog = dialogs.at(-1);
    const main = document.querySelector('main');
    const root = activeDialog ?? (visible(main) ? main : document.body);

    const overflowPx = Math.max(
      0,
      Math.round(document.documentElement.scrollWidth - window.innerWidth),
      Math.round(document.body.scrollWidth - window.innerWidth),
    );

    let shellCollision: string | null = null;
    if (!activeDialog && visible(main)) {
      const mainBox = main.getBoundingClientRect();
      const aside = document.querySelector('aside');
      const mobileNav = document.querySelector('nav[aria-label="Navegación principal"]');
      if (visible(aside)) {
        const asideBox = aside.getBoundingClientRect();
        if (mainBox.left < asideBox.right - 2) {
          shellCollision = `main (${String(Math.round(mainBox.left))}) overlaps aside (${String(Math.round(asideBox.right))})`;
        }
      } else if (visible(mobileNav)) {
        const navBox = mobileNav.getBoundingClientRect();
        const padBottom = parseFloat(getComputedStyle(main).paddingBottom) || 0;
        if (navBox.top < window.innerHeight && padBottom < navBox.height - 2) {
          shellCollision = `main paddingBottom (${String(Math.round(padBottom))}) < mobile bottom nav height (${String(Math.round(navBox.height))})`;
        }
      }
    }

    const clippedTexts: string[] = [];
    const fragments: { element: HTMLElement; node: Node; text: string; rect: { left: number; right: number; top: number; bottom: number } }[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const element = node.parentElement;
      const raw = node.textContent ?? '';
      if (!raw.trim() || !visible(element) || element.closest('svg, style, script, textarea, select, option, .xterm')) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const clientRects = Array.from(range.getClientRects());
      for (const rect of clientRects) {
        if (rect.width < 1 || rect.height < 1) continue;
        const painted = paintedBox(element, rect);
        if (painted.right > painted.left && painted.bottom > painted.top) {
          fragments.push({ element, node, text: raw.trim().slice(0, 60), rect: painted });
        }
        const scrollersX: DOMRect[] = [];
        const scrollersY: DOMRect[] = [];
        for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) {
          const style = getComputedStyle(ancestor);
          const box = ancestor.getBoundingClientRect();
          const outX = rect.left < box.left - 2 || rect.right > box.right + 2;
          const outY = rect.top < box.top - 2 || rect.bottom > box.bottom + 2;
          const reachableX = scrollersX.some((scroll) => scroll.left < box.right && scroll.right > box.left);
          const reachableY = scrollersY.some((scroll) => scroll.top < box.bottom && scroll.bottom > box.top);
          if ((outX && !reachableX && /hidden|clip/u.test(style.overflowX))
            || (outY && !reachableY && /hidden|clip/u.test(style.overflowY))) {
            const hasEllipsis = style.textOverflow === 'ellipsis' || ancestor.classList.contains('truncate');
            if (!hasEllipsis) {
              clippedTexts.push(`${identify(element)} "${raw.trim().slice(0, 40)}" clipped by ${identify(ancestor)}`);
            }
            break;
          }
          if (/auto|scroll/u.test(style.overflowX)) scrollersX.push(box);
          if (/auto|scroll/u.test(style.overflowY)) scrollersY.push(box);
        }
      }
    }

    const stickyAncestor = (element: HTMLElement): HTMLElement | null => {
      for (let ancestor: HTMLElement | null = element; ancestor && ancestor !== root; ancestor = ancestor.parentElement) {
        const pos = getComputedStyle(ancestor).position;
        if (pos === 'sticky' || pos === 'fixed') return ancestor;
      }
      return null;
    };

    const controls = Array.from(
      root.querySelectorAll('button, a[href], input:not([type="hidden"]), select, textarea, [role="tab"], [role="menuitem"]'),
    ).filter(visible);

    const unreachableControls: string[] = [];
    for (const control of controls) {
      const rect = control.getBoundingClientRect();
      const label = (control.getAttribute('aria-label') ?? control.textContent).trim().slice(0, 40);
      const minHeight = control.matches('input[type="range"]') ? 6 : 12;
      if (rect.width < 12 || rect.height < minHeight) {
        unreachableControls.push(`${identify(control)} ("${label}") shrunk to ${String(Math.round(rect.width))}x${String(Math.round(rect.height))}`);
        continue;
      }
      let insideHorizontalScroller = false;
      for (let ancestor = control.parentElement; ancestor; ancestor = ancestor.parentElement) {
        if (/auto|scroll/u.test(getComputedStyle(ancestor).overflowX)) {
          insideHorizontalScroller = true;
          break;
        }
      }
      if (!insideHorizontalScroller && (rect.left < -2 || rect.right > window.innerWidth + 2)) {
        unreachableControls.push(`${identify(control)} ("${label}") outside horizontal viewport [${String(Math.round(rect.left))}..${String(Math.round(rect.right))}]`);
      }
    }

    const isCardSurface = (el: HTMLElement): boolean => (
      el.hasAttribute('data-agent-tile')
      || el.hasAttribute('data-launcher-card')
      || el.hasAttribute('data-agent-id')
    );

    const overlaps: string[] = [];
    for (let i = 0; i < controls.length; i += 1) {
      for (let j = i + 1; j < controls.length; j += 1) {
        const a = controls[i];
        const b = controls[j];
        if (!a || !b || a.contains(b) || b.contains(a)) continue;
        if (stickyAncestor(a) !== stickyAncestor(b)) continue;
        const sharedLi = a.closest('li');
        if (sharedLi && sharedLi === b.closest('li') && (isCardSurface(a) !== isCardSurface(b))) {
          continue;
        }
        const first = paintedBox(a, a.getBoundingClientRect());
        const second = paintedBox(b, b.getBoundingClientRect());
        const width = Math.min(first.right, second.right) - Math.max(first.left, second.left);
        const height = Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top);
        if (width > 3 && height > 3) {
          const labelA = (a.getAttribute('aria-label') ?? a.textContent).trim().slice(0, 30);
          const labelB = (b.getAttribute('aria-label') ?? b.textContent).trim().slice(0, 30);
          overlaps.push(`${identify(a)} ("${labelA}") overlaps ${identify(b)} ("${labelB}") by ${String(Math.round(width))}x${String(Math.round(height))}px`);
        }
      }
    }

    const culprits: string[] = [];
    if (overflowPx > 0) {
      const all = Array.from(document.querySelectorAll('*'));
      for (const el of all) {
        if (!(el instanceof HTMLElement)) continue;
        const r = el.getBoundingClientRect();
        if (r.right > window.innerWidth + 1) {
          culprits.push(`${identify(el)} [right=${String(Math.round(r.right))}, w=${String(Math.round(r.width))}, text="${el.textContent.trim().slice(0, 50)}", parent=${el.parentElement ? identify(el.parentElement) : 'none'}]`);
        }
      }
    }

    return {
      stateId: expected.stateId,
      width: window.innerWidth,
      height: window.innerHeight,
      url: window.location.pathname + window.location.search,
      overflowPx,
      culprits: Array.from(new Set(culprits)),
      rootTag: identify(root),
      dialogTags: dialogs.map(identify),
      clippedTexts: Array.from(new Set(clippedTexts)),
      overlaps: Array.from(new Set(overlaps)),
      unreachableControls: Array.from(new Set(unreachableControls)),
      shellCollision,
      textFragments: fragments.length,
      interactiveControls: controls.length,
    };
  }, { width: viewport.width, height: viewport.height, stateId });

  let screenshotName: string | undefined;
  if (captureScreenshot) {
    screenshotName = `${viewport.label}-${stateId.replace(/[^a-zA-Z0-9_-]+/gu, '-')}.png`;
    await page.screenshot({ path: join(RECEIPTS_DIR, screenshotName), fullPage: false });
  }

  const record: LayoutAuditRecord = {
    ...measured,
    viewport: viewport.label,
    ...(screenshotName ? { screenshot: screenshotName } : {}),
  };
  auditRecords.push(record);

  expect(record.width, `${viewport.label} ${stateId} width`).toBe(viewport.width);
  expect(record.height, `${viewport.label} ${stateId} height`).toBe(viewport.height);
  expect(record.overflowPx, `${viewport.label} ${stateId} horizontal overflow (culprits: ${record.culprits?.join(', ') ?? 'none'})`).toBe(0);
  expect(record.shellCollision, `${viewport.label} ${stateId} shell collision`).toBeNull();
  expect(record.clippedTexts, `${viewport.label} ${stateId} clipped texts`).toEqual([]);
  expect(record.overlaps, `${viewport.label} ${stateId} control overlaps`).toEqual([]);
  expect(record.unreachableControls, `${viewport.label} ${stateId} unreachable controls`).toEqual([]);
  expect(record.interactiveControls, `${viewport.label} ${stateId} interactive controls in ${record.rootTag ?? 'unknown'} (dialogs: ${record.dialogTags?.join(', ') ?? 'none'})`).toBeGreaterThan(0);
  return record;
}

async function assertKeyboardFocusUsable(page: BrowserPage, viewport: ViewportSpec, contextLabel: string): Promise<void> {
  await page.locator('body').press('Tab');
  const firstFocus = await page.evaluate(() => {
    const activeEl = document.activeElement;
    if (!(activeEl instanceof HTMLElement) || activeEl === document.body) return null;
    const rect = activeEl.getBoundingClientRect();
    const style = getComputedStyle(activeEl);
    return {
      tag: activeEl.tagName.toLowerCase(),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      visibleFocus: style.outlineStyle !== 'none' || style.boxShadow !== 'none' || activeEl.matches(':focus-visible'),
    };
  });
  expect(firstFocus, `${viewport.label} ${contextLabel} Tab focus`).not.toBeNull();
  expect(firstFocus?.width ?? 0, `${viewport.label} ${contextLabel} focused control width`).toBeGreaterThan(0);
  expect(firstFocus?.height ?? 0, `${viewport.label} ${contextLabel} focused control height`).toBeGreaterThan(0);
  await page.locator('body').press('Shift+Tab');
}

describe('V4 diseño adaptable en navegador real (390×844, 768×1024 y 1440×900)', () => {
  beforeAll(async () => {
    await mkdir(RECEIPTS_DIR, { recursive: true });
    fixture = await startConsoleFunctionalFixture();
    seeded = await seedResponsiveData();
  }, 240_000);

  afterAll(async () => {
    await writeFile(
      join(RECEIPTS_DIR, 'layout-audit-summary.json'),
      `${JSON.stringify({ totalAudits: auditRecords.length, records: auditRecords }, null, 2)}\n`,
      { mode: 0o600 },
    ).catch(() => undefined);
    if (fixture) await fixture.close();
  }, 120_000);

  it('recorre autenticación, registro de empresa y el armazón de navegación adaptable (barra móvil, riel de tableta, barra lateral de escritorio, menú Más, menú de cuenta y paleta de comandos) a 390×844, 768×1024 y 1440×900 sin desbordes ni solapes', async () => {
    const unauthPage = await newTrustedPage(active(), { width: 390, height: 844 });
    for (const vp of VIEWPORTS) {
      await unauthPage.setViewportSize({ width: vp.width, height: vp.height });
      await unauthPage.goto(`${active().baseUrl}/live`, { waitUntil: 'domcontentloaded' });
      await unauthPage.getByRole('button', { name: 'Iniciar sesión', exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
      await auditLayout(unauthPage, vp, 'auth-login', true);
      await assertKeyboardFocusUsable(unauthPage, vp, 'auth-login');

      await unauthPage.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
      await unauthPage.getByRole('form', { name: 'Registro de persona y empresa', exact: true }).waitFor({ state: 'visible', timeout: 15_000 });
      await auditLayout(unauthPage, vp, 'auth-registration', true);
      await unauthPage.getByRole('button', { name: 'Ya tengo una cuenta', exact: true }).click();
    }
    await unauthPage.context().close();

    const page = await newTrustedPage(active(), { width: 390, height: 844 });
    await loginOperator(page);

    // 1. Mobile (390×844): bottom bar + Más dialog + AccountMenu inside Más dialog
    await page.setViewportSize({ width: 390, height: 844 });
    await spaNavigate(page, '/live');
    await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
    await page.locator('main [data-objeto-principal="oficina"] [role="listbox"] > canvas').waitFor({ state: 'visible', timeout: 20_000 });
    await auditLayout(page, VP_MOBILE, 'shell-mobile-bottom-nav', true);

    await page.getByRole('button', { name: 'Más', exact: true }).click();
    await page.getByRole('dialog', { name: 'Gestión', exact: true }).waitFor({ state: 'visible', timeout: 15_000 });
    await auditLayout(page, VP_MOBILE, 'shell-mobile-mas-dialog', true);
    await assertKeyboardFocusUsable(page, VP_MOBILE, 'shell-mobile-mas-dialog');

    await page.getByRole('dialog', { name: 'Gestión', exact: true }).getByRole('button', { name: /Cuenta/u }).click();
    await page.getByRole('dialog', { name: 'Cuenta y apariencia', exact: true }).waitFor({ state: 'visible', timeout: 15_000 });
    await auditLayout(page, VP_MOBILE, 'shell-mobile-account-menu-dialog', true);
    await page.locator('body').press('Escape');
    await page.locator('body').press('Escape');
    await expect.poll(async () => page.locator('[role="dialog"]:visible').count(), { timeout: 10_000 }).toBe(0);

    // 2. Tablet (768×1024): icon rail (64px) + AccountMenu + CommandPalette (Ctrl+K)
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.locator('aside').waitFor({ state: 'visible', timeout: 15_000 });
    await page.locator('main [data-objeto-principal="oficina"] [role="listbox"] > canvas').waitFor({ state: 'visible', timeout: 20_000 });
    const railBox = await page.locator('aside').boundingBox();
    expect(Math.round(railBox?.width ?? 0)).toBe(64);
    await auditLayout(page, VP_TABLET, 'shell-tablet-icon-rail', true);

    await page.locator('aside').getByRole('button', { name: /Cuenta/u }).click();
    await page.getByRole('dialog', { name: 'Cuenta y apariencia', exact: true }).waitFor({ state: 'visible', timeout: 15_000 });
    await auditLayout(page, VP_TABLET, 'shell-tablet-account-menu', true);
    await page.locator('body').press('Escape');

    await page.locator('body').press('Control+k');
    await page.getByRole('dialog', { name: 'Saltar a un agente o sección', exact: true }).waitFor({ state: 'visible', timeout: 15_000 });
    await auditLayout(page, VP_TABLET, 'shell-tablet-command-palette', true);
    await page.locator('body').press('Escape');
    await expect.poll(async () => page.getByRole('dialog', { name: 'Saltar a un agente o sección', exact: true }).count(), { timeout: 10_000 }).toBe(0);

    // 3. Desktop (1440×900): expanded sidebar (272px) + Alt+Shift+B toggle + CommandPalette
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('aside').waitFor({ state: 'visible', timeout: 15_000 });
    await page.locator('main [data-objeto-principal="oficina"] [role="listbox"] > canvas').waitFor({ state: 'visible', timeout: 20_000 });
    const expandedBox = await page.locator('aside').boundingBox();
    expect(Math.round(expandedBox?.width ?? 0)).toBe(272);
    await auditLayout(page, VP_DESKTOP, 'shell-desktop-sidebar-expanded', true);

    await page.locator('body').press('Alt+Shift+B');
    await expect.poll(async () => Math.round((await page.locator('aside').boundingBox())?.width ?? 0), { timeout: 10_000 }).toBe(64);
    await auditLayout(page, VP_DESKTOP, 'shell-desktop-sidebar-collapsed', false);

    await page.locator('body').press('Alt+Shift+B');
    await expect.poll(async () => Math.round((await page.locator('aside').boundingBox())?.width ?? 0), { timeout: 10_000 }).toBe(272);

    await page.locator('body').press('Control+k');
    await page.getByRole('dialog', { name: 'Saltar a un agente o sección', exact: true }).waitFor({ state: 'visible', timeout: 15_000 });
    await auditLayout(page, VP_DESKTOP, 'shell-desktop-command-palette', true);
    await page.locator('body').press('Escape');
    await page.context().close();
  }, 180_000);

  it('recorre Mensajes, diálogo de detalles de conversación, Contexto del agente (todas las pestañas y copias) y Oficina en vivo (campus, ayuda, tarjeta, diálogo Hablar, cajón, apariencia y plano editable) a 390×844, 768×1024 y 1440×900', async () => {
    const page = await newTrustedPage(active(), { width: 390, height: 844 });
    await loginOperator(page);

    for (const vp of VIEWPORTS) {
      const mobile = vp.width === 390;
      await page.setViewportSize({ width: vp.width, height: vp.height });

      // Mensajes: bandeja
      await spaNavigate(page, '/messages');
      await page.getByLabel('Buscar un agente para chatear', { exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
      await expect.poll(async () => page.locator('[data-launcher-card]').count(), { timeout: 20_000 }).toBeGreaterThan(0);
      await auditLayout(page, vp, 'messages-inbox', true);

      // Mensajes: hilo de conversación activo + diálogo Detalles de la conversación
      await spaNavigate(page, `/messages/${isaTenant.tenant}/${isaTenant.target}`);
      await page.getByRole('button', { name: 'Opciones de la conversación', exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
      await auditLayout(page, vp, 'messages-conversation', mobile);

      await page.getByRole('button', { name: 'Opciones de la conversación', exact: true }).click();
      await page.getByRole('menuitem', { name: /Detalles de la conversación/u }).click();
      await page.getByRole('dialog', { name: 'Detalles de la conversación', exact: true }).waitFor({ state: 'visible', timeout: 15_000 });
      await auditLayout(page, vp, 'messages-conversation-details-dialog', mobile);
      await page.locator('body').press('Escape');
      await expect.poll(async () => page.getByRole('dialog', { name: 'Detalles de la conversación', exact: true }).count(), { timeout: 10_000 }).toBe(0);

      // Mensajes: conversación fantasma (agente no registrado)
      await spaNavigate(page, `/messages/${isaTenant.tenant}/fantasma`);
      await page.getByRole('heading', { name: 'No encontramos esa conversación', exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
      await auditLayout(page, vp, 'messages-ghost-thread', false);

      // Contexto del agente: todas las pestañas (perfil, ficheros, directiva, historial, git, versiones) + SpaceBackupPanel
      await spaNavigate(page, `/messages/${isaTenant.tenant}/${isaTenant.target}?view=context`);
      await page.getByRole('region', { name: `Perfil y contexto de ${isaTenant.target}`, exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
      const contextTablist = page.getByRole('tablist', { name: 'Secciones del contexto', exact: true });
      await contextTablist.waitFor({ state: 'visible', timeout: 20_000 });
      const contextTabs: readonly [string, string | RegExp][] = [
        ['perfil', /^Perfil/u],
        ['ficheros', /^Ficheros/u],
        ['directiva', 'Directiva'],
        ['historial', 'Historial'],
        ['git', 'Git'],
        ['versiones', 'Versiones y aplicación'],
      ];
      for (const [tabId, tabLabel] of contextTabs) {
        await contextTablist.getByRole('tab', { name: tabLabel }).click();
        await auditLayout(page, vp, `agent-context-${tabId}`, mobile && (tabId === 'perfil' || tabId === 'versiones'));
      }

      // Oficina en vivo: Campus + Ayuda de Oficina
      await spaNavigate(page, '/live');
      const campusBtn = page.getByRole('button', { name: 'Campus', exact: true });
      if ((await campusBtn.count()) > 0) {
        await campusBtn.click();
      }
      await page.locator('main [data-objeto-principal="oficina"] [role="listbox"] > canvas').waitFor({ state: 'visible', timeout: 20_000 });
      await auditLayout(page, vp, 'live-campus', true);

      const showHudBtn = page.getByRole('button', { name: 'Mostrar panel', exact: true });
      if ((await showHudBtn.count()) > 0) {
        await showHudBtn.click();
      }
      await page.getByRole('button', { name: 'Qué es «Oficina»', exact: true }).click();
      await page.getByRole('dialog', { name: 'Oficina', exact: true }).waitFor({ state: 'visible', timeout: 15_000 });
      await auditLayout(page, vp, 'live-page-help-dialog', false);
      await page.locator('body').press('Escape');

      // Oficina en vivo: AgentCard (?agente=...&ficha=0) + OfficeDialog (Hablar)
      await spaNavigate(page, `/live?agente=${encodeURIComponent(`${isaTenant.tenant}/${isaTenant.target}`)}&ficha=0`);
      const cardDialog = page.locator('[role="dialog"]:has(button[aria-label="Cerrar la tarjeta"])');
      await cardDialog.waitFor({ state: 'visible', timeout: 20_000 });
      await auditLayout(page, vp, 'live-agent-card-dialog', mobile);

      await cardDialog.getByRole('button', { name: 'Hablar', exact: true }).click();
      const talkDialog = page.locator('[role="dialog"]:has(button[aria-label="Cerrar la charla"])');
      await talkDialog.waitFor({ state: 'visible', timeout: 15_000 });
      await auditLayout(page, vp, 'live-office-talk-dialog', mobile);
      await talkDialog.getByRole('button', { name: 'Cerrar la charla', exact: true }).click();

      // Oficina en vivo: AgentSheet (?agente=...&ficha=1) + pestañas Ahora/Conexión/Entregas + AppearanceDialog
      await spaNavigate(page, `/live?agente=${encodeURIComponent(`${isaTenant.tenant}/${isaTenant.target}`)}&ficha=1`);
      const sheet = page.locator('[role="dialog"]:has(button[aria-label="Cerrar el detalle"])');
      await sheet.waitFor({ state: 'visible', timeout: 20_000 });
      await auditLayout(page, vp, 'live-agent-sheet-ahora', mobile);

      await sheet.getByRole('tab', { name: 'Conexión', exact: true }).click();
      await auditLayout(page, vp, 'live-agent-sheet-conexion', false);

      await sheet.getByRole('tab', { name: /^Entregas/u }).click();
      await auditLayout(page, vp, 'live-agent-sheet-entregas', false);

      await sheet.getByRole('button', { name: `Acciones de ${isaTenant.target}`, exact: true }).click();
      await page.getByRole('menuitem', { name: /Personalizar icono/u }).click();
      const appearanceDialog = page.getByRole('dialog', { name: `Personalizar icono de ${isaTenant.target}`, exact: true });
      await appearanceDialog.waitFor({ state: 'visible', timeout: 15_000 });
      await auditLayout(page, vp, 'live-appearance-dialog', mobile);
      await appearanceDialog.getByRole('button', { name: 'Cerrar', exact: true }).click();
      const closeDetailBtn = sheet.getByRole('button', { name: 'Cerrar el detalle', exact: true });
      if ((await closeDetailBtn.count()) > 0) {
        await closeDetailBtn.click();
      }
      const closeCardBtn = cardDialog.getByRole('button', { name: 'Cerrar la tarjeta', exact: true });
      if ((await closeCardBtn.count()) > 0) {
        await closeCardBtn.click();
      }
      await spaNavigate(page, '/live');
      await expect.poll(async () => page.locator('[role="dialog"]:visible').count(), { timeout: 10_000 }).toBe(0);

      // Oficina en vivo: Plano editable + editor de sala
      await page.getByRole('button', { name: 'Plano editable', exact: true }).click();
      const roomRegion = page.getByRole('region', { name: `Sala ${isaTenant.tenant}/${isaTenant.room}`, exact: true });
      await roomRegion.waitFor({ state: 'visible', timeout: 20_000 });
      await roomRegion.click();
      await page.getByRole('region', { name: `Editar sala ${isaTenant.tenant}/${isaTenant.room}`, exact: true }).waitFor({ state: 'visible', timeout: 15_000 });
      await auditLayout(page, vp, 'live-office-plan-editor', mobile);
      await page.getByRole('button', { name: 'Plano editable', exact: true }).click();
    }

    await page.context().close();
  }, 240_000);

  it('recorre Cuentas, Mis cuotas (tarjetas, entornos y diálogos de alta, edición y confirmación), Colas (entregas, DLQ y diálogos), Observabilidad y Auditoría a 390×844, 768×1024 y 1440×900', async () => {
    const page = await newTrustedPage(active(), { width: 390, height: 844 });
    await loginOperator(page);

    for (const vp of VIEWPORTS) {
      const mobile = vp.width === 390;
      await page.setViewportSize({ width: vp.width, height: vp.height });

      // Cuentas: Inventario + diálogo Editar + Asignaciones + diálogo Asignar
      await spaNavigate(page, '/accounts');
      await page.getByRole('heading', { name: 'Cuentas', exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
      await page.getByRole('tab', { name: 'Inventario', exact: true }).click();
      await auditLayout(page, vp, 'accounts-inventory', true);

      await page.getByRole('button', { name: 'Editar «codex-ops-movil»', exact: true }).click();
      await page.getByRole('dialog', { name: 'Edición de «codex-ops-movil»', exact: true }).waitFor({ state: 'visible', timeout: 15_000 });
      await auditLayout(page, vp, 'accounts-edit-dialog', mobile);
      await page.locator('body').press('Escape');

      await page.getByRole('tab', { name: 'Asignaciones', exact: true }).click();
      await auditLayout(page, vp, 'accounts-assignments', mobile);

      await page.getByRole('button', { name: 'Nueva asignación', exact: true }).click();
      await page.getByRole('dialog', { name: 'Asignar', exact: true }).waitFor({ state: 'visible', timeout: 15_000 });
      await auditLayout(page, vp, 'accounts-assign-dialog', mobile);
      await page.locator('body').press('Escape');

      // Mis cuotas: tarjetas + formularios Registrar cuenta, Editar cuenta, Eliminar cuenta y Entornos de consulta
      await spaNavigate(page, '/my-quotas');
      await page.getByRole('region', { name: 'Tarjetas de Mis cuotas', exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
      await page.getByRole('region', { name: 'Entornos de Mis cuotas', exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
      await auditLayout(page, vp, 'my-quotas-page', true);

      await page.getByRole('button', { name: 'Registrar cuenta', exact: true }).click();
      await page.getByRole('form', { name: 'Registrar cuenta de cuotas', exact: true }).waitFor({ state: 'visible', timeout: 15_000 });
      await auditLayout(page, vp, 'my-quotas-register-form', mobile);
      await page.getByRole('form', { name: 'Registrar cuenta de cuotas', exact: true }).getByRole('button', { name: 'Cancelar', exact: true }).click();

      const quotaCard = page.getByRole('region', { name: 'Tarjetas de Mis cuotas', exact: true }).locator('article[aria-label="Cuotas de Codex Operación Móvil"]');
      await quotaCard.getByRole('button', { name: 'Editar cuenta', exact: true }).click();
      await page.getByRole('form', { name: 'Editar cuenta de cuotas', exact: true }).waitFor({ state: 'visible', timeout: 15_000 });
      await auditLayout(page, vp, 'my-quotas-edit-form', mobile);
      await page.getByRole('form', { name: 'Editar cuenta de cuotas', exact: true }).getByRole('button', { name: 'Cancelar', exact: true }).click();

      await quotaCard.getByRole('button', { name: 'Eliminar cuenta', exact: true }).click();
      await page.getByRole('region', { name: 'Confirmar eliminación de cuenta', exact: true }).waitFor({ state: 'visible', timeout: 15_000 });
      await auditLayout(page, vp, 'my-quotas-delete-confirm', mobile);
      await page.getByRole('region', { name: 'Confirmar eliminación de cuenta', exact: true }).getByRole('button', { name: 'Cancelar', exact: true }).click();

      // Colas: Entregas + diálogo Reinyectar + DLQ operativo + diálogo Cerrar sin replay
      await spaNavigate(page, '/queues');
      await page.getByRole('heading', { name: 'Colas y DLQ operativo', exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
      await page.getByRole('tab', { name: 'Entregas', exact: true }).click();
      const replayBtn = page.getByRole('button', { name: `Replay delivery ${activeSeeded().pendingDeliveryId}`, exact: true });
      await replayBtn.waitFor({ state: 'visible', timeout: 20_000 });
      await auditLayout(page, vp, 'queues-deliveries', true);

      await replayBtn.click();
      await page.getByRole('alertdialog', { name: /Reinyectar la entrega/u }).waitFor({ state: 'visible', timeout: 15_000 });
      await auditLayout(page, vp, 'queues-replay-dialog', mobile);
      await page.locator('body').press('Escape');

      await page.getByRole('tab', { name: /DLQ operativo/u }).click();
      await page.getByRole('button', { name: 'Cerrar sin replay', exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
      await auditLayout(page, vp, 'queues-dlq', mobile);

      await page.getByRole('button', { name: 'Cerrar sin replay', exact: true }).click();
      await page.getByRole('alertdialog', { name: /^Cerrar .* sin replay$/u }).waitFor({ state: 'visible', timeout: 15_000 });
      await auditLayout(page, vp, 'queues-dlq-resolve-dialog', mobile);
      await page.locator('body').press('Escape');

      // Observabilidad: Señales y relays + Auditoría
      await spaNavigate(page, '/observability');
      await page.getByRole('heading', { name: 'Señales y auditoría', exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
      await page.getByRole('tab', { name: 'Señales y relays', exact: true }).click();
      await auditLayout(page, vp, 'observability-signals', true);

      await page.getByRole('tab', { name: 'Auditoría', exact: true }).click();
      await page.getByRole('button', { name: 'Releer auditoría', exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
      await auditLayout(page, vp, 'observability-audit', mobile);
    }

    await page.context().close();
  }, 240_000);

  it('recorre Configuración (general, empresas, espacios y asistente, agentes y diálogos, computadoras y diálogos, arneses, acceso y personas, avanzado), Terminal, Ayuda y ruta inexistente a 390×844, 768×1024 y 1440×900', async () => {
    const page = await newTrustedPage(active(), { width: 390, height: 844 });
    await loginOperator(page);

    for (const vp of VIEWPORTS) {
      const mobile = vp.width === 390;
      await page.setViewportSize({ width: vp.width, height: vp.height });

      // Config: General + Empresas + Autoridad de empresa
      await page.goto(`${active().baseUrl}/config?seccion=general`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('region', { name: 'Empresas', exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
      await auditLayout(page, vp, 'config-general-companies', true);

      await page.getByRole('button', { name: 'Autoridad de empresa', exact: true }).click();
      await page.getByRole('region', { name: 'Autoridad de empresa', exact: true }).waitFor({ state: 'visible', timeout: 15_000 });
      await auditLayout(page, vp, 'config-general-company-admins', mobile);

      // Config: Espacios y salas + SpaceWizard
      await switchConfigSection(page, vp, 'espacios', 'Espacios y salas');
      await page.getByRole('region', { name: 'Alta de espacios', exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
      await auditLayout(page, vp, 'config-espacios', mobile);

      await page.getByRole('button', { name: 'Espacio completo, paso a paso', exact: true }).click();
      await auditLayout(page, vp, 'config-espacios-wizard', mobile);

      // Config: Agentes + Añadir agente (wizard) + Nuevo equipo + Ficha de agente en config
      await switchConfigSection(page, vp, 'agentes', 'Agentes');
      await page.getByRole('button', { name: 'Añadir agente', exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
      await auditLayout(page, vp, 'config-agentes', mobile);

      await page.getByRole('button', { name: 'Añadir agente', exact: true }).click();
      await page.getByRole('dialog', { name: 'Añadir agente', exact: true }).waitFor({ state: 'visible', timeout: 15_000 });
      await auditLayout(page, vp, 'config-agentes-register-dialog', mobile);
      await page.locator('body').press('Escape');

      await page.getByRole('button', { name: 'Nuevo equipo', exact: true }).click();
      await page.getByRole('dialog', { name: 'Nuevo equipo', exact: true }).waitFor({ state: 'visible', timeout: 15_000 });
      await auditLayout(page, vp, 'config-agentes-team-dialog', mobile);
      await page.locator('body').press('Escape');

      await page.getByRole('button', { name: `Abrir agente ${isaTenant.tenant}/${isaTenant.target}`, exact: true }).click();
      await page.getByRole('dialog', { name: new RegExp(isaTenant.target, 'iu') }).waitFor({ state: 'visible', timeout: 15_000 });
      await auditLayout(page, vp, 'config-agentes-sheet-drawer', mobile);
      await page.locator('body').press('Escape');

      // Config: Computadoras + Invitar ordenador + Registrar computadora
      await switchConfigSection(page, vp, 'computadoras', 'Computadoras');
      await page.getByRole('region', { name: 'Añadir ordenador', exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
      await auditLayout(page, vp, 'config-computadoras', mobile);

      await page.getByRole('region', { name: 'Añadir ordenador', exact: true }).getByRole('button', { name: 'Añadir ordenador', exact: true }).click();
      await page.getByRole('dialog', { name: 'Invitar ordenador', exact: true }).waitFor({ state: 'visible', timeout: 15_000 });
      await auditLayout(page, vp, 'config-computadoras-invite-form', mobile);
      await page.locator('body').press('Escape');
      await expect.poll(async () => page.getByRole('dialog', { name: 'Invitar ordenador', exact: true }).count(), { timeout: 10_000 }).toBe(0);

      await page.getByRole('button', { name: 'Registrar computadora', exact: true }).click();
      await page.getByRole('dialog', { name: 'Registrar computadora', exact: true }).waitFor({ state: 'visible', timeout: 15_000 });
      await auditLayout(page, vp, 'config-computadoras-register-dialog', mobile);
      await page.locator('body').press('Escape');
      await expect.poll(async () => page.getByRole('dialog', { name: 'Registrar computadora', exact: true }).count(), { timeout: 10_000 }).toBe(0);

      // Config: Arneses
      await switchConfigSection(page, vp, 'arneses', 'Arneses');
      await page.getByRole('region', { name: 'Qué lee cada arnés de verdad', exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
      await auditLayout(page, vp, 'config-arneses', mobile);

      // Config: Acceso + Administrar personas
      await switchConfigSection(page, vp, 'acceso', 'Acceso y roles');
      await page.getByRole('button', { name: 'Administrar personas', exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
      await auditLayout(page, vp, 'config-acceso', mobile);

      await page.getByRole('button', { name: 'Administrar personas', exact: true }).click();
      await page.getByRole('region', { name: 'Administración de personas', exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
      await auditLayout(page, vp, 'config-acceso-people', mobile);

      // Config: Avanzado
      await switchConfigSection(page, vp, 'avanzado', 'Avanzado');
      await page.getByRole('region', { name: 'Historial de revisiones', exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
      await auditLayout(page, vp, 'config-avanzado', mobile);

      // Terminal: selector y agente
      await spaNavigate(page, '/terminal');
      await expect.poll(async () => page.locator('main button, main a[href], main input, main select').count(), { timeout: 20_000 }).toBeGreaterThan(0);
      await auditLayout(page, vp, 'terminal-home', true);

      await spaNavigate(page, `/terminal/${isaTenant.tenant}/${isaTenant.target}`);
      await expect.poll(async () => page.locator('main button, main a[href], main input, main select').count(), { timeout: 20_000 }).toBeGreaterThan(0);
      await auditLayout(page, vp, 'terminal-agent', mobile);

      // Ayuda y Ruta inexistente
      await spaNavigate(page, '/ayuda');
      await page.getByRole('heading', { name: 'Ayuda y documentación', exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
      await auditLayout(page, vp, 'help-page', true);

      await spaNavigate(page, '/ruta-inexistente-404');
      await page.getByRole('heading', { name: 'Ruta no encontrada', exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
      await auditLayout(page, vp, 'route-not-found', true);
    }

    await page.context().close();
  }, 300_000);
});
