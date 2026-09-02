import type { FastifyInstance } from 'fastify';
import {
  ConfigChangeRequestSchema, ConfigRollbackRequestSchema,
} from '@cauce/protocol';
import { requireOperatorPermission, requirePermission } from '../../auth.js';
import { principal, replyError } from '../shared.js';
import type { ConsoleRoutes } from './contracts.js';
import { validatedConfigurationReceipt } from './helpers.js';

export function registerConsoleOperationsRoutes(
  app: FastifyInstance,
  context: ConsoleRoutes,
): void {
  const { options, repository } = context;
  app.get('/v3/console/config', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requirePermission(actor, 'read');
      return await repository.getConfiguration(actor.tenant_id, actor.alias);
    } catch (error) { replyError(reply, error); }
  });

  app.post('/v3/console/config/changes', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requireOperatorPermission(actor, 'control');
      const change = ConfigChangeRequestSchema.parse(request.body);
      const result = await repository.applyConfigurationChange(
        actor.tenant_id, actor.alias, change.mutation, change.dry_run, change.expected_revision
      );
      return await reply.code(change.dry_run ? 200 : 201).send(validatedConfigurationReceipt(
        result, change.dry_run, null, change.mutation,
      ));
    } catch (error) { replyError(reply, error); }
  });

  app.post<{ Params: { revisionId: string } }>('/v3/console/config/revisions/:revisionId/rollback', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requireOperatorPermission(actor, 'control');
      const revisionId = Number(request.params.revisionId);
      if (!Number.isSafeInteger(revisionId) || revisionId < 1) throw new Error('revision id must be positive');
      const rollback = ConfigRollbackRequestSchema.parse(request.body);
      const result = await repository.rollbackConfiguration(
        actor.tenant_id, actor.alias, revisionId, rollback.dry_run, rollback.expected_revision
      );
      return await reply.code(rollback.dry_run ? 200 : 201).send(validatedConfigurationReceipt(
        result, rollback.dry_run, revisionId,
      ));
    } catch (error) { replyError(reply, error); }
  });

  app.get('/v3/console/observability', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requirePermission(actor, 'read');
      const [status, queues, jobs, relays] = await Promise.all([
        repository.status(actor.tenant_id, actor.alias),
        repository.queueSnapshot(actor.tenant_id, actor.alias),
        repository.listJobs(actor.tenant_id, actor.alias),
        repository.listOriginRelays(actor.tenant_id, actor.alias)
      ]);
      return { observed_at: new Date().toISOString(), status, queues, jobs, origin_relays: relays };
    } catch (error) { replyError(reply, error); }
  });

  app.get('/v3/console/terminal/capability', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requireOperatorPermission(actor, 'control');
      await repository.assertPermission(actor.tenant_id, actor.alias, 'control');
      if (options.terminalCapability?.available === true) return options.terminalCapability;
      return await reply.code(501).send({ available: false, reason: 'PTY backend capability is not configured' });
    } catch (error) { replyError(reply, error); }
  });
}
