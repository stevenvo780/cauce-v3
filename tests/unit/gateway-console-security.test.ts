import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  createConsoleSecurityHook,
} from '../../services/gateway/src/console-security.js';

/**
 * Tests for `services/gateway/src/console-security.ts`.
 *
 * The hook is an `onRequest` pre-handler that lets every request pass through, except:
 *   * routes under `/v3/console/` and the browser auth trio (`/v3/auth/login|session|logout`)
 *     must carry an allowed `Origin` and avoid `Sec-Fetch-Site: cross-site`;
 *   * unsafe methods on those routes additionally require a same-origin `Origin`;
 *   * `OPTIONS` on those routes is answered with 204 so the browser preflight is honoured.
 *
 * The hook is exercised here against hand-rolled `FastifyRequest`/`FastifyReply` mocks: every
 * branch is a pure function of `request.url|method|headers` and `reply.header|code|send`, so
 * booting a real Fastify app is unnecessary and would couple the test to Fastify's install
 * location (the package is only linked under `services/gateway/node_modules`).
 */

const ALLOWED = 'https://console.example.test';
const OTHER_ORIGIN = 'https://evil.example.test';

interface CapturedReply {
  statusCode: number;
  sent: unknown;
  headers: Record<string, string>;
}

interface ReplyLike {
  header(name: string, value: string): ReplyLike;
  code(value: number): { send(payload: unknown): Promise<ReplyLike> };
}

function buildReply(): { reply: ReplyLike; captured: CapturedReply } {
  const captured: CapturedReply = { statusCode: 200, sent: undefined, headers: {} };
  const reply: ReplyLike = {
    header(name, value) {
      captured.headers[name.toLowerCase()] = value;
      return reply;
    },
    code(value) {
      captured.statusCode = value;
      return {
        async send(payload: unknown) {
          captured.sent = payload;
          return reply;
        },
      };
    },
  };
  return { reply, captured };
}

interface RequestLike {
  url: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
  protocol: string;
  raw: { socket: { authorized: boolean } };
}

function buildRequest(overrides: {
  url?: string | undefined;
  method?: string | undefined;
  host?: string | undefined;
  protocol?: string | undefined;
  origin?: string | undefined;
  secFetchSite?: string | undefined;
  cookie?: string | undefined;
  clientCertVerified?: boolean | undefined;
}): FastifyRequest {
  const request: RequestLike = {
    url: overrides.url ?? '/v3/console/terminal/sessions',
    method: overrides.method ?? 'GET',
    headers: {
      host: overrides.host ?? 'console.example.test',
      ...(overrides.origin === undefined ? {} : { origin: overrides.origin }),
      ...(overrides.secFetchSite === undefined ? {} : { 'sec-fetch-site': overrides.secFetchSite }),
      ...(overrides.cookie === undefined ? {} : { cookie: overrides.cookie }),
    },
    protocol: overrides.protocol ?? 'https',
    raw: { socket: { authorized: overrides.clientCertVerified ?? false } },
  };
  return request as unknown as FastifyRequest;
}

