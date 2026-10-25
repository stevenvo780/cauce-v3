import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { terminalGrantAllows } from '@cauce/store';
import { buildGateway } from '../../services/gateway/src/app.js';
import { hashPassword } from '../../services/gateway/src/password.js';
import type { PasswordAuthProvider } from '../../services/gateway/src/password-auth.js';
import { registerTerminalControlPlane } from '../../services/gateway/src/terminal/plugin.js';
import { terminalCapabilityAnnouncement, type TerminalConfig } from '../../services/gateway/src/terminal/config.js';
import { newTrustedPage, startConsoleFunctionalFixture } from './console-functional-browser.fixtures.js';
import {
  apiGet, asV4Page, BrowserErrorLog, bodySnippet, fillRegistration, HERMETIC_INSTANCE_RULES,
  login, openRegistration, PATTERN_DEFECT_RULE, syntheticPerson, type IgnoredConsoleRule, type V4Page, type V4Person,
} from './v4-console-real-browser.helpers.js';

const run = randomUUID().replaceAll('-', '').slice(0, 8);
const evidence = join(process.cwd(), '.delegados/v4/recibos/e2e-a1-commit-1025/grants');

function registration(label: string): V4Person {
  const person = syntheticPerson(`grants-${label}`, run);
  return {
    ...person,
    email: `zz-canary-grants-${label}-${run}@example.test`,
    name: `zz-canary-grants-${label}-${run}`,
    company: { name: `zz-canary-empresa-${label}-${run}`, slug: `zz-canary-grants-${label}-${run}` },
  };
}

const ownerA = registration('ownera');
const ownerB = registration('ownerb');
const delegate = {
  email: `zz-canary-delegada-${run}@example.test`,
  name: `zz-canary-delegada-${run}`,
};
const agentAlias = `zz-canary-agent-${run}`;
const agentAlias2 = `zz-canary-agent2-${run}`;

function expectedRoleForbidden(path: string, id: string): IgnoredConsoleRule {
  return {
    id,
    reason: 'un rol sin esa capacidad recibe 403 al abrir ajustes',
    matches: (text, url) => {
      try { return text.includes('status of 403') && new URL(url).pathname === path; }
      catch { return false; }
    },
  };
}

const errors = new BrowserErrorLog([
  ...HERMETIC_INSTANCE_RULES,
  PATTERN_DEFECT_RULE,
  expectedRoleForbidden('/v3/console/fleet/hosts', 'grants-host-inventory-403'),
  expectedRoleForbidden('/v3/console/fleet/hosts/enrollments', 'grants-host-enrollments-403'),
  expectedRoleForbidden('/v3/console/fleet/capability', 'grants-fleet-capability-403'),
  expectedRoleForbidden('/v3/console/fleet/operations/recent', 'grants-fleet-history-403'),
]);

let fixture: Awaited<ReturnType<typeof startConsoleFunctionalFixture>> | undefined;
let terminalGateway: Awaited<ReturnType<typeof buildGateway>> | undefined;
let grantsDirectory: string | undefined;
let ownerPage: V4Page | undefined;
let hubA = '';
let hubB = '';
let delegateId = '';
let grantId = '';
let wildcardId = '';

function active() {
  if (!fixture) throw new Error('V4 grants fixture is not initialized');
  return fixture;
}

function base() { return active().baseUrl; }
function pool() { return active().database.pool; }

async function freshPage(label: string): Promise<V4Page> {
  const page = asV4Page(await newTrustedPage(active(), { width: 1440, height: 900 }));
  errors.watch(page, label);
  return page;
}

async function capture(page: V4Page, name: string): Promise<void> {
  await mkdir(evidence, { recursive: true });
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.screenshot({ path: join(evidence, `${name}-${String(viewport.width)}.png`), fullPage: false });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

async function step<T>(page: V4Page, name: string, action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch (cause) {
    throw new Error(`${name} failed at ${page.url()}: ${await bodySnippet(page)} || console=${JSON.stringify(errors.trace.slice(-12))}`, { cause });
  }
}

async function register(page: V4Page, person: V4Person): Promise<void> {
  const form = await openRegistration(page, base());
  await fillRegistration(form, person);
  await form.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
  await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });
}

