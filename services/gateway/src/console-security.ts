import type { FastifyReply, FastifyRequest } from 'fastify';

export interface ConsoleSecurityOptions {
  /** Exact trusted browser origins. Empty means the request's own scheme+Host. */
  allowedOrigins?: readonly string[];
}

function normalizedOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

function ownOrigin(request: FastifyRequest): string | undefined {
  const host = request.headers.host;
  if (!host) return undefined;
  return normalizedOrigin(`${request.protocol}://${host}`);
}

function headerValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

export function createConsoleSecurityHook(options: ConsoleSecurityOptions = {}) {
  const configured = new Set((options.allowedOrigins ?? []).map(normalizedOrigin).filter((item): item is string => item !== undefined));
  if (configured.size !== (options.allowedOrigins ?? []).length) throw new Error('console origins must be exact URL origins');

  return async function consoleSecurity(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const path = request.url.split('?', 1)[0];
    const consoleRoute = path?.startsWith('/v3/console/') === true;
    const browserAuthRoute = ['/v3/auth/login', '/v3/auth/session', '/v3/auth/logout'].includes(path ?? '');
    // The OIDC callback is intentionally excluded: its one-time state, PKCE verifier and Lax
    // transient cookie authenticate the cross-site top-level redirect from the identity provider.
    if (!consoleRoute && !browserAuthRoute) return;
    reply.header('Vary', 'Origin');
    const origin = headerValue(request.headers.origin);
    const allowed = configured.size > 0 ? configured : new Set([ownOrigin(request)].filter((item): item is string => item !== undefined));
    if (origin !== undefined && (!normalizedOrigin(origin) || !allowed.has(origin))) {
      await reply.code(403).send({ error: 'forbidden', message: 'cross-origin console request rejected' });
      return;
    }
    const fetchSite = headerValue(request.headers['sec-fetch-site']);
    if (fetchSite === 'cross-site') {
      await reply.code(403).send({ error: 'forbidden', message: 'cross-site console request rejected' });
      return;
    }
    const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
    if (unsafe && (origin === undefined || !allowed.has(origin))) {
      await reply.code(403).send({ error: 'forbidden', message: 'same-origin Origin is required for console mutations' });
      return;
    }
    if (request.method === 'OPTIONS') {
      await reply.code(204).send();
    }
  };
}
