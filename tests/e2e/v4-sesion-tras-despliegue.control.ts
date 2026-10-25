import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { docker } from '../../services/gateway/src/fleet/host-computer.fixtures.js';
import { TMUX_SOCKET } from '../../packages/adapter-sdk/src/shared-session/types.js';
import { type CancelDeployActor } from './v4-fleet-cancel-deploy.flow.js';
import { apiGet } from './v4-console-real-browser.helpers.js';
import { observeDeploymentSession } from './v4-sesion-tras-despliegue.observe.js';

export interface SessionProviderState {
  pid: number; starttime: string; nativeSessionId: string; turnId: string | null;
  inputBytes: number; submits: number; draftLength: number; draftSha256: string;
  model: string | null; identitySha256: string; contextSha256: string | null;
}
export interface SessionDelivery {
  id: string; status: string; last_error: string | null; execution_started_at: Date | null;
}
export interface AutomaticOperation {
  id: string; actor_subject: string | null; status: string; version: string; expected_revision: string;
  desired_revision: string | null; applied_revision: string | null; steps: { name: string; status: string; evidence?: unknown }[];
  created_at: Date; updated_at: Date; events: { event: string; created_at: Date; metadata: Record<string, unknown> }[];
}

const stateRoot = (actor: CancelDeployActor) => '/home/cauce/.cauce/' + actor.runtime;
const controlRoot = (actor: CancelDeployActor) => stateRoot(actor) + '/space/projects/.h13-provider/';

export async function sessionKeys(actor: CancelDeployActor, keys: string[], literal = false): Promise<void> {
  await docker(['exec', '--user', 'cauce', '--env', 'TMUX_TMPDIR=' + stateRoot(actor), actor.container,
    '/usr/bin/tmux', '-N', '-L', TMUX_SOCKET, 'send-keys', '-t', '=cauce-' + actor.runtime + ':agente',
    ...(literal ? ['-l'] : []), ...keys]);
}

export async function sessionControl(actor: CancelDeployActor, name: string): Promise<void> {
  if (name !== 'hold-next-turn' && !/^release-[a-f0-9-]{36}$/u.test(name)) throw new Error('the provider control name is unsupported');
  await docker(['exec', '--user', 'cauce', actor.container, 'python3', '-I', '-B', '-c',
    'import os,sys;fd=os.open(sys.argv[1],os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600);os.close(fd)', controlRoot(actor) + name]);
}

export async function providerState(actor: CancelDeployActor): Promise<SessionProviderState> {
  return JSON.parse(await docker(['exec', '--user', 'cauce', actor.container, 'python3', '-I', '-B', '-c',
    'import pathlib,sys;print(pathlib.Path(sys.argv[1]).read_text())', controlRoot(actor) + 'state.json'])) as SessionProviderState;
}

export async function observeAutomaticActor(actor: CancelDeployActor) {
  const session = await observeDeploymentSession(actor);
  const compositor = await docker(['exec', '--user', 'cauce', '--env', 'TMUX_TMPDIR=' + stateRoot(actor), actor.container,
    '/usr/bin/tmux', '-N', '-L', TMUX_SOCKET, 'capture-pane', '-p', '-e', '-t', '=cauce-' + actor.runtime + ':agente']);
  const identity = (await actor.fixture.computer.pool.query<{ primary_account_id: string; model_id: string; primary_room_id: string }>(
    'SELECT primary_account_id,model_id,primary_room_id FROM agents WHERE tenant_id=$1 AND alias=$2',
    [actor.fixture.tenantId, actor.alias])).rows[0];
  if (!identity) throw new Error('the owned agent identity disappeared');
  const containerCreatedAt = await docker(['inspect', '--format', '{{.Created}}', actor.container]);
  return { ...session, provider: await providerState(actor), compositor, identity, containerCreatedAt };
}

export async function assertSessionTurnOrdering(actor: CancelDeployActor, marker: string, operation: AutomaticOperation): Promise<unknown> {
  const delivery = await deliveryState(actor, marker);
  expect(delivery).toHaveLength(1);
  const done = (await actor.fixture.computer.pool.query<{ created_at: Date }>(
    "SELECT created_at FROM delivery_acks WHERE delivery_id=$1 AND applied AND status='done' ORDER BY id", [delivery[0]?.id])).rows;
  expect(done).toHaveLength(1);
  const doneAt = done[0]?.created_at.getTime();
  if (doneAt === undefined) throw new Error('the held delivery has no applied completion timestamp');
  const prepared = operation.events.find(event => event.event === 'step_completed' && event.metadata.step === 'prepare');
  const stopping = operation.events.find(event => event.event === 'step_started' && event.metadata.step === 'stop');
  if (!prepared || !stopping) throw new Error('the automatic update lacks its durable prepare/stop chronology');
  expect(new Date(prepared.created_at).getTime()).toBeGreaterThanOrEqual(doneAt);
  expect(new Date(stopping.created_at).getTime()).toBeGreaterThanOrEqual(doneAt);
  const created = await docker(['inspect', '--format', '{{.Created}}', actor.container]);
  expect(Date.parse(created)).toBeGreaterThanOrEqual(doneAt);
  return { doneAt: new Date(doneAt).toISOString(), preparedAt: prepared.created_at, stopStartedAt: stopping.created_at,
    replacementCreatedAt: created };
}

