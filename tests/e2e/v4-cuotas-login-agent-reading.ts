import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from 'vitest';
import type { ConfigMutation } from '@cauce/protocol';
import type { DatabasePool, QuotaAccountCard, QuotaEnvironmentRepository } from '@cauce/store';
import { apiGet, type V4Locator, type V4Page } from './v4-console-real-browser.helpers.js';

interface ReadingOptions {
  page: V4Page; pool: DatabasePool; baseUrl: string; accountId: string; accountLabel: string;
  evidenceDirectory: string; operationId: string;
}
type AgentReadingOptions = ReadingOptions & (
  | { stage: 'verified'; expectedRemaining: readonly [number, number] }
  | { stage: 'expired'; expiresAt: string }
);
interface PublicRequest { method(): string; url(): string }
interface ObservedPage extends V4Page { off(event: string, handler: (value: unknown) => void): void }
interface AccountState { enabled: boolean; verified: boolean }
interface ConfigurationRead {
  revision?: number;
  capabilities?: { actor?: { tenant_id: string; alias: string; company_id?: string; can_control: boolean } };
  agents?: Record<string, unknown>[]; alias_routing_ceiling?: Record<string, unknown>[];
  agent_account_bindings?: Record<string, unknown>[];
}
type EnvironmentRead = Awaited<ReturnType<QuotaEnvironmentRepository['list']>>;

