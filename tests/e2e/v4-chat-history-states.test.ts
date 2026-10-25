import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  functionalTenants, newTrustedPage, startConsoleFunctionalFixture, type FunctionalTenant,
} from './console-functional-browser.fixtures.js';
import {
  apiGet, asV4Page, BrowserErrorLog, HERMETIC_INSTANCE_RULES, login, type V4Page,
} from './v4-console-real-browser.helpers.js';

const owner = 'e2e-a6-chat-1025b';
const prefix = `zz-canary-${owner}`;
const receipts = join(process.cwd(), '.delegados/v4/recibos', owner);
let fixture: Awaited<ReturnType<typeof startConsoleFunctionalFixture>> | undefined;

interface Entry { id: string; delivery: string }
interface WheelPage extends V4Page { mouse: { move(x: number, y: number): Promise<void>; wheel(x: number, y: number): Promise<void> } }
type SeedState = 'pending' | 'retry' | 'dead' | 'failed' | 'leased' | 'accepted' | 'done';

function active() {
  if (!fixture) throw new Error('Chat history fixture is not initialized');
  return fixture;
}

beforeAll(async () => {
  if (process.env.CAUCE_TEST_DATABASE_URL) throw new Error('Chat history requires an isolated Testcontainers database');
  await mkdir(receipts, { recursive: true });
  fixture = await startConsoleFunctionalFixture();
  console.info(JSON.stringify({ owner, postgres: fixture.database.container.getId(), browser: fixture.browserContainer }));
  for (const tenant of functionalTenants) {
    await active().database.pool.query(
      "INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES($1,$2,$3,'agent') ON CONFLICT DO NOTHING",
      [tenant.tenant, tenant.room, tenant.target],
    );
  }
}, 10 * 60_000);

afterAll(async () => { await fixture?.close(); });

