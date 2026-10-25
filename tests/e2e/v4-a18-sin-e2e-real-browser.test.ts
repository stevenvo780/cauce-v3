import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiGet, bodySnippet, type V4Locator, type V4Page } from './v4-console-real-browser.helpers.js';
import {
  ackCanonicalReply, assertRouted, capture, countRows, DESKTOP, detailIdOf, messageRow, openSession, OWNER, PHONE, skillFile, startMeasuredRuntime,
  type MeasuredRuntime,
} from './v4-a18-sin-e2e.helpers.js';

const RUN = randomUUID();
let runtime: MeasuredRuntime | undefined;

function field(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null || !Object.hasOwn(value, key)) throw new Error(`native read missing ${key}`);
  return Reflect.get(value, key) as unknown;
}

function skillContent(body: unknown): string {
  const content = field(field(field(body, 'outcome'), 'piece'), 'value');
  const text = field(content, 'content');
  if (typeof text !== 'string') throw new Error('native read missing content');
  return text;
}

beforeAll(async () => {
  runtime = await startMeasuredRuntime(RUN);
}, 10 * 60_000);

afterAll(async () => { await runtime?.close(); });

describe('controles de escritura que el mapa dejó sin E2E', () => {
  it('recupera con «Releer respuesta» una lectura canónica que falló una vez, sin duplicar el mensaje', async () => {
    if (!runtime) throw new Error('measured runtime missing');
    const active = runtime;
    const marker = `a18-raiz-${RUN.slice(0, 8)}-${randomUUID().slice(0, 8)}`;
    const reply = `a18-respuesta-${RUN.slice(0, 8)}-${randomUUID().slice(0, 8)}`;
    const page = await openSession(active.fixture, `/messages/${active.fixture.tenant}/${active.fixture.targetAlias}`);
    assertRouted(page);
    await page.getByLabel(`Mensaje para ${active.fixture.targetAlias}`, { exact: true }).waitFor({ timeout: 20_000 });
    await page.getByLabel(`Mensaje para ${active.fixture.targetAlias}`, { exact: true }).fill(marker);
    await page.getByRole('button', { name: 'Enviar', exact: true }).click();
    await page.locator('article[data-direction="input"]').filter({ hasText: marker }).waitFor({ timeout: 20_000 });
    const root = await messageRow(active, marker);
    const beforeMessages = await countRows(active, 'SELECT count(*)::text AS count FROM messages WHERE tenant_id=$1', [active.fixture.tenant]);
    await ackCanonicalReply(active, root.message_id, reply);
    const human = page.locator('article[data-direction="input"]').filter({ hasText: marker });
    await human.getByRole('status', { name: 'Entrega: Recibido por el agente · ejecución terminada', exact: true }).waitFor({ timeout: 20_000 });
    await page.getByRole('link', { name: 'Cauce, ir al chat', exact: true }).click();
    await page.getByRole('region', { name: 'Sin conversación abierta', exact: true }).waitFor({ timeout: 20_000 });
    // Dev StrictMode remounts the pane, so the first failed detail GET is not the one the surviving mount paints.
    let detailsSeen = 0;
    let detailsFailed = 0;
    let failCanonicalRead = true;
    await page.route('**/v3/console/messages/**', async (route) => {
      const request = route.request();
      const detailId = detailIdOf(request.url(), request.method());
      if (detailId === root.message_id) {
        detailsSeen += 1;
        if (failCanonicalRead) {
          detailsFailed += 1;
          await route.abort('failed');
          return;
        }
      }
      await route.continue();
    });
    const href = `/messages/${encodeURIComponent(active.fixture.tenant)}/${encodeURIComponent(active.fixture.targetAlias)}`;
    await page.locator(`a[href="${href}"]`).first().click();
    const notice = page.getByRole('status').filter({ hasText: 'No se pudo leer la respuesta canónica.' });
    try { await notice.waitFor({ timeout: 20_000 }); }
    catch (cause) {
      throw new Error(`canonical retry did not appear (seen ${String(detailsSeen)} failed ${String(detailsFailed)}): ${await bodySnippet(page)}`, { cause });
    }
    expect(detailsFailed).toBeGreaterThan(0);
    await capture(page, 'releer-pendiente', notice);
    try { await notice.waitFor({ timeout: 20_000 }); }
    catch (cause) {
      throw new Error(`canonical retry left before the click (seen ${String(detailsSeen)} failed ${String(detailsFailed)}): ${await bodySnippet(page)}`, { cause });
    }
    const quietDeadline = Date.now() + 3_000;
    let quietSince = Date.now();
    let failedMark = detailsFailed;
    while (Date.now() - quietSince < 500 && Date.now() < quietDeadline) {
      if (detailsFailed !== failedMark) {
        failedMark = detailsFailed;
        quietSince = Date.now();
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const beforeClick = await messageRow(active, marker);
    expect(beforeClick.message_id).toBe(root.message_id);
    process.stdout.write(`a18 canonical before click seen=${String(detailsSeen)} failed=${String(failedMark)}\n`);
    failCanonicalRead = false;
    await notice.getByRole('button', { name: 'Releer respuesta', exact: true }).click();
    const canonical = page.getByRole('region', { name: `Respuesta canónica de ${active.fixture.tenant}:${active.fixture.targetAlias}`, exact: true });
    await canonical.getByText(reply, { exact: true }).waitFor({ timeout: 20_000 });
    expect(detailsFailed).toBe(failedMark);
    expect(detailsSeen).toBeGreaterThan(detailsFailed);
    expect(await canonical.getByText(reply, { exact: true }).count()).toBe(1);
    expect(await page.getByLabel('Historial de la conversación', { exact: true }).getByText(reply, { exact: true }).count()).toBe(1);
    expect(await page.getByRole('article', { name: `Mensaje de ${active.fixture.targetAlias}`, exact: true }).count()).toBe(1);
    const afterClick = await messageRow(active, marker);
    expect(afterClick).toEqual(beforeClick);
    expect(await countRows(active, 'SELECT count(*)::text AS count FROM messages WHERE tenant_id=$1', [active.fixture.tenant])).toBe(beforeMessages);
    expect(await countRows(active,
      `SELECT count(*)::text AS count FROM delivery_acks da JOIN deliveries d ON d.id=da.delivery_id
        WHERE d.message_id=$1::uuid AND da.applied AND da.payload->'result'->'output'->>'reply'=$2`,
      [root.message_id, reply])).toBe('1');
    const detail = await apiGet(page, `/v3/console/messages/${encodeURIComponent(root.message_id)}`);
    expect(detail.status).toBe(200);
    expect(JSON.stringify(detail.body).split(reply).length - 1).toBe(1);
    await notice.waitFor({ state: 'hidden', timeout: 20_000 });
    await capture(page, 'releer-recuperada', canonical);
  }, 180_000);

  it('pulsa «Verificar operación nativa pendiente» tras un guardado cuya respuesta no volvió y acredita archivo, API y PostgreSQL', async () => {
    if (!runtime) throw new Error('measured runtime missing');
    const active = runtime;
    const page = await openSession(active.fixture, `/messages/${active.fixture.tenant}/${active.fixture.targetAlias}?view=context`);
    assertRouted(page);
    await page.getByLabel('Responsabilidades', { exact: true }).waitFor({ timeout: 20_000 });
    await page.getByText('Piezas nativas · MCP, skills y subagentes', { exact: true }).click();
    await page.getByRole('button', { name: 'Leer inventario nativo', exact: true }).click();
    const native = page.getByRole('region', { name: 'Editor de piezas nativas', exact: true });
    await native.getByText(/Arnés: codex/u).waitFor({ timeout: 20_000 });
    const id = `zza18${RUN.replaceAll('-', '').slice(0, 8)}`;
    const content = `---\nname: ${id}\ndescription: Contexto sintético para verificar una operación nativa pendiente.\n---\n\nInstrucciones públicas del canario ${RUN}.\n`;
    await native.getByLabel('Nombre de pieza', { exact: true }).fill(id);
    await native.getByRole('button', { name: 'Leer o preparar pieza', exact: true }).click();
    const markdown = native.getByLabel('Contenido Markdown', { exact: true });
    await expect.poll(() => markdown.isDisabled(), { timeout: 20_000 }).toBe(false);
    await markdown.fill(content);
    await native.getByLabel('Motivo del cambio nativo', { exact: true }).fill('Crear una pieza sintética y dejar la respuesta sin confirmar.');
    let dropped = false;
    let upstream = 0;
    let upstreamNote = 'no replay';
    await page.route('**/v3/console/tenants/**/native/**', async (route) => {
      const request = route.request();
      const target = new URL(request.url());
      const save = request.method() === 'PUT' && target.pathname.endsWith(`/native/skill/${id}`);
      if (!save || dropped) {
        await route.continue();
        return;
      }
      dropped = true;
      try {
        const headers = request.headers();
        const cookie = headers.cookie;
        const csrf = headers['x-csrf-token'];
        if (!cookie || !csrf) throw new Error('native save is missing cookie or csrf');
        const response = await active.fixture.request(`${target.pathname}${target.search}`, {
          method: 'PUT',
          headers: { cookie, origin: headers.origin ?? active.fixture.baseUrl, 'x-csrf-token': csrf },
          body: JSON.parse(request.postData() ?? '') as unknown,
        });
        upstream = response.status;
        const applied = response.status === 200 || response.status === 202;
        upstreamNote = applied ? 'written' : response.body.replaceAll(/\s+/gu, ' ').slice(0, 160);
        if (applied) await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"response_dropped"}' });
        else await route.fulfill({ status: response.status, contentType: 'application/json', body: response.body });
      } catch (error) {
        upstreamNote = error instanceof Error ? error.message : 'replay failed';
        await route.abort('failed').catch(() => undefined);
      }
    });
    await native.getByRole('button', { name: 'Guardar pieza nativa', exact: true }).click();
    const verify = native.getByRole('button', { name: 'Verificar operación nativa pendiente', exact: true });
    try { await verify.waitFor({ timeout: 30_000 }); }
    catch (cause) { throw new Error(`native verify did not appear (upstream ${String(upstream)} ${upstreamNote}): ${await bodySnippet(page)}`, { cause }); }
    const replayDeadline = Date.now() + 30_000;
    while (upstream === 0 && Date.now() < replayDeadline) await new Promise((resolve) => setTimeout(resolve, 100));
    expect([200, 202], upstreamNote).toContain(upstream);
    const document = `native:skill:${id}`;
    const jobs = await countRows(active,
      `SELECT count(*)::text AS count FROM jobs WHERE tenant_id=$1 AND kind='system.context.write.quarantine.v1'
        AND payload#>>'{documents,0,name}'=$2`,
      [active.fixture.tenant, document]);
    expect(jobs, `upstream ${String(upstream)} ${upstreamNote}`).not.toBe('0');
    const writeAudit = `SELECT count(*)::text AS count FROM audit_events WHERE action='agent_native_admin.write' AND decision='allow' AND metadata->>'id'=$1 AND metadata->>'target_alias'=$2`;
    const recoverAudit = `SELECT count(*)::text AS count FROM audit_events WHERE action='agent_native_admin.recover' AND metadata->>'id'=$1`;
    expect(await countRows(active, writeAudit, [id, active.fixture.targetAlias])).toBe('1');
    expect(await countRows(active, recoverAudit, [id])).toBe('0');
    await capture(page, 'nativa-pendiente', verify);
    await verify.click();
    try {
      await native.getByText('Guardado recuperado con recibo durable y archivo verificado. Pendiente de recarga.', { exact: true })
        .waitFor({ timeout: 30_000 });
    } catch (cause) { throw new Error(`native recover failed: ${await bodySnippet(page)}`, { cause }); }
    expect(await verify.count()).toBe(0);
    expect(await skillFile(active, id)).toBe(content.trimEnd());
    expect(await countRows(active, writeAudit, [id, active.fixture.targetAlias])).toBe('1');
    expect(await countRows(active, recoverAudit, [id])).toBe('0');
    expect(await countRows(active,
      `SELECT count(*)::text AS count FROM jobs WHERE tenant_id=$1 AND kind='system.context.write.quarantine.v1'
        AND payload#>>'{documents,0,name}'=$2`,
      [active.fixture.tenant, document])).toBe(jobs);
    const read = await apiGet(page, `/v3/console/tenants/${encodeURIComponent(active.fixture.tenant)}/agents/${encodeURIComponent(active.fixture.targetAlias)}/native/skill/${encodeURIComponent(id)}`);
    expect(read.status).toBe(200);
    expect(skillContent(read.body).trimEnd()).toBe(content.trimEnd());
    await capture(page, 'nativa-recuperada', native.getByText('Guardado recuperado con recibo durable y archivo verificado. Pendiente de recarga.', { exact: true }));
    process.stdout.write(`a18 native recover: owner=${OWNER} upstream=${String(upstream)} piece=${id}\n`);
  }, 180_000);

  it('a 390 la barra de motivo no tapa el campo enfocado y a 1440 sigue fija', async () => {
    if (!runtime) throw new Error('measured runtime missing');
    const active = runtime;
    const page = await openSession(active.fixture, `/messages/${active.fixture.tenant}/${active.fixture.targetAlias}?view=context`);
    const profile = page.getByRole('region', { name: `Perfil y contexto de ${active.fixture.targetAlias}` });
    await profile.getByRole('textbox', { name: 'Responsabilidades', exact: true }).waitFor({ timeout: 20_000 });
    const bar = profile.locator('[data-profile-reason-bar]');
    await page.setViewportSize(DESKTOP);
    await bar.evaluate((element) => { element.scrollIntoView({ block: 'center' }); });
    await shot(page, 'perfil-1440.png');
    await page.setViewportSize(PHONE);
    const last = profile.getByRole('textbox', { name: 'Instrucciones fijas de funcionamiento', exact: true });
    await last.evaluate((element) => { element.scrollIntoView({ block: 'center' }); });
    await shot(page, 'perfil-390.png');
    for (const name of PROFILE_FIELDS) {
      const field = profile.getByRole('textbox', { name, exact: true });
      const placed = await place(field);
      const barBox = await measure(bar);
      const viewport = page.viewportSize();
      if (!viewport) throw new Error('viewport missing');
      const overlap = overlaps(placed.box, barBox);
      const visible = insideViewport(placed.box, viewport);
      if (overlap || !visible || !placed.hit) {
        await shot(page, 'perfil-390-tapada.png');
        throw new Error(`reason bar covers the focused profile field ${name} overlap=${String(overlap)} visible=${String(visible)} hit=${String(placed.hit)}`);
      }
    }
    await page.setViewportSize(DESKTOP);
    expect(await bar.evaluate((element) => getComputedStyle(element).position)).toBe('sticky');
    await bar.evaluate((element) => { element.scrollIntoView({ block: 'center' }); });
    await shot(page, 'perfil-1440.png');
  }, 120_000);
});

const PROFILE_FIELDS = [
  'Identidad y propósito',
  'Rol declarado',
  'Tu humano y cómo tratarlo',
  'Responsabilidades',
  'Restricciones',
  'Herramientas declaradas en el contexto',
  'Instrucciones fijas de funcionamiento',
] as const;

const BAR_SHOTS = join(process.cwd(), '.delegados/v4/recibos/a18b-barra-390-1025');

interface Rect { top: number; right: number; bottom: number; left: number }

async function shot(page: V4Page, name: string): Promise<void> {
  await mkdir(BAR_SHOTS, { recursive: true });
  await page.screenshot({ path: join(BAR_SHOTS, name), fullPage: false });
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.left < b.right - 0.5 && a.right > b.left + 0.5 && a.top < b.bottom - 0.5 && a.bottom > b.top + 0.5;
}

function insideViewport(box: Rect, viewport: { width: number; height: number }): boolean {
  return box.top >= -1 && box.left >= -1 && box.bottom <= viewport.height + 1 && box.right <= viewport.width + 1;
}

async function measure(target: V4Locator): Promise<Rect> {
  return target.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left };
  });
}

async function place(target: V4Locator): Promise<{ box: Rect; hit: boolean }> {
  return target.evaluate((element) => {
    element.focus();
    const rect = element.getBoundingClientRect();
    const x = Math.min(rect.right - 2, Math.max(rect.left + 2, rect.left + rect.width / 2));
    const y = Math.min(rect.bottom - 2, Math.max(rect.top + 2, rect.top + rect.height / 2));
    const hit = document.elementFromPoint(x, y);
    return {
      box: { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left },
      hit: hit === element || (hit !== null && element.contains(hit)),
    };
  });
}
