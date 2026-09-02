import type { FastifyInstance } from 'fastify';
import { registerRelayAuthorizationRoute } from './relay-proxy/authorization.js';
import { registerRelayCloseRoute } from './relay-proxy/close.js';
import { registerRelayConsumeRoute } from './relay-proxy/consume.js';
import {
  createRelayProxyContext, type TerminalRelayProxyOptions,
} from './relay-proxy/context.js';
import { registerRelayPresenceRoutes } from './relay-proxy/presence.js';
import { registerRelayResumeRoute } from './relay-proxy/resume.js';

export { relayClaimEpoch } from './relay-proxy/context.js';

export function registerTerminalRelayProxy(
  app: FastifyInstance,
  options: TerminalRelayProxyOptions,
): void {
  const context = createRelayProxyContext(app, options);
  registerRelayPresenceRoutes(context);
  registerRelayConsumeRoute(context);
  registerRelayResumeRoute(context);
  registerRelayAuthorizationRoute(context);
  registerRelayCloseRoute(context);
}
