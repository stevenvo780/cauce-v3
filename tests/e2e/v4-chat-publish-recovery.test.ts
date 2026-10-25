import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isaTenant, newTrustedPage, startConsoleFunctionalFixture } from './console-functional-browser.fixtures.js';
import { apiGet, asV4Page, login, type V4Locator, type V4Page } from './v4-console-real-browser.helpers.js';

const receipts = join(process.cwd(), '.delegados/v4/recibos/e2e-a6-chat-1025b');
const prefix = 'zz-canary-e2e-a6-chat-1025b-recovery';
let fixture: Awaited<ReturnType<typeof startConsoleFunctionalFixture>> | undefined;
let disconnect = false;
let confirmations = 0;
const held: (() => void)[] = [];
interface FileInput extends V4Locator {
  setInputFiles(files: { name: string; mimeType: string; buffer: Buffer }[]): Promise<void>;
}

beforeAll(async () => {
  if (process.env.CAUCE_TEST_DATABASE_URL) throw new Error('Chat recovery requires its own Testcontainers database');
  await mkdir(receipts, { recursive: true });
  fixture = await startConsoleFunctionalFixture({ configureGateway(app) {
    app.addHook('onSend', async (request, reply, payload) => {
      if (disconnect && request.method === 'POST' && request.routeOptions.url === '/v3/console/publish-intents/confirm') {
        confirmations += 1;
        await new Promise<void>((resolve) => { held.push(resolve); });
        reply.raw.destroy();
      }
      return payload;
    });
  } });
  await fixture.database.pool.query(
    "INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES($1,$2,$3,'agent')",
    [isaTenant.tenant, isaTenant.room, isaTenant.target],
  );
  console.info(JSON.stringify({ owner: prefix, postgres: fixture.database.container.getId(), browser: fixture.browserContainer }));
}, 10 * 60_000);

afterAll(async () => { disconnect = false; held.splice(0).forEach((release) => { release(); }); await fixture?.close(); });

