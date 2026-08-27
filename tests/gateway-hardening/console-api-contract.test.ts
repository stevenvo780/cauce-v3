import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildGateway } from '../../services/gateway/src/index.js';
import { FixedAuthProvider, fakePool, fakeRepository, grants, noDeliveryWakes, roles, testPrincipal } from './helpers.js';

/**
 * Contract guard for the console -> gateway API surface.
 *
 * Regression origin: the console shipped `getTopologyAccess()` against
 * `/v3/console/topology/access`, a route the gateway never registered. The MSW
 * development mock defined that route, so every console test passed while
 * production answered 404 and the Ultimate Terminal composer stayed disabled.
 *
 * These tests fail if the console (or its mock) ever again names a gateway
 * route that `buildGateway` does not serve.
 */

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

interface ApiCall {
  readonly method: HttpMethod;
  readonly path: string;
}

const CLIENT_PATH = fileURLToPath(new URL('../../console/src/api/client.ts', import.meta.url));
const HANDLERS_PATH = fileURLToPath(new URL('../../console/src/mocks/handlers.ts', import.meta.url));

/**
 * Routes registered only when the gateway runs with an OIDC BFF auth provider.
 * The console tolerates their 404 on purpose (it flips `bffSessionSupported`
 * off and falls back to non-BFF auth), so they are the only legitimate
 * exemptions. The final test proves this exemption is real rather than a
 * rubber stamp.
 */
const OIDC_BFF_ONLY = new Set(['/v3/auth/session', '/v3/auth/logout']);

/**
 * Rutas que sólo existen cuando el gateway arranca CON el plano de control del terminal.
 *
 * `registerTerminalControlPlane` necesita su propia configuración (token de relé, URL de
 * gobernanza) y `operatorGateway()` no se la da, así que estas dos no están montadas en el
 * gateway de esta prueba — y no es un defecto: en producción sí lo están, colgadas de ese plugin.
 *
 * Se declaran EXPLÍCITAMENTE en vez de dejarlas en la lista de fallos porque una prueba que lleva
 * meses en rojo por motivos conocidos deja de leerse, y entonces el fallo NUEVO —el que sí importa—
 * entra sin que nadie lo vea. Que estén acá es la afirmación de que se miraron una por una.
 */
const SOLO_CON_PLANO_DE_TERMINAL = new Set([
  '/v3/console/agents/1/1/directive',
  '/v3/console/terminal/sessions'
]);

function isHttpMethod(value: string): value is HttpMethod {
  return (HTTP_METHODS as readonly string[]).includes(value);
}

/** Returns the argument text of the call whose opening parenthesis is at `openParen`. */
function callArguments(source: string, openParen: number): string {
  let depth = 0;
  for (let cursor = openParen; cursor < source.length; cursor += 1) {
    const char = source[cursor];
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(openParen + 1, cursor);
    }
  }
  throw new Error('unbalanced call arguments while parsing the console API surface');
}

/** Replaces `${...}` interpolations and `:params` with a concrete, valid segment. */
function concreteSegments(path: string): string {
  return path.replace(/\$\{[^}]*\}/g, '1').replace(/:[A-Za-z][A-Za-z0-9_]*/g, '1');
}

/**
 * La ruta que un `const <nombre> = \`/v3/...\`` declara antes de la llamada, o `undefined`.
 *
 * 🔴 Sin esto el extractor era CIEGO justo para los métodos que arman la ruta en una variable:
 *
 *     const ruta = \`/v3/console/agents/${'${alias}'}/documents\`;
 *     await this.request(ruta);
 *
 * `getAgentDocuments`, `getAgentDocumentContent` y `getAgentPerfil` están escritos así —lo hacen
 * para poder nombrar la ruta en el mensaje de error del 404—. El extractor no encontraba una
 * cadena literal como primer argumento y hacía `continue`, **en silencio**. O sea que la prueba
 * que existía para cazar rutas no servidas dejaba fuera de la comprobación exactamente los tres
 * métodos cuyas rutas el gateway no servía. Se buscan hacia atrás porque la declaración siempre
 * precede al uso.
 */
function rutaDeclaradaAntes(source: string, hasta: number, nombre: string): string | undefined {
  const patron = new RegExp(`const\\s+${nombre}\\s*=\\s*[\`'"]([^\`'"]*)[\`'"]`, 'g');
  let ultima: string | undefined;
  for (let m = patron.exec(source); m && m.index < hasta; m = patron.exec(source)) ultima = m[1];
  return ultima;
}

