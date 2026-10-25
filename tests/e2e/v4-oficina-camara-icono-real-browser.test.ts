import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newTrustedPage, startConsoleFunctionalFixture } from './console-functional-browser.fixtures.js';
import {
  apiGet, asV4Page, BrowserErrorLog, fillRegistration, HERMETIC_INSTANCE_RULES, login, openRegistration,
  PATTERN_DEFECT_RULE, syntheticPerson, type V4Locator, type V4Page,
} from './v4-console-real-browser.helpers.js';
import { apiMutation, escapeRegex } from './v4-office-real-browser.helpers.js';

const task = 'm4-oficina-camara-icono-1025';
const run = randomUUID().slice(0, 8);
const directory = join(process.cwd(), '.delegados/v4/recibos', task, run);
const alias = `zz-canary-m4-${run}`;
const instance = `zz-canary-m4-instance-${run}`;
const person = { ...syntheticPerson('m4', run), company: { name: `zz-canary-m4-${run}`, slug: `zz-canary-m4-${run}` } };
const viewports = [{ width: 1280, height: 800 }, { width: 390, height: 844 }] as const;
const baselineLook = { glyph: '🦉', hue: 200, style: 'pulse', expected_revision: null };
const errors = new BrowserErrorLog([...HERMETIC_INSTANCE_RULES, PATTERN_DEFECT_RULE, {
  id: 'own-hermetic-terminal-targets', reason: 'the fixture has no terminal relay',
  matches: (text, url) => text.includes('status of 404') && new URL(url).pathname === '/v3/console/terminal/targets',
}]);
const writes: { method: string; path: string }[] = [];
const observations: Record<string, unknown>[] = [];
const realIcon = '[role="dialog"]:has(button[aria-label="Cerrar el detalle"]) header .agent-orb, section[role="dialog"]:has(button[aria-label="Cerrar la tarjeta"]) header .agent-orb';
let fixture: Awaited<ReturnType<typeof startConsoleFunctionalFixture>> | undefined;
let hub = '';
let delivery = '';

interface Pose { x: number; y: number; zoom: number; ax: number; ay: number; level: string }
interface PointerPage extends V4Page {
  mouse: { move(x: number, y: number, options?: { steps: number }): Promise<void>; down(): Promise<void>; up(): Promise<void>; wheel(x: number, y: number): Promise<void> };
  keyboard: { down(key: string): Promise<void>; up(key: string): Promise<void> };
}
const active = () => { if (!fixture) throw new Error('office fixture is absent'); return fixture; };
const pool = () => active().database.pool;
const pressed = (node: V4Locator) => node.evaluate(element => element.getAttribute('aria-pressed'));

function watch(page: V4Page): void {
  errors.watch(page, String(page.viewportSize()?.width));
  page.on('request', (value: unknown) => {
    const request = value as { method(): string; url(): string };
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) writes.push({ method: request.method(), path: new URL(request.url()).pathname });
  });
}

async function pose(page: V4Page): Promise<Pose> {
  return page.evaluate(() => {
    const frame = document.querySelector<HTMLElement>('[data-nivel][data-cam-zoom]');
    if (!frame) throw new Error('rendered camera state is absent');
    const state = { x: Number(frame.dataset.camX), y: Number(frame.dataset.camY), zoom: Number(frame.dataset.camZoom),
      ax: Number(frame.dataset.avatarX), ay: Number(frame.dataset.avatarY), level: frame.dataset.nivel ?? '' };
    if (![state.x, state.y, state.zoom, state.ax, state.ay].every(Number.isFinite) || state.zoom <= 0) throw new Error('invalid rendered camera state');
    return state;
  });
}

async function settled(page: V4Page): Promise<Pose> {
  let previous = '';
  let stable = 0;
  await expect.poll(async () => {
    const current = await pose(page);
    const key = JSON.stringify([current.x, current.y, current.zoom, current.level]);
    stable = key === previous ? stable + 1 : 0;
    previous = key;
    return stable;
  }, { timeout: 15_000, interval: 100 }).toBeGreaterThanOrEqual(2);
  return pose(page);
}

