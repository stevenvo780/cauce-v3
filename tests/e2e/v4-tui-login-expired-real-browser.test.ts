import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { apiGet, asV4Page, type V4Page } from './v4-console-real-browser.helpers.js';
import { evidence, runId, startLoginCanary } from './v4-tui-login-expired-real-browser.fixtures.js';

const message = 'La sesión del proveedor caducó: vuelve a iniciar sesión';
type Canary = Awaited<ReturnType<typeof startLoginCanary>>;
interface Ack { delivery_id: string; error_code: string; retryable: boolean; created_at: string; attempt: number }
async function capture(page: V4Page, name: string): Promise<void> {
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.screenshot({ path: join(evidence, `${name}-${String(width)}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}
async function publish(page: V4Page, runtime: Canary, text: string): Promise<{ message_id: string; delivery_id: string }> {
  await page.getByLabel(`Mensaje para ${runtime.alias}`, { exact: true }).fill(text);
  await page.getByRole('button', { name: 'Enviar', exact: true }).click();
  const rows = () => runtime.database.pool.query<{ message_id: string; delivery_id: string }>(
    `SELECT m.id::text AS message_id,d.id::text AS delivery_id FROM messages m JOIN deliveries d ON d.message_id=m.id
     WHERE m.tenant_id='Steven' AND m.body->>'text'=$1 AND d.recipient_alias=$2`, [text, runtime.alias]);
  await expect.poll(async () => (await rows()).rowCount, { timeout: 20_000 }).toBe(1);
  const row = (await rows()).rows[0];
  if (!row) throw new Error('console publication omitted its durable delivery');
  return row;
}
async function failedLogin(runtime: Canary, delivery: string): Promise<Ack> {
  let ack: Ack | undefined;
  await expect.poll(async () => {
    ack = (await runtime.database.pool.query<Ack>(`SELECT delivery_id::text,payload->>'error_code' AS error_code,
      (payload->>'retryable')::boolean AS retryable,created_at::text,attempt FROM delivery_acks
      WHERE delivery_id=$1 AND applied AND status='failed' ORDER BY id LIMIT 1`, [delivery])).rows[0];
    return ack?.error_code;
  }, { timeout: 55_000, interval: 200 }).toBe('PROVIDER_LOGIN_REQUIRED');
  if (!ack) throw new Error('real SDK omitted the applied login failure');
  expect(ack.retryable).toBe(true);
  return ack;
}
async function done(runtime: Canary, delivery: string): Promise<void> {
  await expect.poll(async () => (await runtime.database.pool.query<{ status: string }>('SELECT status FROM deliveries WHERE id=$1', [delivery])).rows[0]?.status,
    { timeout: 60_000, interval: 250 }).toBe('done');
}
async function terminal(runtime: Canary, delivery: string): Promise<string> {
  let status: string | undefined;
  await expect.poll(async () => {
    status = (await runtime.database.pool.query<{ status: string }>('SELECT status FROM deliveries WHERE id=$1', [delivery])).rows[0]?.status;
    return status !== undefined && ['done', 'dead', 'failed'].includes(status);
  }, { timeout: 60_000, interval: 250 }).toBe(true);
  if (!status) throw new Error('delivery disappeared before its natural terminal state');
  return status;
}

it('termina rápido ante login caducado, lo explica y procesa la siguiente entrega sana', async () => {
  const runtime = await startLoginCanary();
  let failedPage: V4Page | undefined;
  const observed: Record<string, unknown> = { run_id: runId, provider: 'authorized TUI double', adapter: 'real SDK', image: runtime.image };
  try {
    const page = asV4Page(await runtime.page(1440));
    failedPage = page;
    await page.goto(runtime.baseUrl, { waitUntil: 'domcontentloaded' });
    await page.getByLabel('Correo', { exact: true }).fill(runtime.email);
    await page.getByLabel('Contraseña', { exact: true }).fill(runtime.password);
    await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
    await expect.poll(async () => (await page.context().cookies(runtime.baseUrl)).some(cookie => cookie.name === '__Host-cauce_session'), { timeout: 30_000 }).toBe(true);
    await expect.poll(() => runtime.capture(), { timeout: 30_000 }).toContain('Login expired · Please run /login');
    const initial = await runtime.facts();
    expect(initial).toMatchObject({ double: true, uid: 1000, mode: 'expired', inputs: [] });
    expect(initial.command_sha256).toBe(runtime.binding.files[runtime.binding.command]);
    await page.goto(`${runtime.baseUrl}/terminal/Steven/${runtime.alias}?modo=tui`, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-pty-shell][data-state="open"]').waitFor({ timeout: 30_000 });
    await expect.poll(() => page.locator('.xterm-rows').innerText(), { timeout: 15_000 }).toContain('Paste code here if prompted >');
    await capture(page, 'expired-tui');
    await page.getByRole('button', { name: 'Más acciones', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Cerrar sesión PTY', exact: true }).click();
    await page.goto(`${runtime.baseUrl}/messages/Steven/${runtime.alias}`, { waitUntil: 'domcontentloaded' });
    const firstText = `H8C_EXPIRED_${randomUUID()}`;
    const started = performance.now();
    const first = await publish(page, runtime, firstText);
    const ack = await failedLogin(runtime, first.delivery_id);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(60_000);
    expect((await runtime.facts()).inputs).toEqual([]);
    observed.failed = { ...first, ack, elapsed_ms: elapsed, inputs_before_failure: [] };
    await page.getByRole('status', { name: `Entrega: ${message}`, exact: true }).waitFor({ timeout: 20_000 });
    const alert = page.getByRole('alert', { name: 'Sesión del proveedor caducada', exact: true });
    await alert.waitFor({ timeout: 20_000 });
    expect(await alert.innerText()).toContain(message);
    const agentState = page.locator('header [data-live-state]');
    await expect.poll(() => agentState.evaluate(element => element.getAttribute('data-live-state')), { timeout: 20_000 }).toBe('blocked');
    expect(await agentState.evaluate(element => element.getAttribute('title'))).toContain(message);
    expect(await alert.getByRole('button', { name: `Iniciar sesión de ${runtime.alias}`, exact: true }).isDisabled()).toBe(true);
    await capture(page, 'expired-thread-and-agent');
    const messageApi = await apiGet(page, `/v3/console/messages/${first.message_id}`);
    const listApi = await apiGet(page, '/v3/console/messages');
    const activityApi = await apiGet(page, '/v3/console/activity');
    expect(messageApi.status).toBe(200);
    expect(activityApi.status).toBe(200);
    expect(listApi.status).toBe(200);
    const listed = (listApi.body.items as { message_id: string; deliveries: unknown }[]).find(item => item.message_id === first.message_id);
    expect(listed?.deliveries).toContainEqual(expect.objectContaining({ recipient_alias: runtime.alias, provider_login_required: true }));
    expect(activityApi.body.agents).toContainEqual(expect.objectContaining({ alias: runtime.alias, provider_login_required: true }));
    observed.failed = { ...first, ack, elapsed_ms: elapsed, inputs_before_failure: [], message_preserved: true,
      login_action: 'disabled: canary host is not enrolled for provider login', message_api: messageApi, delivery_projection_api: listApi, activity_api: activityApi };
    expect((await runtime.database.pool.query('SELECT 1 FROM messages WHERE id=$1 AND body->>\'text\'=$2', [first.message_id, firstText])).rowCount).toBe(1);
    await runtime.mode('healthy');
    await expect.poll(() => runtime.capture(), { timeout: 5_000 }).toContain('CLAUDE_CANARY_READY');
    observed.first_terminal_status = await terminal(runtime, first.delivery_id);
    const heldText = `H8C_WAIT_${randomUUID()}`;
    const held = await publish(page, runtime, heldText);
    await expect.poll(async () => (await runtime.facts()).hold_ready, { timeout: 20_000 }).toBe(heldText);
    await expect.poll(() => runtime.capture(), { timeout: 5_000 }).toContain('CLAUDE_CANARY_BUSY');
    const switched = performance.now();
    await runtime.mode('expired');
    const heldAck = await failedLogin(runtime, held.delivery_id);
    const heldElapsed = performance.now() - switched;
    expect(heldElapsed).toBeLessThan(60_000);
    observed.during_wait = { ...held, ack: heldAck, elapsed_ms: heldElapsed, native: await runtime.facts() };
    await alert.waitFor({ timeout: 20_000 });
    await capture(page, 'expired-while-waiting');
    await runtime.mode('healthy');
    await expect.poll(() => runtime.capture(), { timeout: 5_000 }).toContain('CLAUDE_CANARY_READY');
    observed.held_terminal_status = await terminal(runtime, held.delivery_id);
    const healthyText = `H8C_OK_${randomUUID()}`;
    const second = await publish(page, runtime, healthyText);
    await done(runtime, second.delivery_id);
    const row = (await runtime.database.pool.query<{ reply: string; status: string }>(
      "SELECT status,result->'output'->>'reply' AS reply FROM deliveries WHERE id=$1", [second.delivery_id])).rows[0];
    expect(row?.reply).toBe(`H8C_HEALTHY_REPLY:${healthyText}`);
    const consumption = (await runtime.database.pool.query<{ witness: Record<string, unknown> }>(
      `SELECT payload->'result'->'harness_consumption_v1' AS witness FROM delivery_acks
       WHERE delivery_id=$1 AND applied AND status='done' ORDER BY id DESC LIMIT 1`, [second.delivery_id])).rows[0]?.witness;
    expect(consumption).toMatchObject({ harness_id: 'claude', native_session_id: initial.native_id, evidence_kind: 'canonical_final_response' });
    await page.getByText(`H8C_HEALTHY_REPLY:${healthyText}`, { exact: true }).waitFor({ timeout: 20_000 });
    await expect.poll(() => alert.count(), { timeout: 20_000 }).toBe(0);
    await expect.poll(() => agentState.evaluate(element => element.getAttribute('data-live-state')), { timeout: 20_000 }).toMatch(/^(?:receiving|thinking|settled|idle)$/u);
    await capture(page, 'healthy-next-delivery');
    const healthyActivity = await apiGet(page, '/v3/console/activity');
    expect(healthyActivity.body.agents).toContainEqual(expect.objectContaining({ alias: runtime.alias, provider_login_required: false }));
    const final = await runtime.facts();
    expect(final.pid).toBe(initial.pid);
    expect(final.starttime).toBe(initial.starttime);
    expect(final.inputs.every(input => input.mode === 'healthy')).toBe(true);
    expect(final.normalization.some(item => item.raw_cr > 0 && item.raw_sha256 !== item.normalized_sha256)).toBe(true);
    expect(final.normalization.every(item => item.normalized_cr === 0)).toBe(true);
    expect(await runtime.observe()).toEqual({ id: runtime.binding.container_id, image: runtime.image.id,
      started_at: runtime.binding.started_at, read_only: true });
    const originals = await runtime.database.pool.query<{ id: string; status: string; text: string }>(
      `SELECT d.id::text,d.status,m.body->>'text' AS text FROM deliveries d JOIN messages m ON m.id=d.message_id
       WHERE d.id=ANY($1::uuid[])`, [[first.delivery_id, held.delivery_id]]);
    expect(originals.rows).toHaveLength(2);
    expect(originals.rows.map(item => item.text).sort()).toEqual([firstText, heldText].sort());
    observed.success = { ...second, ...row, consumption_witness: consumption, same_native_process: true, original_messages_preserved: originals.rows, initial, final,
      markers: await runtime.tmuxMarkers(), activity_api: healthyActivity };
  } catch (error) {
    if (failedPage) await capture(failedPage, 'failed').catch(() => undefined);
    throw error;
  } finally {
    try {
      await writeFile(join(evidence, 'result.json'), JSON.stringify(observed, null, 2));
      await writeFile(join(evidence, 'claude-launcher.log'), runtime.launcherLog());
      await writeFile(join(evidence, 'claude-adapter.log'), await runtime.adapterLog());
    } finally { await runtime.close(); }
  }
}, 600_000);
