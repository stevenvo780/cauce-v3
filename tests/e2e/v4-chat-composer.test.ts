import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CauceRepository } from '../../packages/store/src/index.js';
import { ackEnvelope, terminalAck } from '../../packages/store/test/helpers/consumer.js';
import { generatedMedia } from './chat-media-real-browser.fixtures.js';
import { browserDocker } from './browser-owned-lifecycle.js';
import { isaSecondHuman, isaTenant, newTrustedPage, startConsoleFunctionalFixture } from './console-functional-browser.fixtures.js';
import { apiGet, asV4Page, login, type V4Page } from './v4-console-real-browser.helpers.js';

const receipts = join(process.cwd(), '.delegados/v4/recibos/e2e-a6-chat-1025b');
const prefix = 'zz-canary-e2e-a6-chat-1025b';
let fixture: Awaited<ReturnType<typeof startConsoleFunctionalFixture>> | undefined;

beforeAll(async () => {
  if (process.env.CAUCE_TEST_DATABASE_URL) throw new Error('Chat E2E requires an isolated Testcontainers database');
  await mkdir(receipts, { recursive: true });
  fixture = await startConsoleFunctionalFixture();
  console.info(JSON.stringify({ owner: prefix, postgres: fixture.database.container.getId(), browser: fixture.browserContainer }));
  await fixture.database.pool.query(
    "INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES ($1,$2,$3,'agent')",
    [isaTenant.tenant, isaTenant.room, isaTenant.target],
  );
}, 10 * 60_000);

afterAll(async () => { await fixture?.close(); });

async function conversation(width: number): Promise<V4Page> {
  if (!fixture) throw new Error('Missing chat fixture');
  const page = asV4Page(await newTrustedPage(fixture, { width, height: width === 390 ? 844 : 900 }));
  await login(page, fixture.baseUrl, {
    email: isaTenant.email, password: isaTenant.password, name: 'Canary', company: { name: 'Canary', slug: 'canary' },
  });
  await page.goto(`${fixture.baseUrl}/messages/${isaTenant.tenant}/${isaTenant.target}`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel(`Mensaje para ${isaTenant.target}`, { exact: true }).waitFor({ timeout: 20_000 });
  return page;
}

async function switchHuman(page: V4Page): Promise<void> {
  if ((page.viewportSize()?.width ?? 1440) < 761) await page.getByRole('button', { name: 'Más', exact: true }).click();
  await page.getByRole('button', { name: /^Cuenta de /u }).click();
  await page.getByRole('button', { name: 'Cambiar cuenta', exact: true }).click();
  await page.getByRole('button', { name: 'Cerrar sesión y continuar', exact: true }).click();
  await page.getByLabel('Correo', { exact: true }).fill(isaSecondHuman.email);
  await page.getByLabel('Contraseña', { exact: true }).fill(isaSecondHuman.password);
  await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
  await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 20_000 });
}

async function publish(page: V4Page, text: string): Promise<{ id: string; delivery: string }> {
  if (!fixture) throw new Error('Missing chat fixture');
  await page.getByLabel(`Mensaje para ${isaTenant.target}`, { exact: true }).fill(text);
  await page.getByRole('button', { name: 'Enviar', exact: true }).click();
  const rows = () => fixture?.database.pool.query<{ id: string; delivery: string }>(
    `SELECT m.id,d.id AS delivery FROM messages m JOIN deliveries d ON d.message_id=m.id
     WHERE m.tenant_id=$1 AND m.body->>'text'=$2`, [isaTenant.tenant, text],
  );
  await expect.poll(async () => (await rows())?.rowCount, { timeout: 20_000 }).toBe(1);
  const message = (await rows())?.rows[0];
  if (!message) throw new Error('Missing durable chat publication');
  expect((await apiGet(page, `/v3/console/messages/${message.id}`)).status).toBe(200);
  await page.getByRole('button', { name: 'Enviar', exact: true }).waitFor({ timeout: 20_000 });
  return message;
}