export async function deliveryState(actor: CancelDeployActor, marker: string): Promise<SessionDelivery[]> {
  return (await actor.fixture.computer.pool.query<SessionDelivery>(`SELECT delivery.id,delivery.status,delivery.last_error,delivery.execution_started_at
    FROM deliveries delivery JOIN messages message ON message.id=delivery.message_id
    WHERE message.tenant_id=$1 AND message.body->>'text'=$2 AND delivery.recipient_tenant=$1 AND delivery.recipient_alias=$3`,
  [actor.fixture.tenantId, marker, actor.alias])).rows;
}

export async function sendSessionDelivery(actor: CancelDeployActor): Promise<{ marker: string }> {
  const marker = 'FLEET-DEPLOY-DELIVERY-' + randomUUID();
  const { page, baseUrl, tenantId } = actor.fixture;
  await page.goto(baseUrl + '/messages/' + tenantId + '/' + actor.alias, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Mensaje para ' + actor.alias).fill(marker);
  await page.getByRole('button', { name: 'Enviar', exact: true }).click();
  return { marker };
}

export async function finishSessionDelivery(actor: CancelDeployActor, marker: string): Promise<Record<string, unknown>> {
  let delivery: SessionDelivery[] = [];
  await expect.poll(async () => {
    delivery = await deliveryState(actor, marker);
    if (delivery[0]?.status === 'dead') throw new Error('the owned delivery died: ' + JSON.stringify(delivery));
    return delivery[0]?.status;
  }, { timeout: 90_000, interval: 500 }).toBe('done');
  expect(delivery).toHaveLength(1);
  expect(delivery[0]?.execution_started_at).not.toBeNull();
  const acknowledgements = (await actor.fixture.computer.pool.query<{ status: string; renewal: boolean }>(
    'SELECT status,renewal FROM delivery_acks WHERE delivery_id=$1 AND applied ORDER BY id', [delivery[0]?.id])).rows;
  expect(acknowledgements.filter(row => !row.renewal).map(row => row.status)).toEqual(['accepted', 'started', 'done']);
  return { marker, delivery, acknowledgements };
}

export async function automaticOperations(actor: CancelDeployActor): Promise<AutomaticOperation[]> {
  return (await actor.fixture.computer.pool.query<AutomaticOperation>(`SELECT operation.id,
    (SELECT metadata->>'actor_subject' FROM fleet_operation_events WHERE operation_id=operation.id AND event='queued'
      ORDER BY id LIMIT 1) AS actor_subject,operation.status,
    operation.version,operation.expected_revision,operation.desired_revision,operation.applied_revision,operation.steps,
    operation.created_at,operation.updated_at,COALESCE((SELECT jsonb_agg(jsonb_build_object('event',event.event,
      'created_at',event.created_at,'metadata',event.metadata) ORDER BY event.id) FROM fleet_operation_events event
      WHERE event.operation_id=operation.id),'[]'::jsonb) AS events
    FROM fleet_operations operation WHERE operation.company_id=$1 AND operation.kind='update'
      AND operation.target->>'resource'='agent' AND operation.target->>'tenant_id'=$2 AND operation.target->>'alias'=$3
    ORDER BY operation.created_at,operation.id`, [actor.fixture.company, actor.fixture.tenantId, actor.alias])).rows;
}

export async function observeAutomaticQuota(actor: CancelDeployActor): Promise<unknown> {
  const { page, baseUrl, tenantId } = actor.fixture;
  await page.goto(baseUrl + '/config?seccion=agentes&agente=' + encodeURIComponent(tenantId + '/' + actor.alias),
    { waitUntil: 'domcontentloaded' });
  const reader = page.getByRole('region', { name: 'Cuota de ' + actor.alias, exact: true });
  await reader.waitFor({ timeout: 20_000 });
  const query = reader.getByRole('button', { name: 'Consultar cuota', exact: true });
  await expect.poll(() => query.isDisabled(), { timeout: 30_000 }).toBe(false);
  await query.click();
  const path = '/v3/console/agents/' + tenantId + '/' + actor.alias + '/quota';
  let observed: Awaited<ReturnType<typeof apiGet>> | undefined;
  await expect.poll(async () => {
    observed = await apiGet(page, path);
    if (observed.body.status === 'failed') throw new Error('the physical agent quota failed: ' + JSON.stringify(observed.body));
    return observed.body.status;
  }, { timeout: 90_000, interval: 1_000 }).toBe('ok');
  expect(observed?.body).toMatchObject({ operation: { status: 'done' }, sample: { ok: true, effective_remaining_percent: 75,
    windows: [{ window_key: '5h', remaining_percent: 75, window_minutes: 300 }] } });
  const operations = (await actor.fixture.computer.pool.query(`SELECT id,status,error_code,claim_epoch::int,receipt,result
    FROM agent_quota_operations WHERE tenant_id=$1 AND alias=$2 ORDER BY created_at`, [tenantId, actor.alias])).rows;
  expect(operations.at(-1)).toMatchObject({ status: 'done', error_code: null,
    receipt: { status: 'measured', container_name: actor.container } });
  const observations = (await actor.fixture.computer.pool.query(`SELECT status,reader_available,account_id,sample
    FROM agent_quota_observations WHERE tenant_id=$1 AND alias=$2`, [tenantId, actor.alias])).rows;
  expect(observations).toMatchObject([{ status: 'ok', reader_available: true, sample: observed?.body.sample }]);
  expect(JSON.stringify({ observed, operations, observations })).not.toContain('CONTAINER_ISOLATION_DRIFT');
  return { observed, operations, observations };
}
