import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_MESSAGE, MAX_ATTACHMENTS_TOTAL_BYTES,
} from '../../packages/protocol/src/attachment-limits.js';
import {
  functionalTenants, isaTenant, newTrustedPage, startConsoleFunctionalFixture, type FunctionalTenant,
} from './console-functional-browser.fixtures.js';
import {
  apiGet, asV4Page, BrowserErrorLog, HERMETIC_INSTANCE_RULES, login, type V4Page,
} from './v4-console-real-browser.helpers.js';

const owner = 'e2e-a6-chat-1025b';
const prefix = `zz-canary-${owner}`;
const receipts = join(process.cwd(), '.delegados/v4/recibos', owner);
let fixture: Awaited<ReturnType<typeof startConsoleFunctionalFixture>> | undefined;

interface KeyboardPage extends V4Page { keyboard: { insertText(text: string): Promise<void> } }
interface ClipboardContext { grantPermissions(names: string[], options: { origin: string }): Promise<void> }
interface DroppedFile { name: string; size: number; type?: string }
interface Publication { id: string; delivery: string; room_id: string; body: { text: string } }

function active() {
  if (!fixture) throw new Error('Chat edge fixture is not initialized');
  return fixture;
}

beforeAll(async () => {
  if (process.env.CAUCE_TEST_DATABASE_URL) throw new Error('Chat edges require an isolated Testcontainers database');
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

async function conversation(tenant: FunctionalTenant, width: number) {
  const page = asV4Page(await newTrustedPage(active(), { width, height: width === 390 ? 844 : 900 }));
  const errors = new BrowserErrorLog([...HERMETIC_INSTANCE_RULES, {
    id: 'hermetic-terminal-targets-404', reason: 'fixture without a terminal relay mount',
    matches: (text, url) => text.includes('status of 404') && url === `${active().baseUrl}/v3/console/terminal/targets`,
  }]);
  errors.watch(page, `edges-${String(width)}`);
  await login(page, active().baseUrl, { ...tenant, name: 'Canary', company: { name: 'Canary', slug: 'canary' } });
  await page.goto(`${active().baseUrl}/messages/${tenant.tenant}/${tenant.target}`, { waitUntil: 'domcontentloaded' });
  const editor = page.getByLabel(`Mensaje para ${tenant.target}`, { exact: true });
  await editor.waitFor({ timeout: 20_000 });
  return { page, editor, errors };
}

async function persisted(page: V4Page, tenant: FunctionalTenant, text: string): Promise<Publication> {
  const rows = () => active().database.pool.query<Publication>(
    `SELECT m.id,d.id AS delivery,m.room_id,m.body FROM messages m JOIN deliveries d ON d.message_id=m.id
     WHERE m.tenant_id=$1 AND m.body->>'text'=$2 AND d.recipient_alias=$3`, [tenant.tenant, text.trim(), tenant.target],
  );
  await expect.poll(async () => (await rows()).rowCount, { timeout: 20_000 }).toBe(1);
  const row = (await rows()).rows[0];
  if (!row) throw new Error('UI chat publication is absent from PostgreSQL');
  expect((await apiGet(page, `/v3/console/messages/${row.id}`))).toMatchObject({
    status: 200, body: { body: { text: text.trim() }, room_id: row.room_id },
  });
  await expect.poll(() => page.getByLabel(`Mensaje para ${tenant.target}`, { exact: true }).inputValue(), { timeout: 20_000 }).toBe('');
  await page.locator(`article[data-message-id="${row.id}"]`).waitFor({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Enviar', exact: true }).waitFor({ timeout: 20_000 });
  return row;
}

async function send(page: V4Page, tenant: FunctionalTenant, text: string) {
  await page.getByLabel(`Mensaje para ${tenant.target}`, { exact: true }).fill(text);
  await page.getByRole('button', { name: 'Enviar', exact: true }).click();
  return persisted(page, tenant, text);
}

async function sync(page: V4Page) {
  await page.getByRole('button', { name: 'Opciones de la conversación', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Sincronizar', exact: true }).click();
}

async function drop(page: V4Page, files: DroppedFile[]) {
  await page.evaluate((items) => {
    const transfer = new DataTransfer();
    for (const item of items) transfer.items.add(new File([new Uint8Array(item.size)], item.name, { type: item.type ?? 'text/plain' }));
    const composer = document.querySelector('[data-chat-composer]');
    if (!composer) throw new Error('Missing chat drop target');
    composer.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, files);
}

async function countMessages(tenant: FunctionalTenant) {
  return (await active().database.pool.query<{ count: number }>(
    'SELECT count(*)::integer AS count FROM messages WHERE tenant_id=$1', [tenant.tenant],
  )).rows[0]?.count;
}

async function paint(page: V4Page) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => { resolve(); }))));
}

describe('Chat V4: bordes reales del compositor', () => {
  it('respeta Enter, Shift+Enter y composición, rechaza texto vacío y limita la entrada a 8000 caracteres', async () => {
    for (const [index, tenant] of functionalTenants.entries()) {
      const width = index === 0 ? 1440 : 390;
      const { page, editor, errors } = await conversation(tenant, width);
      const before = await countMessages(tenant);
      await editor.fill(' \n\t');
      await editor.press('Enter');
      await paint(page);
      expect(await page.getByRole('button', { name: 'Enviar', exact: true }).isDisabled()).toBe(true);
      expect(await countMessages(tenant)).toBe(before);
      const first = `${prefix}-keys-${randomUUID()}`;
      await editor.fill(first);
      await editor.press('Shift+Enter');
      await (page as KeyboardPage).keyboard.insertText('segunda línea');
      const multiline = `${first}\nsegunda línea`;
      expect(await editor.inputValue()).toBe(multiline);
      const prevented = await page.evaluate(() => {
        const input = document.querySelector('[data-chat-composer] textarea');
        if (!input) throw new Error('Missing composing input');
        const enter = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, bubbles: true, cancelable: true });
        input.dispatchEvent(enter);
        return enter.defaultPrevented;
      });
      expect(prevented).toBe(false);
      await paint(page);
      expect(await editor.inputValue()).toBe(multiline);
      expect(await countMessages(tenant)).toBe(before);
      await page.screenshot({ path: join(receipts, `keys-composing-${String(width)}.png`) });
      await editor.press('Enter');
      await persisted(page, tenant, multiline);
      const longText = `${prefix}-limit-${randomUUID()}${'x'.repeat(8_001)}`;
      await editor.click();
      await (page as KeyboardPage).keyboard.insertText(longText);
      expect(await editor.inputValue()).toBe(longText.slice(0, 8_000));
      await editor.press('Enter');
      const long = await persisted(page, tenant, longText.slice(0, 8_000));
      expect(long.body.text.length).toBe(8_000);
      await page.screenshot({ path: join(receipts, `text-limit-persisted-${String(width)}.png`) });
      errors.assertClean();
      await page.context().close();
    }
  }, 180_000);

  it('copia al portapapeles real y vuelve a escribir mensajes propios fallidos sin alterar el original', async () => {
    for (const [index, tenant] of functionalTenants.entries()) {
      const width = index === 0 ? 1440 : 390;
      const { page, editor, errors } = await conversation(tenant, width);
      await (page.context() as unknown as ClipboardContext).grantPermissions(['clipboard-read', 'clipboard-write'], { origin: active().baseUrl });
      const text = `${prefix}-copy-resend-${randomUUID()}`;
      const original = await send(page, tenant, text);
      const article = page.locator(`article[data-message-id="${original.id}"]`);
      await article.getByRole('button', { name: 'Copiar mensaje', exact: true }).click();
      await article.getByRole('button', { name: 'Copiado', exact: true }).waitFor({ timeout: 10_000 });
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(text);
      const status = index === 0 ? 'failed' : 'dead';
      await active().database.pool.query(
        'UPDATE deliveries SET status=$2,attempt=1,last_error=$3,terminal_at=now() WHERE id=$1',
        [original.delivery, status, `${prefix}-synthetic-failure`],
      );
      await sync(page);
      const resend = article.getByRole('button', { name: 'Volver a escribir este mensaje', exact: true });
      await resend.waitFor({ timeout: 20_000 });
      await editor.fill('Nuevo contexto');
      await resend.click();
      const rewritten = `Nuevo contexto\n\n${text}`;
      expect(await editor.inputValue()).toBe(rewritten);
      expect(await editor.evaluate((element) => document.activeElement === element)).toBe(true);
      expect((await active().database.pool.query('SELECT id FROM messages WHERE body->>\'text\'=$1', [rewritten])).rowCount).toBe(0);
      await page.screenshot({ path: join(receipts, `rewritten-${status}-${String(width)}.png`) });
      await page.getByRole('button', { name: 'Enviar', exact: true }).click();
      expect((await persisted(page, tenant, rewritten)).id).not.toBe(original.id);
      expect((await active().database.pool.query<{ status: string }>('SELECT status FROM deliveries WHERE id=$1', [original.delivery])).rows)
        .toEqual([{ status }]);
      errors.assertClean();
      await page.context().close();
    }
  }, 180_000);

  it('rechaza nombres y MIME inseguros, exceso de cantidad y bytes, conservando sólo los adjuntos válidos', async () => {
    for (const [index, tenant] of functionalTenants.entries()) {
      const width = index === 0 ? 1440 : 390;
      const { page, errors } = await conversation(tenant, width);
      const before = await countMessages(tenant);
      const rejected: { files: DroppedFile[]; error: string }[] = [
        { files: [{ name: '../unsafe.txt', size: 1 }], error: 'El nombre del archivo no es seguro.' },
        { files: [{ name: 'unsafe\u202etxt', size: 1 }], error: 'El nombre del archivo no es seguro.' },
        { files: [{ name: 'invalid-mime.txt', size: 1, type: 'invalid' }], error: '“invalid-mime.txt” no tiene un tipo MIME válido.' },
        { files: Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE + 1 }, (_, item) => ({ name: `extra-${String(item)}.txt`, size: 1 })),
          error: `Podés adjuntar hasta ${String(MAX_ATTACHMENTS_PER_MESSAGE)} archivos.` },
        { files: [{ name: 'oversize.bin', size: MAX_ATTACHMENT_BYTES + 1 }],
          error: `“oversize.bin” supera el límite de ${MAX_ATTACHMENT_BYTES.toLocaleString('es-CO')} bytes.` },
        { files: [{ name: 'aggregate-a.bin', size: 6_000_000 }, { name: 'aggregate-b.bin', size: 4_000_001 }],
          error: `Los archivos superan el límite total de ${MAX_ATTACHMENTS_TOTAL_BYTES.toLocaleString('es-CO')} bytes.` },
      ];
      for (const entry of rejected) {
        await drop(page, entry.files);
        await page.getByRole('alert').getByText(entry.error, { exact: true }).waitFor({ timeout: 10_000 });
        expect(await page.getByRole('list', { name: 'Archivos adjuntos', exact: true }).count()).toBe(0);
        expect(await page.getByRole('button', { name: 'Enviar', exact: true }).isDisabled()).toBe(true);
      }
      expect(await countMessages(tenant)).toBe(before);
      await page.screenshot({ path: join(receipts, `attachments-rejected-${String(width)}.png`) });
      const valid = Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE }, (_, item) => ({ name: `${prefix}-${String(item)}.txt`, size: 1 }));
      await drop(page, valid);
      const selection = page.getByRole('list', { name: 'Archivos adjuntos', exact: true });
      expect(await selection.locator('li').count()).toBe(MAX_ATTACHMENTS_PER_MESSAGE);
      expect(await page.getByRole('button', { name: 'Adjuntar archivos', exact: true }).isDisabled()).toBe(true);
      await drop(page, [{ name: 'fifth.txt', size: 1 }]);
      await page.getByRole('alert').getByText(`Podés adjuntar hasta ${String(MAX_ATTACHMENTS_PER_MESSAGE)} archivos.`, { exact: true }).waitFor();
      expect(await selection.locator('li').count()).toBe(MAX_ATTACHMENTS_PER_MESSAGE);
      const publication = await send(page, tenant, `${prefix}-four-files-${randomUUID()}`);
      const files = await active().database.pool.query<{ files: { name: string; file_size: number }[] }>(
        "SELECT body->'attachments_v1' AS files FROM messages WHERE id=$1", [publication.id],
      );
      expect(files.rows[0]?.files.map((file) => ({ name: file.name, file_size: file.file_size })))
        .toEqual(valid.map((file) => ({ name: file.name, file_size: 1 })));
      const bytes = await page.evaluate(async (id) => {
        const response = await fetch(`/v3/console/messages/${id}/attachments/0`, { credentials: 'include' });
        return { status: response.status, bytes: [...new Uint8Array(await response.arrayBuffer())] };
      }, publication.id);
      expect(bytes).toEqual({ status: 200, bytes: [0] });
      await page.screenshot({ path: join(receipts, `attachments-four-persisted-${String(width)}.png`) });
      errors.assertClean();
      await page.context().close();
    }
  }, 180_000);

  it('publica un archivo en el límite exacto de bytes y recupera íntegro su contenido', async () => {
    const { page, errors } = await conversation(isaTenant, 1440);
    const name = `${prefix}-exact-limit.bin`;
    await drop(page, [{ name, size: MAX_ATTACHMENT_BYTES, type: 'application/octet-stream' }]);
    await page.getByRole('button', { name: `Quitar ${name}`, exact: true }).waitFor();
    await page.screenshot({ path: join(receipts, 'attachment-exact-limit-1440.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: join(receipts, 'attachment-exact-limit-390.png') });
    const publication = await send(page, isaTenant, `${prefix}-exact-limit-${randomUUID()}`);
    const bytes = await page.evaluate(async (id) => {
      const response = await fetch(`/v3/console/messages/${id}/attachments/0`, { credentials: 'include' });
      const body = new Uint8Array(await response.arrayBuffer());
      return { status: response.status, length: body.length, zeroes: body.every((byte) => byte === 0) };
    }, publication.id);
    expect(bytes).toEqual({ status: 200, length: MAX_ATTACHMENT_BYTES, zeroes: true });
    errors.assertClean();
    await page.context().close();
  }, 180_000);

  it('exige elegir entre salas, restaura la selección y bloquea una sala retirada conservando el borrador', async () => {
    for (const [index, tenant] of functionalTenants.entries()) {
      const width = index === 0 ? 1440 : 390;
      const room = `${prefix}-${tenant.tenant.toLowerCase()}-extra`;
      await active().database.pool.query('INSERT INTO rooms(id,tenant_id) VALUES($1,$2)', [room, tenant.tenant]);
      await active().database.pool.query(
        "INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES($1,$2,$3,'operator'),($1,$2,$4,'agent')",
        [tenant.tenant, room, tenant.operator, tenant.target],
      );
      try {
        const { page, editor, errors } = await conversation(tenant, width);
        const choose = page.getByRole('combobox', { name: 'Room de origen', exact: true });
        await choose.waitFor({ timeout: 20_000 });
        expect(await choose.inputValue()).toBe('');
        expect(await editor.isDisabled()).toBe(true);
        await page.getByText('Elegí una sala de origen antes de enviar.', { exact: true }).waitFor();
        await choose.selectOption(room);
        const draft = `${prefix}-room-draft-${randomUUID()}`;
        await editor.fill(draft);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await choose.waitFor({ timeout: 20_000 });
        expect(await choose.inputValue()).toBe(room);
        expect(await editor.inputValue()).toBe(draft);
        await page.screenshot({ path: join(receipts, `room-restored-${String(width)}.png`) });
        await active().database.pool.query('UPDATE memberships SET enabled=false WHERE tenant_id=$1 AND room_id=$2', [tenant.tenant, room]);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.getByText('La sala elegida ya no está disponible. Elegí otra sala antes de enviar; el borrador se conserva.', { exact: true })
          .waitFor({ timeout: 20_000 });
        expect(await editor.inputValue()).toBe(draft);
        expect(await choose.inputValue()).toBe(room);
        expect(await editor.isDisabled()).toBe(true);
        expect(await page.getByRole('button', { name: 'Enviar', exact: true }).isDisabled()).toBe(true);
        expect((await active().database.pool.query('SELECT id FROM messages WHERE body->>\'text\'=$1', [draft])).rowCount).toBe(0);
        await page.screenshot({ path: join(receipts, `room-retired-${String(width)}.png`) });
        await choose.selectOption(tenant.room);
        expect(await editor.inputValue()).toBe(draft);
        await page.getByRole('button', { name: 'Enviar', exact: true }).click();
        expect((await persisted(page, tenant, draft)).room_id).toBe(tenant.room);
        errors.assertClean();
        await page.context().close();
      } finally {
        await active().database.pool.query('UPDATE memberships SET enabled=false WHERE tenant_id=$1 AND room_id=$2', [tenant.tenant, room]);
      }
    }
  }, 180_000);
});