async function conversation(width: number): Promise<V4Page> {
  if (!fixture) throw new Error('Missing recovery fixture');
  const page = asV4Page(await newTrustedPage(fixture, { width, height: width === 390 ? 844 : 900 }));
  await login(page, fixture.baseUrl, {
    email: isaTenant.email, password: isaTenant.password, name: 'Canary', company: { name: 'Canary', slug: 'canary' },
  });
  await page.goto(`${fixture.baseUrl}/messages/${isaTenant.tenant}/${isaTenant.target}`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel(`Mensaje para ${isaTenant.target}`, { exact: true }).waitFor({ timeout: 20_000 });
  return page;
}

async function root(text: string) {
  if (!fixture) throw new Error('Missing recovery fixture');
  return fixture.database.pool.query<{ id: string; body: { text: string }; status: string; confirmed: string }>(
    `SELECT m.id,m.body,d.status,(SELECT count(*)::text FROM audit_events a
       WHERE a.message_id=m.id AND a.action='console.publish.confirm') AS confirmed
       FROM messages m JOIN deliveries d ON d.message_id=m.id
       WHERE m.tenant_id=$1 AND m.body->>'text'=$2 AND d.recipient_alias=$3`,
    [isaTenant.tenant, text, isaTenant.target],
  );
}

describe('Chat V4: recuperación de publicación con fallos reales', () => {
  it('conserva texto y archivo tras rechazo de PostgreSQL y permite reintentar sin duplicar', async () => {
    if (!fixture) throw new Error('Missing recovery fixture');
    const page = await conversation(390);
    const text = `${prefix}-database-${randomUUID()}`;
    const bytes = Buffer.from('Owned attachment preserved across a real database rejection');
    const file = { name: `${prefix}.txt`, mimeType: 'text/plain', buffer: bytes };
    await (page.locator('input[type="file"]') as FileInput).setInputFiles([file]);
    await page.getByLabel(`Mensaje para ${isaTenant.target}`, { exact: true }).fill(text);
    await fixture.database.pool.query(`CREATE FUNCTION chat_reject_owned_publication() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.body->>'text' LIKE 'zz-canary-e2e-a6-chat-1025b-recovery-database-%' THEN
        RAISE EXCEPTION 'Owned test database rejects publication'; END IF; RETURN NEW; END; $$`);
    await fixture.database.pool.query(`CREATE TRIGGER chat_reject_owned_publication BEFORE INSERT ON messages
      FOR EACH ROW EXECUTE FUNCTION chat_reject_owned_publication()`);
    try {
      await page.getByRole('button', { name: 'Enviar', exact: true }).click();
      await page.getByText(/Owned test database rejects publication/u).waitFor({ timeout: 20_000 });
      expect((await root(text)).rows).toEqual([]);
      expect(await page.getByLabel(`Mensaje para ${isaTenant.target}`, { exact: true }).inputValue()).toBe(text);
      expect(await page.getByRole('list', { name: 'Archivos adjuntos', exact: true }).innerText()).toContain(file.name);
      await page.screenshot({ path: join(receipts, 'publish-database-failed-390.png') });
    } finally {
      await fixture.database.pool.query('DROP TRIGGER chat_reject_owned_publication ON messages');
      await fixture.database.pool.query('DROP FUNCTION chat_reject_owned_publication()');
    }
    await page.getByRole('button', { name: 'Enviar', exact: true }).click();
    await expect.poll(async () => (await root(text)).rowCount, { timeout: 20_000 }).toBe(1);
    await expect.poll(async () => (await root(text)).rows[0]?.confirmed, { timeout: 20_000 }).toBe('1');
    const message = (await root(text)).rows[0];
    if (!message) throw new Error('Retried publication was not persisted');
    expect(message).toMatchObject({ body: { text }, status: 'pending', confirmed: '1' });
    const download = await page.evaluate(async (id) => {
      const response = await fetch(`/v3/console/messages/${id}/attachments/0`, { credentials: 'include' });
      return { status: response.status, bytes: [...new Uint8Array(await response.arrayBuffer())] };
    }, message.id);
    expect(download).toEqual({ status: 200, bytes: [...bytes] });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator(`article[data-message-id="${message.id}"]`).waitFor({ timeout: 20_000 });
    expect((await root(text)).rowCount).toBe(1);
    await page.screenshot({ path: join(receipts, 'publish-database-retried-390.png') });
  }, 90_000);

  it('recupera al recargar una confirmación cuyo commit ocurrió pero ambas respuestas perdieron el transporte', async () => {
    const page = await conversation(1440);
    const text = `${prefix}-transport-${randomUUID()}`;
    const editor = page.getByLabel(`Mensaje para ${isaTenant.target}`, { exact: true });
    confirmations = 0;
    disconnect = true;
    try {
      await editor.fill(text);
      await page.getByRole('button', { name: 'Enviar', exact: true }).click();
      await expect.poll(() => confirmations, { timeout: 20_000 }).toBe(1);
      expect(await page.getByRole('button', { name: 'Confirmando…', exact: true }).isDisabled()).toBe(true);
      expect(await editor.inputValue()).toBe('');
      const committed = (await root(text)).rows[0];
      if (!committed) throw new Error('Gateway did not commit before the transport fault');
      expect(committed.confirmed).toBe('1');
      held.shift()?.();
      await expect.poll(() => confirmations, { timeout: 20_000 }).toBe(2);
      held.shift()?.();
      await page.getByText(/Confirmación incierta; intención pendiente/u).waitFor({ timeout: 20_000 });
      expect((await root(text)).rows).toHaveLength(1);
      await page.screenshot({ path: join(receipts, 'publish-transport-uncertain-1440.png') });
      disconnect = false;
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator(`article[data-message-id="${committed.id}"]`).waitFor({ timeout: 20_000 });
      expect((await apiGet(page, `/v3/console/messages/${committed.id}`)).body).toMatchObject({ body: { text } });
      expect((await root(text)).rows).toEqual([committed]);
      await page.screenshot({ path: join(receipts, 'publish-transport-recovered-1440.png') });
    } finally { disconnect = false; held.splice(0).forEach((release) => { release(); }); }
  }, 90_000);
});
