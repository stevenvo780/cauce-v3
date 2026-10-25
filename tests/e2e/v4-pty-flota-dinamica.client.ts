import { randomUUID } from 'node:crypto';
import { chmod, lstat, readdir, rm, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { expect } from 'vitest';
import { buildInstalledCli } from './v4-cli-flota-dinamica.install.js';
import { apiGet, type V4Page } from './v4-console-real-browser.helpers.js';
import { ptyFleetAlias } from './v4-pty-flota-dinamica.flow.js';
import { capturePtyFleet, ptyFleetReceipt, type PtyFleetFixture } from './v4-pty-flota-dinamica.helpers.js';

export type PtyFleetCli = Awaited<ReturnType<typeof buildInstalledCli>>;

async function observeBrowserErrors(page: V4Page): Promise<void> {
  await page.evaluate(() => {
    const state = window as Window & { h12BrowserErrors?: Record<string, unknown>[] };
    if (state.h12BrowserErrors) return;
    state.h12BrowserErrors = [];
    const source = (value: string): string | null => {
      try {
        const path = new URL(value).pathname;
        return path.startsWith('/src/') || path.startsWith('/node_modules/') ? path.slice(0, 250) : null;
      } catch { return null; }
    };
    const capture = (type: string, value: unknown, message: string, filename: string): void => {
      if (!state.h12BrowserErrors || state.h12BrowserErrors.length >= 40) return;
      const name = value instanceof Error ? value.name : '';
      const stack = value instanceof Error ? value.stack ?? '' : '';
      const frames = stack.split('\n').slice(1, 9).flatMap(line => {
        const url = /https?:\/\/[^\s)]+/u.exec(line)?.[0];
        const path = url ? source(url) : null;
        return path ? [path] : [];
      });
      state.h12BrowserErrors.push({ type, value_type: typeof value, error_object: value instanceof Error,
        name: /^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(name) ? name : null, frames, source: source(filename),
        resize_observer_loop: message === 'ResizeObserver loop completed with undelivered notifications.'
          || message === 'ResizeObserver loop limit exceeded' });
    };
    window.addEventListener('error', event => { capture(event.type, event.error, event.message, event.filename); });
    window.addEventListener('unhandledrejection', event => { capture(event.type, event.reason, '', ''); });
  });
}

function connection(fixture: PtyFleetFixture, cli: PtyFleetCli): string[] {
  return ['--gateway', fixture.baseUrl, '--origin', fixture.baseUrl, '--ca-file', fixture.caFile, '--session-file', cli.sessionFile];
}

export async function loginPtyFleetCli(fixture: PtyFleetFixture, cli: PtyFleetCli): Promise<void> {
  expect(relative(process.cwd(), cli.home).startsWith('..')).toBe(true);
  expect((await stat(cli.home)).mode & 0o777).toBe(0o700);
  const login = cli.start(['login', '--dispositivo', ...connection(fixture, cli)]);
  try {
    await login.waitFor(/Código: [A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}/u);
    const code = /Código: ([A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4})/u.exec(login.stderr)?.[1];
    if (!code) throw new Error('the installed CLI omitted its private device code');
    await fixture.page.goto(fixture.baseUrl + '/dispositivo?code=' + encodeURIComponent(code), { waitUntil: 'domcontentloaded' });
    await fixture.page.getByRole('region', { name: 'Solicitud de acceso', exact: true }).waitFor({ timeout: 30_000 });
    await fixture.page.getByRole('button', { name: 'Autorizar', exact: true }).click();
    const result = await login.result;
    expect(result.code).toBe(0);
    const body = JSON.parse(result.stdout) as { subject: string };
    expect(body.subject).toBe(fixture.owner.email);
  } finally { await login.stop(); }
  expect((await stat(cli.sessionFile)).mode & 0o777).toBe(0o600);
  await ptyFleetReceipt('installed-cli', { manifest: cli.manifest, private_home: true, nominal_device_login: true });
}

async function released(fixture: PtyFleetFixture): Promise<void> {
  await expect.poll(async () => (await fixture.computer.pool.query<{ sessions: string; holds: string }>(
    `SELECT (SELECT count(*)::text FROM terminal_sessions WHERE tenant_id=$1 AND alias=$2
       AND closed_at IS NULL AND revoked_at IS NULL) AS sessions,
     (SELECT count(*)::text FROM terminal_control_holds h JOIN terminal_sessions s ON s.id=h.session_id
       WHERE s.tenant_id=$1 AND s.alias=$2 AND h.released_at IS NULL AND h.expires_at>clock_timestamp()) AS holds`,
    [fixture.tenantId, ptyFleetAlias])).rows[0], { timeout: 20_000 }).toEqual({ sessions: '0', holds: '0' });
}