async function canonicalReply(id: string, reply: string): Promise<void> {
  if (!fixture) throw new Error('Missing chat fixture');
  const repository = new CauceRepository(fixture.database.pool);
  const instanceId = `${prefix}-${randomUUID()}`;
  const lease = await repository.acquireLease(isaTenant.tenant, isaTenant.target, instanceId, [], 60_000, { takeover: true });
  if (!lease.acquired || lease.epoch === undefined || lease.connection_token === undefined) throw new Error('Missing fenced lease');
  try {
    const target = { instanceId, epoch: lease.epoch };
    for (let batch = 0; batch < 100; batch += 1) {
      const deliveries = await repository.claimDeliveries(isaTenant.tenant, isaTenant.target, instanceId,
        lease.epoch, 100, 30_000, 3, {}, lease.connection_token);
      if (deliveries.length === 0) throw new Error('Missing claimed chat message');
      let completed = false;
      for (const delivery of deliveries) {
        expect(await repository.ackDelivery(delivery.delivery_id, isaTenant.tenant, isaTenant.target,
          ackEnvelope(delivery, target, {}, { status: 'started', execution_started: true, retryable: false })))
          .toMatchObject({ applied: true, status: 'started' });
        expect(await repository.ackDelivery(delivery.delivery_id, isaTenant.tenant, isaTenant.target,
          terminalAck(delivery, target, { reply: delivery.message_id === id ? reply : 'Confirmación sintética anterior' })))
          .toMatchObject({ applied: true, status: 'done' });
        completed ||= delivery.message_id === id;
      }
      if (completed) return;
    }
    throw new Error('Chat fixture exceeded its claim budget');
  } finally {
    await repository.releaseLease(isaTenant.tenant, isaTenant.target, instanceId, lease.epoch, lease.connection_token);
  }
}

