import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ConfigChangeRequestSchema, ConfigurationDependencySchema, ConfigurationIdentitySchema, ConfigLeafMutationSchema, ConfigRollbackRequestSchema,
} from '@cauce/protocol';
import { ConfigurationError, StoreError } from '@cauce/store';
import { AuthError, AuthorizationError, requireOperatorPermission, requirePermission } from '../../auth.js';
import { principal, replyError } from '../shared.js';
import type { ConsoleRoutes } from './contracts.js';
import { validatedConfigurationReceipt } from './helpers.js';

const ConfigurationDependenciesRequestSchema = z.object({
  mutation: ConfigLeafMutationSchema,
  expected_revision: z.number().int().nonnegative().optional(),
}).strict();
const ConfigurationDependenciesPreviewSchema = z.object({
  revision: z.number().int().nonnegative(), resource: z.string(),
  identity: ConfigurationIdentitySchema,
  dependencies: z.array(ConfigurationDependencySchema), can_delete: z.boolean(),
}).strict();

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

  app.post('/v3/console/config/dependencies', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requireOperatorPermission(actor, 'control');
      const input = ConfigurationDependenciesRequestSchema.parse(request.body);
      if (!('getConfigurationDependencies' in repository)) {
        return await reply.code(501).send({
          error: 'not_supported', message: 'configuration dependency preview is not configured',
        });
      }
      const result = ConfigurationDependenciesPreviewSchema.safeParse(await repository.getConfigurationDependencies(
        actor.tenant_id, actor.alias, input.mutation, input.expected_revision,
      ));
      const identity = new Map(Object.entries(input.mutation).filter(([key, value]) =>
        !['resource', 'action', 'value'].includes(key) && typeof value === 'string'));
      if (!result.success || result.data.resource !== input.mutation.resource
          || (input.expected_revision !== undefined && result.data.revision !== input.expected_revision)
          || Object.keys(result.data.identity).length !== identity.size
          || Object.entries(result.data.identity).some(([key, value]) => identity.get(key) !== value)
          || result.data.can_delete !== !result.data.dependencies.some((dependency) => dependency.blocking)) {
        throw new StoreError('conflict', 'configuration dependency preview did not return an exact durable receipt');
      }
      return result.data;
    } catch (error) {
      if (error instanceof AuthError || error instanceof AuthorizationError
          || error instanceof ConfigurationError || error instanceof StoreError) {
        replyError(reply, error);
      } else if (error instanceof z.ZodError) {
        return await reply.code(400).send({ error: 'invalid_request', message: 'invalid configuration dependency request' });
      } else {
        return await reply.code(500).send({ error: 'preview_unverified', message: 'configuration dependencies could not be verified' });
      }
    }
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
