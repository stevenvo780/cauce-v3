import { readFile } from 'node:fs/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthorizedAgentTarget } from '@cauce/store';
import { requirePermission, type Principal } from '../auth.js';
import { registerAgentDirectiveRoutes } from '../console/agent-directive.routes.js';
import {
  TerminalRelayFactsProbe, type GovernanceRelayClient, type MeasuredFactsSource
} from '../console/agent-documents.js';
import { HttpGovernanceRelayClient } from '../console/relay-governance-client.js';
import type { TerminalConfig } from './config.js';
import { hechosDelRegistro } from './hechos-del-registro.js';
import type { AgentRegistry } from './registry.js';

interface GovernanceProbeContext {
  readonly config: TerminalConfig;
  readonly registry: AgentRegistry;
  readonly repository: {
    authorizeAgentTarget(
      actorTenant: string,
      actorAlias: string,
      targetTenant: string,
      targetAlias: string,
      permission: 'read' | 'control',
    ): Promise<AuthorizedAgentTarget | undefined>;
  };
  readonly runtimeOptions: {
    readonly measuredFacts?: MeasuredFactsSource;
  };
  readonly principal: (request: FastifyRequest) => Promise<Principal>;
  readonly replyError: (reply: FastifyReply, error: unknown) => void;
}

/**
 * El cliente hacia el terminal-relay, o uno que explica por qué no hay ninguno.
 *
 * El material TLS se lee AQUÍ, al registrar el plugin, y no en la primera lectura: un fichero de
 * certificado que no se puede leer tiene que matar el arranque, no descubrirse cuando un operador
 * abre el modal.
 */
async function buildGovernanceRelay(config: TerminalConfig): Promise<GovernanceRelayClient> {
  if (config.relayUrl === undefined) {
    return {
      readFile: async () => ({
        error: 'unavailable',
        reason: 'el gateway no tiene configurada la dirección del terminal-relay (CAUCE_TERMINAL_RELAY_URL)'
      })
    };
  }
  const [ca, clientCert, clientKey] = await Promise.all([
    config.relayCaFile === undefined ? undefined : readFile(config.relayCaFile),
    config.relayClientCertFile === undefined ? undefined : readFile(config.relayClientCertFile),
    config.relayClientKeyFile === undefined ? undefined : readFile(config.relayClientKeyFile)
  ]);
  return new HttpGovernanceRelayClient({
    relayUrl: config.relayUrl,
    token: config.relayToken,
    ...(ca === undefined ? {} : { ca }),
    ...(clientCert === undefined || clientKey === undefined ? {} : { clientCert, clientKey })
  });
}

export function createGovernanceProbes(
  app: FastifyInstance,
  context: GovernanceProbeContext,
): {
  buildRelay: () => Promise<GovernanceRelayClient>;
  register: (relayGovernance: GovernanceRelayClient) => ReturnType<FastifyInstance['register']>;
} {
  const { config, registry, repository, runtimeOptions, principal, replyError } = context;
  return {
    buildRelay: () => buildGovernanceRelay(config),
    register: (relayGovernance) => {
      // Presencia real que el pty-agent publica. Inyectable para tests.
      const measuredFacts: MeasuredFactsSource = runtimeOptions.measuredFacts ?? hechosDelRegistro(registry);

      async function authorizeDirective(
        raw: unknown,
        requested: { tenant_id: string; alias: string },
      ): Promise<{ tenant_id: string; alias: string } | undefined> {
        const request = raw as FastifyRequest;
        const actor = await principal(request);
        // Mismo permiso y visibilidad canónica que perfiles, documentos y listAgents: tenant propio o arista allow_read.
        requirePermission(actor, 'read');
        const target = await repository.authorizeAgentTarget(
          actor.tenant_id, actor.alias, requested.tenant_id, requested.alias, 'read',
        );
        return target === undefined ? undefined : { tenant_id: target.tenant_id, alias: target.alias };
      }

      // Encapsulado en su propio ámbito para poder darle un manejador de errores: la ruta de directiva
      // no atrapa nada por dentro, así que sin esto un `AuthError` saldría como 500 y un operador sin
      // sesión vería «error interno» en vez de «no estás autenticado».
      const sondaReal = new TerminalRelayFactsProbe(measuredFacts, relayGovernance);

      /*
       * SE INSTALA LA SONDA EN EL HUECO que `app.ts` dejó, para que las rutas de documentos —montadas
       * antes que este plugin, con el resto de `/v3/console`— dejen de contestar «no hay canal».
       *
       * `app.sondaDeDocumentos` es opcional a propósito: los tests montan este plugin sobre instancias
       * de Fastify que no pasaron por `buildGateway`, y ahí no hay hueco que rellenar. No tenerlo no
       * es un fallo, es que ese gateway no sirve la consola.
       */
      app.sondaDeDocumentos?.instalar(sondaReal);

      return app.register(async (scope) => {
        scope.setErrorHandler((error, _request, reply) => { replyError(reply, error); });
        registerAgentDirectiveRoutes(scope, { authorize: authorizeDirective, probe: sondaReal });
      });
    },
  };
}
