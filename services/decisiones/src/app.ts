import Fastify, { type FastifyInstance, type FastifyReply, type FastifyServerOptions } from 'fastify';
import { errorLabel, logEvent } from '@cauce/protocol';
import type { DecisionService } from './decide.js';
import { DecisionError } from './errors.js';
import type { IdentifyCaller } from './identity.js';

export interface AppOptions {
  readonly service: DecisionService;
  readonly identify: IdentifyCaller;
  readonly credentialPresent: () => Promise<boolean>;
  readonly jevModel: string;
  readonly fastify?: FastifyServerOptions & { https?: unknown };
}

export const SERVICE_VERSION = '0.1.0';
/* Room for the largest body each part admits (64 KiB state, 32 questions of 16 KiB), so an oversized
   request gets the typed 413 with its fallback instead of Fastify's generic one. */
const BODY_LIMIT = 640 * 1024;

function send(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof DecisionError) {
    const retryAfter = error.details.retryAfterMs;
    if (retryAfter !== undefined) void reply.header('retry-after', String(Math.max(1, Math.ceil(retryAfter / 1000))));
    return reply.code(error.status).send(error.toBody());
  }
  logEvent('decisiones_error_interno', { error: errorLabel(error) }, { level: 'error' });
  return reply.code(500).send({ error: 'error_interno', mensaje: 'fallo interno del servicio de decisiones' });
}

/** Routes only: TLS, identity and Jev are injected so tests can drive each piece on its own. */
export function buildApp(options: AppOptions): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: BODY_LIMIT, ...(options.fastify ?? {}) } as FastifyServerOptions);
  const { service } = options;

  app.setErrorHandler((error, _request, reply) => {
    const status = (error as { statusCode?: unknown }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return reply.code(status).send({ error: 'solicitud_invalida', mensaje: status === 413 ? 'el cuerpo es demasiado grande' : 'cuerpo JSON inválido' });
    }
    return send(reply, error);
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: 'ruta_desconocida', mensaje: 'rutas: GET /health, GET /v1/plantillas[/:id], POST /v1/decidir' }));

  app.get('/health', async () => ({
    ok: true,
    servicio: 'decisiones',
    version: SERVICE_VERSION,
    catalogo: { version: service.catalog.version, plantillas: service.catalog.plantillas.size, modelo_calibrado: service.catalog.calibratedModel },
    jev: { modelo: options.jevModel, credencial: (await options.credentialPresent()) ? 'presente' : 'ausente' },
  }));

  app.get('/v1/plantillas', async (request, reply) => {
    try {
      await options.identify(request.raw.socket);
      return service.listing();
    } catch (error) { return send(reply, error); }
  });

  app.get<{ Params: { id: string } }>('/v1/plantillas/:id', async (request, reply) => {
    try {
      await options.identify(request.raw.socket);
      return service.detail(request.params.id);
    } catch (error) { return send(reply, error); }
  });

  app.post('/v1/decidir', async (request, reply) => {
    try {
      const caller = await options.identify(request.raw.socket);
      return await service.decide(caller, request.body);
    } catch (error) { return send(reply, error); }
  });

  return app;
}