/** Extracts every `this.request(...)` call the console client issues. */
function extractClientCalls(source: string): ApiCall[] {
  const calls: ApiCall[] = [];
  /*
   * Las llamadas que no se pudieron resolver. NO se descartan en silencio: una ruta que el
   * extractor no ve queda fuera de la comprobación, y este fichero existe precisamente porque una
   * ruta fuera de la comprobación acabó en un 404 en producción.
   */
  const sinResolver: string[] = [];
  const marker = 'this.request';
  for (let index = source.indexOf(marker); index !== -1; index = source.indexOf(marker, index + marker.length)) {
    const openParen = source.indexOf('(', index);
    if (openParen === -1) break;
    const args = callArguments(source, openParen);
    const pathMatch = /^\s*[`'"]([^`'"]*)[`'"]/.exec(args);
    let ruta = pathMatch?.[1];
    if (ruta === undefined) {
      // `callArguments` devuelve el interior SIN el paréntesis de cierre, así que el nombre
      // puede terminar la cadena: sin el `$` la coincidencia fallaba y el aviso salía igual.
      const identificador = /^\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:,|\)|$)/.exec(args)?.[1];
      ruta = identificador === undefined ? undefined : rutaDeclaradaAntes(source, index, identificador);
      if (ruta === undefined) {
        sinResolver.push(args.slice(0, 60).replace(/\s+/g, ' '));
        continue;
      }
    }
    if (!ruta.startsWith('/v3/')) continue;
    const methodMatch = /method:\s*'([A-Za-z]+)'/.exec(args);
    const method = (methodMatch?.[1] ?? 'GET').toUpperCase();
    if (!isHttpMethod(method)) throw new Error(`unsupported HTTP method in client.ts: ${method}`);
    calls.push({ method, path: concreteSegments(ruta) });
  }
  if (sinResolver.length > 0) {
    throw new Error(
      'el extractor no supo sacar la ruta de estas llamadas de client.ts, así que quedarían FUERA '
      + `de la comprobación sin que nadie se entere: ${sinResolver.join(' | ')}`
    );
  }
  return calls;
}

/** Extracts every gateway route the MSW development mock pretends to serve. */
function extractMockCalls(source: string): ApiCall[] {
  const calls: ApiCall[] = [];
  const pattern = /http\.([a-z]+)\(\s*'([^']+)'/g;
  for (let match = pattern.exec(source); match !== null; match = pattern.exec(source)) {
    const method = (match[1] ?? '').toUpperCase();
    const rawPath = (match[2] ?? '').replace(/^\*/, '');
    if (!isHttpMethod(method)) throw new Error(`unsupported HTTP method in handlers.ts: ${method}`);
    if (!rawPath.startsWith('/v3/')) continue;
    calls.push({ method, path: concreteSegments(rawPath) });
  }
  return calls;
}

const apps: Array<Awaited<ReturnType<typeof buildGateway>>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

async function operatorGateway() {
  const app = await buildGateway({
    pool: fakePool(),
    repository: fakeRepository(),
    authProvider: new FixedAuthProvider(testPrincipal({
      roles: roles('operator'),
      permissions: grants('route', 'read', 'control')
    })),
    deliveryWakeSubscriber: noDeliveryWakes,
    outboxPollMs: 60_000
  });
  apps.push(app);
  return app;
}

async function unroutedPaths(calls: readonly ApiCall[]): Promise<string[]> {
  const app = await operatorGateway();
  const missing: string[] = [];
  for (const call of calls) {
    if (OIDC_BFF_ONLY.has(call.path)) continue;
    if (SOLO_CON_PLANO_DE_TERMINAL.has(call.path)) continue;
    const response = await app.inject({
      method: call.method,
      url: call.path,
      ...(call.method === 'GET' ? {} : { payload: {} })
    });
    /*
     * Un 404 del ENRUTADOR es «esta ruta no está montada»; uno del MANEJADOR es «no encontré ese
     * alias», que con un repositorio falso es la respuesta correcta y no un defecto de rutas.
     * Fastify contesta lo primero con `{"message":"Route GET:/... not found"}` y sin campo
     * `error`; los manejadores de esta casa contestan con `{"error":"not_found", ...}`.
     *
     * Sin esta distinción la prueba marcaba como «no servida» una ruta que sí lo estaba, y con
     * ella dentro de la lista de fallos conocidos nadie iba a mirar la lista.
     */
    if (response.statusCode !== 404) continue;
    const cuerpo = response.json<{ error?: string; message?: string }>();
    if (cuerpo.error !== undefined) continue;
    missing.push(`${call.method} ${call.path}`);
  }
  return missing;
}

describe('console API surface matches the gateway routing table', () => {
  it('serves every route the console client requests', async () => {
    const calls = extractClientCalls(await readFile(CLIENT_PATH, 'utf8'));

    // Guards the parser itself: a silently empty extraction would make this suite vacuous.
    expect(calls.length).toBeGreaterThanOrEqual(15);
    expect(calls).toContainEqual({ method: 'GET', path: '/v3/console/topology' });
    expect(calls.map((call) => call.path)).not.toContain('/v3/console/topology/access');

    expect(await unroutedPaths(calls)).toEqual([]);
  });

  it('serves every route the MSW development mock declares', async () => {
    const calls = extractMockCalls(await readFile(HANDLERS_PATH, 'utf8'));

    expect(calls.length).toBeGreaterThanOrEqual(15);
    expect(await unroutedPaths(calls)).toEqual([]);
  });

  it('confirms the OIDC-only exemptions are genuinely absent without a BFF provider', async () => {
    const app = await operatorGateway();

    for (const path of OIDC_BFF_ONLY) {
      const response = await app.inject({ method: 'GET', url: path });
      expect(response.statusCode, `${path} should be OIDC-conditional`).toBe(404);
    }
  });
});
