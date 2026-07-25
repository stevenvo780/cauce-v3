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

const CLIENT_PATH = fileURLToPath(new URL('../../apps/console/src/api/client.ts', import.meta.url));
const HANDLERS_PATH = fileURLToPath(new URL('../../apps/console/src/mocks/handlers.ts', import.meta.url));

/**
 * Routes registered only when the gateway runs with an OIDC BFF auth provider.
 * The console tolerates their 404 on purpose (it flips `bffSessionSupported`
 * off and falls back to non-BFF auth), so they are the only legitimate
 * exemptions. The final test proves this exemption is real rather than a
 * rubber stamp.
 */
const OIDC_BFF_ONLY = new Set(['/v3/auth/session', '/v3/auth/logout']);

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

/** Extracts every `this.request(...)` call the console client issues. */
function extractClientCalls(source: string): ApiCall[] {
  const calls: ApiCall[] = [];
  const marker = 'this.request';
  for (let index = source.indexOf(marker); index !== -1; index = source.indexOf(marker, index + marker.length)) {
    const openParen = source.indexOf('(', index);
    if (openParen === -1) break;
    const args = callArguments(source, openParen);
    const pathMatch = /^\s*[`'"]([^`'"]*)[`'"]/.exec(args);
    if (!pathMatch?.[1]) continue;
    const methodMatch = /method:\s*'([A-Za-z]+)'/.exec(args);
    const method = (methodMatch?.[1] ?? 'GET').toUpperCase();
    if (!isHttpMethod(method)) throw new Error(`unsupported HTTP method in client.ts: ${method}`);
    calls.push({ method, path: concreteSegments(pathMatch[1]) });
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
    const response = await app.inject({
      method: call.method,
      url: call.path,
      ...(call.method === 'GET' ? {} : { payload: {} })
    });
    if (response.statusCode === 404) missing.push(`${call.method} ${call.path}`);
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
