import {
  RelayBootConflictError, parseAgentPresence,
} from '../registry.js';
import type { RelayProxyContext } from './context.js';

export function registerRelayPresenceRoutes(context: RelayProxyContext): void {
  const {
    app, config, exactObjectKeys, PRESENCE_KEYS, registry, relayAuthorized, replyError,
    requestRelayIdentity,
  } = context;
  /* ------------------------------------------------------------------ */
  /* Relay routes: /v3/terminal/relay                                    */
  /* ------------------------------------------------------------------ */

  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?', 1)[0];
    if (path?.startsWith('/v3/terminal/relay/') !== true) return;
    if (!relayAuthorized(request, config.relayToken)) {
      // No informative body: an unauthenticated caller learns nothing about the plane.
      await reply.code(401).send();
    }
  });

  app.post('/v3/terminal/relay/agents', async (request, reply) => {
    try {
      const body = request.body;
      if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('body must be an object');
      const record = body as Record<string, unknown>;
      if (!exactObjectKeys(record, PRESENCE_KEYS)) throw new Error('relay presence has unexpected or missing fields');
      const identity = requestRelayIdentity(request, record, false);
      if (identity === undefined) return await reply.code(401).send();
      const agents = record.agents;
      if (!Array.isArray(agents)) throw new Error('agents must be an array');
      try {
        registry.observe(identity, agents.map(parseAgentPresence));
      } catch (error) {
        if (error instanceof RelayBootConflictError) {
          return await reply.code(409).send({ ok: false, reason: 'relay_boot_conflict' });
        }
        throw error;
      }
      return {
        ok: true,
        relay_instance_id: identity.relay_instance_id,
        relay_boot_id: identity.relay_boot_id,
      };
    } catch (error) { replyError(reply, error); }
  });

}
