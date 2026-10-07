import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  AgentAppearanceUpdateSchema, AliasSchema, TenantSchema, type Tenant,
} from '@cauce/protocol';
import {
  AgentAppearanceRevisionError, AgentFavoriteLimitError, AgentPreferencesStore, StoreError,
  type AgentAppearanceActor, type AgentAppearanceDenialRecord, type AgentPreferencesRepository,
  type AgentTargetPermission, type AuthorizedAgentTarget,
} from '@cauce/store';
import { requireOperatorPermission, requirePermission, type AuthProvider, type Principal } from '../../auth.js';
import { consoleHumanSubject } from '../../console-message-author.js';
import { PasswordAuthProvider } from '../../password-auth.js';
import { principal, replyError } from '../shared.js';
import type { ConsoleRoutes } from './contracts.js';

const HUMAN_SESSION_REQUIRED = 'Hace falta una sesión de persona con contraseña.';
const POSITIVE_REVISION = /^[1-9][0-9]{0,15}$/u;

interface AgentParams { tenant: string; alias: string }
interface AgentIdentity { tenant_id: Tenant; alias: string }
type AppearanceOperation = AgentAppearanceDenialRecord['operation'];

/** Favorites belong to the console account behind the session cookie, never to the shared technical alias. */
async function callingHuman(provider: AuthProvider, request: FastifyRequest): Promise<string | undefined> {
  if (!(provider instanceof PasswordAuthProvider)) return undefined;
  return (await provider.verifiedConsoleSession(request))?.humanId;
}

function agentIdentity(params: AgentParams): AgentIdentity | undefined {
  const tenant = TenantSchema.safeParse(params.tenant);
  const alias = AliasSchema.safeParse(params.alias);
  return tenant.success && alias.success ? { tenant_id: tenant.data, alias: alias.data } : undefined;
}

function appearanceActor(actor: Principal): AgentAppearanceActor {
  const subject = consoleHumanSubject(actor);
  return {
    tenant_id: actor.tenant_id,
    alias: actor.alias,
    display: actor.operator_profile?.display_name ?? `${actor.tenant_id}:${actor.alias}`,
    ...(subject === undefined ? {} : { human_subject: subject }),
  };
}

async function invalidIdentity(reply: FastifyReply): Promise<FastifyReply> {
  return reply.code(400).send({ error: 'invalid_input', message: 'tenant or alias is invalid' });
}

async function hiddenAgent(reply: FastifyReply): Promise<FastifyReply> {
  return reply.code(404).send({ error: 'not_found', message: 'agent not found or not visible' });
}

async function humanRequired(reply: FastifyReply): Promise<FastifyReply> {
  return reply.code(401).send({ error: 'unauthorized', message: HUMAN_SESSION_REQUIRED });
}

function replyPreferenceError(reply: FastifyReply, error: unknown): void {
  if (error instanceof AgentFavoriteLimitError) {
    void reply.code(409).send({ error: error.reason, message: error.message, limit: error.limit });
    return;
  }
  replyError(reply, error);
}

