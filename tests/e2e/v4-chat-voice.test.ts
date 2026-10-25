import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_ATTACHMENTS_TOTAL_BYTES } from '../../packages/protocol/src/attachment-limits.js';
import { isaTenant, startConsoleFunctionalFixture, type BrowserContext } from './console-functional-browser.fixtures.js';
import { observeUiBootstrap } from './ui-bootstrap-diagnostics.js';
import { apiGet, asV4Page, login, type V4Page } from './v4-console-real-browser.helpers.js';
import { startVoiceBrowser } from './v4-chat-voice.fixtures.js';

const receipts = join(process.cwd(), '.delegados/v4/recibos/e2e-a6-chat-1025b');
const prefix = 'zz-canary-e2e-a6-chat-1025b-voice';
let fixture: Awaited<ReturnType<typeof startConsoleFunctionalFixture>> | undefined;
let voice: Awaited<ReturnType<typeof startVoiceBrowser>> | undefined;
const pageErrors: string[] = [];
const bootstrapDiagnostics: { width: number; elapsedMs: number; success: boolean }[] = [];
interface RecordedAudio { bytes: number[]; duration: number; sampleRate: number; channels: number; peak: number }
interface DurableAttachment { name: string; mime_type: string; file_size: number; sha256: string; content_base64: string }

beforeAll(async () => {
  if (process.env.CAUCE_TEST_DATABASE_URL) throw new Error('Voice E2E requires isolated Testcontainers PostgreSQL');
  await mkdir(receipts, { recursive: true });
  fixture = await startConsoleFunctionalFixture();
  await fixture.database.pool.query(
    "INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES ($1,$2,$3,'agent')", [isaTenant.tenant, isaTenant.room, isaTenant.target]);
  voice = await startVoiceBrowser(fixture, receipts);
  console.info(JSON.stringify({ owner: prefix, syntheticTenantsOnly: true,
    postgres: fixture.database.container.getId(), browser: fixture.browserContainer }));
}, 10 * 60_000);

afterAll(async () => {
  const errors: unknown[] = [];
  try { await writeFile(join(receipts, 'voice-bootstrap.json'), JSON.stringify(bootstrapDiagnostics, null, 2)); }
  catch (error) { errors.push(error); }
  try { await voice?.close(); } catch (error) { errors.push(error); }
  try { await fixture?.close(); } catch (error) { errors.push(error); }
  if (errors.length > 0) throw new AggregateError(errors, 'Voice fixture cleanup was incomplete');
});

async function conversation(width: number): Promise<V4Page> {
  if (!fixture || !voice) throw new Error('Missing voice fixture');
  const context = await voice.browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 },
    ignoreHTTPSErrors: false, serviceWorkers: 'block' });
  fixture.contexts.push(context);
  await (context as BrowserContext & { grantPermissions(permissions: string[], options: { origin: string }): Promise<void> })
    .grantPermissions(['microphone'], { origin: fixture.baseUrl });
  const page = asV4Page(await context.newPage());
  (page as V4Page & { setDefaultNavigationTimeout(timeout: number): void }).setDefaultNavigationTimeout(90_000);
  observeUiBootstrap(page);
  page.on('pageerror', (error) => { pageErrors.push(error instanceof Error ? error.message : String(error)); });
  const started = performance.now();
  let success = false;
  try {
    await login(page, fixture.baseUrl, {
      email: isaTenant.email, password: isaTenant.password, name: 'Canary', company: { name: 'Canary', slug: 'canary' },
    });
    success = true;
  } finally { bootstrapDiagnostics.push({ width, elapsedMs: Math.round(performance.now() - started), success }); }
  await page.goto(`${fixture.baseUrl}/messages/${isaTenant.tenant}/${isaTenant.target}`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel(`Mensaje para ${isaTenant.target}`, { exact: true }).waitFor({ timeout: 20_000 });
  const capture = await page.evaluate(async () => ({ secure: isSecureContext,
    audioInputs: (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === 'audioinput').length,
    opus: MediaRecorder.isTypeSupported('audio/webm;codecs=opus') }));
  expect(capture.secure).toBe(true); expect(capture.audioInputs).toBeGreaterThan(0); expect(capture.opus).toBe(true);
  return page;
}

async function selectedAudio(page: V4Page): Promise<RecordedAudio> {
  await page.getByLabel('Vista previa de nota-de-voz.webm', { exact: true }).waitFor({ timeout: 20_000 });
  return page.evaluate(async () => {
    const audio = document.querySelector<HTMLAudioElement>('ul[aria-label="Archivos adjuntos"] audio');
    if (!audio?.src.startsWith('blob:')) throw new Error('Missing native recorder preview Blob');
    const response = await fetch(audio.src);
    if (!response.ok) throw new Error('Native recorder preview Blob could not be read');
    const bytes = await response.arrayBuffer();
    const context = new AudioContext();
    try {
      const decoded = await context.decodeAudioData(bytes.slice(0));
      let peak = 0;
      for (const sample of decoded.getChannelData(0)) peak = Math.max(peak, Math.abs(sample));
      return { bytes: [...new Uint8Array(bytes)], duration: decoded.duration,
        sampleRate: decoded.sampleRate, channels: decoded.numberOfChannels, peak };
    } finally { await context.close(); }
  });
}

