import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ClientDelegationLabelSchema, Sha256HexSchema, CanonicalUuidV4Schema } from '@cauce/protocol';
import { withAbortableTransaction, type DatabasePool } from '@cauce/store';
import { AuthorizationError } from '../auth.js';
import { consoleHumanAccess } from '../console-human-authority.js';
import { PasswordAuthProvider } from '../password-auth.js';
import { OAuthError } from '../oauth-authorization-types.js';
import { CreateClientDelegationSchema, RenameClientDelegationSchema, RevokeClientDelegationSchema,
  lockClientDeclarationOwner, listClientDelegations, mutateClientDelegation, type ClientDelegationControlOptions } from '../client-delegation-control.js';
import { replyError } from './shared.js';

export function registerClientDelegationRoutes(app: FastifyInstance, pool: DatabasePool,
  provider: PasswordAuthProvider, options: ClientDelegationControlOptions): void {
  const path = '/v3/console/mcp/client-delegations';
  const register = (operation: 'list' | 'create' | 'rename' | 'revoke') => {
    app.route({ method: operation === 'list' ? 'GET' : 'POST',
      url: operation === 'list' || operation === 'create' ? path : `${path}/:binding_id/${operation}`,
      bodyLimit: 4096, handler: async (request, reply) => {
        let human: Awaited<ReturnType<typeof consoleHumanAccess>>;
        try {
          reply.header('Cache-Control', 'no-store');
          if (request.headers.authorization !== undefined) throw new AuthorizationError();
          const session = await provider.verifiedConsoleSession(request);
          if (!session) throw new AuthorizationError();
          if (operation !== 'list') {
            if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') throw new AuthorizationError();
            await provider.requireCsrf(request);
          }
          human = await consoleHumanAccess(provider, request, reply);
          if (!human) throw new AuthorizationError();
          const access = human.options;
          const command = operation === 'list' ? undefined : parseCommand(operation, request);
          const result = await withAbortableTransaction(pool, access.signal, async (client) => {
            if (command) await lockClientDeclarationOwner(client, session.humanId, options.issuer);
            const owner = await access.humanAuthority(client);
            return command ? mutateClientDelegation(client, owner, options, command)
              : listClientDelegations(client, owner, options);
          });
          return await reply.send(result);
        } catch (error) {
          if (error instanceof OAuthError) return await reply.code(403).send({ error: 'forbidden' });
          replyError(reply, error);
        } finally { human?.close(); }
      } });
  };
  for (const operation of ['list', 'create', 'rename', 'revoke'] as const) register(operation);
}
function parseCommand(operation: 'create' | 'rename' | 'revoke', request: FastifyRequest) {
  const data = (operation === 'create' ? CreateClientDelegationSchema
    : operation === 'rename' ? RenameClientDelegationSchema : RevokeClientDelegationSchema).parse(request.body);
  const target = 'connection_ref' in data ? Sha256HexSchema.parse(data.connection_ref)
    : CanonicalUuidV4Schema.parse((request.params as Record<string, unknown>).binding_id);
  return { operation, target, requestId: data.request_id, ...('label' in data ? { label: ClientDelegationLabelSchema.parse(data.label) } : {}) };
}
