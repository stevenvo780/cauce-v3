import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { AliasSchema, TenantSchema, UUID_ANY_PATTERN } from '@cauce/protocol';
import {
  canonicalProfileRuntimeContract, contextHumanId, contextWriteAuthority, legacyContextWriteIsProfile,
  persistAgentContextReconcileInTransaction, StoreError, withTransaction,
  type CompanyAuthority, type ContextWriteDescriptor, type ContextWriteDocument, type ContextWriteHistory,
  type ContextWritePlan, type ContextWriterRecoveryProof, type DatabaseClient, type DatabasePool,
} from '@cauce/store';
import { AuthError, AuthorizationError, type AuthProvider } from '../auth.js';
import { consoleHumanAccess } from '../console-human-authority.js';
import { PasswordAuthProvider } from '../password-auth.js';
import type { AgentContextWriteCoordinator } from './agent-context-write-coordinator.js';

/** Plan fields are short printable lines; whatever the person typed is folded into one. */
function planText(value: string | null | undefined, fallback: string): string {
  const folded = Array.from(value ?? '', character => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127 ? ' ' : character;
  }).join('').trim();
  const bounded = Buffer.from(folded, 'utf8').subarray(0, 480).toString('utf8').trim();
  return bounded.length > 0 ? bounded : fallback;
}

/**
 * The plan a profile write seals with its reservation: which documents the result journals and which form the runtime
 * expectation. Without a document to select there is nothing to recover from, so no plan is sealed.
 */
export function profileWritePlan(input: {
  readonly actor: { readonly tenant_id: string; readonly alias: string };
  readonly operatorId: string; readonly attributed: boolean; readonly reason: string | null;
  readonly documents: readonly ContextWriteDocument[];
}): ContextWritePlan | undefined {
  const selected = input.documents.filter(document => document.targetSha !== null)
    .map(document => ({ name: document.name, path: document.path }));
  if (selected.length === 0) return undefined;
  return {
    operation: 'profile', actor: { tenantId: input.actor.tenant_id, alias: input.actor.alias },
    audit: { traceId: randomUUID(), attribution: { kind: 'operator', operatorId: planText(input.operatorId, 'unattributed'),
      attributed: input.attributed, reason: planText(input.reason, 'profile write') } },
    journalDocuments: selected.map(document => ({ ...document, kind: 'directive' })),
    expectationDocuments: selected, sourceReceipt: null,
  };
}

/** A sealed v1 profile reservation carries no plan; the person who recovers it is the one the result is attributed to. */
export function legacyProfileWritePlan(descriptor: ContextWriteDescriptor, recoverer: CompanyAuthority): ContextWritePlan | null {
  if (descriptor.version !== 1 || !legacyContextWriteIsProfile(descriptor)) return null;
  return profileWritePlan({ actor: { tenant_id: recoverer.homeTenant, alias: recoverer.alias },
    operatorId: recoverer.humanId ?? 'unattributed', attributed: recoverer.humanId !== null,
    reason: 'recuperación de una escritura de perfil sin confirmar', documents: descriptor.documents }) ?? null;
}

/**
 * Persists a recovered `target` exactly as the profile write would have: the runtime expectation of the sealed desired
 * revision, measured on the same writer, and the journal of every written document. The journal and the result audit
 * name the person who accredited the effect; the audit also keeps who requested the write.
 */
export async function persistRecoveredProfileWrite(client: DatabaseClient, plan: ContextWritePlan,
  proof: ContextWriterRecoveryProof, descriptor: ContextWriteDescriptor, recoverer: CompanyAuthority): Promise<void> {
  if (plan.operation !== 'profile') throw new StoreError('conflict', 'context write recovery for this operation is unsupported');
  const revision = descriptor.after.revision;
  if (revision === null) throw new StoreError('conflict', 'context write recovery revision is absent');
  const measured = (selection: { readonly name: string; readonly path: string }) => {
    const document = proof.documents.find(item => item.name === selection.name && item.path === selection.path);
    if (document?.sha == null) throw new StoreError('conflict', 'context write recovery proof is incomplete');
    return { ...document, sha: document.sha };
  };
  const expected = descriptor.after.expectation === null ? undefined : canonicalProfileRuntimeContract(descriptor.after.expectation);
  const effect = {
    value: null,
    expectation: { revision, generation: descriptor.writer.runtimeGeneration,
      documents: proof.documents.filter(document => document.sha !== null).map(document => ({
        name: document.name, path: document.path, sha: measured(document).sha })) },
    documentRevisions: plan.journalDocuments.map(selection => {
      const document = measured(selection);
      return { path: document.path, sha256: document.sha, bytes: document.bytes, kind: selection.kind,
        actorTenant: recoverer.homeTenant, actorAlias: recoverer.alias, actorHumanId: contextHumanId(recoverer.humanId) ?? null };
    }),
    resultAudit: { tenantId: recoverer.homeTenant, actorAlias: recoverer.alias, traceId: plan.audit.traceId, metadata: {
      component: 'context', target_tenant: descriptor.tenantId, target_alias: descriptor.alias, revision,
      state: 'pending_session_refresh', recovered_operation_id: descriptor.operationId, sealed_plan: descriptor.version === 2,
      requested_by: { tenant_id: plan.actor.tenantId, alias: plan.actor.alias, operator_id: plan.audit.attribution.operatorId,
        attributed: plan.audit.attribution.attributed },
      recovered_by_human: recoverer.humanId,
    } },
  };
  await persistAgentContextReconcileInTransaction(client, {
    mode: 'reload', tenantId: descriptor.tenantId, alias: descriptor.alias, expectedRevision: revision,
    expectedExpectation: expected ?? null, apply: async () => effect,
  }, expected, effect);
}

