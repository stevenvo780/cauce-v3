import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AliasSchema, TenantSchema, type ContextoDeAlias } from '@cauce/protocol';
import type { DocumentOperator, TerminalAuditEntry } from './agent-documents.routes.js';
import type {
  ProfileRuntimeAck, ProfileRuntimePreflight, ProfileRuntimeVerification,
} from './agent-profile.routes.js';
import { acksCompletos } from './agent-profile/write-gates.js';
import {
  runtimeErrorCode, runtimeErrorMessage, runtimeErrorStatus,
} from './agent-profile/runtime-errors.js';
import { appliedRuntimeVerification } from './agent-profile/runtime-verification.js';
import type { DeliveriesInFlight } from './agent-context-reload.routes.js';
import type { ContextContaminationVerdict } from './contaminacion-de-contexto.js';
import { CONTEXT_APPLY_POLICY } from './context-apply-policy.js';
import {
  ContextReconcileError, contextReconcileSnapshotMatches,
  parseContextReconcileApplyBody, parseContextReconcilePreviewBody,
  prepareContextReconcileSnapshot,
  type ContextReconcileDocumentSnapshot, type ContextReconcileExpectation,
  type ContextReconcileSnapshot,
} from './agent-context-reconcile.js';

interface ReconcileTarget {
  readonly tenant_id: string;
  readonly alias: string;
  readonly enabled?: boolean;
}

interface ReconcileCaller {
  readonly actor: { readonly tenant_id: string; readonly alias: string };
  readonly operator: DocumentOperator;
  readonly reason: string;
  readonly target: ReconcileTarget;
  readonly correlation_id: string;
}

export interface AgentContextReconcileDeps {
  authorize(
    request: unknown, permission: 'control',
  ): Promise<{ tenant_id: string; alias: string }>;
  authorizeTarget(
    actor: { tenant_id: string; alias: string },
    targetTenantId: string,
    targetAlias: string,
    permission: 'control',
  ): Promise<ReconcileTarget | undefined>;
  resolveOperator?: (request: unknown) => DocumentOperator | Promise<DocumentOperator>;
  readContext(tenantId: string, alias: string): Promise<{
    contexto: ContextoDeAlias;
    exists: boolean;
    revision: number | null;
    applied_revision: number | null;
  }>;
  prepareRuntime(
    tenantId: string, alias: string, contexto: ContextoDeAlias,
  ): Promise<ProfileRuntimePreflight>;
  readRuntimeExpectation(
    tenantId: string, alias: string,
  ): Promise<ContextReconcileExpectation | undefined>;
  deliveryInFlight(tenantId: string, alias: string): Promise<DeliveriesInFlight>;
  reconcileRuntime<Value>(input: {
    readonly tenantId: string;
    readonly alias: string;
    readonly expectedRevision: number;
    readonly expectedExpectation: ContextReconcileExpectation;
    readonly apply: () => Promise<{
      readonly value: Value;
      readonly expectation: ContextReconcileExpectation;
      readonly documentRevisions: readonly {
        readonly path: string;
        readonly sha256: string;
        readonly bytes: number;
        readonly actorTenant: string;
        readonly actorAlias: string;
      }[];
      readonly resultAudit: {
        readonly tenantId: string;
        readonly actorAlias: string;
        readonly traceId: string;
        readonly metadata: Readonly<Record<string, unknown>>;
      };
    }>;
  }): Promise<{ readonly state: 'committed'; readonly value: Value }
    | { readonly state: 'effect_unknown' }>;
  recordAudit(entry: TerminalAuditEntry): Promise<void>;
}

export interface ContextReconcilePreviewResponse {
  readonly ok: true;
  readonly tenant_id: string;
  readonly alias: string;
  readonly expected_revision: number;
  readonly expected_runtime_generation: string;
  readonly preserve_external: true;
  readonly documents: readonly ContextReconcileDocumentSnapshot[];
}