export async function usePtyFleetShells(fixture: PtyFleetFixture, cli: PtyFleetCli, uid: number, phase: string): Promise<void> {
  const targets = await apiGet(fixture.page, '/v3/console/terminal/targets');
  expect(targets.status).toBe(200);
  expect(targets.body.items).toEqual(expect.arrayContaining([expect.objectContaining({
    tenant_id: fixture.tenantId, alias: ptyFleetAlias, pty_state: 'online' })]));
  const nonce = randomUUID(), marker = 'H12-WEB-' + nonce;
  await fixture.page.goto(fixture.baseUrl + '/terminal/' + encodeURIComponent(fixture.tenantId) + '/' + ptyFleetAlias
    + '?modo=terminal', { waitUntil: 'domcontentloaded' });
  await observeBrowserErrors(fixture.page);
  await fixture.page.locator('[data-pty-shell][data-state="open"]').waitFor({ timeout: 30_000 });
  const sessionId = await fixture.page.locator('[data-session-id]').evaluate(element => element.getAttribute('data-session-id'));
  const input = fixture.page.locator('.xterm-helper-textarea');
  await input.type("printf 'H12-WEB-%s\\n' '" + nonce + "'; printf 'UID:%s\\n' \"$(id -u)\"; printf 'PWD:%s\\n' \"$(pwd)\"");
  await input.press('Enter');
  const expected = [marker, 'UID:' + String(uid), 'PWD:/home/cauce'];
  await expect.poll(async () => {
    const text = await fixture.page.locator('.xterm-rows').innerText();
    return expected.every(value => text.includes(value));
  }, { timeout: 20_000 }).toBe(true);
  const web = await fixture.page.locator('.xterm-rows').innerText();
  expect(web).toContain('UID:' + String(uid)); expect(web).toContain('PWD:/home/cauce');
  await capturePtyFleet(fixture.page, phase + '-web-shell');
  await fixture.page.getByRole('button', { name: 'Más acciones', exact: true }).click();
  await fixture.page.getByRole('menuitem', { name: 'Cerrar sesión PTY', exact: true }).click();
  await fixture.page.getByRole('button', { name: 'Abrir terminal', exact: true }).waitFor();
  await released(fixture);
  const cliNonce = randomUUID(), cliMarker = 'H12-CLI-' + cliNonce;
  const result = await cli.run([ptyFleetAlias, '--tenant', fixture.tenantId, '--mode', 'shell', ...connection(fixture, cli)], {
    input: "printf 'H12-CLI-%s\\n' '" + cliNonce + "'; printf 'UID:%s\\n' \"$(id -u)\"; printf 'PWD:%s\\n' \"$(pwd)\"; exit\n",
  });
  expect(result.code).toBe(0); expect(result.stdout).toContain(cliMarker);
  expect(result.stdout).toContain('UID:' + String(uid)); expect(result.stdout).toContain('PWD:/home/cauce');
  await released(fixture);
  const durable = await fixture.computer.pool.query<{ id: string; mode: string; operator_id: string; consumed: boolean; closed: boolean }>(
    `SELECT id,mode,operator_id,consumed_at IS NOT NULL AS consumed,
       (closed_at IS NOT NULL OR revoked_at IS NOT NULL) AS closed
     FROM terminal_sessions WHERE tenant_id=$1 AND alias=$2 ORDER BY issued_at`, [fixture.tenantId, ptyFleetAlias]);
  expect(durable.rows.some(row => row.id === sessionId && row.mode === 'shell' && row.closed && row.consumed)).toBe(true);
  expect(durable.rows.every(row => row.mode === 'shell' && row.operator_id === fixture.owner.email && row.closed && row.consumed)).toBe(true);
  await ptyFleetReceipt(phase + '-browser-events', await fixture.page.evaluate(() =>
    (window as Window & { h12BrowserErrors?: Record<string, unknown>[] }).h12BrowserErrors ?? []));
  await ptyFleetReceipt(phase + '-shells', { web: { session_id: sessionId, nonce_verified: true, uid, pwd: '/home/cauce' },
    cli: { code: result.code, nonce_verified: true, uid, pwd: '/home/cauce', installed: true }, sessions: durable.rows });
}

export async function discardPtyFleetInstallation(directory: string): Promise<void> {
  const writable = async (path: string): Promise<void> => {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) return;
    await chmod(path, (info.mode & 0o777) | 0o700);
    for (const entry of await readdir(path, { withFileTypes: true })) if (entry.isDirectory()) await writable(join(path, entry.name));
  };
  await writable(directory); await rm(directory, { recursive: true, force: true });
}