async function configuration(page: V4Page): Promise<ConfigurationRead> {
  const response = await apiGet(page, '/v3/console/config');
  expect(response.status).toBe(200);
  return response.body;
}
function configurationRevision(snapshot: ConfigurationRead): number {
  if (typeof snapshot.revision !== 'number') throw new Error('cleanup revision unavailable');
  return snapshot.revision;
}
function reportCleanupFailures(original: unknown, failures: unknown[]): void {
  if (failures.length) throw new AggregateError(original === undefined ? failures : [original, ...failures], 'Agent account reading or canonical cleanup failed');
}
async function change(page: V4Page, mutation: ConfigMutation, revision: number, beforeApply?: () => void) {
  const request = async (dryRun: boolean) => page.evaluate(async input => {
    const session = await (await fetch('/v3/auth/session', { credentials: 'include', cache: 'no-store' })).json() as { csrf_token: string };
    const response = await fetch('/v3/console/config/changes', { method: 'POST', credentials: 'include', headers: {
      'Content-Type': 'application/json', 'X-Cauce-Console': '1', 'X-CSRF-Token': session.csrf_token },
    body: JSON.stringify({ mutation: input.mutation, expected_revision: input.revision, dry_run: input.dryRun }) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }, { mutation, revision, dryRun });
  const preview = await request(true);
  expect(preview).toMatchObject({ status: 200, body: { applied: false, dry_run: true, revision, mutation } });
  beforeApply?.();
  const applied = await request(false);
  expect(applied).toMatchObject({ status: 201, body: { applied: true, dry_run: false, mutation } });
  expect(applied.body.mutation_sha256).toBe(preview.body.mutation_sha256);
  return { preview: preview.body, applied: applied.body };
}

export async function readLoginAccountInAgent(options: AgentReadingOptions): Promise<void> {
  const { page, pool, baseUrl, accountId, accountLabel, evidenceDirectory, operationId } = options;
  await mkdir(evidenceDirectory, { recursive: true });
  const record = async (name: string, value: unknown) => writeFile(join(evidenceDirectory, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
  const authenticationIds = async () => (await pool.query<{ id: string }>(`SELECT operation.id FROM quota_environment_operations operation
    JOIN quota_environments environment ON environment.id=operation.environment_id
    WHERE environment.account_id=$1 AND operation.action='authenticate' ORDER BY operation.id`, [accountId])).rows.map(row => row.id);
  const accountState = async () => (await pool.query<AccountState>(
    'SELECT enabled,quota_identity_hash IS NOT NULL AS verified FROM provider_accounts WHERE id=$1', [accountId])).rows[0];
  const originalUrl = page.url(); const viewport = page.viewportSize();
  expect(new URL(originalUrl).origin).toBe(new URL(baseUrl).origin);
  const beforeIds = await authenticationIds();
  const beforeAccount = await accountState();
  expect(beforeIds).toContain(operationId);
  expect(beforeAccount).toEqual(options.stage === 'verified' ? { enabled: true, verified: true } : { enabled: false, verified: false });
  const operation = (await pool.query<{ id: string; status: string; error_code: string | null; expires_at: string | null; verified: boolean | null }>(
    `SELECT operation.id,operation.status,operation.error_code,operation.result->>'expires_at' AS expires_at,
      (operation.result->>'authenticated_verified')::boolean AS verified
     FROM quota_environment_operations operation JOIN quota_environments environment ON environment.id=operation.environment_id
     WHERE operation.id=$1 AND environment.account_id=$2 AND operation.action='authenticate'`, [operationId, accountId])).rows[0];
  expect(operation).toMatchObject(options.stage === 'verified' ? { id: operationId, status: 'done', error_code: null, verified: true }
    : { id: operationId, status: 'failed', error_code: 'AUTH_EXPIRED', expires_at: options.expiresAt });
  const initial = await configuration(page); const actor = initial.capabilities?.actor;
  if (!actor?.company_id?.startsWith('zz-canary-e2e-a7c-login-definitivo-1025-login-') || !actor.can_control
    || typeof initial.revision !== 'number' || !Array.isArray(initial.agents)
    || !Array.isArray(initial.alias_routing_ceiling) || !Array.isArray(initial.agent_account_bindings)) throw new Error('owned agent configuration unavailable');
  const { tenant_id: tenant, alias } = actor;
  expect(initial.agents.some(agent => agent.tenant_id === tenant && agent.alias === alias)).toBe(true);
  const accountsResponse = await apiGet(page, '/v3/console/quota-accounts');
  expect(accountsResponse.status).toBe(200);
  const initialAccount = (accountsResponse.body as unknown as { accounts: QuotaAccountCard[] }).accounts.find(account => account.id === accountId);
  expect(initialAccount).toMatchObject({ id: accountId, label: accountLabel, payer_tenant_id: tenant, enabled: beforeAccount?.enabled });
  const hasCeiling = initial.alias_routing_ceiling.some(row => row.tenant_id === tenant && row.alias === alias && row.account_id === accountId);
  const priorBinding = initial.agent_account_bindings.find(row => row.tenant_id === tenant && row.agent_alias === alias && row.account_id === accountId);
  if (priorBinding && priorBinding.enabled !== true) throw new Error('refusing to change a pre-existing inactive account binding');
  const occupied = new Set(initial.agent_account_bindings.filter(row => row.tenant_id === tenant && row.agent_alias === alias && row.enabled === true).map(row => Number(row.priority)));
  let priority = 0; while (occupied.has(priority) && priority <= 32767) priority++;
  if (priority > 32767) throw new Error('no canonical binding priority available');
  const mutations: Extract<ConfigMutation, { resource: 'batch' }>['mutations'] = [];
  if (!hasCeiling) mutations.push({ resource: 'alias_routing_ceiling', action: 'create', tenant_id: tenant, alias, account_id: accountId });
  if (!priorBinding) mutations.push({ resource: 'agent_account_binding', action: 'create', tenant_id: tenant, agent_alias: alias,
    account_id: accountId, value: { priority, enabled: true } });
  const posts: { method: string; path: string }[] = [];
  const observe = (value: unknown) => {
    const request = value as PublicRequest; if (request.method() !== 'POST') return;
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/v3/console/provider-auth/') || path === '/v3/console/provider-auth'
      || path.startsWith('/v3/console/quota-environments') || /^\/v3\/console\/agents\/[^/]+\/[^/]+\/(?:quota|authentication|provider-auth)(?:\/|$)/u.test(path)) posts.push({ method: 'POST', path });
  };
  page.on('request', observe);
  const application = { attempted: false }; let originalError: unknown;
  const readCard = async (card: V4Locator, location: 'principal' | 'agent') => {
    const readings: { state: string; remaining: number[]; deadline: string | null; message: string | null }[] = [];
    await card.waitFor({ timeout: 30_000 });
    for (const [size, suffix] of [[{ width: 1440, height: 900 }, '1440'], [{ width: 390, height: 844 }, '390']] as const) {
      await page.setViewportSize(size);
      const reading = { state: options.stage === 'verified' ? 'Disponible' : 'Pendiente de autenticación',
        remaining: [] as number[], deadline: null as string | null, message: null as string | null };
      await card.getByText(reading.state, { exact: true }).waitFor({ timeout: 20_000 });
      if (options.stage === 'verified') {
        for (const [name, remaining] of [['5 h', options.expectedRemaining[0]], ['Semanal', options.expectedRemaining[1]]] as const) {
          const meter = card.getByRole('meter', { name: `Restante ${name}`, exact: true }); await meter.waitFor({ timeout: 20_000 });
          const value = await meter.evaluate(element => element.getAttribute('value'));
          expect(value).toBe(String(remaining));
          expect(await meter.evaluate(element => element.classList.contains('opacity-50'))).toBe(false);
          reading.remaining.push(Number(value));
        }
      } else {
        const notice = card.getByRole('region', { name: 'Inicio de sesión de la cuenta', exact: true });
        const message = notice.getByText('La autenticación venció. Autentica la cuenta de nuevo.', { exact: true });
        await message.waitFor({ timeout: 20_000 });
        reading.deadline = await notice.locator('time').evaluate(element => element.getAttribute('datetime'));
        expect(reading.deadline).toBe(options.expiresAt); reading.message = await message.innerText();
      }
      await (card as unknown as { scrollIntoViewIfNeeded(): Promise<void> }).scrollIntoViewIfNeeded();
      const geometry = await card.evaluate(element => ({ left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right,
        width: element.clientWidth, scroll_width: element.scrollWidth, viewport: innerWidth }));
      expect(geometry.left).toBeGreaterThanOrEqual(0); expect(geometry.right).toBeLessThanOrEqual(size.width);
      expect(geometry.scroll_width).toBeLessThanOrEqual(geometry.width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: join(evidenceDirectory, `same-account-${location}-${options.stage}-${suffix}.png`), fullPage: false });
      await record(`${location}-${suffix}`, { account_id: accountId, tenant, alias, geometry, reading, card: await card.innerText() });
      readings.push(reading);
    }
    return readings;
  };
  try {
    if (mutations.length) {
      const receipt = await change(page, { resource: 'batch', action: 'apply', mutations }, initial.revision, () => { application.attempted = true; });
      await record('binding-applied', receipt);
    }
    const bound = await configuration(page);
    expect(bound.agent_account_bindings?.some(row => row.tenant_id === tenant && row.agent_alias === alias && row.account_id === accountId && row.enabled === true)).toBe(true);
    const boundResponse = await apiGet(page, '/v3/console/quota-accounts'); expect(boundResponse.status).toBe(200);
    const boundAccount = (boundResponse.body as unknown as { accounts: QuotaAccountCard[] }).accounts.find(account => account.id === accountId);
    expect(boundAccount).toMatchObject({ id: accountId, label: accountLabel, enabled: beforeAccount?.enabled });
    expect(boundAccount?.agents.some(agent => agent.tenant_id === tenant && agent.alias === alias && agent.enabled)).toBe(true);
    const snapshotResponse = await apiGet(page, '/v3/console/quota-environments'); expect(snapshotResponse.status).toBe(200);
    const snapshot = snapshotResponse.body as unknown as EnvironmentRead;
    if (options.stage === 'expired') {
      const published = snapshot.operations.find(item => item.id === operationId);
      expect(published).toMatchObject({ action: 'authenticate', status: 'failed', error_code: 'AUTH_EXPIRED', result: { expires_at: options.expiresAt } });
      expect(snapshot.environments.some(environment => environment.id === published?.environment_id && environment.account_id === accountId)).toBe(true);
    }
    await record('same-account', { actor: { tenant_id: tenant, alias }, account: boundAccount, operation,
      authenticate_ids_before: beforeIds, runtime_claim: 'Vinculación pública de lectura; no acredita un runtime del agente autenticado.' });
    const principalReading = await readCard(page.getByRole('article', { name: `Cuotas de ${accountLabel}`, exact: true }), 'principal');
    const route = `/config?seccion=agentes&agente=${encodeURIComponent(`${tenant}/${alias}`)}`;
    expect((await page.goto(baseUrl + route, { waitUntil: 'domcontentloaded' }))?.status()).toBe(200);
    const detail = page.getByRole('dialog').getByRole('region', { name: `Disponibilidad de ${alias}`, exact: true });
    const card = detail.getByRole('article', { name: `Cuotas de ${accountLabel}`, exact: true });
    const agentReading = await readCard(card, 'agent');
    await record('principal-and-agent', { account_id: accountId, operation_id: operationId, principal: principalReading, agent: agentReading });
    expect(agentReading).toEqual(principalReading);
  } catch (error) { originalError = error; throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    try {
      if (application.attempted) {
        const current = await configuration(page);
        expect(Array.isArray(current.agent_account_bindings)).toBe(true);
        expect(Array.isArray(current.alias_routing_ceiling)).toBe(true);
        const remove: Extract<ConfigMutation, { resource: 'batch' }>['mutations'] = [];
        const currentBinding = current.agent_account_bindings?.find(row => row.tenant_id === tenant && row.agent_alias === alias && row.account_id === accountId);
        const currentCeiling = current.alias_routing_ceiling?.find(row => row.tenant_id === tenant && row.alias === alias && row.account_id === accountId);
        if (!priorBinding && currentBinding) {
          expect(currentBinding).toMatchObject({ priority, enabled: true });
          remove.push({ resource: 'agent_account_binding', action: 'delete', tenant_id: tenant, agent_alias: alias, account_id: accountId });
        }
        if (!hasCeiling && currentCeiling) {
          expect(currentCeiling).toMatchObject({ account_payer_tenant: tenant, created_by_tenant: tenant });
          remove.push({ resource: 'alias_routing_ceiling', action: 'delete', tenant_id: tenant, alias, account_id: accountId });
        }
        await record('binding-reconciled', { apply_attempted: application.attempted, current_binding: currentBinding ?? null,
          current_ceiling: currentCeiling ?? null, removal: remove });
        if (remove.length) await record('binding-restored', await change(page, { resource: 'batch', action: 'apply', mutations: remove }, configurationRevision(current)));
        const restored = await configuration(page);
        expect(restored.agent_account_bindings?.filter(row => row.tenant_id === tenant && row.agent_alias === alias && row.account_id === accountId))
          .toEqual(priorBinding ? [priorBinding] : []);
        expect(restored.alias_routing_ceiling?.some(row => row.tenant_id === tenant && row.alias === alias && row.account_id === accountId)).toBe(hasCeiling);
      }
    } catch (error) { cleanupErrors.push(error); }
    try {
      if (viewport) await page.setViewportSize(viewport);
      if (page.url() !== originalUrl) await page.goto(originalUrl, { waitUntil: 'domcontentloaded' });
    } catch (error) { cleanupErrors.push(error); }
    try {
      const afterIds = await authenticationIds(); const afterAccount = await accountState();
      await record('read-only-authentication', { account_id: accountId, authenticate_ids_before: beforeIds, authenticate_ids_after: afterIds,
        public_operational_posts: posts, account_before: beforeAccount, account_after: afterAccount });
      expect(afterIds).toEqual(beforeIds); expect(afterAccount).toEqual(beforeAccount); expect(posts).toEqual([]);
    } catch (error) { cleanupErrors.push(error); }
    finally { (page as ObservedPage).off('request', observe); }
    reportCleanupFailures(originalError, cleanupErrors);
  }
}
