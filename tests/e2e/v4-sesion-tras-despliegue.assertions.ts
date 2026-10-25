import { join } from 'node:path';
import { expect } from 'vitest';
import { enqueueCancelDeploy, observeCancelDeployActor, type CancelDeployActor } from './v4-fleet-cancel-deploy.flow.js';
import { cancelDeployPrefix, cancelDeployRun, type CancelDeployFixture } from './v4-fleet-cancel-deploy.helpers.js';
import { assertNativeSessionTurn, seedSessionContext } from './v4-sesion-tras-despliegue.observe.js';
import type { SessionRelease } from './v4-sesion-tras-despliegue.release.js';
import { AUTO_SESSION_MODEL } from './v4-sesion-tras-despliegue.runtime.js';
import { automaticOperations, finishSessionDelivery, observeAutomaticActor, sendSessionDelivery,
  type AutomaticOperation } from './v4-sesion-tras-despliegue.control.js';

type Observation = Awaited<ReturnType<typeof observeAutomaticActor>>;
export interface Canary {
  actor: CancelDeployActor; before: Observation; knownOperations: Set<string>;
  context: Awaited<ReturnType<typeof seedSessionContext>>;
  native: Awaited<ReturnType<typeof assertNativeSessionTurn>>;
}
export type UnseededCanary = Omit<Canary, 'native'>;

async function createConfiguredActor(fixture: CancelDeployFixture, suffix: string): Promise<CancelDeployActor> {
  const { page, baseUrl, tenantId, hostId, accountId, room } = fixture;
  const alias = `deploy${cancelDeployRun}${suffix}`, runtime = `deploy-${cancelDeployRun}${suffix}`;
  await page.goto(`${baseUrl}/config?seccion=agentes`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Añadir agente', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Añadir agente' });
  await dialog.getByText('Solo preparar, sin desplegar', { exact: true }).click();
  const create = dialog.getByRole('region', { name: 'Alta operativa de agente', exact: true });
  await create.getByLabel('Espacio de trabajo operativo').selectOption(tenantId);
  await create.getByLabel('Alias operativo').fill(alias);
  await create.getByLabel('Nombre visible operativo').fill(`Despliegue ${cancelDeployRun}${suffix}`);
  await create.getByLabel('Clave física de ejecución').fill(runtime);
  await create.getByRole('checkbox', { name: new RegExp(`· "${room}"$`, 'u') }).check();
  await create.getByLabel('Grupo primario').selectOption(room);
  await create.getByLabel('Host operativo').locator(`option[value="${hostId}"]`).waitFor({ state: 'attached', timeout: 30_000 });
  await create.getByLabel('Host operativo').selectOption(hostId);
  await create.getByLabel('Plantilla de ejecución').selectOption('0');
  await create.getByLabel('Cuenta principal de ejecución').selectOption(accountId);
  await create.getByLabel('Modelo operativo').fill(AUTO_SESSION_MODEL);
  const container = await create.getByLabel('Contenedor operativo').inputValue();
  expect(container).toBe(`${cancelDeployPrefix}-${runtime}`);
  const actor = { fixture, alias, runtime, container };
  await enqueueCancelDeploy(actor, create, 'create');
  expect(await observeCancelDeployActor(actor)).toMatchObject({ running: true, adapterAlive: true });
  return actor;
}

export function createCanary(fixture: CancelDeployFixture, suffix: string): Promise<Canary>;
export function createCanary(fixture: CancelDeployFixture, suffix: string, initialize: false): Promise<UnseededCanary>;
export async function createCanary(fixture: CancelDeployFixture, suffix: string, initialize = true): Promise<Canary | UnseededCanary> {
  const actor = await createConfiguredActor(fixture, suffix);
  const context = await seedSessionContext(actor);
  const native = initialize
    ? await assertNativeSessionTurn(actor, await finishSessionDelivery(actor, (await sendSessionDelivery(actor)).marker)) : undefined;
  const before = await observeAutomaticActor(actor);
  if (native) {
    expect(before.provider.nativeSessionId).toBe(native.witness.native_session_id);
    expect(before.provider.contextSha256).toBe(context.sha256);
  }
  expect(before.runtime.context[context.path]).toBe(context.sha256);
  expect(before.provider.model).toBe(AUTO_SESSION_MODEL);
  expect(before.identity).toMatchObject({ primary_account_id: fixture.accountId, model_id: AUTO_SESSION_MODEL });
  expect(before.runtime.quarantine).toEqual([]);
  return { actor, before, context, ...(native ? { native } : {}),
    knownOperations: new Set((await automaticOperations(actor)).map(row => row.id)) };
}

async function newOperations(canary: UnseededCanary, release: SessionRelease): Promise<AutomaticOperation[]> {
  const rows = (await automaticOperations(canary.actor)).filter(row => {
    const origin = row.events.find(event => event.event === 'queued')?.metadata.maintenance;
    return !canary.knownOperations.has(row.id) && typeof origin === 'object' && origin !== null
      && 'release_sha256' in origin && origin.release_sha256 === release.manifest.release.sha256;
  });
  for (const row of rows.filter(operation => operation.status === 'cancelled')) {
    expect(row.events.some(event => event.metadata.maintenance_skipped === 'revision_changed')).toBe(true);
    expect(row.desired_revision).toBeNull();
    expect(row.steps.every(step => step.status === 'pending')).toBe(true);
  }
  return rows.filter(row => row.status !== 'cancelled');
}

