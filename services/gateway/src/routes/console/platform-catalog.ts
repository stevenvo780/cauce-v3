import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  applyPlatformConfiguration, readPlatformConfiguration, withTransaction, ConfigurationError, StoreError,
  type ConfigurationAuthorityResolver, type DatabaseClient, type DatabasePool, type PlatformActor,
} from '@cauce/store';
import { AuthorizationError, type AuthProvider } from '../../auth.js';
import { consoleHumanAccess } from '../../console-human-authority.js';
import { driverErrorCode, replyError } from '../shared.js';
import { validatedConfigurationReceipt } from './helpers.js';

const IDENTIFIER = /^[a-z][a-z0-9_-]{0,63}$/u;
const Revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Capabilities = z.array(z.string().min(1).max(80)).min(1).max(5);

const HarnessCreate = z.object({
  id: z.string().regex(IDENTIFIER), display_name: z.string().trim().min(1).max(128),
  capabilities: Capabilities, enabled: z.boolean().optional(), expected_revision: Revision,
}).strict();
const HarnessUpdate = z.object({
  display_name: z.string().trim().min(1).max(128).optional(), capabilities: Capabilities.optional(),
  enabled: z.boolean().optional(), expected_revision: Revision,
}).strict().refine(
  (value) => value.display_name !== undefined || value.capabilities !== undefined || value.enabled !== undefined,
  { message: 'at least one field must change' },
);
const RoleCreate = z.object({
  role: z.string().regex(IDENTIFIER),
  allow_route: z.boolean().optional(), allow_read: z.boolean().optional(),
  allow_control: z.boolean().optional(), allow_notify: z.boolean().optional(),
  expected_revision: Revision,
}).strict();
const RoleUpdate = z.object({
  allow_route: z.boolean().optional(), allow_read: z.boolean().optional(),
  allow_control: z.boolean().optional(), allow_notify: z.boolean().optional(),
  expected_revision: Revision,
}).strict().refine(
  (value) => value.allow_route !== undefined || value.allow_read !== undefined
    || value.allow_control !== undefined || value.allow_notify !== undefined,
  { message: 'at least one field must change' },
);
const RevisionQuery = z.object({
  expected_revision: z.string().regex(/^[0-9]{1,15}$/u).transform(Number),
}).strict();

const FIELD_LABELS: Readonly<Record<string, string>> = {
  id: 'Id del arnés', role: 'Id del rol', display_name: 'Nombre visible', capabilities: 'Capacidades',
  enabled: 'Habilitado', allow_route: 'Permitir ruta', allow_read: 'Permitir lectura',
  allow_control: 'Permitir control', allow_notify: 'Permitir aviso proactivo',
  expected_revision: 'Revisión esperada',
};

function spanishZodMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue?.code === 'unrecognized_keys') {
    const keys = 'keys' in issue && Array.isArray(issue.keys) ? issue.keys.join('», «') : '';
    return `Campo no admitido: «${keys}». Esta operación no acepta ese campo.`;
  }
  const key = String(issue?.path.at(-1) ?? '');
  const label = FIELD_LABELS[key] ?? 'Configuración';
  if (issue?.code === 'custom') return `${label}: modifica al menos un campo antes de guardar.`;
  return `${label}: valor no válido. Revisa el formato y los límites del campo.`;
}

