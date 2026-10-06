import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sep } from 'node:path';
import { isRfcUuid, objectRecord } from '@cauce/protocol';
import { generatedMedia, passiveDocuments, startMediaReplyAdapter, readReplyFiles, type MediaFile, type MediaReplyAdapter } from './chat-media-real-browser.fixtures.js';
import {
  functionalTenants, isaTenant, isaSecondHuman, jhonTenant, newTrustedPage, startConsoleFunctionalFixture,
  type BrowserPage, type FunctionalTenant, type Locator,
} from './console-functional-browser.fixtures.js';
import { fileSha256, readFileTurns } from './chat-file-send-real-browser.fixtures.js';

interface FileInput extends Locator {
  setInputFiles(files: { name: string; mimeType: string; buffer: Buffer }[]): Promise<void>;
}
interface FileChooserPage extends BrowserPage {
  waitForEvent(event: 'filechooser', options: { timeout: number }): Promise<unknown>;
}
interface DurableFile {
  name: string; mime_type: string; file_size: number; sha256: string; kind: string; content_base64: string;
}
interface MessageRow {
  id: string; tenant_id: string; auth_channel: string; body: { text: string; attachments_v1: DurableFile[] };
  delivery_id: string; status: string; attempt: number;
}
type Fixture = Awaited<ReturnType<typeof startConsoleFunctionalFixture>>;
let fixture: Fixture | undefined;
const pages = new Map<string, BrowserPage>();
const adapters = new Map<string, MediaReplyAdapter>();
let secondHuman: BrowserPage | undefined;
const sent = new Map<string, { id: string; files: MediaFile[] }>();
let incoming: ReplyReference | undefined;

async function login(page: BrowserPage, tenant: FunctionalTenant): Promise<void> {
  await page.getByLabel('Correo').waitFor({ timeout: 15_000 });
  await page.getByLabel('Correo').fill(tenant.email);
  await page.getByLabel('Contraseña').fill(tenant.password);
  await page.getByRole('button', { name: 'Iniciar sesión' }).click();
  await page.getByRole('link', { name: /Conversaciones/u }).waitFor({ state: 'visible', timeout: 20_000 });
}