function shifted(before: Pose, after: Pose): boolean { return Math.hypot(after.x - before.x, after.y - before.y) > 0.5; }

async function shot(page: V4Page, name: string): Promise<void> {
  await page.screenshot({ path: join(directory, `${String(page.viewportSize()?.width)}-${name}.png`) });
}

async function change(page: V4Page, name: string, action: () => Promise<unknown>, predicate: (before: Pose, after: Pose) => boolean, timeout = 20_000): Promise<Pose> {
  const before = await settled(page);
  await action();
  const levels = [before.level];
  await expect.poll(async () => {
    const current = await pose(page);
    if (levels.at(-1) !== current.level) levels.push(current.level);
    return predicate(before, current);
  }, { timeout }).toBe(true);
  const after = await settled(page);
  expect(predicate(before, after), name).toBe(true);
  observations.push({ viewport: page.viewportSize(), action: name, before, after, levels });
  await shot(page, name);
  return after;
}

async function freshPage(viewport: { width: number; height: number }): Promise<PointerPage> {
  let page: V4Page;
  if (viewport.width === 390) {
    const context = await active().browser.newContext({ viewport, isMobile: true, hasTouch: true, ignoreHTTPSErrors: false, serviceWorkers: 'block' });
    active().contexts.push(context);
    page = asV4Page(await context.newPage());
  } else page = asV4Page(await newTrustedPage(active(), viewport));
  watch(page);
  await login(page, active().baseUrl, person);
  return page as PointerPage;
}

async function openOffice(page: V4Page): Promise<void> {
  await page.goto(`${active().baseUrl}/live`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('region', { name: 'Oficina', exact: true }).waitFor({ timeout: 30_000 });
  await page.locator('[data-nivel][data-cam-zoom]').waitFor({ timeout: 20_000 });
  const show = page.getByRole('button', { name: 'Mostrar panel', exact: true });
  if (await show.count()) await show.click();
  if (!await page.getByRole('button', { name: 'Actualizar', exact: true }).count()) {
    await page.getByRole('button', { name: 'Estados', exact: true }).click();
  }
  await page.getByRole('toolbar', { name: 'Cámara de la oficina', exact: true }).waitFor();
  const more = page.getByRole('button', { name: 'Más controles', exact: true });
  if (await more.count()) {
    await more.click();
    expect(await pressed(page.getByRole('button', { name: 'Menos controles', exact: true }))).toBe('true');
    await page.getByRole('button', { name: 'Menos controles', exact: true }).click();
    expect(await page.getByRole('button', { name: 'Centrar en mí', exact: true }).count()).toBe(0);
    await more.click();
  }
  await settled(page);
}

async function canvasPoint(page: V4Page): Promise<{ x: number; y: number }> {
  const box = await page.locator('[data-nivel] [role="listbox"] > canvas').boundingBox();
  if (!box) throw new Error('office canvas has no geometry');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function drag(page: PointerPage): Promise<void> {
  const { x, y } = await canvasPoint(page);
  if (page.viewportSize()?.width === 390) {
    const context = page.context() as unknown as { newCDPSession(target: V4Page): Promise<{ send(method: string, params: Record<string, unknown>): Promise<unknown>; detach(): Promise<void> }> };
    const session = await context.newCDPSession(page);
    try {
      await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      for (let i = 1; i <= 10; i++) await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + i * 6, y: y + i * 3.5 }] });
    } finally {
      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await session.detach();
    }
    return;
  }
  await page.mouse.move(x, y);
  await page.mouse.down();
  try { await page.mouse.move(x + 60, y + 35, { steps: 10 }); }
  finally { await page.mouse.up(); }
}

async function hold(page: PointerPage, key: string, avatar = false): Promise<void> {
  await page.evaluate(() => { document.querySelector<HTMLElement>('[data-nivel] [role="listbox"]')?.focus(); });
  const before = await settled(page);
  await page.keyboard.down(key);
  try {
    await expect.poll(async () => {
      const after = await pose(page);
      return avatar ? Math.hypot(after.ax - before.ax, after.ay - before.ay) > 1 : shifted(before, after);
    }, { timeout: 5_000 }).toBe(true);
  } finally { await page.keyboard.up(key); }
}

