import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CauceRepository } from '@cauce/store';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGateway } from '../../services/gateway/src/app.js';
import { PostgresConsoleUserStore } from '../../services/gateway/src/console-users.js';
import { PasswordAuthProvider } from '../../services/gateway/src/password-auth.js';
import type { ProviderAuthReservation } from '../../services/gateway/src/console/provider-auth-reservation.js';
import { AgentProviderAuthBroker } from '../../services/gateway/src/fleet/agent-provider-auth-broker.js';
import { SignedFleetAuthorityClient } from '../../services/gateway/src/fleet/authority/signed-client.js';
import { COMPUTER_RUNTIME, FIXTURE_DEVICE_CODE, FIXTURE_LOGIN_DONE, FIXTURE_PROVIDER_IDENTITY, docker } from '../../services/gateway/src/fleet/host-computer.fixtures.js';
import { apiGet, bodySnippet, type IgnoredConsoleRule, type V4Locator } from './v4-console-real-browser.helpers.js';
import { coverageCapture, coverageEnabled, coverageEnqueue, coverageOperations, startCoverageFixture,
  type CoverageFixture, type CoverageOperation } from './v4-agentes-l-helpers.js';

let fixture: CoverageFixture | undefined;
let gateway: Awaited<ReturnType<typeof buildGateway>> | undefined;
let alias = '', runtime = '', container = '';
let deniedScope = '';
const fixtureRules: IgnoredConsoleRule[] = [
  { id: 'provider-auth-scope-403', reason: 'scope endpoint probed while provider account is disabled',
    matches: (text, url) => text.includes('status of 403')
      && deniedScope !== '' && new URL(url, 'https://fixture.invalid').pathname === deniedScope },
];
const evidence: Record<string, unknown> = { section: 'H', provider: 'pinned interactive fixture CLI' };
const active = () => { if (!fixture) throw new Error('operation authentication fixture absent'); return fixture; };
const card = () => active().page.getByRole('region', { name: 'Operación de flota', exact: true });
const auth = () => card().getByRole('region', { name: 'Autenticación de la operación', exact: true });
interface AuthFrame { payload: string | Buffer }
interface AuthSocket {
  on(event: 'framereceived' | 'framesent', callback: (frame: AuthFrame) => void): void;
  on(event: 'close', callback: () => void): void;
}
type TextInputPage = CoverageFixture['page'] & { keyboard: { insertText(value: string): Promise<void> } };
const socketObservations: { session_id: string; sent: { type: string; bytes: number; at_ms: number }[]; closed: boolean }[] = [];
const providerPosts: { path: string; status: number }[] = [];
let terminalOutput = '';

async function loginTtl(ttlMs: number): Promise<void> {
  const { computer, page, baseUrl } = active();
  await page.goto('about:blank', { waitUntil: 'domcontentloaded' });
  await (gateway ?? computer.app).close();
  const uid = process.geteuid?.() ?? 0;
  const broker = new AgentProviderAuthBroker(computer.pool, { ttlMs });
  gateway = await buildGateway({ pool: computer.pool, repository: new CauceRepository(computer.pool), logger: false,
    consoleOrigins: [baseUrl], hostSetup: computer.packager, agentProviderAuthBroker: broker,
    signedFleetAuthorityClient: new SignedFleetAuthorityClient(join(dirname(computer.installRoot), 'authority/signed.sock'), { ownerUid: uid, peerUid: uid }),
    authProvider: new PasswordAuthProvider({ users: new PostgresConsoleUserStore(computer.pool), signingKey: Buffer.alloc(32, 61) }) });
  await gateway.listen({ host: '127.0.0.1', port: Number(new URL(computer.gatewayUrl).port) });
}