const Params = z.object({ tenant: TenantSchema, alias: AliasSchema,
  operation: z.string().regex(UUID_ANY_PATTERN) }).strict();

type RecoveryCode = 'context_write_not_found' | 'context_write_recovery_unsupported' | 'context_write_snapshot_changed'
  | 'context_write_writer_changed' | 'context_write_not_recoverable' | 'context_write_files_mixed'
  | 'context_write_expectation_changed' | 'context_write_recovery_unproven' | 'context_write_recovery_unavailable';

/** Maps the store's fail-closed refusals to stable codes; the console explains each one. */
export function contextWriteRecoveryRefusal(error: unknown): { readonly status: number; readonly code: RecoveryCode } {
  const message = error instanceof Error ? error.message : '';
  if (error instanceof StoreError && error.code === 'not_found') return { status: 404, code: 'context_write_not_found' };
  if (/recovery plan|operation is unsupported|plan differs/u.test(message)) return { status: 409, code: 'context_write_recovery_unsupported' };
  if (message.includes('snapshot changed')) return { status: 409, code: 'context_write_snapshot_changed' };
  if (message.includes('writer changed')) return { status: 409, code: 'context_write_writer_changed' };
  if (message.includes('control fields are invalid')) return { status: 409, code: 'context_write_not_recoverable' };
  if (message.includes('mixed or unexpected')) return { status: 409, code: 'context_write_files_mixed' };
  if (/expectation (?:CAS failed|changed)/u.test(message)) return { status: 409, code: 'context_write_expectation_changed' };
  if (/receipt|readback|read-back|proof|quiescence/u.test(message)) return { status: 409, code: 'context_write_recovery_unproven' };
  return { status: 503, code: 'context_write_recovery_unavailable' };
}

async function auditRecovery(pool: DatabasePool, recoverer: CompanyAuthority, target: z.infer<typeof Params>,
  outcome: { readonly resolution?: ContextWriteHistory['resolution']; readonly error?: RecoveryCode }): Promise<void> {
  await withTransaction(pool, async client => {
    await client.query(`INSERT INTO audit_events(tenant_id,company_id,actor_alias,actor_human_id,action,decision,metadata)
      VALUES($1,$2,$3,$4::uuid,'agent_context_write.recover',$5,$6::jsonb)`, [recoverer.homeTenant, recoverer.actingCompany,
      recoverer.alias, contextHumanId(recoverer.humanId) ?? null, outcome.error === undefined ? 'allow' : 'deny', JSON.stringify({
        component: 'context', target_tenant: target.tenant, target_alias: target.alias, operation_id: target.operation,
        ...(outcome.resolution === undefined ? {} : { resolution: outcome.resolution }),
        ...(outcome.error === undefined ? {} : { error_code: outcome.error }),
      })]);
  });
}

/**
 * «Comprobar y resolver»: a person with context write authority over the agent asks the gateway to measure a write left
 * `effect_unknown` again. The same writer must report the operation done and the files must read back as either the
 * target or the untouched original; anything else keeps the fence and says why.
 */
export function registerContextWriteRecoveryRoutes(app: FastifyInstance, deps: {
  readonly pool: DatabasePool; readonly authProvider: AuthProvider; readonly coordinator: AgentContextWriteCoordinator;
}): void {
  app.post('/v3/console/context/agents/:tenant/:alias/writes/:operation/recover', { bodyLimit: 1024 },
    async (request, reply): Promise<FastifyReply> => {
      reply.header('Cache-Control', 'no-store');
      let target: z.infer<typeof Params>;
      try { target = Params.parse(request.params); }
      catch { return reply.code(400).send({ error: 'invalid_request', message: 'invalid context write recovery request' }); }
      let recoverer: CompanyAuthority | undefined;
      try {
        if (deps.authProvider instanceof PasswordAuthProvider) await deps.authProvider.requireCsrf(request);
        const access = await consoleHumanAccess(deps.authProvider, request, reply, 'read');
        if (!access) throw new AuthorizationError('a console session is required');
        try {
          const result = await deps.coordinator.recover({
            tenantId: target.tenant, alias: target.alias, operationId: target.operation, signal: access.options.signal,
            lockHumanAuthority: async client => {
              recoverer = (await contextWriteAuthority(client, access.companyAuthority.bind(access), target.tenant, target.alias)).authority;
            },
            legacyPlan: descriptor => recoverer === undefined ? null : legacyProfileWritePlan(descriptor, recoverer),
            persistTarget: async (client, plan, proof, descriptor) => {
              if (recoverer === undefined) throw new AuthorizationError();
              await persistRecoveredProfileWrite(client, plan, proof, descriptor, recoverer);
            },
          });
          if (recoverer !== undefined) await auditRecovery(deps.pool, recoverer, target, { resolution: result.resolution }).catch(() => undefined);
          return await reply.send({ operation_id: result.operationId, resolution: result.resolution });
        } finally { access.close(); }
      } catch (error) {
        if (error instanceof AuthError) return reply.code(401).send({ error: error.code, message: error.message });
        if (error instanceof AuthorizationError || (error instanceof StoreError && error.code === 'forbidden')) {
          return reply.code(403).send({ error: 'forbidden', message: 'context write authority is required' });
        }
        const refusal = contextWriteRecoveryRefusal(error);
        request.log.warn({ event: 'context_write_recovery_refused', operation_id: target.operation, error_code: refusal.code },
          'context write recovery refused');
        if (recoverer !== undefined) await auditRecovery(deps.pool, recoverer, target, { error: refusal.code }).catch(() => undefined);
        return reply.code(refusal.status).send({ error: refusal.code, operation_id: target.operation });
      }
    });
}
