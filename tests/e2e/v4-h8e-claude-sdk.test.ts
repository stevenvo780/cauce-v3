import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { asV4Page, apiGet } from './v4-console-real-browser.helpers.js';
import { startH8eCanary } from './v4-h8e-claude-fixtures.js';
import { H8E_EVIDENCE, H8E_RUN, h8eReceipt, redactH8ePane } from './v4-h8e-claude-runtime.js';

const message = 'La sesión del proveedor caducó: vuelve a iniciar sesión';

it('admite el login caducado nativo, aplica ACK pronto y lo muestra al dueño en la consola real', async () => {
  const canary = await startH8eCanary();
  const target = `cauce-${canary.runtimeKey}:agente`;
  let safePane = '';
  let adapterStarted = false;
  const mode = process.env.H8E_SDK_UNDER_TEST === 'before' ? 'before' : 'fixed';
  const observation: Record<string, unknown> = { run: H8E_RUN, sdk_under_test: mode, real_claude_cli: true, oauth_approval_completed: false };
  const pane = async () => {
    const raw = (await canary.runtime.tmux(['capture-pane', '-p', '-t', target, '-S', '-100'])).stdout;
    safePane = redactH8ePane(raw);
    return safePane;
  };
  const leases = async () => (await canary.database.pool.query('SELECT 1 FROM connection_leases WHERE tenant_id=$1 AND alias=$2 AND lease_until>now()',
    [canary.tenant.tenant, canary.tenant.target])).rowCount;
  try {
    const page = asV4Page(await canary.page());
    observation.membership_created_by_owner_ui = true;
    const initial = await canary.observe('fixed');
    expect(initial.ready).toBe(true);
    expect(initial.pid).toMatch(/^[1-9][0-9]*$/u);
    await canary.runtime.tmux(['send-keys', '-t', target, '-l', 'H8E_LOCAL_AUTHENTICATION_PROBE']);
    await canary.runtime.tmux(['send-keys', '-t', target, 'Enter']);
    await expect.poll(pane, { timeout: 30_000, interval: 250 }).toContain('● Login expired · Please run /login');
    await canary.runtime.tmux(['send-keys', '-t', target, '-l', '/login']);
    await canary.runtime.tmux(['send-keys', '-t', target, 'Enter']);
    await expect.poll(pane, { timeout: 15_000, interval: 250 }).toContain('Select login method:');
    await canary.runtime.tmux(['send-keys', '-t', target, 'Enter']);
    await expect.poll(pane, { timeout: 15_000, interval: 250 }).toContain('Paste code here if prompted >');
    expect(safePane).toContain('● Login expired · Please run /login');
    const identity = (await canary.runtime.tmux(['display-message', '-p', '-t', target, '#{session_id}|#{pane_id}|#{pane_pid}'])).stdout.trim();
    const before = await canary.observe('before');
    expect(before.readiness).toBe('timeout');
    await canary.startAdapter('before'); adapterStarted = true;
    await expect.poll(() => canary.diagnostics('before'), { timeout: 15_000, interval: 250 }).toMatchObject({ adapter_alive: true, local_lease_owned: true });
    const oldLeases = await leases();
    const oldDiagnostics = await canary.diagnostics('before');
    observation.before = { readiness: before, remote_active_leases: oldLeases, diagnostics: oldDiagnostics };
    await h8eReceipt('old-runtime.json', observation.before);
    expect(oldLeases).toBe(0);
    await canary.stopAdapter(); adapterStarted = false;
    const selected = await canary.observe(mode);
    observation.selected_readiness = selected;
    await h8eReceipt('selected-readiness.json', { mode, observed: selected, expected: 'login_required' });
    expect(selected.readiness).toBe('login_required');
    expect(selected.pid).toMatch(/^[1-9][0-9]*$/u);
    expect(selected.pid).toBe(initial.pid);
    await canary.startAdapter(mode); adapterStarted = true;
    await expect.poll(leases, { timeout: 30_000, interval: 250 }).toBe(1);
    expect((await canary.runtime.tmux(['display-message', '-p', '-t', target, '#{session_id}|#{pane_id}|#{pane_pid}'])).stdout.trim()).toBe(identity);
    await page.goto(`${canary.baseUrl}/messages/${canary.tenant.tenant}/${canary.tenant.target}`, { waitUntil: 'domcontentloaded' });
    const text = `H8E_OWNED_${H8E_RUN}_${randomUUID()}`;
    const started = performance.now();
    await page.getByLabel(`Mensaje para ${canary.tenant.target}`, { exact: true }).fill(text);
    await page.getByRole('button', { name: 'Enviar', exact: true }).click();
    const published = () => canary.database.pool.query<{ message_id: string; delivery_id: string }>(
      `SELECT m.id::text AS message_id,d.id::text AS delivery_id FROM messages m JOIN deliveries d ON d.message_id=m.id
        WHERE m.tenant_id=$1 AND m.body->>'text'=$2 AND d.recipient_alias=$3`, [canary.tenant.tenant, text, canary.tenant.target]);
    await expect.poll(async () => (await published()).rowCount, { timeout: 15_000, interval: 200 }).toBe(1);
    const delivery = (await published()).rows[0];
    if (!delivery) throw new Error('the console omitted its durable H8e delivery');
    const acknowledgements = () => canary.database.pool.query<{ delivery_id: string; error_code: string; retryable: boolean; status: string; applied: boolean; attempt: number }>(
      `SELECT delivery_id::text,payload->>'error_code' AS error_code,(payload->>'retryable')::boolean AS retryable,status,applied,attempt
        FROM delivery_acks WHERE delivery_id=$1 AND applied AND status='failed' ORDER BY id`, [delivery.delivery_id]);
    await expect.poll(async () => {
      const rows = (await acknowledgements()).rows;
      const safe = rows.map(row => ({ ...row, error_code: canary.runtime.diagnosticAllowlist.includes(row.error_code) ? row.error_code : 'unrecognized' }));
      if (rows.length) await h8eReceipt('delivery-acknowledgements.json', { delivery, acknowledgements: safe });
      return rows[0]?.error_code;
    }, { timeout: 25_000, interval: 200 }).toBe('PROVIDER_LOGIN_REQUIRED');
    const elapsedMs = performance.now() - started;
    const ack = (await acknowledgements()).rows[0];
    const durableState = (await canary.database.pool.query<{ status: string; attempt: number; terminal_at: string | null; login_error_visible: boolean }>(
      'SELECT status,attempt,terminal_at::text,last_error=$2 AS login_error_visible FROM deliveries WHERE id=$1', [delivery.delivery_id, message])).rows[0];
    expect(ack?.retryable).toBe(true);
    expect(elapsedMs).toBeLessThan(25_000);
    await page.getByRole('status', { name: `Entrega: ${message}`, exact: true }).waitFor({ timeout: 20_000 });
    const alert = page.getByRole('alert', { name: 'Sesión del proveedor caducada', exact: true });
    await alert.waitFor({ timeout: 20_000 });
    expect(await alert.innerText()).toContain(message);
    const state = page.locator('header [data-live-state]');
    await expect.poll(() => state.evaluate(element => element.getAttribute('data-live-state')), { timeout: 20_000 }).toBe('blocked');
    expect(await state.evaluate(element => element.getAttribute('title'))).toContain(message);
    const login = alert.getByRole('button', { name: `Iniciar sesión de ${canary.tenant.target}`, exact: true });
    expect(await login.isDisabled()).toBe(true);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await alert.waitFor();
      await page.screenshot({ path: join(H8E_EVIDENCE, `provider-login-${String(width)}.png`), fullPage: true });
    }
    const list = await apiGet(page, '/v3/console/messages');
    const activity = await apiGet(page, '/v3/console/activity');
    expect(list.status).toBe(200);
    expect(activity.status).toBe(200);
    const listed = (list.body.items as { message_id: string; deliveries: unknown }[]).find(row => row.message_id === delivery.message_id);
    expect(listed?.deliveries).toContainEqual(expect.objectContaining({ recipient_alias: canary.tenant.target, provider_login_required: true }));
    expect(activity.body.agents).toContainEqual(expect.objectContaining({ alias: canary.tenant.target, provider_login_required: true }));
    expect((await canary.database.pool.query('SELECT 1 FROM messages WHERE id=$1 AND body->>\'text\'=$2', [delivery.message_id, text])).rowCount).toBe(1);
    observation.after = { readiness: selected, remote_active_leases: await leases(), same_native_pane: true, delivery, ack, durable_state_observed: durableState,
      total_delivery_terminality_required: false, elapsed_ms: elapsedMs,
      message_preserved: true, console: { login_notice_visible: true, state: 'blocked', login_action_disabled: true, host_enrolled: false,
        message_projection_login_required: true, activity_projection_login_required: true, viewports: [1440, 390] } };
  } finally {
    try {
      await h8eReceipt('native-tui.redacted.txt', safePane);
      await h8eReceipt('result.json', { ...observation, provider_requests: canary.runtime.requests, oauth_urls_persisted: false });
      await h8eReceipt('sdk-diagnostics.json', await canary.diagnostics(mode));
      const audit = await canary.database.pool.query<{ action: string; reason: string | null }>(
        `SELECT action,CASE WHEN metadata->>'reason' IN ('consumer_placement_mismatch','placement_provenance_unverified') THEN metadata->>'reason' ELSE NULL END AS reason
          FROM audit_events WHERE tenant_id=$1 AND actor_alias=$2 AND action IN ('connection.lease.rejected','placement_provenance_unverified') ORDER BY id`,
        [canary.tenant.tenant, canary.tenant.target]);
      await h8eReceipt('runtime-lease-audit.json', audit.rows);
      if (adapterStarted) { await canary.stopAdapter(); adapterStarted = false; }
    } finally { await canary.close(); }
  }
}, 600_000);
