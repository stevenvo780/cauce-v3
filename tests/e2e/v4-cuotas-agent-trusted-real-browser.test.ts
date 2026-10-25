import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startAgentQuotaDocker, type QuotaAgentPlacement } from './v4-cuotas-agent-real-browser.fixtures.js';
import { apiGet, asV4Page, BrowserErrorLog, fillRegistration, HERMETIC_INSTANCE_RULES, openRegistration,
  type V4Page, type V4Person } from './v4-console-real-browser.helpers.js';

vi.stubEnv('CAUCE_PLAZOS_FACTOR', '3');
const { newTrustedPage, startConsoleFunctionalFixture } = await import('./console-functional-browser.fixtures.js');

const run = randomUUID().replaceAll('-', '').slice(0, 8);
const directory = resolve('.delegados/v4/recibos/q1-cuota-cuentas-confiables-1025/agent', run);
const dynamicAccount = `codex-dyn-${run}`;
const person: V4Person = {
  email: `zz-canary-trusted-${run}@example.invalid`,
  name: 'Dueño cuotas dinámicas',
  password: `Synthetic-quota-${run}-password`,
  company: { slug: `zz-canary-trusted-${run}`, name: 'Cuotas Confiables' },
};
const errors = new BrowserErrorLog(HERMETIC_INSTANCE_RULES);
let fixture: Awaited<ReturnType<typeof startConsoleFunctionalFixture>> | undefined;
let physical: Awaited<ReturnType<typeof startAgentQuotaDocker>> | undefined;
let page: V4Page;
const active = () => { if (!fixture) throw new Error('quota browser fixture missing'); return fixture; };
const runtime = () => { if (!physical) throw new Error('physical quota fixture missing'); return physical; };
const quotaPath = (agent: QuotaAgentPlacement) => `/v3/console/agents/${agent.tenant_id}/${agent.alias}/quota`;

beforeAll(async () => {
  if (process.env.CAUCE_TEST_DATABASE_URL || process.env.VITE_USE_MOCKS === 'true') throw new Error('owned PostgreSQL and mocks=false required');
  await mkdir(directory, { recursive: true });
  fixture = await startConsoleFunctionalFixture();
  page = asV4Page(await newTrustedPage(fixture, { width: 1440, height: 900 }));
  errors.watch(page, 'quota-agent-owner');
  const form = await openRegistration(page, fixture.baseUrl);
  await fillRegistration(form, person);
  await form.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
  await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });
  physical = await startAgentQuotaDocker(fixture, person.email, directory, undefined, { dynamicAccount });
  vi.stubEnv('CAUCE_HARNESS_DESCRIPTOR_APPROVALS_FILE', physical.approvalsFile);
  vi.stubEnv('CAUCE_HARNESS_DESCRIPTOR_DIRECTORY', physical.descriptors);
}, 600_000);

afterAll(async () => {
  try { await physical?.close(); }
  finally { try { await fixture?.close(); } finally { vi.unstubAllEnvs(); } }
}, 180_000);

async function openSheet(agent: QuotaAgentPlacement) {
  await runtime().announce();
  await page.goto(`${active().baseUrl}/config?seccion=agentes&agente=${encodeURIComponent(`${agent.tenant_id}/${agent.alias}`)}`, { waitUntil: 'domcontentloaded' });
  const sheet = page.getByRole('dialog');
  await sheet.getByText(agent.alias, { exact: true }).first().waitFor({ timeout: 20_000 });
  await sheet.getByRole('region', { name: `Cuota de ${agent.alias}`, exact: true }).waitFor({ timeout: 20_000 });
  return sheet;
}

describe('cuota en navegador real con cuenta dinámica y cuentas confiables', () => {
  it('termina measured desde la consola cuando la cuenta no es un perfil estático', async () => {
    const agent = runtime().agents[0];
    if (!agent) throw new Error('dynamic quota agent missing');
    expect(agent.primary_account_id).toBe(dynamicAccount);

    const sheet = await openSheet(agent);
    const reader = sheet.getByRole('region', { name: `Cuota de ${agent.alias}`, exact: true });
    await expect.poll(async () => reader.getByRole('button', { name: 'Consultar cuota', exact: true }).isDisabled(), { timeout: 20_000 }).toBe(false);
    await reader.getByRole('button', { name: 'Consultar cuota', exact: true }).click();
    await reader.getByText('La consulta sigue pendiente; la ficha relee el resultado del ordenador.', { exact: true }).waitFor({ timeout: 15_000 });

    expect(await runtime().executor.runOnce()).toBe(true);
    const operation = (await active().database.pool.query<{ status: string; error_code: string | null }>(
      'SELECT status,error_code FROM agent_quota_operations WHERE tenant_id=$1 AND alias=$2', [agent.tenant_id, agent.alias])).rows[0];
    expect(operation).toEqual({ status: 'done', error_code: null });

    await reader.getByRole('button', { name: 'Releer cuota', exact: true }).click();
    await reader.getByText('Último saldo medido: 75%.', { exact: true }).waitFor({ timeout: 20_000 });
    await reader.getByText('5 h: 75% medido', { exact: true }).waitFor({ timeout: 20_000 });

    const reading = await apiGet(page, quotaPath(agent));
    expect(reading.status).toBe(200);
    expect(reading.body).toMatchObject({
      status: 'ok',
      reader_available: true,
      operation: { status: 'done' },
      sample: { windows: [expect.objectContaining({ remaining_percent: 75, window_minutes: 300 })] },
    });

    const stored = (await active().database.pool.query<{ account_id: string; sample: { effective_remaining_percent: number } }>(
      'SELECT account_id,sample FROM agent_quota_observations WHERE tenant_id=$1 AND alias=$2',
      [agent.tenant_id, agent.alias],
    )).rows[0];
    if (!stored) throw new Error('dynamic quota observation was not persisted');
    expect(stored.account_id).toBe(dynamicAccount);
    expect(stored.sample.effective_remaining_percent).toBe(75);
  }, 120_000);
});
