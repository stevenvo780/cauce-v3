import type { FastifyInstance } from 'fastify';
import {
  ContextRetirementApplySchema, ContextRetirementPreviewRequestSchema, ContextRetirementPreviewSchema,
  ContextRetirementReceiptSchema,
} from '@cauce/protocol';
import { assertPlatformAdmin, ContextRetirementService, StoreError, withTransaction, type DatabasePool } from '@cauce/store';
import { z } from 'zod';
import { AuthError, AuthorizationError, type AuthProvider } from '../../auth.js';
import { consoleHumanAccess, type ConsoleHumanAccess } from '../../console-human-authority.js';
import { PasswordAuthProvider } from '../../password-auth.js';
import { replyError } from '../../routes/shared.js';

export function registerContextRetirementRoutes(app: FastifyInstance, provider: AuthProvider, pool: DatabasePool,
  root: string | undefined): void {
  const service = root === undefined ? undefined : new ContextRetirementService(pool, root);
  const authorize = async (access: ConsoleHumanAccess) => withTransaction(pool, async client => {
    const actor = await access.companyAuthority(client);
    assertPlatformAdmin(actor);
    if (actor.actingCompany !== 'humanizar') throw new StoreError('forbidden', 'context retirement requires the Humanizar platform scope');
  });
  app.get('/v3/console/context-repository/retirements/:operation_id', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const access = await consoleHumanAccess(provider, request, reply, 'read');
      if (!access) throw new AuthorizationError('a console session is required');
      try {
        await authorize(access);
        if (!service) return await reply.code(503).send({ error: 'context_repository_unavailable' });
        const { operation_id } = z.object({ operation_id: z.uuid() }).strict().parse(request.params);
        const { company_id } = z.object({ company_id: ContextRetirementApplySchema.shape.company_id }).strict().parse(request.query);
        return ContextRetirementReceiptSchema.parse(await service.status(access.companyAuthority.bind(access), company_id, operation_id));
      } finally { access.close(); }
    } catch (error) {
      if (error instanceof z.ZodError) return await reply.code(400).send({ error: 'invalid_request' });
      if (error instanceof AuthError || error instanceof AuthorizationError || error instanceof StoreError) {
        replyError(reply, error); return;
      }
      return await reply.code(503).send({ error: 'context_retirement_unverified' });
    }
  });
  for (const action of ['preview', 'apply', 'revert'] as const) {
    app.post(`/v3/console/context-repository/retirements/${action}`, { bodyLimit: 4096 }, async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      try {
        if (provider instanceof PasswordAuthProvider) await provider.requireCsrf(request);
        const access = await consoleHumanAccess(provider, request, reply, 'read');
        if (!access) throw new AuthorizationError('a console session is required');
        try {
          await authorize(access);
          if (!service) return await reply.code(503).send({ error: 'context_repository_unavailable' });
          const source = access.companyAuthority.bind(access);
          if (action === 'preview') {
            const input = ContextRetirementPreviewRequestSchema.parse(request.body);
            return ContextRetirementPreviewSchema.parse(await service.preview(source, input));
          }
          const input = ContextRetirementApplySchema.parse(request.body);
          if ((action === 'revert') !== (input.retirement_commit !== undefined)) {
            return await reply.code(400).send({ error: 'invalid_request' });
          }
          return ContextRetirementReceiptSchema.parse(await service.apply(source, input, action === 'apply' ? 'retire' : 'restore'));
        } finally { access.close(); }
      } catch (error) {
        if (error instanceof z.ZodError) return await reply.code(400).send({ error: 'invalid_request' });
        if (error instanceof AuthError || error instanceof AuthorizationError || error instanceof StoreError) {
          replyError(reply, error); return;
        }
        return await reply.code(503).send({ error: 'context_retirement_unverified', effects_possible: action !== 'preview' });
      }
    });
  }
}
