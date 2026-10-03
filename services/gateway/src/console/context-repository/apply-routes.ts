import type { FastifyInstance } from 'fastify';
import { AliasSchema, TenantSchema } from '@cauce/protocol';
import { AuthError, AuthorizationError } from '../../auth.js';
import { admitGovernanceReason } from '../agent-documents/write-admission.js';
import { prepareContextSource, snapshotContextSourceDeps, type ContextSourceDeps } from './apply-preview.js';
import { assertContextCommit } from './git-reader.js';
import { ContextRepositoryError } from './model.js';

export function registerContextSourcePreviewRoute(app: FastifyInstance, input: ContextSourceDeps): void {
  const deps = snapshotContextSourceDeps(input);
  app.post<{ Params: { tenantId: string; alias: string }; Body: unknown }>(
    '/v3/console/tenants/:tenantId/agents/:alias/context/repository/preview', async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      try {
        const actor = await deps.profile.authorize(request, 'control');
        const tenant = TenantSchema.safeParse(request.params.tenantId);
        const alias = AliasSchema.safeParse(request.params.alias);
        if (!tenant.success || !alias.success) return await reply.code(400).send({ error: 'invalid_input' });
        const target = await deps.profile.authorizeTarget(actor, tenant.data, alias.data, 'control', false);
        if (target?.tenant_id !== tenant.data || target.alias !== alias.data) return await reply.code(404).send({ error: 'not_found' });
        const operator = await deps.profile.resolveOperator?.(request);
        if (operator?.attributed !== true) return await reply.code(403).send({ error: 'writable_requires_attribution' });
        if (target.enabled !== true) return await reply.code(409).send({ error: 'agent_disabled' });
        const body = request.body;
        if (body === null || typeof body !== 'object' || Array.isArray(body)) return await reply.code(400).send({ error: 'invalid_input' });
        const row = body as Record<string, unknown>;
        const reason = admitGovernanceReason(row.reason);
        if (Object.keys(row).length !== 2 || typeof row.commit !== 'string' || typeof reason !== 'string') {
          return await reply.code(400).send({ error: 'invalid_input' });
        }
        assertContextCommit(row.commit);
        const preview = await prepareContextSource(deps, {
          actor, operator, tenantId: tenant.data, alias: alias.data, reason,
        }, row.commit);
        const currentActor = await deps.profile.authorize(request, 'control');
        const currentTarget = await deps.profile.authorizeTarget(currentActor, tenant.data, alias.data, 'control', false);
        const currentOperator = await deps.profile.resolveOperator?.(request);
        if (currentActor.tenant_id !== actor.tenant_id || currentActor.alias !== actor.alias
          || currentTarget?.tenant_id !== tenant.data || currentTarget.alias !== alias.data || currentTarget.enabled !== true
          || currentOperator?.attributed !== true || currentOperator.operator_id !== operator.operator_id) {
          return await reply.code(403).send({ error: 'forbidden' });
        }
        await deps.profile.recordAudit({ tenant_id: actor.tenant_id, actor_alias: actor.alias,
          action: 'agent_document.read', decision: 'allow', metadata: {
            operation: 'context_source_preview', operator_id: operator.operator_id,
            operator_reason: reason, target_tenant: tenant.data, target_alias: alias.data,
            ...preview.context_source,
          } });
        return preview;
      } catch (error) {
        const status = error instanceof AuthError ? 401 : error instanceof AuthorizationError ? 403
          : error instanceof ContextRepositoryError ? 409 : 503;
        return await reply.code(status).send({ error: error instanceof ContextRepositoryError ? error.code : 'context_source_unavailable' });
      }
    },
  );
}
