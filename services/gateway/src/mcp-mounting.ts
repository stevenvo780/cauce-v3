import type { ServerOptions as HttpServerOptions } from 'node:http';
import type { ServerOptions as HttpsServerOptions } from 'node:https';
import type { FastifyInstance } from 'fastify';
import { lockHumanIdentity, resolveHumanIdentity, type DatabasePool } from '@cauce/store';
import type { HumanMcpRepository } from './mcp-operations.js';
import { createHumanMcpOperationsFactory } from './mcp-operations.js';
import type { ConsolePublishTelemetry } from './console-publish-telemetry.js';
import type { configuredHumanMcp } from './mcp-configuration.js';
import { registerOAuthAuthorizationServer } from './oauth-authorization-server.js';
import { registerMcpIngress } from './mcp-ingress.js';
import { logPublishRedaction } from './routes/publish-redaction.js';

export type HumanMcpConfiguration = NonNullable<ReturnType<typeof configuredHumanMcp>>;

interface HumanMcpListenerOptions {
  http?: HttpServerOptions;
  https?: HttpsServerOptions;
  requestTimeout?: number;
  keepAliveTimeout?: number;
}

export function humanMcpListenerOptions(
  configuration: HumanMcpConfiguration | undefined, https: HttpsServerOptions | undefined,
): HumanMcpListenerOptions {
  if (configuration === undefined) return https === undefined ? {} : { https };
  return {
    ...(https === undefined ? { http: { maxHeaderSize: 16 * 1024 } }
      : { https: { ...https, maxHeaderSize: 16 * 1024 } }),
    requestTimeout: 10_000,
    keepAliveTimeout: 1_000,
  };
}

export async function registerHumanMcp(
  app: FastifyInstance, configuration: HumanMcpConfiguration,
  repository: HumanMcpRepository, pool: DatabasePool, telemetry: ConsolePublishTelemetry,
): Promise<void> {
  app.server.headersTimeout = 10_000;
  app.server.maxHeadersCount = 64;
  app.server.maxConnections = 64;
  const operationsFactory = createHumanMcpOperationsFactory({
    repository, pool, telemetry, priorityLog: app.log,
    ...(configuration.oauth === undefined ? {} : { identityStore: {
      resolve: (key, signal) => resolveHumanIdentity(pool, key, signal), lock: lockHumanIdentity,
      verifyCredentialStamp: configuration.oauth.passwordAuth.verifyCredentialStamp.bind(configuration.oauth.passwordAuth),
    } }),
    logRedaction: (actor, redaction) => { logPublishRedaction(app.log, actor, redaction); },
  });
  if (configuration.oauth !== undefined) await registerOAuthAuthorizationServer(app, configuration.oauth);
  await app.register(registerMcpIngress, { ...configuration, operationsFactory });
}