async function conversation(tenant: FunctionalTenant, width: number, databaseOutage = false) {
  const page = asV4Page(await newTrustedPage(active(), { width, height: width === 390 ? 844 : 900 }));
  const errors = new BrowserErrorLog([...HERMETIC_INSTANCE_RULES, {
    id: 'hermetic-terminal-targets-404', reason: 'fixture without a terminal relay mount',
    matches: (text, url) => text.includes('status of 404') && url === `${active().baseUrl}/v3/console/terminal/targets`,
  }, {
    id: 'isolated-postgres-table-outage', reason: 'this test temporarily renames its own PostgreSQL tables and restores them in finally',
    matches: (text, url) => databaseOutage && text.includes('status of 400')
      && ['/v3/status', '/v3/console/queues', '/v3/console/activity', '/v3/console/messages'].some((path) => url === `${active().baseUrl}${path}`),
  }]);
  errors.watch(page, `history-${String(width)}`);
  const responses: { path: string; status: number }[] = [];
  page.on('response', (response) => { responses.push({ path: new URL(response.url()).pathname, status: response.status() }); });
  await login(page, active().baseUrl, { ...tenant, name: 'Canary', company: { name: 'Canary', slug: 'canary' } });
  await page.goto(`${active().baseUrl}/messages/${tenant.tenant}/${tenant.target}`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel(`Mensaje para ${tenant.target}`, { exact: true }).waitFor({ timeout: 20_000 });
  return { page, errors, responses };
}

async function seed(tenant: FunctionalTenant, text: string, state: SeedState = 'pending'): Promise<Entry> {
  const result = await active().database.pool.query<Entry>(
    `WITH message AS (
       INSERT INTO messages(request_id,trace_id,tenant_id,room_id,actor_alias,body,lane,priority)
       VALUES($1,$2,$3,$4,$5,jsonb_build_object('text',$6::text),'interactive',10) RETURNING id
     ), delivery AS (
       INSERT INTO deliveries(message_id,recipient_tenant,recipient_alias,status,attempt,claim_token,
         consumer_instance_id,consumer_epoch,claimed_at,ack_deadline_at,last_error,terminal_at)
       SELECT id,$3,$7,$8,CASE WHEN $8='pending' THEN 0 ELSE 1 END,gen_random_uuid(),$9,1,now(),now()+interval '1 hour',
         CASE WHEN $8 IN ('retry','dead','failed') THEN 'synthetic history failure' ELSE NULL END,
         CASE WHEN $8 IN ('dead','failed','done') THEN now() ELSE NULL END FROM message RETURNING id,message_id
     ) SELECT message_id AS id,id AS delivery FROM delivery`,
    [randomUUID(), randomUUID(), tenant.tenant, tenant.room, tenant.operator, text, tenant.target, state, prefix],
  );
  const entry = result.rows[0];
  if (!entry) throw new Error('Missing synthetic history row');
  return entry;
}

async function seedWindow(tenant: FunctionalTenant, count: number) {
  return active().database.pool.query<{ id: string }>(
    `WITH message AS (
       INSERT INTO messages(request_id,trace_id,tenant_id,room_id,actor_alias,body,lane,priority,created_at)
       SELECT gen_random_uuid(),gen_random_uuid()::text,$1,$2,$3,jsonb_build_object('text',$4::text||i::text),
         'interactive',10,clock_timestamp()+i*interval '1 microsecond' FROM generate_series(1,$6::integer) i RETURNING id
     ) INSERT INTO deliveries(message_id,recipient_tenant,recipient_alias)
       SELECT id,$1,$5 FROM message RETURNING message_id AS id`,
    [tenant.tenant, tenant.room, tenant.operator, `${prefix}-window-`, tenant.target, count],
  );
}

async function sync(page: V4Page) {
  await page.getByRole('button', { name: 'Opciones de la conversación', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Sincronizar', exact: true }).click();
}

async function detail(page: V4Page, id: string) {
  await page.locator(`article[data-message-id="${id}"]`).getByRole('button', { name: 'Opciones del mensaje', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Ver detalle', exact: true }).click();
  const panel = page.getByRole('group', { name: 'Detalle del mensaje seleccionado', exact: true });
  await panel.waitFor({ timeout: 15_000 });
  expect(await panel.innerText()).toContain(id);
  return panel;
}

async function readEarlier(page: V4Page) {
  const scroll = page.locator('[data-thread-scroll]');
  await expect.poll(() => scroll.evaluate((element) => element.scrollHeight - element.clientHeight), { timeout: 20_000 }).toBeGreaterThan(200);
  const box = await scroll.boundingBox();
  if (!box) throw new Error('Missing visible thread scroll pane');
  await (page as WheelPage).mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await (page as WheelPage).mouse.wheel(0, -100_000);
  await page.getByRole('button', { name: /^Ir al último/u }).waitFor({ timeout: 10_000 });
  await expect.poll(() => scroll.evaluate((element) => element.scrollTop), { timeout: 10_000 }).toBeLessThan(10);
  return scroll.evaluate((element) => element.scrollTop);
}

describe('Chat V4: historial y estados desde PostgreSQL real', () => {
  it('muestra accepted, retry, dead, failed y leased, avisa la cola y navega a Colas desde el aviso y el detalle', async () => {
    for (const [index, tenant] of functionalTenants.entries()) {
      const width = index === 0 ? 1440 : 390;
      const entries = new Map<SeedState, Entry>();
      for (const state of ['accepted', 'retry', 'dead', 'failed', 'leased'] as const) entries.set(state, await seed(tenant, `${prefix}-${state}-${randomUUID()}`, state));
      const { page, errors } = await conversation(tenant, width);
      const labels: [SeedState, string][] = [
        ['accepted', 'Recibido por el agente · entrega aceptada'],
        ['retry', 'Cauce reintentará la entrega'], ['dead', 'La entrega quedó detenida'],
        ['failed', 'La ejecución falló'], ['leased', 'Enviado · esperando aceptación del agente'],
      ];
      for (const [state, label] of labels) {
        const entry = entries.get(state);
        if (!entry) throw new Error(`Missing ${state} fixture`);
        await page.locator(`article[data-message-id="${entry.id}"]`).getByRole('status', { name: `Entrega: ${label}`, exact: true })
          .waitFor({ timeout: 20_000 });
      }
      await page.getByRole('button', { name: /Ver detalles:.*1 reintento\(s\).*2 muerta\(s\)/u }).click();
      const notices = page.getByRole('region', { name: 'Detalles de los avisos', exact: true });
      await notices.getByText('Hay entregas que necesitan atención.', { exact: false }).waitFor();
      await page.screenshot({ path: join(receipts, `queue-states-${String(width)}.png`) });
      await notices.getByRole('link', { name: 'Revisar en Colas', exact: true }).click();
      expect(new URL(page.url()).pathname).toBe('/queues');
      const queues = await apiGet(page, '/v3/console/queues');
      expect(queues.status).toBe(200);
      for (const [state, entry] of entries) {
        expect(queues.body.items).toEqual(expect.arrayContaining([expect.objectContaining({ delivery_id: entry.delivery, state })]));
      }
      await page.goto(`${active().baseUrl}/messages/${tenant.tenant}/${tenant.target}`, { waitUntil: 'domcontentloaded' });
      const leased = entries.get('leased');
      if (!leased) throw new Error('Missing leased message');
      await page.locator(`article[data-message-id="${leased.id}"]`).waitFor({ timeout: 20_000 });
      const panel = await detail(page, leased.id);
      const timeline = panel.getByRole('list', { name: 'Timeline publish a resultado terminal', exact: true });
      expect(await timeline.locator('li[data-missing]').count()).toBe(3);
      await panel.getByRole('link', { name: `Gestionar delivery ${leased.delivery} en Colas`, exact: true }).click();
      expect(new URL(page.url()).pathname).toBe('/queues');
      expect(new URL(page.url()).search).toContain(leased.delivery);
      errors.assertClean();
      await page.context().close();
    }
  }, 180_000);

  it('renderiza mensajes estructurados de agentes, probes y tipos desconocidos sin exponer el nonce', async () => {
    for (const [index, tenant] of functionalTenants.entries()) {
      const width = index === 0 ? 1440 : 390;
      const fixtures = [];
      for (const [type, label] of [
        ['agent.message', 'Mensaje entre agentes'], ['agent.response', 'Respuesta entre agentes'],
        ['agent.fanin', 'Resumen de respuestas de agentes'], ['agent.notify', 'Notificación del agente'],
        ['system.gate.probe', 'Comprobación de conexión'], ['unknown.canary', 'Mensaje estructurado'],
      ]) {
        if (!type || !label) throw new Error('Missing structured fixture type');
        const marker = `${prefix}-structured-${randomUUID()}`;
        const nonce = randomUUID();
        const body = { type, correlation: marker, nonce, timeout_ms: 2_000 };
        const entry = await seed(tenant, marker);
        await active().database.pool.query('UPDATE messages SET body=$2::jsonb WHERE id=$1', [entry.id, JSON.stringify(body)]);
        fixtures.push({ ...entry, type, label, marker, nonce, body });
      }
      const { page, errors } = await conversation(tenant, width);
      for (const entry of fixtures) {
        const card = page.locator(`article[data-message-id="${entry.id}"]`).getByRole('group', { name: entry.label, exact: true });
        await card.waitFor({ timeout: 20_000 });
        expect(await card.innerText()).toContain(entry.marker);
        expect(await card.innerText()).not.toContain(entry.nonce);
        if (entry.type === 'system.gate.probe') expect(await card.innerText()).toContain('2 segundos');
        if (entry.type === 'unknown.canary') expect(await card.innerText()).toContain('Tipo: unknown.canary');
        expect((await apiGet(page, `/v3/console/messages/${entry.id}`))).toMatchObject({ status: 200, body: { body: entry.body } });
        await page.screenshot({ path: join(receipts, `structured-${entry.type.replaceAll('.', '-')}-${String(width)}.png`) });
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      errors.assertClean();
      await page.context().close();
    }
  }, 180_000);

  it('conserva el historial ante fallos reales de cola y lectura inicial, y recupera con Reintentar y Sincronizar', async () => {
    for (const [index, tenant] of functionalTenants.entries()) {
      const width = index === 0 ? 1440 : 390;
      const original = await seed(tenant, `${prefix}-outage-${randomUUID()}`);
      const { page, errors, responses } = await conversation(tenant, width, true);
      const article = page.locator(`article[data-message-id="${original.id}"]`);
      await article.waitFor({ timeout: 20_000 });
      const count = (path: string, status: number) => responses.filter((entry) => entry.path === path && entry.status === status).length;
      await active().database.adminPool.query('ALTER TABLE dead_letters RENAME TO e2e_chat_dead_letters_outage');
      try {
        await page.getByText('Cola sin verificar', { exact: true }).waitFor({ timeout: 30_000 });
        await page.getByRole('button', { name: /Ver detalles:.*Cola sin verificar/u }).click();
        const failedReads = count('/v3/console/queues', 400);
        await page.getByRole('button', { name: 'Reintentar cola', exact: true }).click();
        await expect.poll(() => count('/v3/console/queues', 400), { timeout: 20_000 }).toBeGreaterThan(failedReads);
        expect(await article.count()).toBe(1);
        await page.screenshot({ path: join(receipts, `queue-error-${String(width)}.png`) });
      } finally {
        await active().database.adminPool.query('ALTER TABLE e2e_chat_dead_letters_outage RENAME TO dead_letters');
      }
      const goodQueues = count('/v3/console/queues', 200);
      await page.getByRole('button', { name: 'Reintentar cola', exact: true }).click();
      await expect.poll(() => count('/v3/console/queues', 200), { timeout: 20_000 }).toBeGreaterThan(goodQueues);
      await page.getByText('Cola sin verificar', { exact: true }).waitFor({ state: 'hidden', timeout: 20_000 });
      await page.getByRole('button', { name: 'Cerrar avisos', exact: true }).click();
      const firstLoad = asV4Page(await page.context().newPage());
      errors.watch(firstLoad, `initial-history-${String(width)}`);
      await active().database.adminPool.query('ALTER TABLE delivery_acks RENAME TO e2e_chat_delivery_acks_outage');
      try {
        await sync(page);
        await page.getByText('Historial anterior: sin actualizar', { exact: true }).waitFor({ timeout: 20_000 });
        expect(await article.count()).toBe(1);
        await page.getByRole('button', { name: /Ver detalles:.*Historial anterior: sin actualizar/u }).click();
        await page.getByText('Se muestra el último historial recibido.', { exact: false }).waitFor();
        await page.screenshot({ path: join(receipts, `history-stale-${String(width)}.png`) });
        await firstLoad.goto(`${active().baseUrl}/messages/${tenant.tenant}/${tenant.target}`, { waitUntil: 'domcontentloaded' });
        await firstLoad.getByText('No se pudo leer Cauce V3', { exact: true }).waitFor({ timeout: 30_000 });
        expect(await firstLoad.locator(`article[data-message-id="${original.id}"]`).count()).toBe(0);
        await firstLoad.screenshot({ path: join(receipts, `history-initial-error-${String(width)}.png`) });
      } finally {
        await active().database.adminPool.query('ALTER TABLE e2e_chat_delivery_acks_outage RENAME TO delivery_acks');
      }
      await firstLoad.getByRole('button', { name: 'Reintentar', exact: true }).click();
      await firstLoad.locator(`article[data-message-id="${original.id}"]`).waitFor({ timeout: 20_000 });
      await sync(page);
      await page.getByText('Historial anterior: sin actualizar', { exact: true }).waitFor({ state: 'hidden', timeout: 20_000 });
      expect(count('/v3/console/messages', 400)).toBeGreaterThan(0);
      expect((await apiGet(page, `/v3/console/messages/${original.id}`)).status).toBe(200);
      expect((await apiGet(page, '/v3/status')).status).toBe(200);
      await page.screenshot({ path: join(receipts, `history-recovered-${String(width)}.png`) });
      errors.assertClean();
      await page.context().close();
    }
  }, 240_000);

  it('conserva el scroll del lector al llegar contenido nuevo, cuenta nuevos y vuelve al último', async () => {
    for (const [index, tenant] of functionalTenants.entries()) {
      const width = index === 0 ? 1440 : 390;
      for (let entry = 0; entry < 8; entry += 1) {
        await seed(tenant, `${prefix}-scroll-${String(entry)}\n${'línea del historial\n'.repeat(10)}`);
      }
      const { page, errors } = await conversation(tenant, width);
      const top = await readEarlier(page);
      const newest = await seed(tenant, `${prefix}-new-content-${randomUUID()}`);
      await sync(page);
      await page.locator(`article[data-message-id="${newest.id}"]`).waitFor({ timeout: 20_000 });
      const last = page.getByRole('button', { name: 'Ir al último · 1 nuevo', exact: true });
      await last.waitFor({ timeout: 15_000 });
      expect(Math.abs(await page.locator('[data-thread-scroll]').evaluate((element) => element.scrollTop) - top)).toBeLessThan(4);
      expect((await apiGet(page, `/v3/console/messages/${newest.id}`)).status).toBe(200);
      await page.screenshot({ path: join(receipts, `history-new-preserves-scroll-${String(width)}.png`) });
      await last.click();
      await expect.poll(() => page.locator('[data-thread-scroll]').evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight),
        { timeout: 15_000 }).toBeLessThan(12);
      await last.waitFor({ state: 'hidden', timeout: 10_000 });
      await page.screenshot({ path: join(receipts, `history-new-at-latest-${String(width)}.png`) });
      errors.assertClean();
      await page.context().close();
    }
  }, 180_000);

  it('expande cuerpos reales, muestra timeline completo y retiene el detalle fuera de la ventana de 100 mensajes', async () => {
    for (const [index, tenant] of functionalTenants.entries()) {
      const width = index === 0 ? 1440 : 390;
      const inlineText = `${prefix}-inline-${randomUUID()}\n${'cuerpo completo de la conversación\n'.repeat(15)}`;
      const detailText = `${prefix}-detail-${randomUUID()}\n${'detalle retenido de la conversación\n'.repeat(15)}`;
      const inline = await seed(tenant, inlineText);
      const selected = await seed(tenant, detailText, 'done');
      await active().database.pool.query(
        `INSERT INTO delivery_acks(delivery_id,status,instance_id,epoch,applied,payload,claim_token,attempt,event_id,created_at)
         SELECT d.id,event.status,d.consumer_instance_id,d.consumer_epoch,true,'{}'::jsonb,d.claim_token,1,gen_random_uuid(),
           m.created_at+event.position*interval '1 millisecond'
         FROM deliveries d JOIN messages m ON m.id=d.message_id
         CROSS JOIN unnest(ARRAY['accepted','started','done']) WITH ORDINALITY event(status,position) WHERE d.id=$1`,
        [selected.delivery],
      );
      const { page, errors } = await conversation(tenant, width);
      const inlineArticle = page.locator(`article[data-message-id="${inline.id}"]`);
      await inlineArticle.getByRole('button', { name: 'Mostrar todo', exact: true }).click();
      await inlineArticle.getByText(inlineText.trim(), { exact: true }).waitFor({ timeout: 15_000 });
      expect((await apiGet(page, `/v3/console/messages/${inline.id}`))).toMatchObject({ status: 200, body: { body: { text: inlineText } } });
      const panel = await detail(page, selected.id);
      await panel.getByRole('button', { name: 'Ver el mensaje completo', exact: true }).click();
      await expect.poll(() => panel.getByRole('region', { name: 'Cuerpo del mensaje', exact: true }).locator('pre').innerText(),
        { timeout: 15_000 }).toBe(detailText);
      const timeline = panel.getByRole('list', { name: 'Timeline publish a resultado terminal', exact: true });
      expect(await timeline.locator('li[data-missing]').count()).toBe(0);
      for (const label of ['PUBLICADA', 'ACEPTADA', 'EN CURSO', 'HECHA']) expect(await timeline.getByText(label, { exact: true }).count()).toBe(1);
      await page.screenshot({ path: join(receipts, `history-full-body-timeline-${String(width)}.png`) });
      expect((await seedWindow(tenant, 101)).rowCount).toBe(101);
      await sync(page);
      await panel.getByText('Mensaje fuera de la ventana actual; se muestra el último detalle recibido.', { exact: true })
        .waitFor({ timeout: 20_000 });
      expect(await page.locator(`article[data-message-id="${selected.id}"]`).count()).toBe(0);
      expect(await panel.innerText()).toContain(selected.id);
      expect(await panel.getByRole('region', { name: 'Cuerpo del mensaje', exact: true }).locator('pre').innerText()).toBe(detailText);
      const listed = await apiGet(page, '/v3/console/messages');
      expect(listed.status).toBe(200);
      expect(listed.body.items).toHaveLength(100);
      expect(listed.body.items).not.toEqual(expect.arrayContaining([expect.objectContaining({ message_id: selected.id })]));
      await page.screenshot({ path: join(receipts, `history-retained-detail-${String(width)}.png`) });
      await panel.getByRole('button', { name: 'Cerrar detalle', exact: true }).click();
      await readEarlier(page);
      await page.getByText('Ventana llena: el servidor devuelve como máximo 100 mensajes', { exact: false }).waitFor();
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      await page.screenshot({ path: join(receipts, `history-full-window-${String(width)}.png`) });
      errors.assertClean();
      await page.context().close();
    }
  }, 240_000);
});