export function registerConsoleAgentPreferenceRoutes(app: FastifyInstance, context: ConsoleRoutes): void {
  const { options, repository } = context;
  const preferences: AgentPreferencesRepository = options.agentPreferences ?? new AgentPreferencesStore(options.pool);
  const authorizedTarget = async (
    actor: Principal, target: AgentIdentity, permission: AgentTargetPermission,
  ): Promise<AuthorizedAgentTarget | undefined> => {
    try {
      const found = await repository.authorizeAgentTarget(
        actor.tenant_id, actor.alias, target.tenant_id, target.alias, permission,
      );
      return found?.tenant_id === target.tenant_id && found.alias === target.alias ? found : undefined;
    } catch (error) {
      if (error instanceof StoreError && (error.code === 'forbidden' || error.code === 'invalid_actor')) return undefined;
      throw error;
    }
  };

  /**
   * Appearance is shared configuration of the target, so the target must grant control, not just
   * read; a disabled agent keeps its appearance editable. Returns whether a denial was sent: a sent
   * FastifyReply is thenable and resolves to nothing.
   */
  const deniedAppearanceWrite = async (
    reply: FastifyReply, actor: Principal, target: AgentIdentity, operation: AppearanceOperation,
  ): Promise<boolean> => {
    if (await authorizedTarget(actor, target, 'configure') !== undefined) return false;
    const record = { target_tenant: target.tenant_id, target_alias: target.alias, operation };
    if (await authorizedTarget(actor, target, 'read') === undefined) {
      await preferences.recordAppearanceDenial(appearanceActor(actor), { ...record, reason: 'not_found' });
      await hiddenAgent(reply);
      return true;
    }
    await preferences.recordAppearanceDenial(appearanceActor(actor), { ...record, reason: 'forbidden' });
    await reply.code(403).send({
      error: 'forbidden',
      message: `the actor can read ${target.tenant_id}/${target.alias} but has no control permission over it`,
    });
    return true;
  };

  const revisionConflict = async (
    reply: FastifyReply, actor: Principal, target: AgentIdentity, operation: AppearanceOperation,
    expected: number | null, error: AgentAppearanceRevisionError,
  ): Promise<FastifyReply> => {
    await preferences.recordAppearanceDenial(appearanceActor(actor), {
      target_tenant: target.tenant_id, target_alias: target.alias, operation,
      reason: 'revision_conflict', expected_revision: expected, current_revision: error.currentRevision,
    });
    return reply.code(409).send({
      error: error.reason, message: error.message, current_revision: error.currentRevision,
    });
  };

  app.get('/v3/console/agent-preferences', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requirePermission(actor, 'read');
      await repository.assertPermission(actor.tenant_id, actor.alias, 'read');
      const humanId = await callingHuman(options.authProvider, request);
      const [favorites, appearances] = await Promise.all([
        humanId === undefined ? [] : preferences.listFavorites(humanId, actor.tenant_id),
        preferences.listAppearances(actor.tenant_id),
      ]);
      return await reply.header('Cache-Control', 'no-store').send({ favorites, appearances });
    } catch (error) { replyPreferenceError(reply, error); }
  });

  app.put<{ Params: AgentParams }>('/v3/console/favorites/:tenant/:alias', async (request, reply) => {
    try {
      const target = agentIdentity(request.params);
      if (target === undefined) return await invalidIdentity(reply);
      const actor = await principal(request, options.authProvider);
      requirePermission(actor, 'read');
      const humanId = await callingHuman(options.authProvider, request);
      if (humanId === undefined) return await humanRequired(reply);
      if (await authorizedTarget(actor, target, 'read') === undefined) return await hiddenAgent(reply);
      await preferences.addFavorite(humanId, actor.tenant_id, target.tenant_id, target.alias);
      return await reply.code(204).send();
    } catch (error) { replyPreferenceError(reply, error); }
  });

  app.delete<{ Params: AgentParams }>('/v3/console/favorites/:tenant/:alias', async (request, reply) => {
    try {
      const target = agentIdentity(request.params);
      if (target === undefined) return await invalidIdentity(reply);
      await principal(request, options.authProvider);
      const humanId = await callingHuman(options.authProvider, request);
      if (humanId === undefined) return await humanRequired(reply);
      await preferences.removeFavorite(humanId, target.tenant_id, target.alias);
      return await reply.code(204).send();
    } catch (error) { replyPreferenceError(reply, error); }
  });

  app.put<{ Params: AgentParams }>('/v3/console/agents/:tenant/:alias/appearance', async (request, reply) => {
    try {
      const target = agentIdentity(request.params);
      if (target === undefined) return await invalidIdentity(reply);
      const actor = await principal(request, options.authProvider);
      requireOperatorPermission(actor, 'control');
      await repository.assertPermission(actor.tenant_id, actor.alias, 'control');
      const body = AgentAppearanceUpdateSchema.safeParse(request.body);
      if (!body.success) {
        return await reply.code(400).send({
          error: 'invalid_input', message: body.error.issues.map((issue) => issue.message).join('; '),
        });
      }
      if (await deniedAppearanceWrite(reply, actor, target, 'set')) return;
      try {
        const saved = await preferences.setAppearance({ ...target, ...body.data }, appearanceActor(actor));
        return await reply.header('Cache-Control', 'no-store').send(saved);
      } catch (error) {
        if (!(error instanceof AgentAppearanceRevisionError)) throw error;
        return await revisionConflict(reply, actor, target, 'set', body.data.expected_revision, error);
      }
    } catch (error) { replyPreferenceError(reply, error); }
  });

  app.delete<{ Params: AgentParams; Querystring: { expected_revision?: unknown } }>(
    '/v3/console/agents/:tenant/:alias/appearance',
    async (request, reply) => {
      try {
        const target = agentIdentity(request.params);
        if (target === undefined) return await invalidIdentity(reply);
        const actor = await principal(request, options.authProvider);
        requireOperatorPermission(actor, 'control');
        await repository.assertPermission(actor.tenant_id, actor.alias, 'control');
        const raw = request.query.expected_revision;
        if (typeof raw !== 'string' || !POSITIVE_REVISION.test(raw) || !Number.isSafeInteger(Number(raw))) {
          return await reply.code(400).send({
            error: 'invalid_input', message: 'expected_revision must be a positive integer',
          });
        }
        if (await deniedAppearanceWrite(reply, actor, target, 'reset')) return;
        const expected = Number(raw);
        try {
          await preferences.resetAppearance(target.tenant_id, target.alias, expected, appearanceActor(actor));
          return await reply.code(204).send();
        } catch (error) {
          if (!(error instanceof AgentAppearanceRevisionError)) throw error;
          return await revisionConflict(reply, actor, target, 'reset', expected, error);
        }
      } catch (error) { replyPreferenceError(reply, error); }
    },
  );
}
