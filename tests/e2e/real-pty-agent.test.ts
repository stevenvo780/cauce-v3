import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { startRealPtyFixture, type RealPtyFixture } from './real-pty-agent.fixtures.js';

let fixture: RealPtyFixture | undefined;
const sessionClosed = (row: { revoked_at: Date | null; closed_at: Date | null } | undefined) =>
  row !== undefined && Boolean(row.revoked_at) && Boolean(row.closed_at);

beforeAll(async () => {
  fixture = await startRealPtyFixture();
}, 10 * 60_000);

afterAll(async () => { await fixture?.close(); });

describe('PTY real Python agent through gateway and relay', () => {
  it('authenticates, claims a real PTY, runs fixed shell probes as UID 1000, and revokes it', async () => {
    if (!fixture) throw new Error('PTY fixture not initialized');
    const active = fixture;
    const session = await active.login();
    await active.waitForTarget(session.cookie);
    const requestId = randomUUID();
    const ownerToken = randomUUID();
    const opened = await active.request('/v3/console/terminal/sessions', {
      method: 'POST',
      headers: { cookie: session.cookie, 'x-csrf-token': session.csrf, origin: active.gatewayUrl },
      body: {
        tenant_id: active.tenant, alias: active.targetAlias, mode: 'shell', reason: 'real PTY E2E',
        cols: 100, rows: 30, request_id: requestId, owner_token: ownerToken,
      },
    });
    expect(opened.status, opened.body).toBe(201);
    const admission = JSON.parse(opened.body) as {
      session_id: string; ticket: string; websocket_path: string; owner_generation: string; request_id: string;
    };
    expect(admission.request_id).toBe(requestId);
    const pty = await active.connect(admission.ticket, admission.session_id, 100, 30);
    const ready = await pty.waitControl((frame) => frame.type === 'ready');
    expect(ready).toMatchObject({ type: 'ready', session_id: admission.session_id, resumed: false });
    expect(typeof ready.claim_token).toBe('string');
    expect(typeof ready.claim_epoch).toBe('string');
    const claimed = await active.database.pool.query<{
      relay_claim_sha256: Buffer | null; relay_claim_epoch: string | null; request_id: string;
      browser_owner_generation: string; browser_owner_sha256: Buffer; operator_id: string;
      console_subject: string; revoked_at: Date | null; closed_at: Date | null;
    }>(`SELECT relay_claim_sha256,relay_claim_epoch,request_id,browser_owner_generation,browser_owner_sha256,
               operator_id,console_subject,revoked_at,closed_at
          FROM terminal_sessions WHERE id=$1`, [admission.session_id]);
    expect(claimed.rows).toHaveLength(1);
    expect(claimed.rows[0]).toMatchObject({
      relay_claim_epoch: ready.claim_epoch, request_id: requestId, browser_owner_generation: admission.owner_generation,
      operator_id: active.operatorEmail, console_subject: `${active.tenant}:${active.operatorAlias}`,
      revoked_at: null, closed_at: null,
    });
    expect(claimed.rows[0]?.relay_claim_sha256?.toString('hex')).toBe(
      createHash('sha256').update(String(ready.claim_token)).digest('hex'),
    );
    expect(claimed.rows[0]?.browser_owner_sha256.toString('hex')).toBe(
      createHash('sha256').update(ownerToken).digest('hex'),
    );

    const nonce = `PTY-${randomUUID()}`;
    pty.socket.send(JSON.stringify({ type: 'input', data: `printf 'PTY:${nonce}\\n'; id -u; printf 'HOME:%s\\n' "$HOME"; stty size\n` }));
    const output = await pty.waitOutput((value) => value.includes(nonce) && value.includes('1000') && value.includes('HOME:/home/node') && value.includes('30 100'));
    expect(output).toContain(`PTY:${nonce}`);
    expect(output).toMatch(/\b1000\b/u);
    expect(output).toContain('HOME:/home/node');
    expect(output).toContain('30 100');

    const closed = await active.request(`/v3/console/terminal/sessions/${encodeURIComponent(admission.session_id)}`, {
      method: 'DELETE', headers: { cookie: session.cookie, 'x-csrf-token': session.csrf, origin: active.gatewayUrl },
      body: { owner_generation: admission.owner_generation, owner_token: ownerToken, request_id: requestId },
    });
    expect(closed.status, closed.body).toBe(204);
    await pty.waitForClose(10_000);
    expect(pty.closeCode).toBe(4403);
    const closeDeadline = Date.now() + 15_000;
    let durable = await active.database.pool.query<{ revoked_at: Date | null; closed_at: Date | null }>(
      'SELECT revoked_at,closed_at FROM terminal_sessions WHERE id=$1', [admission.session_id]);
    expect(durable.rows[0]?.revoked_at).toBeInstanceOf(Date);
    while (durable.rows[0]?.closed_at === null && Date.now() < closeDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      durable = await active.database.pool.query<{ revoked_at: Date | null; closed_at: Date | null }>(
        'SELECT revoked_at,closed_at FROM terminal_sessions WHERE id=$1', [admission.session_id]);
    }
    expect(durable.rows[0]?.closed_at).toBeInstanceOf(Date);
    const closeAudit = await active.database.pool.query<{ decision: string; session_id: string }>(
      "SELECT decision,metadata->>'session_id' AS session_id FROM audit_events WHERE action='terminal.session.close' AND metadata->>'session_id'=$1",
      [admission.session_id],
    );
    expect(closeAudit.rows).toEqual([{ decision: 'info', session_id: admission.session_id }]);
    expect(active.agentLog()).toContain('1000');
  }, 180_000);

  it('opera el shell PTY real desde Chromium móvil, recibe resize del relay y cierra la sesión propia', async () => {
    if (!fixture) throw new Error('PTY fixture not initialized');
    const active = fixture;
    const page = await active.browserPage({ width: 360, height: 800 });
    const nonce = `UI-PTY-${randomUUID().slice(0, 8)}`;
    const websocketPath = `/v3/console/terminal/relays/${active.relayInstanceId}/ws`;
    const browserSocket = { closed: false };
    let browserSocketSeen = false;
    const browserErrors: string[] = [];
    page.on('pageerror', (error) => { browserErrors.push(String(error)); });
    page.on('console', (message) => { if (String(message).includes('error')) browserErrors.push(String(message)); });
    page.on('websocket', (socket) => {
      if (!socket.url().endsWith(websocketPath)) return;
      browserSocketSeen = true;
      socket.on('close', () => { browserSocket.closed = true; });
    });

    const loginPage = await page.goto(active.baseUrl, { waitUntil: 'domcontentloaded' });
    expect(loginPage?.status()).toBe(200);
    await page.getByLabel('Correo').waitFor({ timeout: 15_000 });
    await page.getByLabel('Correo').fill(active.operatorEmail);
    await page.getByLabel('Contraseña').fill(active.operatorPassword);
    await page.getByRole('button', { name: 'Iniciar sesión' }).click();
    await page.getByRole('link', { name: /Conversaciones/u }).waitFor({ state: 'visible', timeout: 20_000 }).catch(async (cause: unknown) => {
      const access = await page.evaluate(async () => {
        const response = await fetch('/v3/console/access', { credentials: 'include' });
        return { status: response.status, body: await response.text() };
      }).catch((error: unknown) => ({ status: 0, body: String(error) }));
      throw new Error(`authenticated navigation missing; url=${page.url()} body=${JSON.stringify((await page.locator('body').innerText()).slice(0, 1_200))} access=${JSON.stringify(access)} browser=${JSON.stringify(browserErrors)}`, { cause });
    });
    const cookies = await page.context().cookies(active.baseUrl);
    const cookie = cookies.find((item) => item.name === '__Host-cauce_session');
    expect(cookie && cookie.httpOnly && cookie.secure).toBe(true);
    if (!cookie) throw new Error('authenticated browser omitted its secure session cookie');
    await active.waitForTarget(`${cookie.name}=${cookie.value}`);
    await page.getByRole('button', { name: 'Herramientas' }).click();
    const toolsMenu = page.getByRole('region', { name: 'Herramientas de Cauce' });
    await toolsMenu.waitFor({ state: 'visible', timeout: 10_000 });
    const artifactDirectory = process.env.CAUCE_E2E_ARTIFACT_DIR;
    if (artifactDirectory) {
      await mkdir(artifactDirectory, { recursive: true });
      await page.screenshot({ path: join(artifactDirectory, 'terminal-360-menu.png'), fullPage: true });
    }
    const terminalLink = toolsMenu.getByRole('link', { name: 'Terminal de agentes' });
    await terminalLink.waitFor({ state: 'visible', timeout: 10_000 });
    const relayDeadline = Date.now() + 30_000;
    let relayEnabled = false;
    while (Date.now() < relayDeadline) {
      relayEnabled = await page.evaluate<boolean>(() => {
        const link = document.querySelector<HTMLAnchorElement>('a[href="/terminal"]');
        return link?.getAttribute('aria-disabled') !== 'true';
      });
      if (relayEnabled) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(relayEnabled, 'the real relay must enable the visible Terminal menu entry').toBe(true);
    await terminalLink.click();
    await page.getByRole('heading', { name: 'Terminal de agentes', exact: true }).waitFor({ timeout: 20_000 });
    const selector = page.getByRole('combobox', { name: 'Agente' });
    await selector.waitFor({ state: 'visible', timeout: 25_000 });
    await selector.selectOption(`${active.tenant}:${active.targetAlias}`);
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    await page.getByRole('dialog', { name: new RegExp(`Abrir Terminal en ${active.targetAlias}`, 'u') }).waitFor({ timeout: 10_000 });
    await page.getByLabel('Motivo de la sesión (queda en la auditoría)').fill('Verificación local de resize y cierre desde Chromium móvil.');
    await page.getByRole('button', { name: 'Abrir sesión PTY' }).click();
    await page.locator('.pty-shell[data-state="open"]').waitFor({ state: 'visible', timeout: 30_000 });
    await page.locator('.xterm-helper-textarea').waitFor({ state: 'visible', timeout: 15_000 });

    const input = page.locator('.xterm-helper-textarea');
    const command = `printf 'UI-PTY:${nonce}\\n'; id -u; printf 'HOME:%s\\n' "$HOME"; printf 'SIZE-A:${nonce}:%s\\n' "$(stty size)"`;
    await input.type(command);
    await input.press('Enter');
    const waitForTerminalText = async (pattern: RegExp): Promise<string> => {
      const deadline = Date.now() + 20_000;
      let output = '';
      while (Date.now() < deadline) {
        output = await page.locator('.xterm-rows').innerText().catch(() => '');
        if (pattern.test(output)) return output;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`mobile xterm output did not match ${String(pattern)}; last output=${JSON.stringify(output.slice(-900))}`);
    };
    const firstOutput = await waitForTerminalText(new RegExp(`SIZE-A:${nonce}:(\\d+)\\s+(\\d+)`, 'u'));
    expect(firstOutput).toContain(nonce);
    expect(firstOutput).toMatch(/\b1000\b/u);
    expect(firstOutput).toContain('HOME:/home/node');
    const firstGeometry = new RegExp(`SIZE-A:${nonce}:(\\d+)\\s+(\\d+)`, 'u').exec(firstOutput);
    if (!firstGeometry?.[1] || !firstGeometry[2]) throw new Error('PTY did not report its initial mobile geometry');
    const firstSize = [Number(firstGeometry[1]), Number(firstGeometry[2])];

    if (artifactDirectory) {
      await page.screenshot({ path: join(artifactDirectory, 'terminal-360-open.png'), fullPage: true });
    }
    await page.setViewportSize({ width: 360, height: 1_200 });
    await new Promise((resolve) => setTimeout(resolve, 750));
    await input.type(`printf 'SIZE-B:${nonce}:%s\\n' "$(stty size)"`);
    await input.press('Enter');
    const resizedOutput = await waitForTerminalText(new RegExp(`SIZE-B:${nonce}:(\\d+)\\s+(\\d+)`, 'u'));
    const resizedGeometry = new RegExp(`SIZE-B:${nonce}:(\\d+)\\s+(\\d+)`, 'u').exec(resizedOutput);
    if (!resizedGeometry?.[1] || !resizedGeometry[2]) throw new Error('PTY did not report geometry after the browser viewport resize');
    const resizedSize = [Number(resizedGeometry[1]), Number(resizedGeometry[2])];
    expect(resizedSize).not.toEqual(firstSize);
    expect(browserSocketSeen).toBe(true);

    const liveRows = await active.database.pool.query<{
      id: string; request_id: string; browser_owner_generation: string; browser_owner_sha256: Buffer;
      relay_claim_sha256: Buffer | null; relay_claim_epoch: string | null; operator_id: string;
      console_subject: string; revoked_at: Date | null; closed_at: Date | null;
    }>(`SELECT id::text AS id,request_id,browser_owner_generation,browser_owner_sha256,
               relay_claim_sha256,relay_claim_epoch,operator_id,console_subject,revoked_at,closed_at
          FROM terminal_sessions WHERE tenant_id=$1 AND alias=$2 AND revoked_at IS NULL`, [active.tenant, active.targetAlias]);
    expect(liveRows.rows).toHaveLength(1);
    const live = liveRows.rows[0];
    if (!live) throw new Error('UI terminal session disappeared before close');
    expect(live.request_id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(live.browser_owner_generation).not.toBe('');
    expect(live.browser_owner_sha256).toHaveLength(32);
    expect(live.relay_claim_sha256).toHaveLength(32);
    expect(live.relay_claim_epoch).not.toBeNull();
    expect(live).toMatchObject({
      operator_id: active.operatorEmail,
      console_subject: `${active.tenant}:${active.operatorAlias}`,
      revoked_at: null,
      closed_at: null,
    });

    let uiDeleteStatus: number | undefined;
    page.on('response', (response) => {
      if (response.request().method() === 'DELETE' && response.url().endsWith(`/v3/console/terminal/sessions/${live.id}`)) {
        uiDeleteStatus = response.status();
      }
    });
    await page.getByRole('link', { name: 'Conversaciones', exact: true }).click();
    await page.locator('.pty-shell').waitFor({ state: 'hidden', timeout: 20_000 });
    const deleteDeadline = Date.now() + 10_000;
    while (uiDeleteStatus === undefined && Date.now() < deleteDeadline) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(uiDeleteStatus).toBe(204);
    const closeDeadline = Date.now() + 15_000;
    while (!browserSocket.closed && Date.now() < closeDeadline) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(browserSocket.closed).toBe(true);
    const durableDeadline = Date.now() + 15_000;
    let durable = await active.database.pool.query<{ revoked_at: Date | null; closed_at: Date | null }>(
      'SELECT revoked_at,closed_at FROM terminal_sessions WHERE id=$1', [live.id],
    );
    while (!sessionClosed(durable.rows[0]) && Date.now() < durableDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      durable = await active.database.pool.query<{ revoked_at: Date | null; closed_at: Date | null }>(
        'SELECT revoked_at,closed_at FROM terminal_sessions WHERE id=$1', [live.id],
      );
    }
    if (!sessionClosed(durable.rows[0])) {
      const state = await active.database.pool.query<{ id: string; request_id: string; revoked_at: Date | null; closed_at: Date | null }>(
        'SELECT id::text AS id,request_id,revoked_at,closed_at FROM terminal_sessions WHERE tenant_id=$1 AND alias=$2',
        [active.tenant, active.targetAlias],
      );
      const audits = await active.database.pool.query<{ action: string; decision: string; session_id: string | null }>(
        "SELECT action,decision,metadata->>'session_id' AS session_id FROM audit_events WHERE action LIKE 'terminal.session.%'",
      );
      process.stdout.write(`E2E mobile close diagnostic: session=${live.id} deleteStatus=${String(uiDeleteStatus)} state=${JSON.stringify(state.rows)} audits=${JSON.stringify(audits.rows)}\n`);
    }
    expect(durable.rows).toHaveLength(1);
    expect(durable.rows[0]?.revoked_at, `session=${live.id} DELETE=${String(uiDeleteStatus)} durable=${JSON.stringify(durable.rows)}`).toBeInstanceOf(Date);
    expect(durable.rows[0]?.closed_at, `session=${live.id} DELETE=${String(uiDeleteStatus)} durable=${JSON.stringify(durable.rows)}`).toBeInstanceOf(Date);
    const revokeAudit = await active.database.pool.query<{ decision: string; session_id: string }>(
      "SELECT decision,metadata->>'session_id' AS session_id FROM audit_events WHERE action='terminal.session.revoked' AND metadata->>'session_id'=$1",
      [live.id],
    );
    expect(revokeAudit.rows).toEqual([{ decision: 'info', session_id: live.id }]);
    if (artifactDirectory) await page.screenshot({ path: join(artifactDirectory, 'terminal-360-closed.png'), fullPage: true });
    process.stdout.write(`E2E mobile PTY: session=${live.id} request=${live.request_id} browser=${active.browserContainer} geometry=${firstSize.join('x')}->${resizedSize.join('x')} DELETE=${String(uiDeleteStatus)} browserSocketClosed=${String(browserSocket.closed)}\n`);
  }, 180_000);
});