async function persistedVoice(page: V4Page, text: string, recorded: RecordedAudio, width: number): Promise<void> {
  if (!fixture) throw new Error('Missing voice fixture');
  await page.getByLabel(`Mensaje para ${isaTenant.target}`, { exact: true }).fill(text);
  await page.getByRole('button', { name: 'Enviar', exact: true }).click();
  const rows = () => fixture?.database.pool.query<{ id: string; body: { attachments_v1: DurableAttachment[] }; recipient_alias: string }>(
    `SELECT m.id,m.body,d.recipient_alias FROM messages m JOIN deliveries d ON d.message_id=m.id
     WHERE m.tenant_id=$1 AND m.body->>'text'=$2`, [isaTenant.tenant, text]);
  await expect.poll(async () => (await rows())?.rowCount, { timeout: 20_000 }).toBe(1);
  const message = (await rows())?.rows[0];
  if (!message) throw new Error('Voice message was not persisted');
  const bytes = Buffer.from(recorded.bytes);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  expect(message.recipient_alias).toBe(isaTenant.target);
  expect(message.body.attachments_v1).toHaveLength(1);
  expect(message.body.attachments_v1[0]).toMatchObject({ name: 'nota-de-voz.webm', mime_type: 'audio/webm',
    file_size: bytes.length, sha256, content_base64: bytes.toString('base64') });
  const downloaded = await page.evaluate(async (id) => {
    const response = await fetch(`/v3/console/messages/${id}/attachments/0`, { credentials: 'include' });
    return { status: response.status, mime: response.headers.get('content-type')?.split(';')[0],
      bytes: [...new Uint8Array(await response.arrayBuffer())] };
  }, message.id);
  expect(downloaded).toEqual({ status: 200, mime: 'audio/webm', bytes: recorded.bytes });
  expect((await apiGet(page, `/v3/console/messages/${message.id}`)).status).toBe(200);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator(`article[data-direction="input"][data-message-id="${message.id}"]`).waitFor({ timeout: 20_000 });
  expect(await page.getByRole('list', { name: 'Archivos adjuntos', exact: true }).count()).toBe(0);
  await page.screenshot({ path: join(receipts, `voice-persisted-${String(width)}.png`) });
  await writeFile(join(receipts, `voice-recorded-${String(width)}.webm`), bytes, { mode: 0o600 });
  await writeFile(join(receipts, `voice-persisted-${String(width)}.json`), JSON.stringify({ messageId: message.id,
    byteLength: bytes.length, sha256, duration: recorded.duration, channels: recorded.channels,
    sampleRate: recorded.sampleRate, peak: recorded.peak, sqlAndHttpBytesEqual: true, syntheticDevice: true }, null, 2));
}

