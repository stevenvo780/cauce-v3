import { canonicallyEqual, sha256Hex, AliasSchema, ProfileRuntimeContractSchema, TenantSchema, type ProfileRuntimeContract, type Tenant } from '@cauce/protocol';
import { withTransaction, withAbortableTransaction, type DatabaseClient, type DatabasePool } from '../db.js';
import { agentContextReconcileLockKey } from './agent-context-lock.js';
import { StoreError } from './errors.js';

export const CONTEXT_WRITE_QUARANTINE_KIND = 'system.context.write.quarantine.v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SHA = /^[0-9a-f]{64}$/u;

export interface ContextWriterIdentity {
  readonly runtimeGeneration: string;
  readonly containerId: string;
  readonly writerInstanceId: string;
}
export interface ContextWriteDocument {
  readonly name: string;
  readonly path: string;
  readonly beforeSha: string | null;
  readonly targetSha: string | null;
}
export interface ContextWriteSnapshot {
  readonly revision: number | null;
  readonly profileSha256: string | null;
  readonly agentSha256: string;
  readonly expectation: ProfileRuntimeContract | null;
}
export interface ContextWriteDescriptor {
  readonly version: 1;
  readonly operationId: string;
  readonly token: string;
  readonly generation: string;
  readonly tenantId: Tenant;
  readonly alias: string;
  readonly writer: ContextWriterIdentity;
  readonly before: ContextWriteSnapshot;
  readonly after: ContextWriteSnapshot;
  readonly documents: readonly ContextWriteDocument[];
  readonly dispatch: 'reserved' | 'authorized';
  readonly completion: { readonly resolution: ContextWriteResolution; readonly proofSha256: string } | null;
}
export interface ReserveContextWriteInput {
  readonly operationId: string;
  readonly token: string;
  readonly generation: string;
  readonly tenantId: Tenant;
  readonly alias: string;
  readonly writer: ContextWriterIdentity;
  readonly expectedRevision: number | null;
  readonly expectedExpectation: ProfileRuntimeContract | null;
  readonly documents: readonly ContextWriteDocument[];
  readonly signal?: AbortSignal;
  readonly updateDesired?: (client: DatabaseClient) => Promise<void>;
}
export interface ContextWriterQuiescence {
  readonly operationId: string;
  readonly token: string;
  readonly generation: string;
  readonly writer: ContextWriterIdentity;
  readonly state: 'quiescent';
  readonly durability: 'post_fsync';
  readonly documents: readonly { readonly name: string; readonly path: string; readonly sha: string | null }[];
}
export type ContextWriteResolution = 'target' | 'old';

function conflict(message: string): never {
  throw new StoreError('conflict', message);
}
function unverifiedCommit(message: string): never {
  throw new StoreError('conflict', message, 'context_write_commit_unverified');
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 1024 && Buffer.from(value).every((byte) => byte >= 32);
}
function sha(value: unknown): value is string | null {
  return value === null || typeof value === 'string' && SHA.test(value);
}
function digest(value: unknown): string {
  return sha256Hex(value);
}
function same(left: unknown, right: unknown): boolean {
  return canonicallyEqual(left, right);
}
export function canonicalProfileRuntimeContract(value: unknown): ProfileRuntimeContract | undefined {
  const parsed = ProfileRuntimeContractSchema.safeParse(value);
  if (!parsed.success) return undefined;
  return { ...parsed.data, documents: [...parsed.data.documents].sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path)) };
}
function writer(value: unknown): value is ContextWriterIdentity {
  return record(value) && keys(value, ['runtimeGeneration', 'containerId', 'writerInstanceId'])
    && text(value.runtimeGeneration) && text(value.containerId) && typeof value.writerInstanceId === 'string' && UUID.test(value.writerInstanceId);
}
function snapshot(value: unknown): value is ContextWriteSnapshot {
  return record(value) && keys(value, ['revision', 'profileSha256', 'agentSha256', 'expectation'])
    && ((value.revision === null && value.profileSha256 === null)
      || (Number.isSafeInteger(value.revision) && Number(value.revision) >= 1 && typeof value.profileSha256 === 'string' && SHA.test(value.profileSha256)))
    && typeof value.agentSha256 === 'string' && SHA.test(value.agentSha256)
    && (value.expectation === null || canonicalProfileRuntimeContract(value.expectation) !== undefined);
}
function documents(value: unknown): value is readonly ContextWriteDocument[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 7) return false;
  const names = new Set<string>();
  const paths = new Set<string>();
  for (const item of value) {
    if (!record(item) || !keys(item, ['name', 'path', 'beforeSha', 'targetSha'])
      || !text(item.name) || !text(item.path) || !item.path.startsWith('/')
      || !sha(item.beforeSha) || !sha(item.targetSha) || names.has(item.name) || paths.has(item.path)) return false;
    names.add(item.name); paths.add(item.path);
  }
  return true;
}
function parseDescriptor(value: unknown): ContextWriteDescriptor | undefined {
  if (!record(value) || !keys(value, ['version', 'operationId', 'token', 'generation', 'tenantId', 'alias', 'writer', 'before', 'after', 'documents', 'dispatch', 'completion'])
    || value.version !== 1 || typeof value.operationId !== 'string' || !UUID.test(value.operationId)
    || typeof value.token !== 'string' || !UUID.test(value.token) || typeof value.generation !== 'string' || !UUID.test(value.generation)
    || !TenantSchema.safeParse(value.tenantId).success || !AliasSchema.safeParse(value.alias).success
    || !writer(value.writer) || !snapshot(value.before) || !snapshot(value.after) || !documents(value.documents)
    || !['reserved', 'authorized'].includes(String(value.dispatch))
    || (value.completion !== null && (!record(value.completion) || !keys(value.completion, ['resolution', 'proofSha256'])
      || !['target', 'old'].includes(String(value.completion.resolution)) || typeof value.completion.proofSha256 !== 'string' || !SHA.test(value.completion.proofSha256)))) return undefined;
  return value as unknown as ContextWriteDescriptor;
}