async function openGrants(page: V4Page) {
  await page.goto(`${base()}/config?seccion=acceso`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Ajustes', exact: true }).waitFor({ timeout: 20_000 });
  const panel = page.getByRole('region', { name: 'Concesiones de terminal', exact: true });
  await panel.waitFor({ timeout: 20_000 });
  return panel;
}

interface GrantRow {
  id: string; tenant_id: string; alias: string; modes: string[];
  expires_at: string | null; version: number; revoked: boolean;
}

async function storedGrants(): Promise<GrantRow[]> {
  const result = await pool().query<{
    id: string; tenant_id: string; alias: string; modes: string[];
    expires_at: Date | null; version: string; revoked_at: Date | null;
  }>(
    `SELECT id, tenant_id, alias, modes, expires_at, version::text AS version, revoked_at
     FROM terminal_grants WHERE company_id = $1 ORDER BY alias, created_at`, [ownerA.company.slug]);
  return result.rows.map((row) => ({
    id: row.id, tenant_id: row.tenant_id, alias: row.alias, modes: row.modes,
    expires_at: row.expires_at?.toISOString() ?? null, version: Number(row.version),
    revoked: row.revoked_at !== null,
  }));
}

interface GrantItem {
  id: string; alias: string; modes: string[]; expires_at: string | null; version: number;
}

function grantItem(value: unknown): GrantItem {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('grant item is not an object');
  const row = value as Record<string, unknown>;
  if (typeof row.id !== 'string' || typeof row.alias !== 'string' || !Array.isArray(row.modes)
    || !(row.expires_at === null || typeof row.expires_at === 'string')
    || typeof row.version !== 'number') throw new Error('grant item is not the expected shape');
  return {
    id: row.id, alias: row.alias, modes: row.modes.filter((mode): mode is string => typeof mode === 'string'),
    expires_at: row.expires_at, version: row.version,
  };
}

async function readGrants(page: V4Page): Promise<{ status: number; items: GrantItem[] }> {
  const response = await apiGet(page, '/v3/console/terminal/grants');
  const items = Array.isArray(response.body.items) ? response.body.items.map(grantItem) : [];
  return { status: response.status, items };
}

async function apiCall(
  page: V4Page, method: string, path: string, body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return page.evaluate(async (input: { method: string; path: string; body?: unknown }) => {
    const session = await (await fetch('/v3/auth/session', { credentials: 'include', cache: 'no-store' }))
      .json() as { csrf_token?: string };
    const response = await fetch(input.path, {
      method: input.method, credentials: 'include', cache: 'no-store',
      headers: { 'x-csrf-token': session.csrf_token ?? '' },
      ...(input.body === undefined ? {} : {
        headers: { 'content-type': 'application/json', 'x-csrf-token': session.csrf_token ?? '' },
        body: JSON.stringify(input.body),
      }),
    });
    return { status: response.status, body: await response.json().catch(() => ({})) as Record<string, unknown> };
  }, { method, path, body });
}

beforeAll(async () => {
  if (process.env.CAUCE_TEST_DATABASE_URL) throw new Error('this E2E requires its own Testcontainers PostgreSQL');
  if (process.env.VITE_USE_MOCKS === 'true') throw new Error('mocks=false is required');
  grantsDirectory = await mkdtemp(join(tmpdir(), 'zz-canary-terminal-grants-'));
  const grantsFile = join(grantsDirectory, 'grants.json');
  await writeFile(grantsFile, JSON.stringify({ version: 1, grants: [] }), { mode: 0o600 });
  const config: TerminalConfig = {
    wsPath: '/v3/console/terminal/ws', ticketKey: randomBytes(32),
    relayToken: randomBytes(32).toString('base64url'),
    relayInstanceIds: new Set(['f1b-grants-browser-relay']), grantsFile,
    ticketTtlSeconds: 30, sessionTtlSeconds: 900, sessionMaxTotalSeconds: 1800,
    claimLeaseSeconds: 150, maxSessionsPerOperator: 10,
    operatorHeader: 'x-cauce-operator', operators: new Set(),
  };
  let authProvider: PasswordAuthProvider | undefined;
  fixture = await startConsoleFunctionalFixture({ configureGateway(_app, _database, auth) { authProvider = auth; } });
  await fixture.app.close();
  if (!authProvider) throw new Error('terminal fixture password provider is missing');
  terminalGateway = await buildGateway({
    pool: pool(), authProvider, consoleOrigins: [base()],
    terminalCapability: terminalCapabilityAnnouncement(config),
    https: { key: await readFile(fixture.pki.server.key), cert: await readFile(fixture.pki.server.cert),
      ca: await readFile(fixture.pki.ca.cert), requestCert: true, rejectUnauthorized: true },
  });
  await terminalGateway.register(registerTerminalControlPlane, {
    pool: pool(), authProvider, config,
    measuredFacts: { factsFor: async () => undefined },
    governanceRelay: { readFile: async () => ({ error: 'unavailable', reason: 'QA has no manuals' }) },
  });
  await terminalGateway.listen({ host: '127.0.0.1', port: Number(new URL(fixture.gatewayUrl).port) });
  ownerPage = await freshPage('owner-a');
  await register(ownerView(), ownerA);
  const registeredA = await pool().query<{ id: string; tenant_id: string; company_id: string }>(
    'SELECT id, tenant_id, company_id FROM console_users WHERE email = $1', [ownerA.email]);
  expect(registeredA.rows).toHaveLength(1);
  hubA = registeredA.rows[0]?.tenant_id ?? '';
  expect(registeredA.rows[0]?.company_id).toBe(ownerA.company.slug);
  const ownerAId = registeredA.rows[0]?.id ?? '';
  for (const alias of [agentAlias, agentAlias2]) {
    await pool().query(
      `INSERT INTO agents(tenant_id,alias,harness_id,display_name,enabled,container_name,runtime_user,home_directory,state_directory,company_id)
       VALUES($1,$2,'fake',$2,true,$3,'stev',$4,$5,$6)`,
      [hubA, alias, `zz-canary-runtime-${alias}`, active().directory, `${active().directory}/state/${alias}`, ownerA.company.slug]);
    await pool().query(
      `INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES($1,'office',$2,'operator')`, [hubA, alias]);
  }
  const passwordHash = await hashPassword(`Grants-${randomBytes(18).toString('hex')}`);
  const inserted = await pool().query<{ id: string }>(
    `INSERT INTO console_users(email,email_normalized,password_hash,display_name,role,tenant_id,alias,active)
     VALUES($1,$2,$3,$4,'operator',$5,$6,true) RETURNING id`,
    [delegate.email, delegate.email.toLowerCase(), passwordHash, delegate.name, hubA, agentAlias]);
  delegateId = inserted.rows[0]?.id ?? '';
  expect(delegateId).not.toBe('');
  await pool().query(
    `INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,permissions,enabled)
     VALUES($1,$2,$3,ARRAY['read','route','control'],true)`, [delegateId, hubA, agentAlias]);
  expect(ownerAId).not.toBe('');

  const pageB = await freshPage('owner-b');
  await register(pageB, ownerB);
  const registeredB = await pool().query<{ tenant_id: string; company_id: string }>(
    'SELECT tenant_id, company_id FROM console_users WHERE email = $1', [ownerB.email]);
  expect(registeredB.rows).toHaveLength(1);
  hubB = registeredB.rows[0]?.tenant_id ?? '';
  expect(registeredB.rows[0]?.company_id).toBe(ownerB.company.slug);
  await pageB.context().close();
}, 600_000);

afterAll(async () => {
  const errors: unknown[] = [];
  try { await terminalGateway?.close(); } catch (cause) { errors.push(cause); }
  try { await fixture?.close(); } catch (cause) { errors.push(cause); }
  if (grantsDirectory) {
    try { await rm(grantsDirectory, { recursive: true, force: true }); } catch (cause) { errors.push(cause); }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'Terminal grants fixture cleanup failed');
}, 180_000);

function ownerView() {
  if (!ownerPage) throw new Error('owner A has no browser page');
  return ownerPage;
}

describe('concesiones de terminal V4 en Chromium contra gateway y PostgreSQL reales', () => {
  it('1. lista vacía al abrir el panel', async () => {
    const page = ownerView();
    const panel = await step(page, 'open empty grants panel', async () => {
      const opened = await openGrants(page);
      await opened.getByText('Todavía no hay concesiones en esta empresa.', { exact: true }).waitFor({ timeout: 20_000 });
      return opened;
    });
    expect(await readGrants(page)).toEqual({ status: 200, items: [] });
    expect(await storedGrants()).toEqual([]);
    await capture(page, 'grants-empty');
    expect(panel).toBeDefined();
  }, 240_000);

  it('2. alta por persona, alias y modo visor con caducidad', async () => {
    const page = ownerView();
    await step(page, 'create grant from the panel', async () => {
      const panel = await openGrants(page);
      const form = panel.getByRole('form', { name: 'Crear concesión de terminal', exact: true });
      const selects = form.locator('select');
      await selects.nth(0).selectOption({ label: `${delegate.name} · ${delegate.email}` });
      await selects.nth(1).selectOption({ label: `${hubA}:${agentAlias}` });
      await form.getByRole('checkbox', { name: 'Visor de TUI', exact: true }).check();
      await form.locator('input[type="datetime-local"]').fill('2030-06-01T10:30');
      await form.getByRole('button', { name: 'Crear concesión', exact: true }).click();
      await panel.getByText('Concesión de terminal creada.', { exact: true }).waitFor({ timeout: 20_000 });
      await panel.getByText(new RegExp(`${delegate.name}.*${hubA}:${agentAlias}.*Visor de TUI`, 'u')).first().waitFor({ timeout: 20_000 });
    });
    const viaApi = await readGrants(page);
    expect(viaApi.status).toBe(200);
    expect(viaApi.items).toHaveLength(1);
    expect(viaApi.items[0]).toMatchObject({ alias: agentAlias, modes: ['harness'] });
    grantId = viaApi.items[0]?.id ?? '';
    expect(grantId).not.toBe('');
    const stored = await storedGrants();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ id: grantId, alias: agentAlias, modes: ['harness'], version: 1, revoked: false });
    expect(stored[0]?.expires_at).toContain('2030-');
    const audit = await pool().query<{ n: number }>(
      "SELECT count(*)::int AS n FROM audit_events WHERE action='terminal.grant.create' AND metadata->>'grant_id'=$1", [grantId]);
    expect(audit.rows[0]?.n).toBe(1);
    await capture(page, 'grants-created');
  }, 240_000);

  it('3. edición de modo y caducidad con CAS y conflicto visible', async () => {
    const page = ownerView();
    const second = await freshPage('owner-a-second');
    await login(second, base(), ownerA);
    await step(page, 'first context opens the editor', async () => {
      const panel = await openGrants(page);
      await panel.getByRole('button', { name: 'Editar', exact: true }).first().click();
      const form = panel.getByRole('form', { name: `Editar concesión de ${delegate.email}`, exact: true });
      await form.waitFor({ timeout: 20_000 });
      await form.getByRole('checkbox', { name: 'Shell', exact: true }).check();
    });
    await step(second, 'second context saves first and bumps the version', async () => {
      const panel = await openGrants(second);
      await panel.getByRole('button', { name: 'Editar', exact: true }).first().click();
      const form = panel.getByRole('form', { name: `Editar concesión de ${delegate.email}`, exact: true });
      await form.getByRole('checkbox', { name: 'TUI escribible', exact: true }).check();
      await form.locator('input[type="datetime-local"]').fill('2031-06-01T09:15');
      await form.getByRole('button', { name: 'Guardar concesión', exact: true }).click();
      await panel.getByText('Concesión de terminal actualizada.', { exact: true }).waitFor({ timeout: 20_000 });
    });
    expect((await storedGrants())[0]).toMatchObject({ modes: ['harness', 'harness_rw'], version: 2 });
    await step(page, 'stale save shows the CAS conflict in Spanish', async () => {
      const panel = page.getByRole('region', { name: 'Concesiones de terminal', exact: true });
      const form = panel.getByRole('form', { name: `Editar concesión de ${delegate.email}`, exact: true });
      errors.expectHttpError(`/v3/console/terminal/grants/${grantId}`, 409);
      await form.getByRole('button', { name: 'Guardar concesión', exact: true }).click();
      await expect.poll(async () => panel.getByRole('alert').innerText(), { timeout: 20_000 })
        .toContain('La concesión cambió mientras guardabas (campo: versión)');
      await capture(page, 'grants-cas-conflict');
    });
    await step(page, 'reload shows the winning modes and expiry', async () => {
      const panel = await openGrants(page);
      await panel.getByText(/Visor de TUI, TUI escribible/u).waitFor({ timeout: 20_000 });
    });
    const viaApi = await readGrants(page);
    expect(viaApi.items[0]).toMatchObject({ modes: ['harness', 'harness_rw'], version: 2 });
    expect(viaApi.items[0]?.expires_at ?? '').toContain('2031-');
    await second.context().close();
  }, 240_000);

  it('4. revocación con confirmación cierra la sesión abierta de esa persona', async () => {
    const page = ownerView();
    const sessionId = randomUUID();
    await pool().query(
      `INSERT INTO terminal_sessions(id,operator_id,attributed,console_subject,tenant_id,alias,container,mode,ticket_sha256,reason,expires_at,
        request_id,request_sha256,browser_owner_sha256,browser_owner_generation,relay_instance_id)
       VALUES($1,$2,true,'browser-e2e',$3,$4,'zz-canary-runtime','harness',$5,'fixture',clock_timestamp()+interval '1 hour',$6,$5,$5,1,$7)`,
      [sessionId, delegate.email, hubA, agentAlias, Buffer.alloc(32, 7), randomUUID(), 'a'.repeat(64)]);
    await pool().query(
      `INSERT INTO terminal_control_holds(session_id,tenant_id,alias,operator_id,reason,expires_at)
       VALUES($1,$2,$3,$4,'fixture',clock_timestamp()+interval '1 hour')`, [sessionId, hubA, agentAlias, delegate.email]);
    await step(page, 'cancel keeps the grant, confirm revokes it', async () => {
      const panel = await openGrants(page);
      await panel.getByRole('button', { name: 'Revocar', exact: true }).first().click();
      const confirmation = panel.getByRole('region', { name: 'Confirmar revocación de concesión', exact: true });
      await confirmation.waitFor({ timeout: 20_000 });
      await capture(page, 'grants-revoke-confirmation');
      await confirmation.getByRole('button', { name: 'Cancelar', exact: true }).click();
      expect(await confirmation.count()).toBe(0);
      expect((await storedGrants())[0]?.revoked).toBe(false);
      await panel.getByRole('button', { name: 'Revocar', exact: true }).first().click();
      await confirmation.getByRole('button', { name: 'Confirmar revocación', exact: true }).click();
      await panel.getByText('Concesión revocada. Sus sesiones abiertas se cerraron.', { exact: true })
        .waitFor({ timeout: 20_000 });
      await panel.getByText('Todavía no hay concesiones en esta empresa.', { exact: true }).waitFor({ timeout: 20_000 });
    });
    expect((await storedGrants())[0]?.revoked).toBe(true);
    const session = await pool().query<{ revoked_at: Date | null }>(
      'SELECT revoked_at FROM terminal_sessions WHERE id=$1', [sessionId]);
    expect(session.rows[0]?.revoked_at).not.toBeNull();
    const hold = await pool().query<{ released_at: Date | null }>(
      'SELECT released_at FROM terminal_control_holds WHERE session_id=$1', [sessionId]);
    expect(hold.rows[0]?.released_at).not.toBeNull();
    expect((await readGrants(page)).items).toEqual([]);
  }, 240_000);

  it('5. concesión comodín sobre todos los agentes del tenant', async () => {
    const page = ownerView();
    await step(page, 'create wildcard grant from the panel', async () => {
      const panel = await openGrants(page);
      const form = panel.getByRole('form', { name: 'Crear concesión de terminal', exact: true });
      const selects = form.locator('select');
      await selects.nth(0).selectOption({ label: `${delegate.name} · ${delegate.email}` });
      await selects.nth(1).selectOption({ label: `${hubA}:* · Todos los agentes` });
      await form.getByRole('checkbox', { name: 'Visor de TUI', exact: true }).uncheck();
      await form.getByRole('checkbox', { name: 'Shell', exact: true }).check();
      await form.getByRole('button', { name: 'Crear concesión', exact: true }).click();
      await panel.getByText('Concesión de terminal creada.', { exact: true }).waitFor({ timeout: 20_000 });
      await panel.getByText(new RegExp(`${hubA}:\\*`, 'u')).first().waitFor({ timeout: 20_000 });
    });
    const viaApi = await readGrants(page);
    expect(viaApi.items).toHaveLength(1);
    expect(viaApi.items[0]).toMatchObject({ alias: '*', modes: ['shell'] });
    wildcardId = viaApi.items[0]?.id ?? '';
    expect(wildcardId).not.toBe('');
    expect(await terminalGrantAllows(pool(), delegate.email, hubA, agentAlias, 'shell')).toBe(true);
    expect(await terminalGrantAllows(pool(), delegate.email, hubA, agentAlias2, 'shell')).toBe(true);
    expect(await terminalGrantAllows(pool(), delegate.email, hubA, agentAlias2, 'harness')).toBe(false);
    await capture(page, 'grants-wildcard');
  }, 240_000);

  it('6. un admin de otra empresa no ve ni toca nada, tampoco manipulando ids', async () => {
    const foreign = await freshPage('owner-b-foreign');
    await login(foreign, base(), ownerB);
    await step(foreign, 'foreign panel starts empty', async () => {
      const panel = await openGrants(foreign);
      await panel.getByText('Todavía no hay concesiones en esta empresa.', { exact: true }).waitFor({ timeout: 20_000 });
      await capture(foreign, 'grants-foreign-empty');
    });
    expect(hubB).not.toBe(hubA);
    expect((await readGrants(foreign)).items).toEqual([]);
    errors.expectHttpError(`/v3/console/terminal/grants/${wildcardId}`, 404);
    const patched = await apiCall(foreign, 'PATCH', `/v3/console/terminal/grants/${wildcardId}`, {
      expected_version: 1, modes: ['harness'],
    });
    expect(patched.status).toBe(404);
    errors.expectHttpError(`/v3/console/terminal/grants/${wildcardId}`, 404);
    const deleted = await apiCall(foreign, 'DELETE',
      `/v3/console/terminal/grants/${wildcardId}?expected_version=1`);
    expect(deleted.status).toBe(404);
    errors.expectHttpError('/v3/console/terminal/grants', 404);
    const created = await apiCall(foreign, 'POST', '/v3/console/terminal/grants', {
      tenant_id: hubA, alias: agentAlias, grantee_human_id: delegateId, modes: ['shell'],
    });
    expect(created.status).toBe(404);
    const mine = await readGrants(ownerView());
    expect(mine.items).toHaveLength(1);
    expect((await storedGrants()).filter((row) => !row.revoked)).toHaveLength(1);
    await foreign.context().close();
  }, 240_000);

  it('7. errores en español con campo y motivo', async () => {
    const page = ownerView();
    await step(page, 'empty modes are explained in the editor', async () => {
      const panel = await openGrants(page);
      await panel.getByRole('button', { name: 'Editar', exact: true }).first().click();
      const form = panel.getByRole('form', { name: `Editar concesión de ${delegate.email}`, exact: true });
      await form.getByRole('checkbox', { name: 'Shell', exact: true }).uncheck();
      await form.getByRole('checkbox', { name: 'Visor de TUI', exact: true }).uncheck();
      await form.getByRole('button', { name: 'Guardar concesión', exact: true }).click();
      await expect.poll(async () => panel.getByRole('alert').innerText(), { timeout: 20_000 })
        .toContain('Campo «Modos»: elige al menos un modo');
      await form.getByRole('button', { name: 'Cancelar', exact: true }).click();
    });
    await step(page, 'duplicate grant explains person and agent fields', async () => {
      const panel = page.getByRole('region', { name: 'Concesiones de terminal', exact: true });
      const form = panel.getByRole('form', { name: 'Crear concesión de terminal', exact: true });
      const selects = form.locator('select');
      await selects.nth(0).selectOption({ label: `${delegate.name} · ${delegate.email}` });
      await selects.nth(1).selectOption({ label: `${hubA}:* · Todos los agentes` });
      errors.expectHttpError('/v3/console/terminal/grants', 409);
      await form.getByRole('button', { name: 'Crear concesión', exact: true }).click();
      await expect.poll(async () => panel.getByRole('alert').innerText(), { timeout: 20_000 })
        .toContain('Ya existe una concesión activa para esa persona sobre ese agente (campos: persona y agente)');
      await capture(page, 'grants-error-spanish');
    });
    expect((await storedGrants()).filter((row) => !row.revoked)).toHaveLength(1);
  }, 240_000);

  it('no quedan errores inesperados del navegador', () => {
    process.stdout.write(`V4 grants e2e tolerated console messages: ${JSON.stringify(Object.fromEntries(errors.ignored))}\n`);
    errors.assertClean();
  });
});