function assertAutomaticOrigin(operation: AutomaticOperation, fixture: CancelDeployFixture, release: SessionRelease): void {
  const subject = operation.actor_subject;
  expect(subject).toMatch(new RegExp('^host:' + fixture.hostId + ':[a-f0-9]{64}$', 'u'));
  const queued = operation.events.find(row => row.event === 'queued');
  expect(queued?.metadata.maintenance).toMatchObject({ host_id: fixture.hostId, release_sha256: release.manifest.release.sha256,
    key_fingerprint: subject?.slice(subject.lastIndexOf(':') + 1) });
  const origin = queued?.metadata.maintenance;
  if (typeof origin !== 'object' || !origin || !('enrollment_id' in origin) || !('parameters_sha256' in origin)) {
    throw new Error('the automatic operation lacks its measured maintenance origin');
  }
  expect(origin.enrollment_id).toBeTypeOf('string');
  expect(origin.parameters_sha256).toMatch(/^[a-f0-9]{64}$/u);
}

export async function assertDeferred(canary: UnseededCanary, fixture: CancelDeployFixture, release: SessionRelease,
  reasons: readonly string[]): Promise<AutomaticOperation> {
  let operation: AutomaticOperation | undefined;
  await expect.poll(async () => {
    const rows = await newOperations(canary, release);
    expect(rows.length).toBeLessThanOrEqual(1);
    operation = rows[0];
    if (operation?.status === 'failed') throw new Error('the automatic update failed: ' + JSON.stringify(operation));
    return operation?.status === 'queued'
      && operation.events.some(row => row.event === 'renewed' && row.metadata.maintenance_deferred !== undefined);
  }, { timeout: 120_000, interval: 1_000 }).toBe(true);
  if (!operation) throw new Error('the deferred automatic operation disappeared');
  expect(operation.status).toBe('queued');
  expect(operation.desired_revision).toBeNull();
  expect(operation.applied_revision).toBeNull();
  expect(operation.events.some(row => row.event === 'step_completed' && row.metadata.step === 'prepare')).toBe(false);
  expect(operation.steps.every(row => row.status === 'pending')).toBe(true);
  const deferred = operation.events.find(row => row.event === 'renewed' && row.metadata.maintenance_deferred !== undefined);
  const delay = deferred?.metadata.maintenance_deferred;
  if (typeof delay !== 'object' || !delay || !('reason' in delay) || !('attempt' in delay) || !('retry_at' in delay)) {
    throw new Error('the automatic deferral lacks its durable retry receipt');
  }
  expect(reasons).toContain(delay.reason);
  expect(Number.isSafeInteger(delay.attempt)).toBe(true);
  expect(Number(delay.attempt)).toBeGreaterThanOrEqual(1);
  expect(delay.retry_at).toBeTypeOf('string');
  expect(Date.parse(String(delay.retry_at))).toBeGreaterThan(new Date(deferred.created_at).getTime());
  assertAutomaticOrigin(operation, fixture, release);
  return operation;
}

export async function assertUpdated(canary: Canary, fixture: CancelDeployFixture, release: SessionRelease) {
  let operation: AutomaticOperation | undefined;
  await expect.poll(async () => {
    const rows = await newOperations(canary, release);
    expect(rows.length).toBeLessThanOrEqual(1);
    operation = rows[0];
    if (operation?.status === 'failed') throw new Error('the automatic update failed: ' + JSON.stringify(operation));
    return operation?.status;
  }, { timeout: 180_000, interval: 1_000 }).toBe('succeeded');
  if (!operation) throw new Error('the successful automatic operation disappeared');
  assertAutomaticOrigin(operation, fixture, release);
  expect(Number(operation.desired_revision)).toBeGreaterThan(Number(operation.expected_revision));
  expect(operation.applied_revision).toBe(operation.desired_revision);
  expect(operation.events.some(row => row.event === 'step_completed' && row.metadata.step === 'prepare')).toBe(true);
  const resume = operation.events.find(row => Object.hasOwn(row.metadata, 'maintenance_resume_sha256'));
  expect(resume?.event).toBe('step_completed');
  expect(resume?.metadata.maintenance_resume_sha256).toMatch(/^[a-f0-9]{64}$/u);
  expect(operation.events.some(row => row.event === 'succeeded')).toBe(true);
  expect(operation.steps.find(row => row.name === 'stop')?.status).toBe('succeeded');
  const observed = await observeAutomaticActor(canary.actor);
  const expectedRelease = join(fixture.computer.installRoot, fixture.company, fixture.hostId, 'release', release.manifest.release.sha256);
  expect(observed.actor.id).not.toBe(canary.before.actor.id);
  expect(observed.actor.release).toBe(expectedRelease);
  expect(observed.actor.bundleDigest).toBe(release.manifest.pins.adapter_digest);
  expect(observed.actor.volumes).toEqual(canary.before.actor.volumes);
  expect(observed.identity).toEqual(canary.before.identity);
  expect(observed.provider.nativeSessionId).toBe(canary.native.witness.native_session_id);
  expect(observed.provider.identitySha256).toBe(canary.before.provider.identitySha256);
  expect(observed.provider.model).toBe(AUTO_SESSION_MODEL);
  expect(observed.runtime.context[canary.context.path]).toBe(canary.context.sha256);
  expect(observed.runtime.quarantine).toEqual([]);
  return { operation, observed };
}

export function assertUnchanged(before: Observation, after: Observation): void {
  expect(after.actor).toEqual(before.actor);
  expect(after.provider).toEqual(before.provider);
  expect(after.compositor).toBe(before.compositor);
  expect(after.runtime.metadata).toEqual(before.runtime.metadata);
  expect(after.runtime.sockets).toEqual(before.runtime.sockets);
  expect(after.runtime.tmux).toEqual(before.runtime.tmux);
  expect(after.identity).toEqual(before.identity);
  expect(after.runtime.quarantine).toEqual(before.runtime.quarantine);
}