describe('Chat V4: compositor real y recuperación', () => {
  it('conserva borrador y carril al recargar y los aísla entre personas del mismo alias', async () => {
    if (!fixture) throw new Error('Missing chat fixture');
    for (const width of [1440, 390]) {
      const page = await conversation(width);
      const draft = `${prefix}-draft-${randomUUID()}\nsegunda línea`;
      const input = page.getByLabel(`Mensaje para ${isaTenant.target}`, { exact: true });
      await input.fill(draft);
      await page.getByRole('button', { name: 'Opciones de la conversación', exact: true }).click();
      await page.getByRole('menuitemradio', { name: 'Batch · prioridad 0', exact: true }).click();
      await page.screenshot({ path: join(receipts, `draft-before-${String(width)}.png`) });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await input.waitFor({ timeout: 20_000 });
      expect(await input.inputValue()).toBe(draft);
      await page.getByRole('button', { name: 'Opciones de la conversación', exact: true }).click();
      expect(await page.getByRole('menuitemradio', { name: 'Batch · prioridad 0', exact: true })
        .evaluate((element) => element.getAttribute('aria-checked'))).toBe('true');
      await page.getByRole('menuitemradio', { name: 'Batch · prioridad 0', exact: true }).press('Escape');
      await page.screenshot({ path: join(receipts, `draft-restored-${String(width)}.png`) });
      const unpublished = await fixture.database.pool.query('SELECT id FROM messages WHERE body->>\'text\'=$1', [draft]);
      expect(unpublished.rowCount).toBe(0);
      await switchHuman(page);
      await page.goto(`${fixture.baseUrl}/messages/${isaTenant.tenant}/${isaTenant.target}`, { waitUntil: 'domcontentloaded' });
      await input.waitFor({ timeout: 20_000 });
      expect(await input.inputValue()).toBe('');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await input.waitFor({ timeout: 20_000 });
      expect(await input.inputValue()).toBe('');
    }
  }, 180_000);

  it('conserva una cita que supera el límite de escritura al recargar para poder editarla sin perder el borrador', async () => {
    if (!fixture) throw new Error('Missing chat fixture');
    for (const width of [1440, 390]) {
      const page = await conversation(width);
      const quote = `${prefix}-quote-${randomUUID()}`;
      const source = await publish(page, quote);
      const editor = page.getByLabel(`Mensaje para ${isaTenant.target}`, { exact: true });
      const draft = `${prefix}-${'a'.repeat(7_950)}`;
      await editor.fill(draft);
      await page.locator(`article[data-message-id="${source.id}"]`)
        .getByRole('button', { name: 'Citar en la respuesta', exact: true }).click();
      const expected = `${draft}\n\n> ${quote}\n\n`;
      expect(expected.length).toBeGreaterThan(8_000);
      expect(await editor.inputValue()).toBe(expected);
      await page.screenshot({ path: join(receipts, `draft-over-limit-before-${String(width)}.png`) });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await editor.waitFor({ timeout: 20_000 });
      expect(await editor.inputValue()).toBe(expected);
      expect((await fixture.database.pool.query("SELECT id FROM messages WHERE body->>'text'=$1", [expected])).rowCount).toBe(0);
      await page.screenshot({ path: join(receipts, `draft-over-limit-restored-${String(width)}.png`) });
      await editor.fill('');
    }
  }, 120_000);

  it('selecciona y quita archivos, pega y arrastra, rechaza vacíos y recupera una vista previa fallida con bytes reales', async () => {
    if (!fixture) throw new Error('Missing chat fixture');
    for (const width of [1440, 390]) {
      const page = await conversation(width);
      const input = page.locator('input[type="file"]') as unknown as {
        setInputFiles(files: { name: string; mimeType: string; buffer: Buffer }[]): Promise<void>;
      };
      await input.setInputFiles([{ name: `${prefix}-empty.txt`, mimeType: 'text/plain', buffer: Buffer.alloc(0) }]);
      await page.getByText(`“${prefix}-empty.txt” está vacío.`, { exact: true }).waitFor({ timeout: 10_000 });
      expect(await page.getByRole('button', { name: 'Enviar', exact: true }).isDisabled()).toBe(true);
      const name = `${prefix}-selected.txt`;
      await input.setInputFiles([{ name, mimeType: 'text/plain', buffer: Buffer.from('canary selected') }]);
      await page.getByRole('button', { name: `Quitar ${name}`, exact: true }).click();
      expect(await page.getByRole('list', { name: 'Archivos adjuntos', exact: true }).count()).toBe(0);
      await page.evaluate((stem) => {
        const target = document.querySelector('textarea');
        if (!target) throw new Error('Missing composer');
        const transfer = new DataTransfer();
        transfer.items.add(new File(['canary pasted'], `${stem}-pasted.txt`, { type: 'text/plain' }));
        target.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
      }, prefix);
      const selection = page.getByRole('list', { name: 'Archivos adjuntos', exact: true });
      await selection.getByText(`${prefix}-pasted.txt`, { exact: true }).waitFor();
      await page.evaluate((stem) => {
        const drop = new DataTransfer();
        drop.items.add(new File(['canary dropped'], `${stem}-dropped.txt`, { type: 'text/plain' }));
        document.querySelector('[data-chat-composer]')?.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: drop }));
      }, prefix);
      await selection.getByText(`${prefix}-dropped.txt`, { exact: true }).waitFor();
      const transfer = await publish(page, `${prefix}-transfer-${randomUUID()}`);
      const transferred = await fixture.database.pool.query<{ files: { name: string }[] }>(
        "SELECT body->'attachments_v1' AS files FROM messages WHERE id=$1", [transfer.id]);
      expect(transferred.rows[0]?.files.map((file) => file.name)).toEqual([`${prefix}-pasted.txt`, `${prefix}-dropped.txt`]);

      const image = (await generatedMedia(page, `${prefix}-${String(width)}`))[0];
      if (!image) throw new Error('Missing generated PNG');
      await input.setInputFiles([image]);
      const message = await publish(page, `${prefix}-image-${randomUUID()}`);
      const article = page.locator(`article[data-direction="input"][data-message-id="${message.id}"]`);
      await article.getByRole('button', { name: 'Vista previa', exact: true }).waitFor();
      const body = (await fixture.database.pool.query<{ body: Record<string, unknown> }>(
        'SELECT body FROM messages WHERE id=$1', [message.id])).rows[0]?.body;
      if (!body) throw new Error('Missing durable image body');
      try {
        await fixture.database.pool.query(
          "UPDATE messages SET body=jsonb_set(body,'{attachments_v1,0,content_base64}','\"\"'::jsonb) WHERE id=$1", [message.id]);
        await article.getByRole('button', { name: 'Vista previa', exact: true }).click();
        await article.getByText('No se pudo cargar el archivo.', { exact: true }).waitFor({ timeout: 10_000 });
        await page.screenshot({ path: join(receipts, `attachment-failed-${String(width)}.png`) });
      } finally {
        await fixture.database.pool.query('UPDATE messages SET body=$2::jsonb WHERE id=$1', [message.id, JSON.stringify(body)]);
      }
      await article.getByRole('button', { name: 'Reintentar', exact: true }).click();
      const preview = page.getByRole('dialog', { name: `Vista previa: ${image.name}`, exact: true });
      await preview.waitFor({ timeout: 15_000 });
      await expect.poll(async () => preview.locator('img').evaluate((element) => {
        const image = element as unknown as HTMLImageElement;
        return image.complete && image.naturalWidth > 0;
      }), { timeout: 10_000 }).toBe(true);
      const bytes = await page.evaluate(async (id) => {
        const response = await fetch(`/v3/console/messages/${id}/attachments/0`, { credentials: 'include' });
        return { status: response.status, bytes: [...new Uint8Array(await response.arrayBuffer())] };
      }, message.id);
      expect(bytes.status).toBe(200);
      expect(Buffer.from(bytes.bytes)).toEqual(image.buffer);
      await page.screenshot({ path: join(receipts, `attachment-retried-${String(width)}.png`) });
      await preview.press('Escape');
      expect(await preview.count()).toBe(0);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await article.getByRole('button', { name: 'Vista previa', exact: true }).waitFor({ timeout: 20_000 });
      try {
        await fixture.database.pool.query(
          "UPDATE messages SET body=jsonb_set(body,'{attachments_v1,0,content_base64}','\"\"'::jsonb) WHERE id=$1", [message.id]);
        await article.getByRole('button', { name: 'Descargar', exact: true }).click();
        await article.getByText('No se pudo cargar el archivo.', { exact: true }).waitFor({ timeout: 10_000 });
        await page.screenshot({ path: join(receipts, `download-failed-${String(width)}.png`) });
      } finally {
        await fixture.database.pool.query('UPDATE messages SET body=$2::jsonb WHERE id=$1', [message.id, JSON.stringify(body)]);
      }
      const downloadPage = page as V4Page & {
        waitForEvent(event: 'download', options: { timeout: number }): Promise<{
          suggestedFilename(): string;
          path(): Promise<string | null>;
          failure(): Promise<string | null>;
        }>;
      };
      const downloadEvent = downloadPage.waitForEvent('download', { timeout: 15_000 });
      await article.getByRole('button', { name: 'Reintentar', exact: true }).click();
      const download = await downloadEvent;
      expect(download.suggestedFilename()).toBe(image.name);
      expect(await download.failure()).toBeNull();
      const downloadPath = await download.path();
      if (!downloadPath?.startsWith('/tmp/playwright-artifacts-') || downloadPath.includes('..')) {
        throw new Error('Native download path is outside the owned Playwright artifact directory');
      }
      const downloaded = await browserDocker(['exec', fixture.browserContainer, 'node', '-e',
        "process.stdout.write(require('node:fs').readFileSync(process.argv[1]).toString('base64'))", downloadPath]);
      expect(Buffer.from(downloaded.stdout, 'base64')).toEqual(image.buffer);
      await page.screenshot({ path: join(receipts, `download-retried-${String(width)}.png`) });
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    }
  }, 240_000);

  it('renderiza texto enriquecido y conserva respuestas canónicas anteriores tras recargar', async () => {
    for (const width of [1440, 390]) {
      const page = await conversation(width);
      const message = await publish(page, `${prefix}-rich-${randomUUID()}`);
      const rich = '# Resultado\n\n**Verificado** con `inline`\n\n- primero\n- segundo\n\n1. ordenado primero\n2. ordenado segundo\n\n```ts\nconst value = 42;\n```';
      await canonicalReply(message.id, rich);
      const response = page.locator(`article[data-reply-to="${message.id}"]`);
      await response.locator('strong').getByText('Verificado', { exact: true }).waitFor({ timeout: 20_000 });
      expect(await response.locator('code').getByText('inline', { exact: true }).count()).toBe(1);
      expect(await response.locator('ul').getByText('segundo', { exact: true }).count()).toBe(1);
      expect(await response.locator('ol').getByText('ordenado segundo', { exact: true }).count()).toBe(1);
      expect(await response.locator('pre[data-lang="ts"]').innerText()).toBe('const value = 42;');
      await page.screenshot({ path: join(receipts, `rich-text-${String(width)}.png`) });
      const next = await publish(page, `${prefix}-next-${randomUUID()}`);
      await canonicalReply(next.id, 'Respuesta posterior');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await response.locator('pre').waitFor({ timeout: 20_000 });
      expect(await page.locator(`article[data-reply-to="${next.id}"]`).innerText()).toContain('Respuesta posterior');
      expect((await apiGet(page, `/v3/console/messages/${message.id}`)).status).toBe(200);
    }
  }, 180_000);

  it('explica el rechazo real del micrófono y permite seguir escribiendo', async () => {
    const page = await conversation(390);
    const context = page.context() as unknown as { clearPermissions(): Promise<void> };
    await context.clearPermissions();
    await page.getByRole('button', { name: 'Grabar nota de voz', exact: true }).click();
    await page.getByRole('alert').getByText('No se pudo acceder al micrófono. Revisa el permiso del navegador.', { exact: true })
      .waitFor({ timeout: 20_000 });
    expect(await page.getByRole('list', { name: 'Archivos adjuntos', exact: true }).count()).toBe(0);
    await page.screenshot({ path: join(receipts, 'voice-permission-denied-390.png') });
    await publish(page, `${prefix}-after-microphone-${randomUUID()}`);
  }, 60_000);
});
