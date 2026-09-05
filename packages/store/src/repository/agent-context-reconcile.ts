import type { ProfileRuntimeContract, Tenant } from '@cauce/protocol';
import { ProfileRuntimeContractSchema } from '@cauce/protocol';
import type { DatabaseClient, DatabasePool } from '../db.js';
import { withTransaction } from '../db.js';
import { canonicallyEqual } from './config.js';
import { StoreError } from './errors.js';
import { agentContextReconcileLockKey } from './agent-context-lock.js';

export interface AgentContextReconcileDocumentRevision {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly actorTenant: string;
  readonly actorAlias: string;
}

export interface AgentContextReconcileEffect<Value> {
  readonly value: Value;
  readonly expectation: AgentContextReconcileRuntimeContract;
  readonly documentRevisions: readonly AgentContextReconcileDocumentRevision[];
  readonly resultAudit: {
    readonly tenantId: string;
    readonly actorAlias: string;
    readonly traceId: string;
    readonly metadata: Readonly<Record<string, unknown>>;
  };
}

export interface AgentContextReconcileFenceInput<Value> {
  readonly tenantId: Tenant;
  readonly alias: string;
  readonly expectedRevision: number;
  readonly expectedExpectation: AgentContextReconcileRuntimeContract;
  readonly apply: () => Promise<AgentContextReconcileEffect<Value>>;
}

export type AgentContextReconcileFenceResult<Value> =
  | { readonly state: 'committed'; readonly value: Value }
  | { readonly state: 'effect_unknown' };

export interface AgentContextReconcileRuntimeContract {
  readonly revision: number;
  readonly generation: string;
  readonly documents: readonly {
    readonly name: string;
    readonly path: string;
    readonly sha: string;
  }[];
}

export function canonicalProfileRuntimeContract(
  value: unknown,
): ProfileRuntimeContract | undefined {
  const parsed = ProfileRuntimeContractSchema.safeParse(value);
  if (!parsed.success) return undefined;
  return {
    ...parsed.data,
    documents: [...parsed.data.documents].sort((left, right) =>
      left.name.localeCompare(right.name) || left.path.localeCompare(right.path)),
  };
}

async function lockReconcileContract(
  client: DatabaseClient,
  input: AgentContextReconcileFenceInput<unknown>,
  expected: ProfileRuntimeContract,
): Promise<void> {
  const agent = await client.query<{ enabled: boolean }>(
    `SELECT enabled FROM agents WHERE tenant_id=$1 AND alias=$2 FOR UPDATE`,
    [input.tenantId, input.alias],
  );
  if (agent.rows[0]?.enabled !== true) {
    throw new StoreError('conflict', 'context reconciliation target is absent or disabled');
  }
  const profile = await client.query<{ revision: string | number }>(
    `SELECT revision FROM agent_profiles
      WHERE tenant_id=$1 AND alias=$2 FOR UPDATE`,
    [input.tenantId, input.alias],
  );
  if (profile.rowCount !== 1 || Number(profile.rows[0]?.revision) !== input.expectedRevision) {
    throw new StoreError('conflict', 'context reconciliation profile revision changed');
  }
  const expectation = await client.query<{
    revision: string | number;
    generation: string;
    documents: unknown;
  }>(
    `SELECT revision,generation,documents FROM agent_profile_runtime_expectations
      WHERE tenant_id=$1 AND alias=$2 FOR UPDATE`,
    [input.tenantId, input.alias],
  );
  const current = expectation.rows[0] === undefined ? undefined : canonicalProfileRuntimeContract({
    revision: Number(expectation.rows[0].revision),
    generation: expectation.rows[0].generation,
    documents: expectation.rows[0].documents,
  });
  if (current === undefined || !canonicallyEqual(current, expected)) {
    throw new StoreError('conflict', 'context reconciliation runtime expectation changed');
  }
  const inFlight = await client.query<{ total: string }>(
    `SELECT count(*)::text AS total FROM deliveries
      WHERE recipient_tenant=$1 AND recipient_alias=$2
        AND status IN ('leased','accepted','started')`,
    [input.tenantId, input.alias],
  );
  if (Number(inFlight.rows[0]?.total ?? '0') > 0) {
    throw new StoreError('conflict', 'context reconciliation target has work in flight');
  }
}

