import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildGateway } from '../../services/gateway/src/index.js';
import { FixedAuthProvider, fakePool, fakeRepository, grants, noDeliveryWakes, roles, testPrincipal } from './helpers.js';

/**
 * Contract guard for the console -> gateway API surface.
 *
 * Regression origin: the console shipped `getTopologyAccess()` against
 * `/v3/console/topology/access`, a route the gateway never registered. The MSW development
 * mock defined that route, so every console test passed while production answered 404 and the
 * Ultimate Terminal composer stayed disabled.
 *
 * These tests fail if the console (or its mock) ever again names a gateway route that
 * `buildGateway` does not serve.
 */

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

interface ApiCall {
  readonly method: HttpMethod;
  readonly path: string;
}

const CLIENT_PATH = fileURLToPath(new URL('../../console/src/api/client.ts', import.meta.url));
/* The routes left `client.ts`, which now only forwards: reading it alone verifies ZERO and passes. */
const CLIENT_MODULES_DIR = fileURLToPath(new URL('../../console/src/api/client/', import.meta.url));
const HANDLERS_PATH = fileURLToPath(new URL('../../console/src/mocks/handlers.ts', import.meta.url));

/**
 * Routes registered only when the gateway runs with an OIDC BFF auth provider. The console
 * tolerates their 404 on purpose (it flips `bffSessionSupported` off and falls back to non-BFF
 * auth), so they are the only legitimate exemptions. The final test proves this exemption is
 * real rather than a rubber stamp.
 */
const OIDC_BFF_ONLY = new Set(['/v3/auth/session', '/v3/auth/logout']);

/**
 * Routes that only exist when the gateway starts WITH the terminal control plane.
 *
 * `registerTerminalControlPlane` needs its own configuration (relay token, governance URL) and
 * `operatorGateway()` does not supply it, so these two are not mounted in this test's gateway —
 * and that is not a defect: in production they ARE mounted, hung off that plugin.
 *
 * They are declared EXPLICITLY instead of being left in the failure list because a test that
 * has been red for months for known reasons stops being read, and then the NEW failure (the one
 * that matters) slips in unnoticed. Their presence here is the assertion that each one was
 * looked at.
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
 * The route a `const <name> = \`/v3/...\`` declares before the call, or `undefined`.
 *
 * 🔴 Without this the extractor was BLIND precisely for the methods that assemble the route in
 * a variable:
 *
 *     const ruta = \`/v3/console/agents/${'${alias}'}/documents\`;
 *     await this.request(ruta);
 *
 * `getAgentDocuments`, `getAgentDocumentContent` and `getAgentPerfil` are written that way — they
 * do it to name the route in the 404's error message. The extractor did not find a literal string
 * as the first argument and did `continue`, **silently**. So the test that existed to catch
 * unserved routes left the check exactly for the three methods whose routes the gateway did not
 * serve. They are looked up backwards because the declaration always precedes the use.
 */
function rutaDeclaradaAntes(source: string, hasta: number, nombre: string): string | undefined {
  const patron = new RegExp(`const\\s+${nombre}\\s*=\\s*[\`'"]([^\`'"]*)[\`'"]`, 'g');
  let ultima: string | undefined;
  for (let m = patron.exec(source); m && m.index < hasta; m = patron.exec(source)) ultima = m[1];
  return ultima;
}

function esParametroDeLaFuncion(source: string, index: number, identificador: string): boolean {
  const firma = source.slice(Math.max(0, index - 240), index);
  const abre = firma.lastIndexOf('(');
  if (abre === -1) return false;
  return new RegExp(`[(,]\\s*${identificador}\\s*[:?,)]`).test(firma.slice(abre));
}

/** Extracts every `request(...)` call the console client issues, wherever its modules live. */
function extractClientCalls(source: string): ApiCall[] {
  const calls: ApiCall[] = [];
  /* Not silently dropped: a route the extractor cannot see is a route nobody checks, and this file
     exists because one of those ended up as a 404 in production. */
  const sinResolver: string[] = [];
  const llamada = /(?<![A-Za-z0-9_$.])(?:this\.)?request\s*[<(]/g;
  for (let hallazgo = llamada.exec(source); hallazgo; hallazgo = llamada.exec(source)) {
    const index = hallazgo.index;
    if (/\b(?:function|async|private|public|protected|static|const|let)\s*$/.test(source.slice(Math.max(0, index - 24), index))) continue;
    const openParen = source.indexOf('(', index + hallazgo[0].length - 1);
    if (openParen === -1) break;
    const args = callArguments(source, openParen);
    const pathMatch = /^\s*[`'"]([^`'"]*)[`'"]/.exec(args);
    let ruta = pathMatch?.[1];
    if (ruta === undefined) {
      // `callArguments` returns the interior WITHOUT the closing parenthesis, so the name may
      // end the string: without the `$` the match failed and the warning fired anyway.
      const identificador = /^\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:,|\)|$)/.exec(args)?.[1];
      ruta = identificador === undefined ? undefined : rutaDeclaradaAntes(source, index, identificador);
      if (ruta === undefined) {
        // A pass-through carries no route: the concrete one is at its callers, also read here.
        if (identificador !== undefined && esParametroDeLaFuncion(source, index, identificador)) continue;
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

const apps: Awaited<ReturnType<typeof buildGateway>>[] = [];

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
     * A 404 from the ROUTER means "this route is not mounted"; one from the HANDLER means "I did
     * not find that alias", which with a fake repository is the correct answer, not a routing
     * defect. Fastify answers the former with `{"message":"Route GET:/... not found"}` and no
     * `error` field; this house's handlers answer with `{"error":"not_found", ...}`.
     *
     * Without this distinction the test flagged a route that WAS served as "unserved", and with
     * that entry sitting inside the known-failure list, nobody was going to look at the list.
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
    const modulos = (await readdir(CLIENT_MODULES_DIR))
      .filter((nombre) => nombre.endsWith('.ts') && !nombre.includes('.test.'))
      .map((nombre) => `${CLIENT_MODULES_DIR}${nombre}`);
    const fuentes = await Promise.all([CLIENT_PATH, ...modulos].map((ruta) => readFile(ruta, 'utf8')));
    const calls = fuentes.flatMap((fuente) => extractClientCalls(fuente));
    expect(calls.length, 'el extractor no encontro ninguna ruta: estaria verificando nada').toBeGreaterThan(20);

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