/** The store messages name the field in English; the console contract is field and reason in Spanish. */
export function spanishCatalogMessage(message: string): string {
  if (message.startsWith('harness.id:')) {
    if (message.includes('no published descriptor declares this harness')) {
      return 'Id del arnés: no hay un descriptor publicado para ese id. Publica primero el descriptor '
        + 'en packages/adapter-sdk/descriptors con su aprobación por digest; los descriptores aprobados no se editan desde la web.';
    }
    if (message.includes('its published descriptor is invalid')) {
      const reason = /\((.*)\)/u.exec(message)?.[1] ?? 'motivo no informado';
      return `Id del arnés: el descriptor publicado no es válido (${reason}). El descriptor se corrige fuera de la web.`;
    }
    if (message.includes('descriptor catalog is unavailable') || message.includes('must be an absolute path')) {
      return 'Id del arnés: el catálogo de descriptores publicados no está disponible en el servidor.';
    }
    return message;
  }
  if (message.startsWith('harness.capabilities:')) {
    if (message.includes('at least one capability is required')) return 'Capacidades: elige al menos una capacidad.';
    const outside = /'([^']+)' is outside the closed vocabulary/u.exec(message)?.[1];
    if (outside !== undefined) {
      return `Capacidades: «${outside}» no pertenece al vocabulario cerrado `
        + '(messages.receive, ack.timeline, origin.relay, jobs.interactive, jobs.batch).';
    }
    const repeated = /'([^']+)' is repeated/u.exec(message)?.[1];
    if (repeated !== undefined) return `Capacidades: «${repeated}» está repetida.`;
    return 'Capacidades: debe ser una lista de capacidades.';
  }
  if (message.startsWith('harness.command:')) {
    return 'Comando: el descriptor publicado no declara comando; el adaptador ejecuta su binario empaquetado y el comando queda vacío.';
  }
  const revision = /^configuration revision changed: expected (\d+), current (\d+)/u.exec(message);
  if (revision?.[1] !== undefined && revision[2] !== undefined) {
    return `Conflicto de revisión: esperabas la revisión ${revision[1]} y el servidor ya va por la ${revision[2]}. `
      + 'Relee el catálogo y vuelve a intentarlo sobre la revisión actual.';
  }
  const known: Readonly<Record<string, string>> = {
    'harness definition already exists': 'Id del arnés: ya existe una definición con ese id.',
    'harness definition was not found': 'Id del arnés: no existe una definición con ese id.',
    'role policy already exists': 'Id del rol: ya existe una política con ese rol.',
    'role policy was not found': 'Id del rol: no existe una política con ese rol.',
    'harness display_name is required': 'Nombre visible: completa el nombre visible del arnés.',
    'expected revision is required': 'Revisión esperada: falta la revisión sobre la que pides el cambio; relee el catálogo.',
    'configuration cannot remove the last qualified platform administrator':
      'El cambio dejaría a la plataforma sin su último administrador calificado. Asigna otro administrador antes de intentarlo.',
    'configuration change violates a durable constraint':
      'El cambio contradice una restricción guardada. Si estás borrando, revisa qué agentes o membresías todavía lo usan.',
    'configuration resource has durable dependencies':
      'No se puede borrar: agentes o membresías todavía usan este recurso. Resuelve las dependencias antes de intentarlo.',
    'authority is busy; reload and retry': 'La autoridad está ocupada por otro cambio; relee el catálogo y vuelve a intentarlo.',
    'platform administrator authority is required':
      'Solo el administrador de plataforma puede ver y cambiar las definiciones de arnés y las políticas de rol.',
  };
  const translated = Object.hasOwn(known, message) ? known[message] : undefined;
  if (translated !== undefined) return translated;
  if (message.includes('must keep a qualified')) {
    return 'El cambio dejaría sin su última autoridad calificada a la plataforma o a una empresa. Asigna otro administrador antes de intentarlo.';
  }
  return message;
}