function asReply(reply: ReplyLike): FastifyReply {
  return reply as unknown as FastifyReply;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('createConsoleSecurityHook: validación de orígenes permitidos', () => {
  it('rechaza la construcción con un origen que trae credenciales embebidas', () => {
    expect(() => createConsoleSecurityHook({
      allowedOrigins: ['https://user:pass@console.example.test'],
    })).toThrow(/console origins must be exact URL origins/u);
  });

  it('rechaza orígenes con query o fragment porque la política exige origins exactos', () => {
    expect(() => createConsoleSecurityHook({
      allowedOrigins: ['https://console.example.test?x=1'],
    })).toThrow(/console origins must be exact URL origins/u);
    expect(() => createConsoleSecurityHook({
      allowedOrigins: ['https://console.example.test#frag'],
    })).toThrow(/console origins must be exact URL origins/u);
  });

  it('normaliza el path vacío (trailing slash) como origin válido y no lanza', () => {
    // El parser de URL colapsa "https://host/" a pathname "/" y origin "https://host";
    // el filtro del hook lo acepta porque pathname === '/' es el caso canónico.
    expect(() => createConsoleSecurityHook({
      allowedOrigins: ['https://console.example.test/'],
    })).not.toThrow();
  });

  it('rechaza URLs inválidas (no es un origin)', () => {
    expect(() => createConsoleSecurityHook({
      allowedOrigins: ['not a url'],
    })).toThrow(/console origins must be exact URL origins/u);
  });

  it('acepta una mezcla de orígenes válidos sin lanzar', () => {
    expect(() => createConsoleSecurityHook({
      allowedOrigins: ['https://a.example.test', 'https://b.example.test'],
    })).not.toThrow();
  });
});

describe('createConsoleSecurityHook: rutas que NO son consola ni auth', () => {
  it('deja pasar en silencio y sin tocar headers', async () => {
    const hook = createConsoleSecurityHook({ allowedOrigins: [ALLOWED] });
    const { reply, captured } = buildReply();
    await hook(
      buildRequest({ url: '/v3/agents/hello', method: 'POST', origin: OTHER_ORIGIN }),
      asReply(reply),
    );
    expect(captured.statusCode).toBe(200);
    expect(captured.sent).toBeUndefined();
    expect(captured.headers).toEqual({});
  });

  it('deja pasar incluso con sec-fetch-site cross-site porque la ruta no es sensible', async () => {
    const hook = createConsoleSecurityHook({ allowedOrigins: [ALLOWED] });
    const { reply, captured } = buildReply();
    await hook(
      buildRequest({ url: '/v3/agents/hello', secFetchSite: 'cross-site', origin: OTHER_ORIGIN }),
      asReply(reply),
    );
    expect(captured.statusCode).toBe(200);
    expect(captured.sent).toBeUndefined();
    expect(captured.headers).toEqual({});
  });
});

describe('createConsoleSecurityHook: rutas /v3/console/* con orígenes permitidos', () => {
  it('deja pasar un GET sin Origin y deja el header Vary puesto para caches', async () => {
    const hook = createConsoleSecurityHook({ allowedOrigins: [ALLOWED] });
    const { reply, captured } = buildReply();
    await hook(buildRequest({}), asReply(reply));
    expect(captured.statusCode).toBe(200);
    expect(captured.sent).toBeUndefined();
    expect(captured.headers.vary).toBe('Origin');
  });

  it('deja pasar un GET con Origin permitido y Vary activo', async () => {
    const hook = createConsoleSecurityHook({ allowedOrigins: [ALLOWED] });
    const { reply, captured } = buildReply();
    await hook(buildRequest({ origin: ALLOWED }), asReply(reply));
    expect(captured.statusCode).toBe(200);
    expect(captured.sent).toBeUndefined();
    expect(captured.headers.vary).toBe('Origin');
  });

  it('deja pasar un POST con Origin permitido (mismo origen) aunque sea método inseguro', async () => {
    const hook = createConsoleSecurityHook({ allowedOrigins: [ALLOWED] });
    const { reply, captured } = buildReply();
    await hook(buildRequest({ method: 'POST', origin: ALLOWED }), asReply(reply));
    expect(captured.statusCode).toBe(200);
    expect(captured.sent).toBeUndefined();
    expect(captured.headers.vary).toBe('Origin');
  });

  it('responde 204 a OPTIONS sobre una ruta consola para honrar el preflight del navegador', async () => {
    const hook = createConsoleSecurityHook({ allowedOrigins: [ALLOWED] });
    const { reply, captured } = buildReply();
    await hook(buildRequest({ method: 'OPTIONS', origin: ALLOWED }), asReply(reply));
    expect(captured.statusCode).toBe(204);
    expect(captured.sent).toBeUndefined();
    expect(captured.headers.vary).toBe('Origin');
  });
});

describe('createConsoleSecurityHook: rechazos en rutas consola', () => {
  it('rechaza un GET cross-origin con 403 y cuerpo exacto', async () => {
    const hook = createConsoleSecurityHook({ allowedOrigins: [ALLOWED] });
    const { reply, captured } = buildReply();
    await hook(buildRequest({ origin: OTHER_ORIGIN }), asReply(reply));
    expect(captured.statusCode).toBe(403);
    expect(captured.sent).toEqual({
      error: 'forbidden',
      message: 'cross-origin console request rejected',
    });
    expect(captured.headers.vary).toBe('Origin');
  });

  it('rechaza con 403 cuando Sec-Fetch-Site es cross-site, incluso con Origin permitido', async () => {
    const hook = createConsoleSecurityHook({ allowedOrigins: [ALLOWED] });
    const { reply, captured } = buildReply();
    await hook(
      buildRequest({ origin: ALLOWED, secFetchSite: 'cross-site' }),
      asReply(reply),
    );
    expect(captured.statusCode).toBe(403);
    expect(captured.sent).toEqual({
      error: 'forbidden',
      message: 'cross-site console request rejected',
    });
  });

  it('rechaza POST sin Origin con un mensaje que nombra same-origin explícitamente', async () => {
    const hook = createConsoleSecurityHook({ allowedOrigins: [ALLOWED] });
    const { reply, captured } = buildReply();
    await hook(buildRequest({ method: 'POST' }), asReply(reply));
    expect(captured.statusCode).toBe(403);
    expect(captured.sent).toEqual({
      error: 'forbidden',
      message: 'same-origin Origin is required for console mutations',
    });
  });

  it('rechaza POST con un Origin que no está permitido aunque la URL sea consola', async () => {
    const hook = createConsoleSecurityHook({ allowedOrigins: [ALLOWED] });
    const { reply, captured } = buildReply();
    await hook(buildRequest({ method: 'POST', origin: OTHER_ORIGIN }), asReply(reply));
    expect(captured.statusCode).toBe(403);
    expect(captured.sent).toEqual({
      error: 'forbidden',
      message: 'cross-origin console request rejected',
    });
  });

  it('rechaza POST con Origin malformado (no es una URL válida)', async () => {
    const hook = createConsoleSecurityHook({ allowedOrigins: [ALLOWED] });
    const { reply, captured } = buildReply();
    await hook(buildRequest({ method: 'POST', origin: 'not-a-url' }), asReply(reply));
    expect(captured.statusCode).toBe(403);
    expect(captured.sent).toEqual({
      error: 'forbidden',
      message: 'cross-origin console request rejected',
    });
  });
});

describe('createConsoleSecurityHook: rutas /v3/auth/* del navegador', () => {
  it('protege /v3/auth/login contra Origin cross-origin', async () => {
    const hook = createConsoleSecurityHook({ allowedOrigins: [ALLOWED] });
    const { reply, captured } = buildReply();
    await hook(
      buildRequest({ url: '/v3/auth/login', method: 'POST', origin: OTHER_ORIGIN }),
      asReply(reply),
    );
    expect(captured.statusCode).toBe(403);
    expect(captured.sent).toEqual({
      error: 'forbidden',
      message: 'cross-origin console request rejected',
    });
  });

  it('deja pasar /v3/auth/session cuando el Origin es permitido', async () => {
    const hook = createConsoleSecurityHook({ allowedOrigins: [ALLOWED] });
    const { reply, captured } = buildReply();
    await hook(
      buildRequest({ url: '/v3/auth/session', method: 'GET', origin: ALLOWED }),
      asReply(reply),
    );
    expect(captured.statusCode).toBe(200);
    expect(captured.headers.vary).toBe('Origin');
  });

  it('NO protege el callback OIDC /v3/auth/callback (deja pasar Origin cross-origin)', async () => {
    // La política lo deja pasar a propósito: la redirección top-level del IdP porta cookies
    // Lax de un solo uso (state, PKCE verifier) que autentican ese único salto cross-site.
    const hook = createConsoleSecurityHook({ allowedOrigins: [ALLOWED] });
    const { reply, captured } = buildReply();
    await hook(
      buildRequest({
        url: '/v3/auth/callback',
        origin: OTHER_ORIGIN,
        secFetchSite: 'cross-site',
      }),
      asReply(reply),
    );
    expect(captured.statusCode).toBe(200);
    expect(captured.sent).toBeUndefined();
  });
});

describe('createConsoleSecurityHook: allowedOrigins vacío (default = mismo Host)', () => {
  it('acepta un GET con Origin igual al Host de la petición', async () => {
    const hook = createConsoleSecurityHook({});
    const { reply, captured } = buildReply();
    await hook(
      buildRequest({
        host: 'console.example.test',
        origin: 'https://console.example.test',
      }),
      asReply(reply),
    );
    expect(captured.statusCode).toBe(200);
    expect(captured.headers.vary).toBe('Origin');
  });

  it('rechaza un POST con Origin que no coincide con el Host (no es mismo origen)', async () => {
    const hook = createConsoleSecurityHook({});
    const { reply, captured } = buildReply();
    await hook(
      buildRequest({
        method: 'POST',
        host: 'console.example.test',
        origin: 'https://other.example.test',
      }),
      asReply(reply),
    );
    expect(captured.statusCode).toBe(403);
    expect(captured.sent).toEqual({
      error: 'forbidden',
      message: 'cross-origin console request rejected',
    });
  });

  it('rechaza cuando allowedOrigins está vacío y la petición no trae Host', async () => {
    // Sin Host no se puede derivar ownOrigin → el allowlist efectivo queda vacío →
    // cualquier Origin distinto al host esperado se rechaza como cross-origin.
    const hook = createConsoleSecurityHook({});
    const { reply, captured } = buildReply();
    await hook(
      buildRequest({ host: undefined, origin: 'https://other.example.test' }),
      asReply(reply),
    );
    expect(captured.statusCode).toBe(403);
    expect(captured.sent).toEqual({
      error: 'forbidden',
      message: 'cross-origin console request rejected',
    });
  });
});

describe('createConsoleSecurityHook: llamador máquina con certificado cliente', () => {
  const SELF_RELOAD = '/v3/console/agents/zeus/context/reload';
  const SAME_ORIGIN_REQUIRED = {
    error: 'forbidden',
    message: 'same-origin Origin is required for console mutations',
  };

  it('deja pasar un POST sin Origin cuando el certificado cliente está verificado y no hay cookie', async () => {
    const hook = createConsoleSecurityHook({ allowedOrigins: [ALLOWED] });
    const { reply, captured } = buildReply();
    await hook(
      buildRequest({ url: SELF_RELOAD, method: 'POST', clientCertVerified: true }),
      asReply(reply),
    );
    expect(captured.statusCode).toBe(200);
    expect(captured.sent).toBeUndefined();
  });

  it('sigue exigiendo Origin si la petición con certificado trae cookie: es un navegador tras el proxy', async () => {
    const hook = createConsoleSecurityHook({ allowedOrigins: [ALLOWED] });
    const { reply, captured } = buildReply();
    await hook(
      buildRequest({ url: SELF_RELOAD, method: 'POST', clientCertVerified: true, cookie: 'cauce_session=abc' }),
      asReply(reply),
    );
    expect(captured.statusCode).toBe(403);
    expect(captured.sent).toEqual(SAME_ORIGIN_REQUIRED);
  });

  it('sigue exigiendo Origin si el certificado cliente no está verificado', async () => {
    const hook = createConsoleSecurityHook({ allowedOrigins: [ALLOWED] });
    const { reply, captured } = buildReply();
    await hook(
      buildRequest({ url: SELF_RELOAD, method: 'POST', clientCertVerified: false }),
      asReply(reply),
    );
    expect(captured.statusCode).toBe(403);
    expect(captured.sent).toEqual(SAME_ORIGIN_REQUIRED);
  });
});