function exactDocumentIdentity(
  previous: ProfileRuntimeContract,
  next: ProfileRuntimeContract,
): boolean {
  return previous.documents.length === next.documents.length
    && previous.documents.every((document, index) => {
      const candidate = next.documents[index];
      return candidate?.name === document.name && candidate.path === document.path;
    });
}

async function persistReconcileResult<Value>(
  client: DatabaseClient,
  input: AgentContextReconcileFenceInput<Value>,
  expected: ProfileRuntimeContract,
  effect: AgentContextReconcileEffect<Value>,
): Promise<void> {
  const next = canonicalProfileRuntimeContract(effect.expectation);
  if (next?.revision !== input.expectedRevision
    || next.generation !== expected.generation || !exactDocumentIdentity(expected, next)) {
    throw new StoreError('conflict', 'context reconciliation returned an invalid runtime contract');
  }
  const expectation = await client.query(
    `UPDATE agent_profile_runtime_expectations
        SET revision=$3,generation=$4,documents=$5::jsonb,updated_at=clock_timestamp()
      WHERE tenant_id=$1 AND alias=$2
        AND revision=$6 AND generation=$7 AND documents=$8::jsonb`,
    [
      input.tenantId, input.alias, next.revision, next.generation,
      JSON.stringify(next.documents), expected.revision, expected.generation,
      JSON.stringify(expected.documents),
    ],
  );
  if (expectation.rowCount !== 1) {
    throw new StoreError('conflict', 'context reconciliation runtime expectation CAS failed');
  }
  for (const document of effect.documentRevisions) {
    await client.query(
      `INSERT INTO agent_document_revisions(
         tenant_id,alias,kind,path,sha256,bytes,actor_tenant,actor_alias
       ) VALUES($1,$2,'directive',$3,$4,$5,$6,$7)`,
      [
        input.tenantId, input.alias, document.path, document.sha256, document.bytes,
        document.actorTenant, document.actorAlias,
      ],
    );
  }
  await client.query(
    `INSERT INTO audit_events(tenant_id,actor_alias,action,decision,trace_id,metadata)
     VALUES($1,$2,'agent_document.write','allow',$3,$4::jsonb)`,
    [
      effect.resultAudit.tenantId, effect.resultAudit.actorAlias, effect.resultAudit.traceId,
      JSON.stringify(effect.resultAudit.metadata),
    ],
  );
}

export async function reconcileAgentContextWithFence<Value>(
  pool: DatabasePool,
  input: AgentContextReconcileFenceInput<Value>,
): Promise<AgentContextReconcileFenceResult<Value>> {
  const expected = canonicalProfileRuntimeContract(input.expectedExpectation);
  if (expected?.revision !== input.expectedRevision) {
    throw new StoreError('invalid_input', 'context reconciliation expectation is invalid');
  }
  const effectState = { started: false };
  try {
    const value = await withTransaction(pool, async (client) => {
      await client.query("SET LOCAL lock_timeout='5000ms'");
      await client.query("SET LOCAL statement_timeout='10000ms'");
      await client.query("SET LOCAL idle_in_transaction_session_timeout='90000ms'");
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [
        agentContextReconcileLockKey(input.tenantId, input.alias),
      ]);
      await lockReconcileContract(client, input, expected);
      effectState.started = true;
      const effect = await input.apply();
      await persistReconcileResult(client, input, expected, effect);
      return effect.value;
    });
    return { state: 'committed', value };
  } catch (error) {
    if (effectState.started) return { state: 'effect_unknown' };
    throw error;
  }
}