function failed(reply: FastifyReply, error: unknown): void {
  if (error instanceof z.ZodError) {
    void reply.code(400).send({ error: 'invalid_input', message: spanishZodMessage(error) });
    return;
  }
  const code = driverErrorCode(error);
  if (['55P03', '40001', '40P01', '23503', '23505', '23514', '23P01'].includes(code ?? '')) {
    const message = ['55P03', '40001', '40P01'].includes(code ?? '')
      ? 'authority is busy; reload and retry' : 'configuration change violates a durable constraint';
    replyError(reply, new ConfigurationError('conflict', spanishCatalogMessage(message)));
    return;
  }
  if (error instanceof ConfigurationError) {
    replyError(reply, new ConfigurationError(error.code, spanishCatalogMessage(error.message), error.dependencies));
    return;
  }
  if (error instanceof StoreError && error.message === 'platform administrator authority is required') {
    replyError(reply, new StoreError(error.code, spanishCatalogMessage(error.message)));
    return;
  }
  if (!(error instanceof AuthorizationError || error instanceof StoreError)) throw error;
  replyError(reply, error);
}

/**
 * The web face of the platform catalog. Every write goes through the same store operation as
 * the platform CLI (`applyPlatformConfiguration`): same Zod contract, same descriptor check,
 * same transaction, same revision and audit rows. Only a platform administrator reaches it.
 */
async function withPlatformAuthority<T>(
  provider: AuthProvider, pool: DatabasePool, request: FastifyRequest, reply: FastifyReply,
  work: (client: DatabaseClient, actor: PlatformActor, revalidate: ConfigurationAuthorityResolver) => Promise<T>,
): Promise<T> {
  const access = await consoleHumanAccess(provider, request, reply, 'read');
  if (access === undefined) throw new AuthorizationError('Se requiere una sesión de consola verificada.');
  try {
    return await withTransaction(pool, async (client) => {
      const mutating = request.method !== 'GET';
      if (mutating) await client.query('SAVEPOINT platform_catalog_authority');
      const authority = await access.companyAuthority(client);
      if (authority.role !== 'platform_admin' || authority.humanId === null) {
        throw new StoreError(
          'forbidden',
          'Solo el administrador de plataforma puede ver y cambiar las definiciones de arnés y las políticas de rol.',
        );
      }
      const actor: PlatformActor = {
        humanId: authority.humanId, tenant: authority.homeTenant,
        alias: authority.alias, companyId: authority.actingCompany,
      };
      if (mutating) {
        await client.query('ROLLBACK TO SAVEPOINT platform_catalog_authority');
        await client.query('RELEASE SAVEPOINT platform_catalog_authority');
      }
      return work(client, actor, (current) => access.companyAuthority(current));
    });
  } finally { access.close(); }
}