async function refreshAgent(page: V4Page, online: boolean): Promise<void> {
  await pool().query("UPDATE connection_leases SET lease_until=now()+($3::int*interval '1 minute'),last_heartbeat_at=now() WHERE tenant_id=$1 AND alias=$2", [hub, alias, online ? 60 : -1]);
  await pool().query('UPDATE delivery_acks SET created_at=now() WHERE delivery_id=$1', [delivery]);
  const show = page.getByRole('button', { name: 'Mostrar panel', exact: true });
  if (await show.count()) await show.click();
  if (!await page.getByRole('button', { name: 'Actualizar', exact: true }).count()) await page.getByRole('button', { name: 'Estados', exact: true }).click();
  await page.getByRole('button', { name: 'Actualizar', exact: true }).click();
  const member = page.getByRole('region', { name: 'Equipo', exact: true }).getByRole('button', { name: new RegExp(escapeRegex(alias), 'u') });
  const opener = page.getByRole('button', { name: /^Equipo/u });
  if (!await member.count() && await opener.count()) await opener.click();
  await expect.poll(() => member.evaluate(element => element.getAttribute('aria-label')), { timeout: 30_000 }).toContain(online ? 'Trabajando' : 'Caído');
  const closer = page.getByRole('button', { name: 'Cerrar el panel de equipo', exact: true });
  if (await closer.count()) await closer.click();
}