export async function assertAgentContextAdmissionAllowed(client: DatabaseClient, tenantId: Tenant, alias: string): Promise<void> {
  const rows = await client.query<{ id: string; payload: unknown; status: string; claim_token: string | null; lease_until: Date | null }>(
    `SELECT id,payload,status,claim_token::text,lease_until FROM jobs WHERE tenant_id=$1 AND kind=$2`,
    [tenantId, CONTEXT_WRITE_QUARANTINE_KIND],
  );
  for (const row of rows.rows) {
    const descriptor = parseDescriptor(row.payload);
    if (descriptor?.tenantId !== tenantId || descriptor.operationId !== row.id
      || row.lease_until !== null || row.claim_token !== descriptor.token) {
      conflict('context write quarantine metadata is invalid');
    }
    if (row.status === 'done' && descriptor.dispatch === 'authorized' && descriptor.completion !== null) continue;
    if (row.status !== 'running' || descriptor.completion !== null) {
      conflict('context write quarantine metadata is invalid');
    }
    if (descriptor.alias === alias) conflict('context write quarantine fences admission');
  }
}
function transaction<Value>(pool: DatabasePool, signal: AbortSignal | undefined, work: (client: DatabaseClient) => Promise<Value>): Promise<Value> {
  return signal === undefined ? withTransaction(pool, work) : withAbortableTransaction(pool, signal, work);
}
async function exclusive(client: DatabaseClient, tenantId: Tenant, alias: string): Promise<void> {
  await client.query("SET LOCAL lock_timeout='5000ms'");
  await client.query("SET LOCAL statement_timeout='10000ms'");
  await client.query("SET LOCAL idle_in_transaction_session_timeout='90000ms'");
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [agentContextReconcileLockKey(tenantId, alias)]);
}
export async function lockAgentContextSnapshot(client: DatabaseClient, tenantId: Tenant, alias: string): Promise<ContextWriteSnapshot> {
  const agent = await client.query<{ enabled: boolean; value: unknown }>(`SELECT enabled,to_jsonb(agent) AS value FROM agents agent WHERE tenant_id=$1 AND alias=$2 FOR UPDATE`, [tenantId, alias]);
  if (agent.rows[0]?.enabled !== true) conflict('context write target is absent or disabled');
  const profile = await client.query<{ revision: string | number; value: unknown }>(
    `SELECT revision,to_jsonb(profile) AS value FROM agent_profiles profile WHERE tenant_id=$1 AND alias=$2 FOR UPDATE`, [tenantId, alias],
  );
  const row = profile.rows[0];
  const expectations = await client.query<{ revision: string | number; generation: string; documents: unknown }>(
    `SELECT revision,generation,documents FROM agent_profile_runtime_expectations WHERE tenant_id=$1 AND alias=$2 FOR UPDATE`, [tenantId, alias],
  );
  const expectation = expectations.rows[0];
  const contract = expectation === undefined ? null : canonicalProfileRuntimeContract({ ...expectation, revision: Number(expectation.revision) });
  if (contract === undefined) conflict('context write expectation is invalid');
  return { revision: row === undefined ? null : Number(row.revision), profileSha256: row === undefined ? null : digest(row.value), agentSha256: digest(agent.rows[0].value), expectation: contract };
}
export async function assertNoContextDeliveriesInFlight(client: DatabaseClient, tenantId: Tenant, alias: string): Promise<void> {
  const result = await client.query<{ exists: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM deliveries WHERE recipient_tenant=$1 AND recipient_alias=$2 AND status IN ('leased','accepted','started')) AS exists`, [tenantId, alias],
  );
  if (result.rows[0]?.exists !== false) conflict('context write target has work in flight');
}

export async function readAgentContextWrite(pool: DatabasePool, tenantId: Tenant, alias: string, operationId: string): Promise<ContextWriteDescriptor | undefined> {
  const result = await pool.query<{ payload: unknown }>(`SELECT payload FROM jobs WHERE id=$1 AND tenant_id=$2 AND kind=$3`, [operationId, tenantId, CONTEXT_WRITE_QUARANTINE_KIND]);
  const row = result.rows[0];
  if (row === undefined) return undefined;
  const descriptor = parseDescriptor(row.payload);
  if (descriptor?.alias !== alias || descriptor.operationId !== operationId || descriptor.tenantId !== tenantId) conflict('context write reservation differs');
  return descriptor;
}
export async function reserveAgentContextWrite(pool: DatabasePool, input: ReserveContextWriteInput): Promise<ContextWriteDescriptor> {
  if (![input.operationId, input.token, input.generation].every((id) => UUID.test(id))
    || !writer(input.writer) || !documents(input.documents) || !AliasSchema.safeParse(input.alias).success
    || !TenantSchema.safeParse(input.tenantId).success || (input.expectedRevision !== null && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1))) {
    throw new StoreError('invalid_input', 'context write reservation is invalid');
  }
  const expected = input.expectedExpectation === null ? null : canonicalProfileRuntimeContract(input.expectedExpectation);
  if (expected === undefined) throw new StoreError('invalid_input', 'context write expectation is invalid');
  await transaction(pool, input.signal, async (client) => {
    await exclusive(client, input.tenantId, input.alias);
    await assertAgentContextAdmissionAllowed(client, input.tenantId, input.alias);
    const before = await lockAgentContextSnapshot(client, input.tenantId, input.alias);
    if (before.revision !== input.expectedRevision || !same(before.expectation, expected)) conflict('context write snapshot changed');
    await assertNoContextDeliveriesInFlight(client, input.tenantId, input.alias);
    await input.updateDesired?.(client);
    const after = await lockAgentContextSnapshot(client, input.tenantId, input.alias);
    const descriptor: ContextWriteDescriptor = { version: 1, operationId: input.operationId, token: input.token, generation: input.generation,
      tenantId: input.tenantId, alias: input.alias, writer: structuredClone(input.writer), before, after, documents: structuredClone(input.documents), dispatch: 'reserved', completion: null };
    await client.query(`INSERT INTO jobs(id,tenant_id,lane,kind,payload,status,claim_token,lease_until) VALUES($1,$2,'interactive',$3,$4::jsonb,'running',$5,NULL)`,
      [input.operationId, input.tenantId, CONTEXT_WRITE_QUARANTINE_KIND, JSON.stringify(descriptor), input.token]);
  });
  const committed = await readAgentContextWrite(pool, input.tenantId, input.alias, input.operationId)
    .catch(() => unverifiedCommit('context write commit is unverified'));
  if (committed?.token !== input.token || committed.generation !== input.generation) unverifiedCommit('context write commit is unverified');
  return committed;
}
async function lockedDescriptor(client: DatabaseClient, expected: ContextWriteDescriptor): Promise<ContextWriteDescriptor> {
  const row = await client.query<{ payload: unknown; status: string; claim_token: string; lease_until: Date | null }>(
    `SELECT payload,status,claim_token::text,lease_until FROM jobs WHERE id=$1 AND tenant_id=$2 AND kind=$3 FOR UPDATE`, [expected.operationId, expected.tenantId, CONTEXT_WRITE_QUARANTINE_KIND],
  );
  const found = row.rows[0];
  const descriptor = parseDescriptor(found?.payload);
  if (descriptor === undefined) conflict('context write reservation CAS failed');
  if (found?.status !== 'running' || found.lease_until !== null || found.claim_token !== expected.token
    || descriptor.completion !== null || !same(descriptor, expected)) conflict('context write reservation CAS failed');
  return descriptor;
}
export async function authorizeAgentContextDispatch(pool: DatabasePool, expected: ContextWriteDescriptor, signal?: AbortSignal): Promise<ContextWriteDescriptor> {
  const authorized = await transaction(pool, signal, async (client) => {
    await exclusive(client, expected.tenantId, expected.alias);
    const descriptor = await lockedDescriptor(client, expected);
    if (descriptor.dispatch !== 'reserved') conflict('context write dispatch was already authorized');
    if (!same(await lockAgentContextSnapshot(client, expected.tenantId, expected.alias), expected.after)) conflict('context write snapshot changed before dispatch');
    const next: ContextWriteDescriptor = { ...descriptor, dispatch: 'authorized' };
    await client.query(`UPDATE jobs SET payload=$2::jsonb,updated_at=clock_timestamp() WHERE id=$1`, [descriptor.operationId, JSON.stringify(next)]);
    return next;
  });
  const readback = await readAgentContextWrite(pool, expected.tenantId, expected.alias, expected.operationId)
    .catch(() => unverifiedCommit('context write dispatch commit is unverified'));
  if (!same(authorized, readback)) unverifiedCommit('context write dispatch commit is unverified');
  return authorized;
}
function parseProof(value: unknown): ContextWriterQuiescence | undefined {
  if (!record(value) || !keys(value, ['operationId', 'token', 'generation', 'writer', 'state', 'durability', 'documents'])
    || value.state !== 'quiescent' || value.durability !== 'post_fsync'
    || !writer(value.writer) || !Array.isArray(value.documents) || value.documents.length < 1 || value.documents.length > 7
    || ![value.operationId, value.token, value.generation].every((id) => typeof id === 'string' && UUID.test(id))) return undefined;
  for (const item of value.documents) {
    if (!record(item) || !keys(item, ['name', 'path', 'sha']) || !text(item.name) || !text(item.path) || !sha(item.sha)) return undefined;
  }
  return value as unknown as ContextWriterQuiescence;
}

export async function resolveAgentContextWrite(
  pool: DatabasePool, expected: ContextWriteDescriptor,
  authenticatedProof: (client: DatabaseClient) => Promise<ContextWriterQuiescence>,
  persistTarget: (client: DatabaseClient, proof: ContextWriterQuiescence) => Promise<void>,
  signal?: AbortSignal,
): Promise<ContextWriteResolution> {
  return transaction(pool, signal, async (client) => {
    await exclusive(client, expected.tenantId, expected.alias);
    const descriptor = await lockedDescriptor(client, expected);
    if (descriptor.dispatch !== 'authorized') conflict('context write was not dispatched');
    if (!same(await lockAgentContextSnapshot(client, expected.tenantId, expected.alias), descriptor.after)) conflict('context write snapshot changed before resolution');
    const received: unknown = await authenticatedProof(client);
    const proof = parseProof(received);
    if (proof?.operationId !== descriptor.operationId || proof.token !== descriptor.token
      || proof.generation !== descriptor.generation || !same(proof.writer, descriptor.writer)
      || proof.documents.length !== descriptor.documents.length) conflict('context writer quiescence is unverified');
    const measured = new Map(proof.documents.map((item) => [item.name, item]));
    if (measured.size !== descriptor.documents.length) conflict('context writer document proof is incomplete');
    const matches = (field: 'beforeSha' | 'targetSha'): boolean => descriptor.documents.every((item) => {
      const actual = measured.get(item.name);
      return actual?.path === item.path && sha(actual.sha) && actual.sha === item[field];
    });
    const target = matches('targetSha');
    if (!target && !matches('beforeSha')) conflict('context writer files are mixed or unexpected');
    if (target) await persistTarget(client, proof);
    const resolution = target ? 'target' : 'old';
    await client.query(`UPDATE jobs SET status='done',payload=$2::jsonb,updated_at=clock_timestamp() WHERE id=$1`,
      [descriptor.operationId, JSON.stringify({ ...descriptor, completion: { resolution, proofSha256: digest(proof) } })]);
    return resolution;
  });
}