export interface ContextReconcileApplyResponse {
  readonly ok: true;
  readonly state: 'pending_session_refresh';
  readonly tenant_id: string;
  readonly alias: string;
  readonly revision: number;
  readonly evidence: 'runtime_verification';
  readonly message: string;
  readonly preserve_external: true;
  readonly documents: readonly {
    readonly name: string;
    readonly path: string;
    readonly sha_before: string;
    readonly sha_after: string;
    readonly bytes: number;
  }[];
  readonly runtime_verification: ProfileRuntimeVerification;
  readonly contaminacion: ContextContaminationVerdict;
}

function statusFor(error: unknown): number {
  if (error instanceof ContextReconcileError) {
    return error.code === 'invalid_input' ? 400 : 409;
  }
  return runtimeErrorStatus(error);
}

function codeFor(error: unknown): string {
  return error instanceof ContextReconcileError
    ? error.code
    : runtimeErrorCode(error) ?? 'context_reconcile_failed';
}

function messageFor(error: unknown): string {
  return runtimeErrorMessage(error, 'no se pudo reconciliar el contexto');
}

export function registerAgentContextReconcileRoutes(
  app: FastifyInstance, deps: AgentContextReconcileDeps,
): void {
  interface Params { tenantId: string; alias: string }

  function auditMetadata(
    caller: ReconcileCaller,
    phase: 'preview' | 'intent' | 'result' | 'denied' | 'effect_unknown',
    extra: Readonly<Record<string, unknown>> = {},
  ): Record<string, unknown> {
    return {
      operation: 'context_reconcile',
      phase,
      operator_id: caller.operator.operator_id,
      attributed: caller.operator.attributed,
      operator_reason: caller.reason,
      actor: `${caller.actor.tenant_id}:${caller.actor.alias}`,
      correlation_id: caller.correlation_id,
      target_tenant: caller.target.tenant_id,
      target_alias: caller.target.alias,
      ...extra,
    };
  }

  async function audit(
    caller: ReconcileCaller,
    action: 'agent_document.read' | 'agent_document.write' | 'agent_document.denied',
    decision: 'allow' | 'deny' | 'info',
    phase: 'preview' | 'intent' | 'result' | 'denied' | 'effect_unknown',
    extra: Readonly<Record<string, unknown>> = {},
  ): Promise<void> {
    await deps.recordAudit({
      tenant_id: caller.actor.tenant_id,
      actor_alias: caller.actor.alias,
      action,
      decision,
      trace_id: caller.correlation_id,
      metadata: auditMetadata(caller, phase, extra),
    });
  }

  async function resolveCaller(
    request: FastifyRequest<{ Params: Params; Body: unknown }>,
    reply: FastifyReply,
    reason: string,
  ): Promise<ReconcileCaller | undefined> {
    const tenant = TenantSchema.safeParse(request.params.tenantId);
    const alias = AliasSchema.safeParse(request.params.alias);
    if (!tenant.success || !alias.success) {
      await reply.code(400).send({ error: 'invalid_input', message: 'tenantId or alias is invalid' });
      return undefined;
    }
    const actor = await deps.authorize(request, 'control');
    const target = await deps.authorizeTarget(actor, tenant.data, alias.data, 'control');
    if (target?.tenant_id !== tenant.data || target.alias !== alias.data) {
      await reply.code(404).send({ error: 'not_found', message: 'agent not found or not visible' });
      return undefined;
    }
    const operator = await (deps.resolveOperator?.(request)
      ?? { operator_id: 'sin-persona', attributed: false });
    const caller = { actor, operator, reason, target, correlation_id: request.id };
    if (!operator.attributed) {
      await audit(caller, 'agent_document.denied', 'deny', 'denied', {
        reason: 'writable_requires_attribution',
      });
      await reply.code(403).send({
        error: 'forbidden',
        reason: 'writable_requires_attribution',
        message: 'reconciliar contexto exige una persona atribuida con permiso de control',
      });
      return undefined;
    }
    return caller;
  }

  async function snapshot(
    caller: ReconcileCaller,
  ): Promise<ContextReconcileSnapshot> {
    if (caller.target.enabled !== true) {
      throw new ContextReconcileError('agent_disabled', 'the target agent is disabled');
    }
    const inFlight = await deps.deliveryInFlight(caller.target.tenant_id, caller.target.alias);
    if (inFlight.count > 0 || inFlight.deliveries.length > 0) {
      throw new ContextReconcileError('delivery_in_flight', 'the target has work in flight');
    }
    const current = await deps.readContext(caller.target.tenant_id, caller.target.alias);
    if (!current.exists || current.revision === null) {
      throw new ContextReconcileError('profile_absent', 'the target has no durable profile');
    }
    if (current.contexto.perfil.tenant_id !== caller.target.tenant_id
      || current.contexto.perfil.alias !== caller.target.alias) {
      throw new ContextReconcileError('profile_identity_conflict', 'durable profile identity differs');
    }
    const [expectation, preflight] = await Promise.all([
      deps.readRuntimeExpectation(caller.target.tenant_id, caller.target.alias),
      deps.prepareRuntime(caller.target.tenant_id, caller.target.alias, current.contexto),
    ]);
    return prepareContextReconcileSnapshot({
      tenantId: caller.target.tenant_id,
      alias: caller.target.alias,
      revision: current.revision,
      expectation,
      preflight,
    });
  }

  async function deny(
    caller: ReconcileCaller, reply: FastifyReply, error: unknown,
    phase: 'denied' | 'result' = 'denied',
  ): Promise<FastifyReply> {
    const code = codeFor(error);
    try {
      await audit(caller, 'agent_document.denied', 'deny', phase, { reason: code });
    } catch {
      return reply.code(503).send({
        error: 'context_reconcile_audit_failed',
        message: 'no se pudo registrar durablemente el resultado de la reconciliación',
      });
    }
    return reply.code(statusFor(error)).send({ error: code, message: messageFor(error) });
  }

  async function preview(
    request: FastifyRequest<{ Params: Params; Body: unknown }>, reply: FastifyReply,
  ): Promise<unknown> {
    let parsed;
    try {
      parsed = parseContextReconcilePreviewBody(request.body);
    } catch (error) {
      return reply.code(statusFor(error)).send({ error: codeFor(error), message: messageFor(error) });
    }
    const caller = await resolveCaller(request, reply, parsed.reason);
    if (caller === undefined) return undefined;
    let current: ContextReconcileSnapshot;
    try {
      current = await snapshot(caller);
    } catch (error) {
      return deny(caller, reply, error);
    }
    try {
      await audit(caller, 'agent_document.read', 'allow', 'preview', {
        revision: current.revision,
        generation: current.generation,
        documents: current.documents,
      });
    } catch {
      return reply.code(503).send({
        error: 'context_reconcile_audit_failed',
        message: 'la vista previa no se sirve sin su fila de auditoría',
      });
    }
    const response: ContextReconcilePreviewResponse = {
      ok: true,
      tenant_id: caller.target.tenant_id,
      alias: caller.target.alias,
      expected_revision: current.revision,
      expected_runtime_generation: current.generation,
      preserve_external: true,
      documents: current.documents,
    };
    return reply.send(response);
  }

  async function apply(
    request: FastifyRequest<{ Params: Params; Body: unknown }>, reply: FastifyReply,
  ): Promise<unknown> {
    let parsed;
    try {
      parsed = parseContextReconcileApplyBody(request.body);
    } catch (error) {
      return reply.code(statusFor(error)).send({ error: codeFor(error), message: messageFor(error) });
    }
    const caller = await resolveCaller(request, reply, parsed.reason);
    if (caller === undefined) return undefined;
    let current: ContextReconcileSnapshot;
    try {
      current = await snapshot(caller);
    } catch (error) {
      return deny(caller, reply, error);
    }
    if (!contextReconcileSnapshotMatches(parsed, current)) {
      return deny(caller, reply, new ContextReconcileError(
        'reconcile_snapshot_conflict', 'desired revision, generation, or document fingerprints changed',
      ));
    }
    try {
      await audit(caller, 'agent_document.write', 'info', 'intent', {
        revision: current.revision,
        generation: current.generation,
        preserve_external: true,
        documents: current.documents,
      });
    } catch {
      return reply.code(503).send({
        error: 'context_reconcile_intent_not_recorded',
        message: 'no se escribió nada porque la intención atribuida no quedó registrada',
      });
    }

    let fenced;
    try {
      fenced = await deps.reconcileRuntime({
        tenantId: caller.target.tenant_id,
        alias: caller.target.alias,
        expectedRevision: current.revision,
        expectedExpectation: current.expectation,
        apply: async () => {
          const acknowledgements: readonly ProfileRuntimeAck[] = await current.prepared.apply();
          if (!acksCompletos(current.prepared, acknowledgements)) {
            throw new ContextReconcileError(
              'runtime_ack_incomplete', 'runtime did not acknowledge the exact document batch',
            );
          }
          const verification = appliedRuntimeVerification(
            current.prepared.verification, acknowledgements, { requireExactBytes: true },
          );
          if (verification.documents.some((document) => !document.current)) {
            throw new ContextReconcileError(
              'runtime_ack_incomplete', 'runtime read-back differs from the durable projection',
            );
          }
          const ackByName = new Map(acknowledgements.map((ack) => [ack.name, ack]));
          const documents = current.documents.map((before) => {
            const acknowledgement = ackByName.get(before.name);
            if (acknowledgement === undefined) {
              throw new ContextReconcileError(
                'runtime_ack_incomplete', 'complete acknowledgement disappeared',
              );
            }
            return {
              name: before.name,
              path: acknowledgement.path,
              sha_before: before.observed_sha,
              sha_after: acknowledgement.sha,
              bytes: acknowledgement.bytes,
            };
          });
          return {
            value: { documents, verification },
            expectation: {
              revision: current.revision,
              generation: current.generation,
              documents: documents.map((document) => ({
                name: document.name, path: document.path, sha: document.sha_after,
              })),
            },
            documentRevisions: acknowledgements.map((acknowledgement) => ({
                path: acknowledgement.path,
                sha256: acknowledgement.sha,
                bytes: acknowledgement.bytes,
                actorTenant: caller.actor.tenant_id,
                actorAlias: caller.actor.alias,
              })),
            resultAudit: {
              tenantId: caller.actor.tenant_id,
              actorAlias: caller.actor.alias,
              traceId: caller.correlation_id,
              metadata: auditMetadata(caller, 'result', {
                revision: current.revision,
                generation: current.generation,
                state: 'pending_session_refresh',
                documents,
              }),
            },
          };
        },
      });
    } catch (error) {
      return deny(caller, reply, error);
    }
    if (fenced.state === 'effect_unknown') {
      let auditRecorded = true;
      try {
        await audit(caller, 'agent_document.write', 'info', 'effect_unknown', {
          revision: current.revision,
          generation: current.generation,
          documents: current.documents,
        });
      } catch {
        auditRecorded = false;
      }
      if (!auditRecorded) {
        return reply.code(503).send({
          error: 'context_reconcile_effect_unknown_audit_failed',
          state: 'effect_unknown',
          message: 'el efecto es incierto y sólo consta la intención durable; releé antes de reintentar',
        });
      }
      return reply.code(503).send({
        error: 'context_reconcile_effect_unknown',
        state: 'effect_unknown',
        message: 'el efecto del runtime no pudo confirmarse; releé la vista previa antes de reintentar',
      });
    }
    const { documents, verification } = fenced.value;
    const response: ContextReconcileApplyResponse = {
      ok: true,
      state: 'pending_session_refresh',
      tenant_id: caller.target.tenant_id,
      alias: caller.target.alias,
      revision: current.revision,
      evidence: 'runtime_verification',
      message: CONTEXT_APPLY_POLICY.pending_session_refresh.message,
      preserve_external: true,
      documents,
      runtime_verification: verification,
      contaminacion: { contaminated: false, findings: [] },
    };
    return reply.send(response);
  }

  app.post<{ Params: Params; Body: unknown }>(
    '/v3/console/tenants/:tenantId/agents/:alias/context/reconcile/preview', preview,
  );
  app.post<{ Params: Params; Body: unknown }>(
    '/v3/console/tenants/:tenantId/agents/:alias/context/reconcile/apply', apply,
  );
}
