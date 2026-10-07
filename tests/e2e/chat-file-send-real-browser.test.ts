import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sep } from 'node:path';
import { browserDeliveryFailure } from './browser-delivery-diagnostics.js';
import {
  functionalTenants, isaTenant, jhonTenant, newTrustedPage, startConsoleFunctionalFixture,
  type BrowserPage, type FunctionalTenant, type Locator,
} from './console-functional-browser.fixtures.js';
import { fileSha256, readFileTurns, startFileAdapter, type FileAdapter } from './chat-file-send-real-browser.fixtures.js';

interface FileInput extends Locator {
  setInputFiles(files: { name: string; mimeType: string; buffer: Buffer }[]): Promise<void>;
}
interface ValueInput extends Locator { inputValue(): Promise<string> }
interface FileChooserPage extends BrowserPage {
  waitForEvent(event: 'filechooser', options: { timeout: number }): Promise<unknown>;
}
interface TestFile { name: string; mimeType: string; buffer: Buffer }
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
const adapters = new Map<string, FileAdapter>();
const sent = new Map<string, { id: string; filename: string; sha256: string; base64: string }>();

async function login(page: BrowserPage, tenant: FunctionalTenant): Promise<void> {
  await page.getByLabel('Correo').waitFor({ timeout: 15_000 });
  await page.getByLabel('Correo').fill(tenant.email);
  await page.getByLabel('Contraseña').fill(tenant.password);
  await page.getByRole('button', { name: 'Iniciar sesión' }).click();
  await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).locator('a[href="/messages"], a[href^="/messages/"]').waitFor({ state: 'visible', timeout: 20_000 });
}