describe('Chat V4: captura nativa de notas de voz', () => {
  it('graba audio real del dispositivo sintético, muestra duración y persiste los mismos bytes al finalizar y enviar en escritorio y móvil', async () => {
    for (const width of [1440, 390]) {
      const page = await conversation(width);
      await page.getByRole('button', { name: 'Grabar nota de voz', exact: true }).click();
      await page.getByRole('button', { name: 'Finalizar nota de voz', exact: true }).waitFor({ timeout: 20_000 });
      await expect.poll(async () => page.getByRole('timer').innerText(), { timeout: 10_000 }).toMatch(/^00:0[2-9]$/u);
      expect(await page.getByRole('button', { name: 'Enviar', exact: true }).isDisabled()).toBe(true);
      expect(await page.getByRole('button', { name: 'Adjuntar archivos', exact: true }).isDisabled()).toBe(true);
      await page.screenshot({ path: join(receipts, `voice-recording-${String(width)}.png`) });
      await page.getByRole('button', { name: 'Finalizar nota de voz', exact: true }).click();
      const recorded = await selectedAudio(page);
      expect(recorded.bytes.length).toBeGreaterThan(0);
      expect(recorded.duration).toBeGreaterThanOrEqual(1.5);
      expect(recorded.channels).toBeGreaterThan(0);
      expect(recorded.peak).toBeGreaterThan(0.001);
      expect(await page.getByRole('timer').count()).toBe(0);
      expect(await page.getByRole('button', { name: 'Enviar', exact: true }).isDisabled()).toBe(false);
      await page.screenshot({ path: join(receipts, `voice-finished-${String(width)}.png`) });
      await persistedVoice(page, `${prefix}-${String(width)}-${randomUUID()}`, recorded, width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
      expect(pageErrors).toEqual([]);
    }
  }, 180_000);

  it('cancela la captura sin adjuntar ni publicar y permite grabar de nuevo en escritorio y móvil', async () => {
    if (!fixture) throw new Error('Missing voice fixture');
    for (const width of [1440, 390]) {
      const page = await conversation(width);
      const text = `${prefix}-cancel-${randomUUID()}`;
      await page.getByLabel(`Mensaje para ${isaTenant.target}`, { exact: true }).fill(text);
      await page.getByRole('button', { name: 'Grabar nota de voz', exact: true }).click();
      await page.getByRole('timer').waitFor({ timeout: 20_000 });
      await expect.poll(async () => page.getByRole('timer').innerText(), { timeout: 10_000 }).toMatch(/^00:0[1-9]$/u);
      await page.getByRole('button', { name: 'Cancelar grabación', exact: true }).click();
      expect(await page.getByRole('timer').count()).toBe(0);
      expect(await page.getByRole('list', { name: 'Archivos adjuntos', exact: true }).count()).toBe(0);
      expect(await page.getByLabel(`Mensaje para ${isaTenant.target}`, { exact: true }).inputValue()).toBe(text);
      expect((await fixture.database.pool.query("SELECT id FROM messages WHERE body->>'text'=$1", [text])).rowCount).toBe(0);
      await page.getByRole('button', { name: 'Grabar nota de voz', exact: true }).click();
      await page.getByRole('timer').waitFor({ timeout: 20_000 });
      await expect.poll(async () => page.getByRole('timer').innerText(), { timeout: 10_000 }).toMatch(/^00:0[1-9]$/u);
      await page.getByRole('button', { name: 'Finalizar nota de voz', exact: true }).click();
      expect((await selectedAudio(page)).bytes.length).toBeGreaterThan(0);
      await page.getByRole('button', { name: 'Quitar nota-de-voz.webm', exact: true }).click();
      expect(await page.getByRole('list', { name: 'Archivos adjuntos', exact: true }).count()).toBe(0);
      await page.screenshot({ path: join(receipts, `voice-cancelled-${String(width)}.png`) });
      expect(pageErrors).toEqual([]);
    }
  }, 120_000);

  it('respeta el espacio restante con tiempo real y deshabilita el micrófono cuando no queda presupuesto', async () => {
    const page = await conversation(390);
    const input = page.locator('input[type="file"]') as unknown as {
      setInputFiles(files: { name: string; mimeType: string; buffer: Buffer }[]): Promise<void>;
    };
    const remainingBytes = 16_000;
    const name = `${prefix}-budget.bin`;
    await input.setInputFiles([{ name, mimeType: 'application/octet-stream', buffer: Buffer.alloc(MAX_ATTACHMENTS_TOTAL_BYTES - remainingBytes, 97) }]);
    await page.getByRole('button', { name: `Quitar ${name}`, exact: true }).waitFor();
    await page.getByRole('button', { name: 'Grabar nota de voz', exact: true }).click();
    await page.getByRole('timer').waitFor({ timeout: 20_000 });
    await page.screenshot({ path: join(receipts, 'voice-budget-recording-390.png') });
    await page.getByRole('timer').waitFor({ state: 'hidden', timeout: 10_000 });
    const audio = await page.getByLabel('Vista previa de nota-de-voz.webm', { exact: true }).count();
    let outcome: 'duration-stop' | 'byte-budget-stop';
    if (audio === 1) {
      const recording = await selectedAudio(page);
      expect(recording.bytes.length).toBeLessThanOrEqual(remainingBytes);
      expect(recording.duration).toBeGreaterThan(0);
      expect(recording.duration).toBeLessThan(8);
      outcome = 'duration-stop';
      await page.getByRole('button', { name: 'Quitar nota-de-voz.webm', exact: true }).click();
    } else {
      await page.getByRole('alert').getByText('La nota de voz alcanzó el espacio disponible.', { exact: true }).waitFor();
      outcome = 'byte-budget-stop';
    }
    await page.screenshot({ path: join(receipts, 'voice-budget-stopped-390.png') });
    await page.getByRole('button', { name: `Quitar ${name}`, exact: true }).click();
    await input.setInputFiles([{ name, mimeType: 'application/octet-stream', buffer: Buffer.alloc(MAX_ATTACHMENTS_TOTAL_BYTES, 97) }]);
    const microphone = page.getByRole('button', { name: 'Grabar nota de voz', exact: true });
    expect(await microphone.isDisabled()).toBe(true);
    expect(await microphone.evaluate((element) => element.getAttribute('title'))).toBe('No queda espacio para adjuntar audio.');
    await page.screenshot({ path: join(receipts, 'voice-budget-full-390.png') });
    await writeFile(join(receipts, 'voice-budget.json'), JSON.stringify({ remainingBytes,
      expectedDurationBudgetMs: 4_000, outcome, fullBudgetDisabled: true, wallClockUnmodified: true }, null, 2));
    await page.getByRole('button', { name: `Quitar ${name}`, exact: true }).click();
    expect(await microphone.isDisabled()).toBe(false);
    expect(pageErrors).toEqual([]);
  }, 90_000);
});