async function appearance(page: V4Page): Promise<V4Locator> {
  await page.goto(`${active().baseUrl}/live?agente=${encodeURIComponent(`${hub}/${alias}`)}&ficha=1`, { waitUntil: 'domcontentloaded' });
  const sheet = page.locator('[role="dialog"]:has(button[aria-label="Cerrar el detalle"])');
  await sheet.waitFor({ timeout: 30_000 });
  await sheet.getByRole('button', { name: `Acciones de ${alias}`, exact: true }).click();
  await page.getByRole('menuitem', { name: 'Personalizar icono…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: `Personalizar icono de ${alias}`, exact: true });
  await dialog.waitFor({ timeout: 20_000 });
  return dialog;
}

async function savedLook(): Promise<unknown> {
  return (await pool().query('SELECT glyph,hue,style,revision::text,updated_at,updated_by FROM agent_appearances WHERE tenant_id=$1 AND alias=$2', [hub, alias])).rows;
}

async function webLook(page: V4Page) {
  await page.locator(realIcon).first().waitFor({ state: 'attached', timeout: 10_000 });
  return page.evaluate(({ selector, expectedAlias }: { selector: string; expectedAlias: string }) => {
    const looks = Array.from(document.querySelectorAll<HTMLElement>(selector)).map(orb => {
      if (orb.closest('[role="dialog"]')?.querySelector('header h2')?.textContent !== expectedAlias) throw new Error('the real icon belongs to another agent');
      return { glyph: orb.querySelector('.agent-orb-glyph')?.textContent, style: orb.dataset.style,
        hues: ['--h1', '--h2', '--h3'].map(key => orb.style.getPropertyValue(key)) };
    });
    const first = looks[0];
    if (!first || looks.some(look => JSON.stringify(look) !== JSON.stringify(first))) throw new Error('the real agent icons are absent or disagree');
    return first;
  }, { selector: realIcon, expectedAlias: alias });
}

beforeAll(async () => {
  if (process.env.CAUCE_REQUIRE_TESTCONTAINERS !== '1' || process.env.CAUCE_TEST_DATABASE_URL || process.env.VITE_USE_MOCKS === 'true') throw new Error('real isolated laboratory fixture is required');
  await mkdir(directory, { recursive: true });
  const sources = ['tests/e2e/v4-oficina-camara-icono-real-browser.test.ts', 'tests/e2e/console-functional-browser.fixtures.ts',
    'console/src/features/office/OfficeGame.tsx', 'console/src/features/office/OfficeControls.tsx', 'console/src/features/office/use-office-engine.ts',
    'console/src/features/office/engine.ts', 'console/src/components/AgentOrb.tsx', 'console/src/components/agent-actions/AppearanceDialog.tsx'];
  const hashes = await Promise.all(sources.map(async path => ({ path, sha256: createHash('sha256').update(await readFile(path)).digest('hex') })));
  await writeFile(join(directory, 'source.json'), JSON.stringify({ run, sha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sources: hashes }, null, 2));
  fixture = await startConsoleFunctionalFixture();
  const page = asV4Page(await newTrustedPage(active(), viewports[0]));
  const form = await openRegistration(page, active().baseUrl);
  await fillRegistration(form, person);
  await form.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
  await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });
  hub = (await pool().query<{ tenant_id: string }>('SELECT tenant_id FROM console_users WHERE email_normalized=$1', [person.email])).rows[0]?.tenant_id ?? '';
  expect(hub).toMatch(/^hub-/u);
  await pool().query(`INSERT INTO agents(tenant_id,alias,harness_id,display_name,enabled,container_name,runtime_user,home_directory,state_directory,company_id)
    VALUES($1,$2,'codex',$2,true,$3,'dev',$4,$5,$6)`, [hub, alias, alias, `/srv/${alias}`, `/srv/${alias}/state`, person.company.slug]);
  await pool().query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES($1,'office',$2,'agent')", [hub, alias]);
  await pool().query("UPDATE agents SET primary_room_id='office' WHERE tenant_id=$1 AND alias=$2", [hub, alias]);
  await pool().query("INSERT INTO connection_leases(tenant_id,alias,instance_id,epoch,lease_until) VALUES($1,$2,$3,1,now()+interval '1 hour')", [hub, alias, instance]);
  const seeded = await pool().query<{ id: string }>(`WITH message AS (
    INSERT INTO messages(request_id,trace_id,tenant_id,room_id,actor_alias,body,lane,priority)
    VALUES($1,$2,$3,'office',$4,jsonb_build_object('text','Synthetic office fixture'),'interactive',10) RETURNING id)
    INSERT INTO deliveries(message_id,recipient_tenant,recipient_alias,status,attempt,claim_token,consumer_instance_id,consumer_epoch,claimed_at,ack_deadline_at)
    SELECT id,$3,$4,'started',1,gen_random_uuid(),$5,1,now(),now()+interval '1 hour' FROM message RETURNING id`, [randomUUID(), randomUUID(), hub, alias, instance]);
  delivery = seeded.rows[0]?.id ?? '';
  expect(delivery).not.toBe('');
  await pool().query(`INSERT INTO delivery_acks(delivery_id,status,instance_id,epoch,applied,attempt,claim_token,event_id)
    SELECT id,'started',$2,1,true,1,claim_token,gen_random_uuid() FROM deliveries WHERE id=$1`, [delivery, instance]);
  expect(await apiMutation(page, `/v3/console/agents/${encodeURIComponent(hub)}/${alias}/appearance`, baselineLook, 'PUT')).toBe(200);
}, 600_000);

afterAll(async () => {
  await writeFile(join(directory, 'observations.json'), JSON.stringify(observations, null, 2));
  await fixture?.close();
  await writeFile(join(directory, 'cleanup.json'), JSON.stringify({ fixture_closed: true, at: new Date().toISOString() }));
}, 180_000);