async function createMembership(page: BrowserPage, tenant: FunctionalTenant, active: Fixture): Promise<void> {
  await page.goto(`${active.baseUrl}/config`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('tab', { name: 'Espacios y salas', exact: true }).click();
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
  process.stdout.write(`File E2E owned resources: postgres=${active.database.container.getId()} browser=${active.browserContainer} image=${active.browserRuntime.image} imageId=${active.browserRuntime.imageId}\n`);
  for (const tenant of functionalTenants) {
    const page = await newTrustedPage(active, { width: tenant === isaTenant ? 1440 : 360, height: 900 });
    pages.set(tenant.tenant, page);
    await page.goto(active.baseUrl, { waitUntil: 'domcontentloaded' });
    await login(page, tenant);
    await createMembership(page, tenant, active);
    adapters.set(tenant.tenant, await startFileAdapter(active, tenant));
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
}, 10 * 60_000);

afterAll(async () => { await fixture?.close(); });

function state(tenant: FunctionalTenant) {
  const page = pages.get(tenant.tenant);
  const adapter = adapters.get(tenant.tenant);
  if (!fixture || !page || !adapter) throw new Error('File E2E setup is incomplete');
  return { active: fixture, page, adapter };
}

async function selectFile(page: BrowserPage, file: TestFile): Promise<void> {
  const trigger = page.getByRole('button', { name: 'Adjuntar archivos', exact: true });
  await trigger.waitFor({ state: 'visible' });
  const chooser = (page as FileChooserPage).waitForEvent('filechooser', { timeout: 10_000 });
  await trigger.click();
  await chooser;
  const input = page.locator('input[type="file"]') as FileInput;
  await input.setInputFiles([file]);
  await page.getByText(file.name, { exact: true }).waitFor({ state: 'visible', timeout: 10_000 });
}

async function publishFile(tenant: FunctionalTenant, file: TestFile, text: string): Promise<void> {
  const { active, page, adapter } = state(tenant);
  await page.goto(`${active.baseUrl}/messages/${tenant.tenant}/${tenant.target}`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel(`Mensaje para ${tenant.target}`).waitFor({ state: 'visible', timeout: 20_000 });
  await selectFile(page, file);
  if (text.length > 0) await page.getByLabel(`Mensaje para ${tenant.target}`).fill(text);
  await page.getByRole('button', { name: 'Enviar', exact: true }).click();
  const records = () => active.database.pool.query<MessageRow>(
    `SELECT m.id,m.tenant_id,m.auth_channel,m.body,d.id AS delivery_id,d.status,d.attempt
       FROM messages m JOIN deliveries d ON d.message_id=m.id
      WHERE m.tenant_id=$1 AND d.recipient_alias=$2 AND m.body->'attachments_v1'->0->>'name'=$3`,
    [tenant.tenant, tenant.target, file.name],
  );
  try {
    await expect.poll(async () => (await records()).rows[0]?.status,
      { timeout: 35_000, interval: 100 }).toBe('done');
  } catch (cause) {
    throw await browserDeliveryFailure(cause, {
      pool: active.database.pool, tenant, instanceId: `file-e2e-${tenant.tenant.toLowerCase()}`,
      selector: { kind: 'filename', value: file.name },
      stdout: active.prompts[`${tenant.tenant}:stdout`] ?? '', stderr: active.prompts[`${tenant.tenant}:stderr`] ?? '',
      child: active.adapters[functionalTenants.indexOf(tenant)],
    });
  }
  const persisted = (await records()).rows;
  expect(persisted).toHaveLength(1);
  const row = persisted[0];
  if (!row) throw new Error('No durable attachment message');
  const sha256 = fileSha256(file.buffer);
  const base64 = file.buffer.toString('base64');
  expect(row).toMatchObject({ tenant_id: tenant.tenant, auth_channel: 'console', status: 'done', attempt: 1 });
  expect(row.body.text).toBe(text);
  expect(row.body.attachments_v1).toEqual([{
    kind: 'document', name: file.name, mime_type: file.mimeType, file_size: file.buffer.length,
    sha256, content_base64: base64,
  }]);
  const acknowledgements = await active.database.pool.query<{ status: string; applied: boolean }>(
    'SELECT status,applied FROM delivery_acks WHERE delivery_id=$1 ORDER BY id DESC LIMIT 1', [row.delivery_id],
  );
  expect(acknowledgements.rows).toEqual([{ status: 'done', applied: true }]);
  const turns = await readFileTurns(adapter);
  const files = turns.flatMap((turn) => turn.files).filter((item) => item.name === file.name);
  expect(files).toHaveLength(1);
  expect(files[0]).toMatchObject({ name: file.name, mime_type: file.mimeType, file_size: file.buffer.length,
    sha256, bytes_base64: base64, mode: 0o600 });
  expect(files[0]?.local_path.startsWith(adapter.workspace + sep)).toBe(true);
  expect(Buffer.from(files[0]?.bytes_base64 ?? '', 'base64')).toEqual(file.buffer);
  const rendered = page.locator(`article[data-direction="input"][data-message-id="${row.id}"]`).filter({ hasText: file.name });
  await rendered.getByRole('list', { name: 'Archivos del mensaje' }).waitFor({ timeout: 20_000 });
  expect(await rendered.count()).toBe(1);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await rendered.getByRole('list', { name: 'Archivos del mensaje' }).waitFor({ timeout: 20_000 });
  const api = await page.evaluate(async (id) => {
    const list = await fetch('/v3/console/messages', { credentials: 'include' });
    const detail = await fetch(`/v3/console/messages/${encodeURIComponent(id)}`, { credentials: 'include' });
    return { listStatus: list.status, detailStatus: detail.status, list: await list.text(), detail: await detail.text() };
  }, row.id);
  expect(api.listStatus).toBe(200);
  expect(api.detailStatus).toBe(200);
  for (const payload of [api.list, api.detail]) {
    expect(payload).toContain(file.name);
    expect(payload).toContain(sha256);
    expect(payload).not.toContain('content_base64');
    expect(payload).not.toContain(base64);
  }
  expect(await rendered.innerText()).not.toContain(base64);
  await rendered.getByRole('button', { name: 'Opciones del mensaje', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Ver detalle', exact: true }).click();
  const detail = page.getByRole('group', { name: 'Detalle del mensaje seleccionado', exact: true });
  await detail.waitFor({ timeout: 10_000 });
  expect(await detail.innerText()).not.toContain(base64);
  expect(await detail.innerText()).not.toContain('content_base64');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  sent.set(tenant.tenant, { id: row.id, filename: file.name, sha256, base64 });
}

async function switchAccount(page: BrowserPage, tenant: FunctionalTenant): Promise<void> {
  await page.getByRole('button', { name: /^Cuenta de /u }).click();
  await page.getByRole('button', { name: 'Cambiar cuenta', exact: true }).click();
  await page.getByRole('button', { name: 'Cerrar sesión y continuar', exact: true }).click();
  await login(page, tenant);
}

describe('Archivos de chat mediante UI, PostgreSQL y SDK reales con harness sintético', () => {
  it('envía archivo y texto en escritorio, materializa los bytes y conserva sólo metadata al recargar', async () => {
    const id = randomUUID();
    await publishFile(isaTenant, { name: `isa-${id}.txt`, mimeType: 'text/plain', buffer: Buffer.from(`Contenido sintético Isa ${id}\n`, 'utf8') }, `Archivo y texto ${id}`);
  }, 180_000);

  it('envía sólo archivo a360px sin duplicarlo y niega el detalle del otro tenant', async () => {
    const id = randomUUID();
    await publishFile(jhonTenant, { name: `jhon-${id}.bin`, mimeType: 'application/octet-stream', buffer: Buffer.from([0, 1, 255, 13, 10, 88, 99]) }, '');
    const own = state(jhonTenant);
    const foreign = sent.get(isaTenant.tenant);
    if (!foreign) throw new Error('Missing first tenant attachment');
    const visibility = await own.page.evaluate(async (id) => {
      const detail = await fetch(`/v3/console/messages/${encodeURIComponent(id)}`, { credentials: 'include' });
      const list = await fetch('/v3/console/messages', { credentials: 'include' });
      return { status: detail.status, detail: await detail.text(), list: await list.text() };
    }, foreign.id);
    expect(visibility.status).toBe(404);
    for (const response of [visibility.detail, visibility.list]) {
      expect(response).not.toContain(foreign.id);
      expect(response).not.toContain(foreign.filename);
      expect(response).not.toContain(foreign.sha256);
      expect(response).not.toContain(foreign.base64);
    }
  }, 180_000);

  it('descarta selección y borrador al cambiar de identidad sin publicar el archivo ajeno', async () => {
    const { active, page } = state(isaTenant);
    await page.goto(`${active.baseUrl}/messages/${isaTenant.tenant}/${isaTenant.target}`, { waitUntil: 'domcontentloaded' });
    const draft = `UNSENT-${randomUUID()}`;
    const name = `borrador-${randomUUID()}.txt`;
    await selectFile(page, { name, mimeType: 'text/plain', buffer: Buffer.from(draft) });
    await page.getByLabel(`Mensaje para ${isaTenant.target}`).fill(draft);
    expect(await state(jhonTenant).page.getByText(name, { exact: true }).count()).toBe(0);
    await switchAccount(page, jhonTenant);
    await page.goto(`${active.baseUrl}/messages/${jhonTenant.tenant}/${jhonTenant.target}`, { waitUntil: 'domcontentloaded' });
    const editor = page.getByLabel(`Mensaje para ${jhonTenant.target}`) as ValueInput;
    await editor.waitFor({ timeout: 20_000 });
    expect(await editor.inputValue()).toBe('');
    expect(await page.getByText(name, { exact: true }).count()).toBe(0);
    const unpublished = await active.database.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM messages WHERE body->>'text'=$1 OR body->'attachments_v1'->0->>'name'=$2", [draft, name],
    );
    expect(unpublished.rows).toEqual([{ count: '0' }]);
  }, 180_000);
});
