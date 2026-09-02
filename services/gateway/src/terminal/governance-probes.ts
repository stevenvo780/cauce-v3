import { readFile } from 'node:fs/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requirePermission, type Principal } from '../auth.js';
import { registerAgentDirectiveRoutes } from '../console/agent-directive.routes.js';
import {
  TerminalRelayFactsProbe, type GovernanceRelayClient, type MeasuredFactsSource
} from '../console/agent-documents.js';
import { HttpGovernanceRelayClient } from '../console/relay-governance-client.js';
import type { TerminalConfig } from './config.js';
import type { AgentTargetRepository } from './helpers.js';
import { hechosDelRegistro } from './hechos-del-registro.js';
import type { AgentRegistry } from './registry.js';

interface GovernanceProbeContext {
  readonly config: TerminalConfig;
  readonly registry: AgentRegistry;
  readonly repository: AgentTargetRepository;
  readonly runtimeOptions: {
    readonly measuredFacts?: MeasuredFactsSource;
  };
  readonly principal: (request: FastifyRequest) => Promise<Principal>;
  readonly replyError: (reply: FastifyReply, error: unknown) => void;
}

/**
 * The client toward the terminal-relay, or one that explains why none exists.
 *
 * The TLS material is read HERE, when registering the plugin, and not on the first read: a
 * certificate file that cannot be read has to kill startup, not be discovered when an operator
 * opens the modal.
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
      // Real presence that the pty-agent publishes. Injectable for tests.
      const measuredFacts: MeasuredFactsSource = runtimeOptions.measuredFacts ?? hechosDelRegistro(registry);

      async function authorizeDirective(
        raw: unknown,
        requested: { tenant_id: string; alias: string },
      ): Promise<{ tenant_id: string; alias: string } | undefined> {
        const request = raw as FastifyRequest;
        const actor = await principal(request);
        // Same permission and canonical visibility as profiles, documents and listAgents: own tenant or allow_read edge.
        requirePermission(actor, 'read');
        const target = await repository.authorizeAgentTarget(
          actor.tenant_id, actor.alias, requested.tenant_id, requested.alias, 'read',
        );
        return target === undefined ? undefined : { tenant_id: target.tenant_id, alias: target.alias };
      }

      // Encapsulated in its own scope so it can be given an error handler: the directive route
      // catches nothing internally, so without this an `AuthError` would surface as a 500 and an
      // operator without a session would see "internal error" instead of "not authenticated".
      const sondaReal = new TerminalRelayFactsProbe(measuredFacts, relayGovernance);

      /*
       * THE PROBE IS INSTALLED IN THE SLOT that `app.ts` left, so the document routes —mounted
       * before this plugin, alongside the rest of `/v3/console`— stop replying "no channel".
       *
       * `app.sondaDeDocumentos` is optional on purpose: tests mount this plugin on Fastify
       * instances that did not go through `buildGateway`, and there is no slot to fill there. Not
       * having it is not a failure; it means that gateway does not serve the console.
       */
      app.sondaDeDocumentos?.instalar(sondaReal);

      return app.register(async (scope) => {
        scope.setErrorHandler((error, _request, reply) => { replyError(reply, error); });
        registerAgentDirectiveRoutes(scope, { authorize: authorizeDirective, probe: sondaReal });
      });
    },
  };
}