export function registerPlatformCatalogRoutes(app: FastifyInstance, provider: AuthProvider, pool: DatabasePool): void {
  app.get('/v3/console/platform/catalog', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      return await withPlatformAuthority(provider, pool, request, reply,
        (client, actor) => readPlatformConfiguration(pool, actor, client));
    } catch (error) { failed(reply, error); }
  });

  app.post('/v3/console/platform/harnesses', { bodyLimit: 8192 }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const receipt = await withPlatformAuthority(provider, pool, request, reply, async (client, actor, revalidate) => {
        const input = HarnessCreate.parse(request.body);
        const mutation = {
          resource: 'harness' as const, action: 'create' as const, id: input.id,
          value: {
            display_name: input.display_name, capabilities: input.capabilities,
            ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
          },
        };
        const result = await applyPlatformConfiguration(pool, actor, mutation, false, input.expected_revision, client, revalidate);
        return validatedConfigurationReceipt(result, false, null, mutation);
      });
      return await reply.code(201).send(receipt);
    } catch (error) { failed(reply, error); }
  });

  app.patch<{ Params: { id: string } }>('/v3/console/platform/harnesses/:id', { bodyLimit: 8192 }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const receipt = await withPlatformAuthority(provider, pool, request, reply, async (client, actor, revalidate) => {
        const id = z.string().regex(IDENTIFIER).parse(request.params.id);
        const input = HarnessUpdate.parse(request.body);
        const mutation = {
          resource: 'harness' as const, action: 'update' as const, id,
          value: {
            ...(input.display_name === undefined ? {} : { display_name: input.display_name }),
            ...(input.capabilities === undefined ? {} : { capabilities: input.capabilities }),
            ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
          },
        };
        const result = await applyPlatformConfiguration(pool, actor, mutation, false, input.expected_revision, client, revalidate);
        return validatedConfigurationReceipt(result, false, null, mutation);
      });
      return await reply.code(200).send(receipt);
    } catch (error) { failed(reply, error); }
  });

  app.delete<{ Params: { id: string } }>('/v3/console/platform/harnesses/:id', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const receipt = await withPlatformAuthority(provider, pool, request, reply, async (client, actor, revalidate) => {
        const id = z.string().regex(IDENTIFIER).parse(request.params.id);
        const { expected_revision } = RevisionQuery.parse(request.query);
        const mutation = { resource: 'harness' as const, action: 'delete' as const, id };
        const result = await applyPlatformConfiguration(pool, actor, mutation, false, expected_revision, client, revalidate);
        return validatedConfigurationReceipt(result, false, null, mutation);
      });
      return await reply.code(200).send(receipt);
    } catch (error) { failed(reply, error); }
  });

  app.post('/v3/console/platform/role-policies', { bodyLimit: 8192 }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const receipt = await withPlatformAuthority(provider, pool, request, reply, async (client, actor, revalidate) => {
        const input = RoleCreate.parse(request.body);
        const mutation = {
          resource: 'role_policy' as const, action: 'create' as const, role: input.role,
          value: {
            ...(input.allow_route === undefined ? {} : { allow_route: input.allow_route }),
            ...(input.allow_read === undefined ? {} : { allow_read: input.allow_read }),
            ...(input.allow_control === undefined ? {} : { allow_control: input.allow_control }),
            ...(input.allow_notify === undefined ? {} : { allow_notify: input.allow_notify }),
          },
        };
        const result = await applyPlatformConfiguration(pool, actor, mutation, false, input.expected_revision, client, revalidate);
        return validatedConfigurationReceipt(result, false, null, mutation);
      });
      return await reply.code(201).send(receipt);
    } catch (error) { failed(reply, error); }
  });

  app.patch<{ Params: { role: string } }>('/v3/console/platform/role-policies/:role', { bodyLimit: 8192 }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const receipt = await withPlatformAuthority(provider, pool, request, reply, async (client, actor, revalidate) => {
        const role = z.string().regex(IDENTIFIER).parse(request.params.role);
        const input = RoleUpdate.parse(request.body);
        const mutation = {
          resource: 'role_policy' as const, action: 'update' as const, role,
          value: {
            ...(input.allow_route === undefined ? {} : { allow_route: input.allow_route }),
            ...(input.allow_read === undefined ? {} : { allow_read: input.allow_read }),
            ...(input.allow_control === undefined ? {} : { allow_control: input.allow_control }),
            ...(input.allow_notify === undefined ? {} : { allow_notify: input.allow_notify }),
          },
        };
        const result = await applyPlatformConfiguration(pool, actor, mutation, false, input.expected_revision, client, revalidate);
        return validatedConfigurationReceipt(result, false, null, mutation);
      });
      return await reply.code(200).send(receipt);
    } catch (error) { failed(reply, error); }
  });

  app.delete<{ Params: { role: string } }>('/v3/console/platform/role-policies/:role', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      const receipt = await withPlatformAuthority(provider, pool, request, reply, async (client, actor, revalidate) => {
        const role = z.string().regex(IDENTIFIER).parse(request.params.role);
        const { expected_revision } = RevisionQuery.parse(request.query);
        const mutation = { resource: 'role_policy' as const, action: 'delete' as const, role };
        const result = await applyPlatformConfiguration(pool, actor, mutation, false, expected_revision, client, revalidate);
        return validatedConfigurationReceipt(result, false, null, mutation);
      });
      return await reply.code(200).send(receipt);
    } catch (error) { failed(reply, error); }
  });
}