describe('Oficina: cámara observable y previsualización sin persistir', () => {
  for (const viewport of viewports) {
    it(`cámara, teclado, rueda, arrastre, foco y seguimiento a ${String(viewport.width)}×${String(viewport.height)}`, async () => {
      const page = await freshPage(viewport);
      await openOffice(page);
      const toolbar = page.getByRole('toolbar', { name: 'Cámara de la oficina', exact: true });
      const list = page.locator('[data-nivel] [role="listbox"]');
      writes.length = 0;
      await change(page, 'zoom-button-in', () => toolbar.getByRole('button', { name: 'Acercar', exact: true }).click(), (a, b) => b.zoom > a.zoom + 0.1);
      await change(page, 'zoom-button-out', () => toolbar.getByRole('button', { name: 'Alejar', exact: true }).click(), (a, b) => b.zoom < a.zoom - 0.1);
      await change(page, 'zoom-key-in', () => list.press('='), (a, b) => b.zoom > a.zoom + 0.1);
      await change(page, 'zoom-key-out', () => list.press('-'), (a, b) => b.zoom < a.zoom - 0.1);
      for (let i = 0; i < 2; i++) await toolbar.getByRole('button', { name: 'Acercar', exact: true }).click();
      const point = await canvasPoint(page);
      await page.mouse.move(point.x, point.y);
      await change(page, 'wheel-zoom', () => page.mouse.wheel(0, -240), (a, b) => b.zoom > a.zoom + 0.1);
      await change(page, 'pointer-drag', () => drag(page), shifted);
      await change(page, 'keyboard-pan-d', () => hold(page, 'd'), shifted);
      await change(page, 'keyboard-pan-s', () => hold(page, 's'), shifted);
      await change(page, 'keyboard-pan-w', () => hold(page, 'w'), shifted);
      await change(page, 'center-button', () => toolbar.getByRole('button', { name: 'Centrar en mí', exact: true }).click(), shifted);
      await change(page, 'keyboard-pan-a', () => hold(page, 'a'), shifted);
      await change(page, 'center-key', () => list.press('c'), shifted);
      await change(page, 'fit-button', () => toolbar.getByRole('button', { name: 'Ver todo el campus', exact: true }).click(), (a, b) => b.zoom < a.zoom - 0.1);
      await toolbar.getByRole('button', { name: 'Acercar', exact: true }).click();
      await change(page, 'fit-key', () => list.press('0'), (a, b) => b.zoom < a.zoom - 0.1);
      const paseo = toolbar.getByRole('button', { name: 'Modo paseo', exact: true });
      await paseo.click();
      expect(await pressed(paseo)).toBe('true');
      const walkBefore = await settled(page);
      await hold(page, 'ArrowRight', true);
      const walkAfter = await pose(page);
      expect(Math.hypot(walkAfter.ax - walkBefore.ax, walkAfter.ay - walkBefore.ay)).toBeGreaterThan(1);
      observations.push({ viewport, action: 'walk', before: walkBefore, after: walkAfter });
      await list.press('p');
      expect(await pressed(paseo)).toBe('false');
      const map = page.locator('canvas[title="Mapa del campus: clic en un edificio para entrar"]');
      const shown = await map.count();
      await toolbar.getByRole('button', { name: /el mapa/u }).click();
      expect(await map.count()).toBe(shown ? 0 : 1);
      await list.press('m');
      expect(await map.count()).toBe(shown);
      const tubes = page.getByRole('region', { name: 'Tubos', exact: true });
      const tubesButton = viewport.width === 390 ? toolbar.getByRole('button', { name: 'Mostrar los tubos', exact: true }) : tubes.getByRole('button', { name: 'Tubos', exact: true });
      await tubesButton.click();
      await expect.poll(() => tubes.getByRole('button', { name: 'Tubos', exact: true }).evaluate(node => node.getAttribute('aria-expanded'))).toBe('true');
      await list.press('t');
      expect(viewport.width === 390 ? await tubes.count() === 0 : await tubes.getByRole('button', { name: 'Tubos', exact: true }).evaluate(node => node.getAttribute('aria-expanded')) === 'false').toBe(true);
      const frame = page.locator('[data-nivel]');
      const frameBefore = await frame.boundingBox();
      if (!frameBefore) throw new Error('office frame has no geometry');
      await toolbar.getByRole('button', { name: 'Pantalla completa', exact: true }).click();
      await expect.poll(async () => (await frame.boundingBox())?.height ?? 0).toBeGreaterThan(frameBefore.height + 1);
      expect(await pressed(toolbar.getByRole('button', { name: 'Salir de pantalla completa', exact: true }))).toBe('true');
      await shot(page, 'fullscreen');
      await toolbar.getByRole('button', { name: 'Salir de pantalla completa', exact: true }).click();
      await expect.poll(async () => Math.abs(((await frame.boundingBox())?.height ?? 0) - frameBefore.height)).toBeLessThan(1);
      await shot(page, 'camera-controls');
      expect(writes).toEqual([]);
      await change(page, 'building-key-2', () => list.press('2'), (a, b) => a.level === 'campus' && b.level.startsWith('grupo:'));
      await change(page, 'building-zoom', () => toolbar.getByRole('button', { name: 'Acercar', exact: true }).click(), (a, b) => b.zoom > a.zoom + 0.1);
      await change(page, 'building-fit', () => toolbar.getByRole('button', { name: 'Ver todo el edificio', exact: true }).click(), (a, b) => b.zoom < a.zoom - 0.1);
      await change(page, 'building-key-page-up', () => list.press('PageUp'), (a, b) => a.level.startsWith('grupo:') && b.level === 'campus');
      await change(page, 'building-key-page-down', () => list.press('PageDown'), (a, b) => a.level === 'campus' && b.level.startsWith('grupo:'));
      await change(page, 'building-key-bracket-left', () => list.press('['), (a, b) => a.level.startsWith('grupo:') && b.level === 'campus');
      await change(page, 'building-key-bracket-right', () => list.press(']'), (a, b) => a.level === 'campus' && b.level.startsWith('grupo:'));
      await change(page, 'building-key-1', () => list.press('1'), (a, b) => a.level.startsWith('grupo:') && b.level === 'campus');

      await refreshAgent(page, true);
      const opener = page.getByRole('button', { name: /^Equipo/u });
      if (await opener.count()) await opener.click();
      await change(page, 'hud-focus', () => page.getByRole('region', { name: 'Equipo', exact: true }).getByRole('button', { name: new RegExp(escapeRegex(alias), 'u') }).click(), (a, b) => b.level !== a.level && b.level.startsWith('grupo:'));
      const card = page.getByRole('dialog', { name: alias, exact: true });
      const follow = card.getByRole('button', { name: 'Seguir', exact: true });
      await follow.click();
      expect(await pressed(follow)).toBe('true');
      await change(page, 'follow-building', () => refreshAgent(page, false), (a, b) => a.level.startsWith('grupo:') && b.level === 'taller', 60_000);
      expect(await pressed(follow)).toBe('true');
      await follow.click();
      expect(await pressed(follow)).toBe('false');
      const stopped = await settled(page);
      await refreshAgent(page, true);
      await expect.poll(() => card.locator('header p').innerText(), { timeout: 60_000 }).not.toMatch(/en (?:taller|el campus)/iu);
      const unfollowed = await settled(page);
      expect(unfollowed.level).toBe('taller');
      const returnedHeader = await card.locator('header p').innerText();
      expect(returnedHeader).toMatch(/office/iu);
      expect(returnedHeader).not.toMatch(/en (?:taller|el campus)/iu);
      observations.push({ viewport, action: 'follow-disabled', before: stopped, after: unfollowed, agent_header: returnedHeader });
      await shot(page, 'follow-stopped');
      expect(writes).toEqual([]);
      errors.assertClean();
    }, 180_000);

    it(`probar cada estado y descartar conserva icono web y PostgreSQL a ${String(viewport.width)}×${String(viewport.height)}`, async () => {
      const page = await freshPage(viewport);
      const dialog = await appearance(page);
      const before = await savedLook();
      expect(before).toHaveLength(1);
      const webBefore = await webLook(page);
      expect(webBefore.glyph).toBe(baselineLook.glyph);
      expect(webBefore.style).toBe(baselineLook.style);
      expect(Number(webBefore.hues[0])).toBe(baselineLook.hue);
      const preferencesBefore = await apiGet(page, '/v3/console/agent-preferences');
      expect(preferencesBefore.status).toBe(200);
      const preview = dialog.getByRole('img', { name: `Vista previa del icono de ${alias}`, exact: true });
      expect(await preview.innerText()).toBe(baselineLook.glyph);
      expect(await preview.evaluate(node => node.getAttribute('data-style'))).toBe(baselineLook.style);
      writes.length = 0;
      const states = dialog.getByRole('group', { name: 'Probar con el estado', exact: true });
      for (const [label, state] of [['Trabajando', 'thinking'], ['Caído', 'down'], ['Reposo', 'idle']] as const) {
        const previous = await preview.evaluate(node => node.getAttribute('data-state'));
        const motionBefore = await preview.evaluate(node => ({ animation: getComputedStyle(node).animationName, duration: getComputedStyle(node).animationDuration, filter: getComputedStyle(node).filter }));
        await states.getByRole('button', { name: label, exact: true }).click();
        await expect.poll(() => preview.evaluate(node => node.getAttribute('data-state'))).toBe(state);
        await preview.evaluate(node => { node.scrollIntoView({ block: 'nearest', inline: 'center' }); });
        const intersection = await preview.evaluate(node => new Promise<number>(resolve => {
          const observer = new IntersectionObserver(entries => {
            observer.disconnect();
            resolve(entries[0]?.intersectionRatio ?? 0);
          });
          observer.observe(node);
        }));
        expect(intersection).toBeGreaterThanOrEqual(0.99);
        expect(state).not.toBe(previous);
        expect(await pressed(states.getByRole('button', { name: label, exact: true }))).toBe('true');
        if (state === 'down') expect(await preview.evaluate(node => getComputedStyle(node).filter)).toContain('grayscale');
        const motionAfter = await preview.evaluate(node => ({ animation: getComputedStyle(node).animationName, duration: getComputedStyle(node).animationDuration, filter: getComputedStyle(node).filter }));
        expect(motionAfter).not.toEqual(motionBefore);
        expect(writes).toEqual([]);
        expect(await savedLook()).toEqual(before);
        expect(await webLook(page)).toEqual(webBefore);
        observations.push({ viewport, action: 'preview-state', state, previous, intersection, motionBefore, motionAfter, writes: [...writes] });
        await shot(page, `preview-${state}`);
      }
      await dialog.getByRole('button', { name: 'Emoji o letra', exact: true }).click();
      await dialog.getByRole('button', { name: 'Icono 🦊', exact: true }).click();
      expect(await preview.innerText()).toBe('🦊');
      expect(await webLook(page)).toEqual(webBefore);
      await dialog.getByRole('button', { name: 'Cancelar', exact: true }).click();
      await dialog.getByRole('button', { name: 'Descartar', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      const realIcons = page.locator(realIcon);
      await expect.poll(async () => {
        const visible = await Promise.all(Array.from({ length: await realIcons.count() }, (_, index) => realIcons.nth(index).isVisible()));
        return visible.some(Boolean);
      }).toBe(true);
      expect(await webLook(page)).toEqual(webBefore);
      expect(await savedLook()).toEqual(before);
      expect(writes).toEqual([]);
      const again = await appearance(page);
      const restored = again.getByRole('img', { name: `Vista previa del icono de ${alias}`, exact: true });
      expect(await restored.innerText()).toBe(baselineLook.glyph);
      expect(await restored.evaluate(node => node.getAttribute('data-style'))).toBe(baselineLook.style);
      expect(await savedLook()).toEqual(before);
      expect(writes).toEqual([]);
      const preferences = await apiGet(page, '/v3/console/agent-preferences');
      expect(preferences.status).toBe(200);
      expect(preferences.body.appearances).toEqual(preferencesBefore.body.appearances);
      await shot(page, 'saved-icon-unchanged');
      await again.getByRole('button', { name: 'Cancelar', exact: true }).click();
      await again.waitFor({ state: 'hidden' });
      observations.push({ viewport, action: 'discard-preview', before, after: await savedLook(), webBefore, webAfter: await webLook(page), writes: [...writes] });
      errors.assertClean();
    }, 120_000);
  }
});
