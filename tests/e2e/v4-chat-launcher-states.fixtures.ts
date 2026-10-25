import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect } from 'vitest';
import {
  newTrustedPage, type BrowserResponse, type FunctionalTenant, type startConsoleFunctionalFixture,
} from './console-functional-browser.fixtures.js';
import {
  asV4Page, BrowserErrorLog, HERMETIC_INSTANCE_RULES, type V4Page,
} from './v4-console-real-browser.helpers.js';

export const launcherOwner = 'e2e-a6-chat-1025b';
export const launcherEvidence = resolve('.delegados/v4/recibos', launcherOwner);
export type LauncherFixture = Awaited<ReturnType<typeof startConsoleFunctionalFixture>>;
export const launcherReads = ['/v3/status', '/v3/console/topology', '/v3/console/activity', '/v3/console/messages'] as const;
const faultPaths = new Set<string>([...launcherReads, '/v3/console/queues', '/v3/console/agent-preferences']);
const tableNames = {
  agents: 'zz_canary_e2e_a6_chat_1025b_agents',
  messages: 'zz_canary_e2e_a6_chat_1025b_messages',
} as const;
type FleetTable = keyof typeof tableNames;

export interface LauncherPage {
  page: V4Page;
  errors: BrowserErrorLog;
  responses: { path: string; method: string; status: number }[];
}

export async function launcherPage(fixture: LauncherFixture, viewport: { width: number; height: number }, fault = false): Promise<LauncherPage> {
  const page = asV4Page(await newTrustedPage(fixture, viewport));
  const errors = new BrowserErrorLog([...HERMETIC_INSTANCE_RULES, {
    id: 'hermetic-terminal-targets-404', reason: 'fixture without the terminal plugin',
    matches: (text, url) => text.includes('status of 404') && url === `${fixture.baseUrl}/v3/console/terminal/targets`,
  }, {
    id: 'hermetic-terminal-grants-404', reason: 'the functional fixture does not register the terminal plugin',
    matches: (text, url) => text.includes('status of 404') && url === `${fixture.baseUrl}/v3/console/terminal/grants`,
  }, ...(fault ? [{
    id: 'owned-postgres-table-fault', reason: 'this scenario temporarily renames tables in its owned PostgreSQL container',
    matches: (text: string, url: string) => /status of (?:400|500)/u.test(text) && faultPaths.has(new URL(url).pathname),
  }] : [])]);
  errors.watch(page, `launcher-${String(viewport.width)}`);
  const responses: LauncherPage['responses'] = [];
  page.on('response', (response: BrowserResponse) => {
    const path = new URL(response.url()).pathname;
    if (path.startsWith('/v3/')) responses.push({ path, method: response.request().method(), status: response.status() });
  });
  return { page, errors, responses };
}

export async function loginLauncher(fixture: LauncherFixture, page: V4Page, tenant: FunctionalTenant): Promise<void> {
  await page.goto(`${fixture.baseUrl}/messages`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Correo', { exact: true }).fill(tenant.email);
  await page.getByLabel('Contraseña', { exact: true }).fill(tenant.password);
  await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
  await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });
  await launcherCard(page, tenant).waitFor({ timeout: 25_000 });
}

export const launcherCard = (page: V4Page, tenant: FunctionalTenant) =>
  page.locator(`a[data-launcher-card][href="/messages/${tenant.tenant}/${tenant.target}"]`);

export async function captureLauncher(page: V4Page, name: string): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  await page.screenshot({ path: resolve(launcherEvidence, `${name}.png`), fullPage: false });
}

export async function saveLauncherLog(name: string, browser: LauncherPage): Promise<void> {
  await writeFile(resolve(launcherEvidence, `${name}-browser.json`), JSON.stringify({
    responses: browser.responses, trace: browser.errors.trace,
    ignored: Object.fromEntries(browser.errors.ignored), unexpected: browser.errors.unexpected,
  }, null, 2));
}

export async function withFleetReadLock<T>(fixture: LauncherFixture, action: (blocked: () => Promise<number>) => Promise<T>): Promise<T> {
  const client = await fixture.database.adminPool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout='45s'");
    await client.query('LOCK TABLE public.agents,public.messages IN ACCESS EXCLUSIVE MODE');
    const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
    if (!pid) throw new Error('The owned PostgreSQL lock has no backend identity');
    return await action(async () => (await fixture.database.adminPool.query<{ total: number }>(
      'SELECT count(*)::int AS total FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))', [pid],
    )).rows[0]?.total ?? 0);
  } finally {
    try { await client.query('ROLLBACK'); } finally { client.release(); }
  }
}

export async function withFleetReadFault<T>(fixture: LauncherFixture, tables: readonly FleetTable[], action: () => Promise<T>): Promise<T> {
  const client = await fixture.database.adminPool.connect();
  let renamed = false;
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='5s'");
    for (const name of tables) await client.query(`ALTER TABLE public.${name} RENAME TO ${tableNames[name]}`);
    await client.query('COMMIT');
    renamed = true;
    return await action();
  } finally {
    try {
      await client.query('ROLLBACK');
      if (renamed) {
        await client.query('BEGIN');
        await client.query("SET LOCAL lock_timeout='5s'");
        for (const name of [...tables].reverse()) await client.query(`ALTER TABLE public.${tableNames[name]} RENAME TO ${name}`);
        await client.query('COMMIT');
      }
    } finally { client.release(); }
  }
}