async function waitReceipt(id: string, status: string): Promise<CoverageOperation> {
  let operation: CoverageOperation | undefined;
  await expect.poll(async () => {
    operation = (await coverageOperations(active(), alias)).find(row => row.id === id);
    return operation?.status;
  }, { timeout: 240_000, interval: 1000 }).toBe(status);
  if (!operation) throw new Error('auth operation absent');
  return operation;
}
async function reservation(operationId: string): Promise<ProviderAuthReservation> {
  const current = (await active().computer.pool.query<{ reservation: ProviderAuthReservation }>(`SELECT metadata->'provider_auth' AS reservation
    FROM fleet_operation_events WHERE operation_id=$1 AND metadata ? 'provider_auth' ORDER BY id DESC LIMIT 1`, [operationId])).rows[0]?.reservation;
  if (!current) throw new Error('provider login reservation absent');
  return current;
}
async function releasedReservation(operationId: string, sessionId: string): Promise<ProviderAuthReservation> {
  let current: ProviderAuthReservation | undefined;
  await expect.poll(async () => {
    current = await reservation(operationId);
    expect(current.session_id).toBe(sessionId);
    return current.state;
  }, { timeout: 360_000, interval: 1000 }).toBe('released');
  if (!current) throw new Error('provider login release absent');
  return current;
}
async function prepare(): Promise<V4Locator> {
  const { page, baseUrl, tenantId, room, hostId, accountId } = active();
  await page.goto(`${baseUrl}/config?seccion=agentes`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Añadir agente', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Añadir agente' });
  await dialog.getByText('Solo preparar, sin desplegar', { exact: true }).click();
  const panel = dialog.getByRole('region', { name: 'Alta operativa de agente', exact: true });
  await panel.getByLabel('Espacio de trabajo operativo').selectOption(tenantId);
  await panel.getByLabel('Alias operativo').fill(alias);
  await panel.getByLabel('Nombre visible operativo').fill(`Autenticación ${active().run}`);
  await panel.getByLabel('Clave física de ejecución').fill(runtime);
  await panel.getByRole('checkbox', { name: new RegExp(`· "${room}"$`, 'u') }).check();
  await panel.getByLabel('Grupo primario').selectOption(room);
  await panel.getByLabel('Host operativo').locator(`option[value="${hostId}"]`).waitFor({ state: 'attached', timeout: 30_000 });
  await panel.getByLabel('Host operativo').selectOption(hostId);
  await panel.getByLabel('Plantilla de ejecución').selectOption('0');
  await panel.getByLabel('Cuenta principal de ejecución').selectOption(accountId);
  return panel;
}
async function openExecution(): Promise<void> {
  const { page, baseUrl, tenantId } = active();
  const target = `${baseUrl}/config?seccion=agentes&agente=${encodeURIComponent(`${tenantId}/${alias}`)}`;
  if (page.url() === target) {
    await page.reload({ waitUntil: 'domcontentloaded' });
  } else {
    await page.goto(target, { waitUntil: 'domcontentloaded' });
  }
  const tab = page.getByRole('tab', { name: 'Ejecución', exact: true });
  await tab.waitFor({ timeout: 30_000 });
  await tab.click();
}
async function signIn(): Promise<V4Locator> {
  terminalOutput = '';
  await auth().getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
  const dialog = active().page.getByRole('dialog', { name: 'Iniciar sesión en GPT / Codex', exact: true });
  await dialog.waitFor({ timeout: 30_000 });
  await dialog.getByLabel('Terminal privada de autenticación', { exact: true }).waitFor({ timeout: 60_000 });
  await expect.poll(() => terminalOutput, { timeout: 60_000 }).toContain(`enter the code ${FIXTURE_DEVICE_CODE}`);
  await expect.poll(() => terminalOutput, { timeout: 30_000 }).toContain('"type":"ready"');
  return dialog;
}