async function createMembership(page: BrowserPage, tenant: FunctionalTenant, active: Fixture): Promise<void> {
  await page.goto(`${active.baseUrl}/config`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Administración avanzada' }).click();
  await page.getByRole('button', { name: 'Un solo recurso' }).click();
  await page.getByLabel('Recurso a crear').selectOption('membership');
  await page.getByLabel('Tenant', { exact: true }).fill(tenant.tenant);
  await page.getByLabel('Room', { exact: true }).fill(tenant.room);
  await page.getByLabel('Alias', { exact: true }).fill(tenant.target);
  await page.getByText('Opciones de alta:', { exact: false }).click();
  await page.getByLabel('Rol de permisos', { exact: true }).fill('agent');
  await page.getByRole('button', { name: 'Previsualizar el alta' }).click();
  await page.getByRole('status').filter({ hasText: 'Dry-run aceptado por el servidor' }).waitFor({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Crear', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'creado en la revisión' }).waitFor({ timeout: 20_000 });
  const membership = await active.database.pool.query<{ enabled: boolean; role: string }>(
    'SELECT enabled,role FROM memberships WHERE tenant_id=$1 AND room_id=$2 AND alias=$3',
    [tenant.tenant, tenant.room, tenant.target],
  );
  expect(membership.rows).toEqual([{ enabled: true, role: 'agent' }]);
}

beforeAll(async () => {
  if (process.env.CAUCE_TEST_DATABASE_URL) throw new Error('File E2E requires its own Testcontainers database');
  const active = await startConsoleFunctionalFixture();
  fixture = active;
  process.stdout.write(`Media E2E owned resources: postgres=${active.database.container.getId()} browser=${active.browserContainer} image=${active.browserRuntime.image} imageId=${active.browserRuntime.imageId}\n`);
  for (const tenant of functionalTenants) {
    const page = await newTrustedPage(active, { width: tenant === isaTenant ? 1440 : 360, height: 900 });
    pages.set(tenant.tenant, page);
    await page.goto(active.baseUrl, { waitUntil: 'domcontentloaded' });
    await login(page, tenant);
    await createMembership(page, tenant, active);
    adapters.set(tenant.tenant, await startMediaReplyAdapter(active, tenant));
    const deadline = Date.now() + 20_000;
    let leases = 0;
    while (Date.now() < deadline) {
      const lease = await active.database.pool.query(
        'SELECT 1 FROM connection_leases WHERE tenant_id=$1 AND alias=$2 AND instance_id=$3 AND lease_until>now()',
        [tenant.tenant, tenant.target, `file-e2e-${tenant.tenant.toLowerCase()}`],
      );
      leases = lease.rowCount ?? 0;
      if (leases === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(leases).toBe(1);
  }
  secondHuman = await newTrustedPage(active, { width: 360, height: 900 });
  await secondHuman.goto(active.baseUrl, { waitUntil: 'domcontentloaded' });
  await login(secondHuman, isaSecondHuman);
}, 10 * 60_000);

afterAll(async () => { await fixture?.close(); });

function state(tenant: FunctionalTenant) {
  const page = pages.get(tenant.tenant);
  const adapter = adapters.get(tenant.tenant);
  if (!fixture || !page || !adapter) throw new Error('Media E2E setup is incomplete');
  return { active: fixture, page, adapter };
}

async function selectMedia(page: BrowserPage, files: MediaFile[]): Promise<void> {
  const chooser = (page as FileChooserPage).waitForEvent('filechooser', { timeout: 10_000 });
  await page.getByRole('button', { name: 'Adjuntar archivos', exact: true }).click();
  await chooser;
  await (page.locator('input[type="file"]') as FileInput).setInputFiles(files);
  for (const file of files) await page.getByText(file.name, { exact: true }).waitFor({ timeout: 10_000 });
}

async function publishMedia(tenant: FunctionalTenant, files: MediaFile[], text: string): Promise<string> {
  const { active, page, adapter } = state(tenant);
  await page.goto(`${active.baseUrl}/messages/${tenant.tenant}/${tenant.target}`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel(`Mensaje para ${tenant.target}`).waitFor({ timeout: 20_000 });
  await selectMedia(page, files);
  if (text) await page.getByLabel(`Mensaje para ${tenant.target}`).fill(text);
  await page.getByRole('button', { name: 'Enviar', exact: true }).click();
  const records = () => active.database.pool.query<MessageRow>(
    `SELECT m.id,m.tenant_id,m.auth_channel,m.body,d.id AS delivery_id,d.status,d.attempt
       FROM messages m JOIN deliveries d ON d.message_id=m.id
      WHERE m.tenant_id=$1 AND d.recipient_alias=$2 AND m.body->'attachments_v1'->0->>'name'=$3`,
    [tenant.tenant, tenant.target, files[0]?.name],
  );
  await expect.poll(async () => (await records()).rows[0]?.status, { timeout: 35_000, interval: 100 }).toBe('done');
  const rows = (await records()).rows;
  expect(rows).toHaveLength(1);
  const row = rows[0];
  if (!row) throw new Error('Missing durable media message');
  expect(row).toMatchObject({ tenant_id: tenant.tenant, auth_channel: 'console', status: 'done', attempt: 1 });
  expect(row.body.text).toBe(text);
  expect(row.body.attachments_v1).toEqual(files.map((file) => ({
    kind: file.mimeType.startsWith('image/') ? 'image' : 'document', name: file.name,
    mime_type: file.mimeType, file_size: file.buffer.length, sha256: fileSha256(file.buffer),
    content_base64: file.buffer.toString('base64'),
  })));
  const acknowledgements = await active.database.pool.query<{ status: string; applied: boolean }>(
    'SELECT status,applied FROM delivery_acks WHERE delivery_id=$1 ORDER BY id DESC LIMIT 1', [row.delivery_id],
  );
  expect(acknowledgements.rows).toEqual([{ status: 'done', applied: true }]);
  const captured = (await readFileTurns(adapter)).flatMap((turn) => turn.files);
  for (const file of files) {
    const matching = captured.filter((item) => item.name === file.name);
    expect(matching).toHaveLength(1);
    expect(matching[0]).toMatchObject({ mime_type: file.mimeType, file_size: file.buffer.length,
      sha256: fileSha256(file.buffer), bytes_base64: file.buffer.toString('base64'), mode: 0o600 });
    expect(matching[0]?.local_path.startsWith(adapter.workspace + sep)).toBe(true);
  }
  process.stdout.write(`Media E2E durable: tenant=${tenant.tenant} message=${row.id} delivery=${row.delivery_id} files=${String(files.length)}\n`);
  sent.set(tenant.tenant, { id: row.id, files });
  return row.id;
}

interface ReplyReference { deliveryId: string; attempt: number }
async function binaryRoundtrip(page: BrowserPage, id: string, files: MediaFile[], reply?: ReplyReference): Promise<void> {
  for (const [index, file] of files.entries()) {
    const response = await page.evaluate(async ({ messageId, attachmentIndex, reply }) => {
      const path = reply
        ? `/v3/console/messages/${encodeURIComponent(messageId)}/replies/${encodeURIComponent(reply.deliveryId)}/${String(reply.attempt)}/attachments/${String(attachmentIndex)}`
        : `/v3/console/messages/${encodeURIComponent(messageId)}/attachments/${String(attachmentIndex)}`;
      const result = await fetch(path, { credentials: 'include' });
      const bytes = new Uint8Array(await result.arrayBuffer());
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      return { status: result.status, mime: result.headers.get('content-type')?.split(';')[0], size: bytes.length,
        sha256: [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join(''), bytes: [...bytes] };
    }, { messageId: id, attachmentIndex: index, reply });
    expect(response).toEqual({ status: 200, mime: ['image/svg+xml', 'text/html'].includes(file.mimeType) ? 'application/octet-stream' : file.mimeType, size: file.buffer.length,
      sha256: fileSha256(file.buffer), bytes: [...file.buffer] });
  }
  const payloads = await page.evaluate(async (id) => {
    const list = await fetch('/v3/console/messages', { credentials: 'include' });
    const detail = await fetch(`/v3/console/messages/${encodeURIComponent(id)}`, { credentials: 'include' });
    return { listStatus: list.status, detailStatus: detail.status, list: await list.text(), detail: await detail.text() };
  }, id);
  expect(payloads.listStatus).toBe(200); expect(payloads.detailStatus).toBe(200);
  for (const payload of [payloads.list, payloads.detail]) {
    expect(payload).not.toContain('content_base64');
    for (const file of files) {
      expect(payload).not.toContain(file.buffer.toString('base64'));
    }
  }
  for (const payload of reply ? [payloads.detail] : [payloads.list, payloads.detail]) {
    for (const file of files) {
      expect(payload).toContain(file.name); expect(payload).toContain(fileSha256(file.buffer));
    }
  }
}

async function incomingMedia(tenant: FunctionalTenant, id: string, originals: MediaFile[]): Promise<ReplyReference> {
  const { active, page, adapter } = state(tenant);
  const files = originals.map((file) => ({ ...file, name: `agent-reply-${file.name}` }));
  const captured = await readReplyFiles(adapter);
  for (const file of files) {
    const matching = captured.filter((item) => item.name === file.name);
    expect(matching).toHaveLength(1);
    expect(matching[0]).toMatchObject({ mime_type: file.mimeType, file_size: file.buffer.length,
      sha256: fileSha256(file.buffer), bytes_base64: file.buffer.toString('base64'), mode: 0o600 });
    expect(matching[0]?.local_path.startsWith(adapter.workspace + sep)).toBe(true);
  }
  const durable = await active.database.pool.query<{ id: string; attempt: number; result: unknown }>(
    "SELECT id,attempt,result FROM deliveries WHERE message_id=$1 AND recipient_alias=$2 AND status='done'", [id, tenant.target],
  );
  expect(durable.rows).toHaveLength(1);
  const row = durable.rows[0];
  if (!row) throw new Error('Missing done reply delivery');
  const result = objectRecord(row.result);
  expect(result?.reply_attachments_v1).toEqual(files.map((file) => ({
    kind: file.mimeType.startsWith('image/') ? 'image' : 'document', name: file.name,
    mime_type: file.mimeType, file_size: file.buffer.length, sha256: fileSha256(file.buffer), content_base64: file.buffer.toString('base64'),
  })));
  const ack = await active.database.pool.query<{ payload: unknown }>(
    "SELECT payload FROM delivery_acks WHERE delivery_id=$1 AND applied AND status='done'", [row.id],
  );
  expect(ack.rows).toHaveLength(1);
  const ackJson = JSON.stringify(ack.rows);
  expect(ackJson).not.toContain('content_base64'); expect(ackJson).not.toContain('data:');
  expect(ackJson).not.toContain(adapter.workspace);
  for (const file of files) expect(ackJson).not.toContain(file.buffer.toString('base64'));
  const detail = await page.evaluate(async (messageId) => (await fetch(`/v3/console/messages/${encodeURIComponent(messageId)}`, { credentials: 'include' })).json() as Promise<unknown>, id);
  const message = objectRecord(detail);
  const deliveries = message?.deliveries;
  if (!Array.isArray(deliveries)) throw new Error('Missing canonical reply metadata');
  const projection = deliveries.map(objectRecord).find((delivery) => delivery?.delivery_id === row.id);
  expect(projection?.reply_attachments).toEqual(files.map((file) => ({ name: file.name, mime_type: file.mimeType, file_size: file.buffer.length, sha256: fileSha256(file.buffer) })));
  const deliveryId = projection?.reply_attachment_delivery_id;
  const attempt = projection?.reply_attachment_attempt;
  if (typeof deliveryId !== 'string' || !isRfcUuid(deliveryId) || typeof attempt !== 'number' || !Number.isInteger(attempt) || attempt < 0) throw new Error('Invalid effective canonical attachment reference');
  expect(deliveryId).toBe(row.id); expect(attempt).toBe(row.attempt);
  const reference = { deliveryId, attempt };
  await binaryRoundtrip(page, id, files, reference);
  const stale = await page.evaluate(async ({ messageId, reference, foreignDeliveryId }) => {
    const paths = [
      `/v3/console/messages/${encodeURIComponent(messageId)}/replies/${encodeURIComponent(reference.deliveryId)}/${String(reference.attempt + 1)}/attachments/0`,
      `/v3/console/messages/${encodeURIComponent(messageId)}/replies/${foreignDeliveryId}/${String(reference.attempt)}/attachments/0`,
    ];
    return Promise.all(paths.map(async (path) => (await fetch(path, { credentials: 'include' })).status));
  }, { messageId: id, reference, foreignDeliveryId: randomUUID() });
  expect(stale).toEqual([404, 404]);
  const bubble = page.locator(`.transcript-entry.output[data-reply-to="${id}"] .canonical-reply[data-delivery-id="${row.id}"]`);
  await bubble.waitFor({ timeout: 20_000 });
  expect(await bubble.locator('li.chat-message-file').count()).toBe(files.length);
  for (const file of files) expect(await bubble.getByText(file.name, { exact: true }).count()).toBe(1);
  await previewMedia(page, files);
  process.stdout.write(`Media E2E incoming: message=${id} delivery=${deliveryId} attempt=${String(attempt)} files=${String(files.length)} providerReply=null\n`);
  return reference;
}

async function previewMedia(page: BrowserPage, files: MediaFile[]): Promise<void> {
  const image = files.find((file) => file.mimeType === 'image/png');
  if (!image) throw new Error('Missing owned raster image');
  const imageRow = page.locator(`li.chat-message-file:has(strong:text-is(${JSON.stringify(image.name)}))`);
  await imageRow.getByRole('button', { name: 'Vista previa', exact: true }).click();
  await page.getByRole('dialog', { name: `Vista previa: ${image.name}`, exact: true }).waitFor({ timeout: 10_000 });
  await expect.poll(() => page.evaluate((name) => {
    const element = Array.from(document.images).find((item) => item.alt === name);
    return element?.complete === true && element.naturalWidth === 32 && element.naturalHeight === 32;
  }, image.name), { timeout: 10_000, interval: 100 }).toBe(true);
  await page.getByRole('button', { name: 'Cerrar vista previa', exact: true }).click();
  for (const file of files.filter((item) => item.mimeType.startsWith('audio/') || item.mimeType.startsWith('video/'))) {
    const row = page.locator(`li.chat-message-file:has(strong:text-is(${JSON.stringify(file.name)}))`);
    await row.getByRole('button', { name: 'Cargar reproductor', exact: true }).click();
    const player = file.mimeType.startsWith('audio/') ? 'audio' : 'video';
    await row.locator(`${player}[controls][src^="blob:"]`).waitFor({ state: 'visible', timeout: 10_000 });
    const played = await page.evaluate(async (name) => {
      const media = Array.from(document.querySelectorAll<HTMLMediaElement>('audio,video'))
        .find((element) => element.getAttribute('aria-label')?.endsWith(name));
      if (!media || !media.controls || !media.src.startsWith('blob:')) throw new Error('Missing native playback controls');
      media.muted = true;
      await media.play();
      return { controls: media.controls, tag: media.tagName };
    }, file.name);
    expect(played).toEqual({ controls: true, tag: file.mimeType.startsWith('audio/') ? 'AUDIO' : 'VIDEO' });
    await expect.poll(() => page.evaluate((name) => Array.from(document.querySelectorAll<HTMLMediaElement>('audio,video'))
      .some((media) => media.getAttribute('aria-label')?.endsWith(name) && media.currentTime > 0 && media.error === null), file.name),
    { timeout: 10_000, interval: 100 }).toBe(true);
  }
}

async function switchAccount(page: BrowserPage, tenant: FunctionalTenant): Promise<void> {
  await page.getByRole('button', { name: /^Cuenta de /u }).click();
  await page.getByRole('button', { name: 'Cambiar cuenta', exact: true }).click();
  await page.getByRole('button', { name: 'Cerrar sesión y continuar', exact: true }).click();
  await login(page, tenant);
}

interface DownloadPage extends BrowserPage {
  waitForEvent(event: 'download', options: { timeout: number }): Promise<{ suggestedFilename(): string }>;
}

describe('Multimedia durable con Chromium, PG y SDK reales y proveedor CLI sintético', () => {
  it('envía imagen, WAV y WebM en escritorio y reproduce bytes autenticados después de recargar', async () => {
    const { page } = state(isaTenant);
    const files = await generatedMedia(page, `isa-${randomUUID()}`);
    const id = await publishMedia(isaTenant, files, 'Multimedia sintética propia');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByText(files[0]?.name ?? '', { exact: true }).waitFor({ timeout: 20_000 });
    await binaryRoundtrip(page, id, files);
    await previewMedia(page, files);
    incoming = await incomingMedia(isaTenant, id, files);
  }, 180_000);

  it('mantiene SVG y HTML como descargas en móvil y niega binarios y metadata de otro tenant', async () => {
    const { page } = state(jhonTenant);
    const files = passiveDocuments(`jhon-${randomUUID()}`);
    const id = await publishMedia(jhonTenant, files, '');
    await page.getByText(files[0]?.name ?? '', { exact: true }).waitFor({ timeout: 20_000 });
    await binaryRoundtrip(page, id, files);
    for (const file of files) {
      const row = page.locator(`li.chat-message-file:has(strong:text-is(${JSON.stringify(file.name)}))`);
      expect(await row.getByRole('button', { name: 'Vista previa', exact: true }).count()).toBe(0);
      expect(await row.locator('img,audio,video,iframe,object,embed').count()).toBe(0);
      const download = (page as DownloadPage).waitForEvent('download', { timeout: 10_000 });
      await row.getByRole('button', { name: 'Descargar', exact: true }).click();
      expect((await download).suggestedFilename()).toBe(file.name);
    }
    const foreign = sent.get(isaTenant.tenant);
    if (!foreign) throw new Error('Missing first media message');
    const denied = await page.evaluate(async (id) => {
      const binary = await fetch(`/v3/console/messages/${encodeURIComponent(id)}/attachments/0`, { credentials: 'include' });
      const detail = await fetch(`/v3/console/messages/${encodeURIComponent(id)}`, { credentials: 'include' });
      const list = await fetch('/v3/console/messages', { credentials: 'include' });
      return { binaryStatus: binary.status, detailStatus: detail.status, bodies: [await binary.text(), await detail.text(), await list.text()] };
    }, foreign.id);
    expect(denied.binaryStatus).toBe(404); expect(denied.detailStatus).toBe(404);
    if (!secondHuman) throw new Error('Missing same-tenant second human');
    const crossHuman = await secondHuman.evaluate(async (id) => {
      const binary = await fetch(`/v3/console/messages/${encodeURIComponent(id)}/attachments/0`, { credentials: 'include' });
      const detail = await fetch(`/v3/console/messages/${encodeURIComponent(id)}`, { credentials: 'include' });
      return { status: binary.status, detailStatus: detail.status, bodies: [await binary.text(), await detail.text()] };
    }, foreign.id);
    expect(crossHuman.status).toBe(404); expect(crossHuman.detailStatus).toBe(404);
    if (!incoming) throw new Error('Missing incoming reply reference');
    for (const actor of [page, secondHuman]) {
      const response = await actor.evaluate(async ({ id, reference }) => {
        const result = await fetch(`/v3/console/messages/${encodeURIComponent(id)}/replies/${encodeURIComponent(reference.deliveryId)}/${String(reference.attempt)}/attachments/0`, { credentials: 'include' });
        return { status: result.status, body: await result.text() };
      }, { id: foreign.id, reference: incoming });
      expect(response.status).toBe(404);
      expect(response.body).not.toContain(foreign.id);
      for (const file of foreign.files) expect(response.body).not.toContain(file.buffer.toString('base64'));
    }
    denied.bodies.push(...crossHuman.bodies);
    for (const body of denied.bodies) for (const file of foreign.files) {
      expect(body).not.toContain(file.name); expect(body).not.toContain(fileSha256(file.buffer));
      expect(body).not.toContain(file.buffer.toString('base64'));
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  }, 180_000);

  it('el cambio de identidad retira reproductores y revoca sus URLs sin adoptar multimedia ajena', async () => {
    const { page } = state(isaTenant);
    const foreign = sent.get(isaTenant.tenant);
    if (!foreign) throw new Error('Missing loaded media');
    const urls = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLMediaElement>('audio,video')).map((media) => media.src));
    expect(urls).toHaveLength(4);
    await switchAccount(page, jhonTenant);
    expect(await page.locator('audio,video,.chat-media-dialog').count()).toBe(0);
    const retained = await page.evaluate(async (urls) => Promise.all(urls.map(async (url) => {
      try { const response = await fetch(url); return response.ok; } catch { return false; }
    })), urls);
    expect(retained).toEqual([false, false, false, false]);
    const denied = await page.evaluate(async (id) => (await fetch(`/v3/console/messages/${encodeURIComponent(id)}/attachments/0`, { credentials: 'include' })).status, foreign.id);
    expect(denied).toBe(404);
  }, 180_000);
});
