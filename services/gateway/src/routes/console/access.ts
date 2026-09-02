import type { FastifyInstance } from 'fastify';
import { requirePermission } from '../../auth.js';
import { visibleMessageList } from '../../facades.js';
import { principal, replyError } from '../shared.js';
import type {
  ConsoleRouteOptions, ConsoleRouteRepository, ConsoleRoutes,
} from './contracts.js';

export function createConsoleRoutes(
  options: ConsoleRouteOptions,
  repository: ConsoleRouteRepository,
): ConsoleRoutes {
  const allowedJobKinds = new Set(options.allowedJobKinds ?? [
    'system.database.probe', ...(process.env.NODE_ENV === 'test' ? ['qa.fairness'] : [])
  ]);
  return { options, repository, allowedJobKinds };
}

export function registerConsoleAccessRoutes(
  app: FastifyInstance,
  context: ConsoleRoutes,
): void {
  const { options, repository } = context;
  app.get('/v3/console/access', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requirePermission(actor, 'read');
      const databaseAccess = await repository.principalAccess(actor.tenant_id, actor.alias);
      const effectiveRoles = actor.roles.filter((role) => databaseAccess.roles.includes(role));
      const effectivePermissions = actor.permissions.filter((permission) => databaseAccess.permissions.includes(permission));
      const permissions = [
        ...(effectivePermissions.includes('route') ? ['message.publish'] : []),
        ...(effectivePermissions.includes('notify') ? ['message.notify'] : []),
        ...(effectiveRoles.includes('operator') && effectivePermissions.includes('control')
          ? ['delivery.replay', 'delivery.cancel', 'job.create', 'config.write', 'config.rollback', 'dlq.resolve'] : []),
        ...(options.terminalCapability?.available === true && effectiveRoles.includes('operator') && effectivePermissions.includes('control')
          ? ['ultimate-terminal.connect'] : [])
      ];
      return {
        subject: `${actor.tenant_id}:${actor.alias}`,
        roles: effectiveRoles,
        permissions,
        observed_at: new Date().toISOString()
      };
    } catch (error) { replyError(reply, error); }
  });

  app.get('/v3/console/topology', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requirePermission(actor, 'read');
      return await repository.topology(actor.tenant_id, actor.alias);
    } catch (error) { replyError(reply, error); }
  });

  app.get('/v3/console/messages', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requirePermission(actor, 'read');
      return visibleMessageList(await repository.listMessages(actor.tenant_id, actor.alias), actor);
    } catch (error) { replyError(reply, error); }
  });
}