beforeAll(async () => {
  process.env.CAUCE_PLAZOS_FACTOR ??= '3';
  fixture = await startCoverageFixture('oh', { ignoredConsoleRules: fixtureRules, providerLogin: true, extraSourceFiles: ['packages/store/src/device-authorization.ts',
    'packages/store/src/device-authorization-authority.ts', 'services/gateway/src/device-authorization.ts',
    'packages/store/src/repository/fleet-operation-recovery.ts', 'ops/cli/fleet_executor_probe_cache.py',
    'ops/cli/fleet_provider_capability_probe.py', 'services/gateway/src/fleet/space-backup.failure.ts',
    'packages/protocol/src/context-retirement.ts', 'packages/store/src/context-retirement.ts',
    'packages/store/src/context-git-retirement.ts', 'ops/container-runtime/cauce_container_restart.py'] });
  alias = `auth${fixture.run}`; runtime = `auth-${fixture.run}`; container = `${fixture.prefix}-${runtime}`;
  const sharedReceipts = fixture.receipts;
  const ownReceipts = join(process.cwd(), '.delegados/v4/recibos/e2e-a19-rojas-viejas-1025/h', fixture.run);
  fixture.receipts = ownReceipts;
  await mkdir(ownReceipts, { recursive: true, mode: 0o700 });
  const sharedClose = fixture.close.bind(fixture);
  fixture.close = async () => { try { await sharedClose(); } finally { await cp(sharedReceipts, ownReceipts, { recursive: true }); } };
  const sourcePaths = ['tests/e2e/v4-agentes-h-real-browser.test.ts', 'services/gateway/src/console/provider-auth-socket.ts'];
  evidence.sources = Object.fromEntries(await Promise.all(sourcePaths.map(async path => [path, createHash('sha256').update(await readFile(path)).digest('hex')])));
  console.info('A19_H_RECEIPTS', JSON.stringify({ receipts: fixture.receipts, run: fixture.run, prefix: fixture.prefix }));
  fixture.page.on('websocket', candidate => {
    const path = new URL(candidate.url()).pathname;
    const matched = /^\/v3\/console\/provider-auth\/sessions\/([a-f0-9-]+)\/stream$/u.exec(path);
    if (!matched?.[1]) return;
    const observed = { session_id: matched[1], sent: [] as { type: string; bytes: number; at_ms: number }[], closed: false };
    socketObservations.push(observed);
    const socket = candidate as unknown as AuthSocket;
    socket.on('framereceived', ({ payload }) => {
      terminalOutput += Buffer.isBuffer(payload) ? payload.toString('utf8') : payload;
    });
    socket.on('framesent', ({ payload }) => {
      let type = 'input';
      if (typeof payload === 'string') {
        try { const value = JSON.parse(payload) as { type?: unknown }; type = value.type === 'auth' || value.type === 'resize' ? value.type : 'unknown_control'; }
        catch { type = 'unknown_control'; }
      }
      observed.sent.push({ type, bytes: Buffer.byteLength(payload), at_ms: performance.now() });
    });
    socket.on('close', () => { observed.closed = true; });
  });
  fixture.page.on('response', response => {
    const path = new URL(response.url()).pathname;
    if (response.request().method() === 'POST' && /^\/v3\/console\/provider-auth\/sessions(?:\/[a-f0-9-]+\/(?:verify|cancel|ticket))?$/u.test(path)) {
      providerPosts.push({ path, status: response.status() });
    }
  });
}, 900_000);
afterAll(async () => {
  if (!fixture) return;
  try {
    evidence.operations = await coverageOperations(fixture, alias).catch(() => []);
    evidence.journal = (await fixture.computer.onComputer(['journalctl', '--user', '-u', fixture.unit, '--no-pager', '-n', '500'])).stdout;
    evidence.browser = { unexpected: fixture.errors.unexpected, trace: fixture.errors.trace };
    evidence.provider_auth = { sockets: socketObservations, posts: providerPosts,
      fixture_success_observed: terminalOutput.includes(`${FIXTURE_LOGIN_DONE} ${FIXTURE_PROVIDER_IDENTITY}`) };
    await writeFile(join(fixture.receipts, 'h-evidence.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  } finally {
    try { await gateway?.close(); } finally { await fixture.close(); }
  }
}, 300_000);

describe('login de una operación desde Chromium con CLI de prueba y autoridad persistente reales', () => {
  it('H01 H02 H03 H04 prepara el scope, recupera rechazo y caducidad, verifica y reanuda manualmente', async () => {
    const { computer, page, accountId } = active();
    try {
      await loginTtl(30_000);
      const create = await prepare();
      const waiting = await coverageEnqueue(active(), create, alias, 'create', ['awaiting_auth']);
      evidence.waiting = waiting;
      expect(waiting.steps.find(step => step.name === 'authenticate')?.status).toBe('waiting');
      await card().getByText('Esperando tu acción', { exact: true }).waitFor({ timeout: 30_000 });
      expect(await docker(['inspect', '--format', '{{.State.Running}}', container])).toBe('true');
      await coverageCapture(active(), 'h-o01-awaiting-auth');
      await page.goto('about:blank', { waitUntil: 'domcontentloaded' });
      await computer.pool.query('UPDATE provider_accounts SET enabled=false WHERE id=$1', [accountId]);
      deniedScope = `/v3/console/provider-auth/operations/${waiting.id}/scope`;
      await openExecution();
      await auth().getByRole('alert').filter({ hasText: 'No se pudo preparar el inicio de sesión de esta operación' }).waitFor({ timeout: 30_000 });
      expect(await auth().getByRole('button', { name: 'Iniciar sesión', exact: true }).count()).toBe(0);
      await coverageCapture(active(), 'h01-scope-denegado');
      await computer.pool.query('UPDATE provider_accounts SET enabled=true WHERE id=$1', [accountId]);
      const lock = await computer.pool.connect();
      try {
        await lock.query('BEGIN');
        await lock.query('SELECT id FROM fleet_operations WHERE id=$1 FOR UPDATE', [waiting.id]);
        await auth().getByRole('button', { name: 'Reintentar', exact: true }).click();
        await auth().getByText('Preparando el inicio de sesión…', { exact: true }).waitFor({ timeout: 20_000 });
        await coverageCapture(active(), 'h01-preparando');
      } finally { await lock.query('ROLLBACK'); lock.release(); }
      await auth().getByRole('button', { name: 'Iniciar sesión', exact: true }).waitFor({ timeout: 30_000 });
      deniedScope = '';
      const first = await signIn();
      const expiringSession = await reservation(waiting.id);
      const reservedOperation = await waitReceipt(waiting.id, 'awaiting_auth');
      await coverageCapture(active(), 'h02-dialogo-terminal');
      await first.getByText('La conexión caducó. Relee la operación antes de continuar.', { exact: true }).waitFor({ timeout: 90_000 });
      expect(await first.getByLabel('Terminal privada de autenticación', { exact: true }).count()).toBe(0);
      const expirationRelease = await releasedReservation(waiting.id, expiringSession.session_id);
      const expired = await waitReceipt(waiting.id, 'awaiting_auth');
      expect(expired.version).toBeGreaterThan(reservedOperation.version);
      evidence.expired_login = { operation_id: expired.id, version: expired.version,
        release: expirationRelease };
      await coverageCapture(active(), 'h04-login-caducado');
      await first.getByRole('button', { name: 'Cerrar', exact: true }).click();
      await loginTtl(900_000);
      await openExecution();
      await auth().getByRole('button', { name: 'Iniciar sesión', exact: true }).waitFor({ timeout: 30_000 });
      const cancelled = await signIn();
      const cancelledSession = await reservation(waiting.id);
      const cancelReservedOperation = await waitReceipt(waiting.id, 'awaiting_auth');
      await cancelled.getByRole('button', { name: 'Cancelar conexión', exact: true }).click();
      await cancelled.getByText('Conexión cancelada', { exact: true }).waitFor({ timeout: 30_000 });
      const cancellationRelease = await releasedReservation(waiting.id, cancelledSession.session_id);
      const released = await waitReceipt(waiting.id, 'awaiting_auth');
      expect(released.version).toBeGreaterThan(cancelReservedOperation.version);
      evidence.cancelled_login = { operation_id: released.id, version: released.version,
        release: cancellationRelease };
      await cancelled.getByRole('button', { name: 'Cerrar', exact: true }).click();
      await openExecution();
      await auth().getByRole('button', { name: 'Iniciar sesión', exact: true }).waitFor({ timeout: 30_000 });
      const second = await signIn();
      const successfulSession = await reservation(waiting.id);
      await second.locator('.xterm-helper-textarea').click();
      await (page as TextInputPage).keyboard.insertText(FIXTURE_DEVICE_CODE);
      await second.locator('.xterm-helper-textarea').press('Enter');
      await expect.poll(() => terminalOutput, { timeout: 30_000 }).toContain(`${FIXTURE_LOGIN_DONE} ${FIXTURE_PROVIDER_IDENTITY}`);
      const sentInput = socketObservations.at(-1)?.sent.filter(row => row.type === 'input').map(row => row.bytes);
      expect(sentInput).toEqual([Buffer.byteLength(FIXTURE_DEVICE_CODE), 1]);
      evidence.interactive_input = { method: 'native Chromium keyboard.insertText followed by Enter', input_frame_bytes: sentInput, fixture_success_observed: true };
      const verify = second.getByRole('button', { name: 'Verificar conexión', exact: true });
      await coverageEnabled(verify); await verify.click();
      await auth().getByText('Cuenta verificada. Ya puedes pulsar «Reanudar» para que la operación siga.', { exact: true }).waitFor({ timeout: 60_000 });
      expect(providerPosts).toContainEqual({ path: `/v3/console/provider-auth/sessions/${successfulSession.session_id}/verify`, status: 200 });
      const verifiedSession = await apiGet(page, `/v3/console/provider-auth/sessions/${successfulSession.session_id}`);
      expect(verifiedSession.status).toBe(200);
      expect(verifiedSession.body).toMatchObject({ session_id: successfulSession.session_id, operation_id: waiting.id, status: 'authenticated', cleanup_pending: false, error: null });
      evidence.authenticated_session = { session_id: successfulSession.session_id, verify_post_status: 200,
        reread_status: verifiedSession.body.status, cleanup_pending: verifiedSession.body.cleanup_pending,
        release: await releasedReservation(waiting.id, successfulSession.session_id) };
      expect(await second.count()).toBe(0);
      const verified = await waitReceipt(waiting.id, 'awaiting_auth');
      expect(verified.version).toBeGreaterThan(released.version);
      evidence.verified_pending_manual_resume = verified;
      const profile = `${COMPUTER_RUNTIME.home}/.cauce-profiles/${runtime}/${createHash('sha256').update(accountId).digest('hex')}/auth.json`;
      expect(await docker(['exec', '--user', COMPUTER_RUNTIME.user, container, 'test', '-s', profile])).toBe('');
      await coverageCapture(active(), 'h03-cuenta-verificada-reanudar-manual');
      await card().getByRole('button', { name: 'Reanudar', exact: true }).click();
      const succeeded = await waitReceipt(waiting.id, 'succeeded');
      expect(succeeded.steps.every(step => step.status === 'succeeded')).toBe(true);
      const probes = (await computer.pool.query<{ phase: string; state: string; valid: boolean }>(`SELECT
        metadata->'bootstrap_probe'->'probe'->>'phase' AS phase, metadata->'bootstrap_probe'->>'state' AS state,
        metadata->'bootstrap_probe'->'proof'->>'reply'='CAUCE_BOOTSTRAP_' || (metadata->'bootstrap_probe'->'probe'->>'nonce') AS valid
        FROM fleet_operation_events WHERE operation_id=$1 AND metadata ? 'bootstrap_probe'`, [waiting.id])).rows;
      for (const phase of ['bootstrap', 'normal']) expect(probes.some(row => row.phase === phase && row.state === 'succeeded' && row.valid)).toBe(true);
      evidence.completed = { operation: succeeded, probes };
      await card().getByText('Terminada', { exact: true }).waitFor({ timeout: 30_000 });
      await coverageCapture(active(), 'h03-operacion-reanudada-terminada');
      active().errors.assertClean();
    } catch (error) {
      evidence.failure = error instanceof Error ? error.message : String(error);
      evidence.page = await bodySnippet(page);
      await coverageCapture(active(), 'h-failure');
      throw error;
    }
  }, 900_000);
});
