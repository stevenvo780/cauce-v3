import { channel } from 'node:diagnostics_channel';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FleetOperationsRepository } from '@cauce/store';
import { buildGateway } from '../../services/gateway/src/app.js';
import { PasswordAuthProvider } from '../../services/gateway/src/password-auth.js';
import { OAuthClients } from '../../services/gateway/src/oauth-client-metadata.js';
import { PostgresOAuthStore } from '../../services/gateway/src/oauth-authorization-store.js';
import { createLocalOAuthAuthorization } from '../../services/gateway/src/oauth-grant-authority.js';
import { OAuthTokens } from '../../services/gateway/src/oauth-tokens.js';
import { registerTerminalControlPlane } from '../../services/gateway/src/terminal/plugin.js';
import { MemoryConsoleUserStore } from '../../services/gateway/src/test-support/console-users.js';
import { fakePool, fakeRepository, noDeliveryWakes } from '../../services/gateway/src/test-support/gateway-doubles.js';

interface ApiReference { method: string; path: string }
interface UiReference { file: string; kind: 'testid' | 'label' | 'text'; value: string }
interface TestReference { file: string; name: string }
interface CrudCell {
  status: 'covered' | 'pending' | 'not_applicable';
  reason?: string; pending_id?: string;
  api?: ApiReference[]; ui?: UiReference[]; tests?: TestReference[];
}
interface CrudEntity { id: string; label: string; operations: Record<'C' | 'R' | 'U' | 'D', CrudCell> }
interface CrudMatrix { schema_version: number; pending: { id: string; reason: string }[]; entities: CrudEntity[] }

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const operations = ['C', 'R', 'U', 'D'] as const;
const requiredEntities = ['companies', 'tenants', 'rooms', 'memberships', 'people', 'company_admins', 'agents',
  'hosts', 'host_enrollments', 'quota_accounts', 'quota_environments', 'office_layout', 'context_versions',
  'space_backups', 'fleet_operations', 'acl_edges', 'harness_definitions', 'role_policies', 'chain_policies',
  'egress_destinations', 'alias_routing_ceilings', 'agent_account_bindings', 'provider_accounts'];
let matrix: CrudMatrix;
const routes = new Set<string>();
const sourceCache = new Map<string, string>();
let app: FastifyInstance | undefined;
let directory: string | undefined;
const key = (method: string, path: string): string => `${method === 'HEAD' ? 'GET' : method} ${path}`;

beforeAll(async () => {
  const matrixPath = process.env.CAUCE_CRUD_MATRIX_FILE ?? resolve(projectRoot, 'docs/v4-matriz-crud.json');
  matrix = JSON.parse(await readFile(matrixPath, 'utf8')) as CrudMatrix;
  for (const name of Object.keys(process.env)) if (name.startsWith('CAUCE_')) vi.stubEnv(name, undefined);
  directory = await mkdtemp(resolve(tmpdir(), 'zz-canary-crud-matrix-'));
  const pool = fakePool();
  const noIo = async (): Promise<never> => { throw new Error('Route inventory must not perform database or network I/O'); };
  const query = vi.spyOn(pool, 'query').mockImplementation(noIo);
  const connect = vi.fn(noIo);
  pool.connect = connect;
  const provider = new PasswordAuthProvider({ users: new MemoryConsoleUserStore(), signingKey: Buffer.alloc(32, 41) });
  const issuer = 'https://zz-canary.example.test';
  const tokens = new OAuthTokens({ issuer, resource: `${issuer}/mcp`, kid: 'crud-unit',
    signingKey: generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey });
  const store = new PostgresOAuthStore(pool, issuer, provider.verifyCredentialStamp.bind(provider));
  const initialization = channel('fastify.initialization');
  const listener = (value: unknown) => {
    const { fastify } = value as { fastify: FastifyInstance };
    fastify.addHook('onRoute', route => {
      for (const method of Array.isArray(route.method) ? route.method : [route.method]) routes.add(key(method, route.url));
    });
  };
  initialization.subscribe(listener);
  try {
    app = await buildGateway({ pool, repository: fakeRepository(), deliveryWakeSubscriber: noDeliveryWakes,
      authProvider: provider, consoleOrigins: [issuer], outboxPollMs: 60_000, pendingSweepMs: 0,
      fleetOperationsRepository: new FleetOperationsRepository(pool),
      spaceBackups: { directory, projectRoot, python: '/usr/bin/python3' },
      contextRepository: { instance_id: 'crud-matrix', repositoryPath: directory },
      legacyFleetAdoptionService: { preview: noIo, apply: noIo },
      humanMcp: { publicOrigin: issuer, authorization: createLocalOAuthAuthorization(tokens, store),
        oauth: { tokens, store, clients: new OAuthClients({ fetch: noIo }), passwordAuth: provider, session: noIo } } });
    await app.register(registerTerminalControlPlane, { pool, authProvider: provider, config: {
      wsPath: '/v3/console/terminal/ws', ticketKey: Buffer.alloc(32, 31), relayToken: 'zz-canary-unit-relay-token',
      relayInstanceIds: new Set(['a'.repeat(64)]), grantsFile: resolve(directory, 'unused-grants.json'),
      ticketTtlSeconds: 30, sessionTtlSeconds: 900, sessionMaxTotalSeconds: 3600, controlHoldSeconds: 900,
      writableTuiEnabled: true, claimLeaseSeconds: 150, maxSessionsPerOperator: 10,
      operatorHeader: 'x-cauce-operator', operators: new Set<string>(),
    } });
    await app.ready();
    expect(query).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  } finally { initialization.unsubscribe(listener); }
});
afterAll(async () => {
  try { await app?.close(); }
  finally {
    vi.unstubAllEnvs();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

async function source(file: string, category: 'ui' | 'test'): Promise<string> {
  const absolute = resolve(projectRoot, file);
  const local = relative(projectRoot, absolute);
  if (local.startsWith('..') || local !== file || (category === 'ui' ? !file.startsWith('console/')
    : !/^(?:tests|console|services|packages|ops\/tests)\//u.test(file))) {
    throw new Error(`Invalid ${category} reference path: ${file}`);
  }
  const cached = sourceCache.get(file);
  if (cached !== undefined) return cached;
  const body = await readFile(absolute, 'utf8');
  sourceCache.set(file, body);
  return body;
}

async function validate(candidate: CrudMatrix): Promise<string[]> {
  const errors: string[] = [];
  const require = (condition: boolean, message: string): void => { if (!condition) errors.push(message); };
  require(candidate.schema_version === 1, 'Unsupported matrix schema_version');
  const pending = new Map(candidate.pending.map(item => [item.id, item.reason]));
  require(pending.size === candidate.pending.length, 'Duplicate pending IDs');
  for (const item of candidate.pending) require(item.id.trim() !== '' && item.reason.trim() !== '', 'Empty pending admission');
  const identities = new Set(candidate.entities.map(entity => entity.id));
  require(identities.size === candidate.entities.length, 'Duplicate entity IDs');
  for (const entity of requiredEntities) require(identities.has(entity), `Missing administrable entity: ${entity}`);
  const declared = new Set<string>();
  const usedPending = new Set<string>();
  for (const entity of candidate.entities) {
    require(entity.id.trim() !== '' && entity.label.trim() !== '', 'Empty entity identity or label');
    require(Object.keys(entity.operations).sort().join(',') === 'C,D,R,U', `Incomplete CRUD operations: ${entity.id}`);
    for (const operation of operations) {
      const cell = (entity.operations as Partial<CrudEntity['operations']>)[operation];
      const identity = `${entity.id}.${operation}`;
      if (!cell) { errors.push(`Empty cell: ${identity}`); continue; }
      require(['covered', 'pending', 'not_applicable'].includes(cell.status), `Invalid cell status: ${identity}`);
      if (cell.status === 'covered') {
        require(Boolean(cell.api?.length && cell.ui?.length && cell.tests?.length), `Covered cell lacks API/UI/test: ${identity}`);
        require(cell.pending_id === undefined, `Covered cell has pending admission: ${identity}`);
      } else {
        require(Boolean(cell.reason?.trim()), `Unjustified cell: ${identity}`);
        if (cell.status === 'pending') {
          require(Boolean(cell.pending_id && pending.has(cell.pending_id)), `Unlisted pending cell: ${identity}`);
          if (cell.pending_id) usedPending.add(cell.pending_id);
        } else require(cell.pending_id === undefined, `Non-applicable cell has pending admission: ${identity}`);
      }
      for (const api of cell.api ?? []) {
        const route = key(api.method, api.path);
        require(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(api.method), `Invalid method: ${route}`);
        require(routes.has(route), `Unregistered gateway route: ${identity}: ${route}`);
        declared.add(route);
      }
      for (const ui of cell.ui ?? []) {
        require(['testid', 'label', 'text'].includes(ui.kind) && ui.value.trim() !== '', `Invalid UI selector: ${identity}`);
        try { require((await source(ui.file, 'ui')).includes(ui.value), `Missing UI control: ${identity}: ${ui.file}: ${ui.value}`); }
        catch (error) { errors.push(`Missing UI source: ${identity}: ${ui.file}: ${error instanceof Error ? error.message : String(error)}`); }
      }
      for (const test of cell.tests ?? []) {
        require(test.name.trim() !== '', `Empty test name: ${identity}`);
        try { require((await source(test.file, 'test')).includes(test.name), `Missing test name: ${identity}: ${test.file}: ${test.name}`); }
        catch (error) { errors.push(`Missing test source: ${identity}: ${test.file}: ${error instanceof Error ? error.message : String(error)}`); }
      }
    }
  }
  for (const id of pending.keys()) require(usedPending.has(id), `Unused pending admission: ${id}`);
  for (const route of routes) {
    if (/^(?:POST|PUT|PATCH|DELETE) \/v3\/console\//u.test(route)) require(declared.has(route), `Uncovered console write route: ${route}`);
  }
  return errors;
}

describe('versioned CRUD coverage matrix', () => {
  it('validates every current CRUD cell, registered write route and referenced control/test', async () => {
    expect(await validate(matrix)).toEqual([]);
    const consoleRoutes = [...routes].filter(route => route.includes(' /v3/console/'));
    const writes = consoleRoutes.filter(route => /^(?:POST|PUT|PATCH|DELETE) /u.test(route));
    console.info(`CRUD_MATRIX entities=${String(matrix.entities.length)} pending=${String(matrix.pending.length)} console_routes=${String(consoleRoutes.length)} console_writes=${String(writes.length)} registered_routes=${String(routes.size)}`);
  });
  it('rejects deletion of a declared console write route', async () => {
    const target = [...routes].find(route => /^(?:POST|PUT|PATCH|DELETE) \/v3\/console\//u.test(route));
    if (!target) throw new Error('Console write inventory is empty');
    const damaged = structuredClone(matrix);
    for (const entity of damaged.entities) for (const cell of Object.values(entity.operations)) {
      cell.api = cell.api?.filter(api => key(api.method, api.path) !== target) ?? [];
    }
    expect(await validate(damaged)).toContain(`Uncovered console write route: ${target}`);
  });
  it('rejects an unregistered gateway route even in an admitted pending cell', async () => {
    const damaged = structuredClone(matrix);
    const first = damaged.entities[0]; if (!first) throw new Error('CRUD entity inventory is empty');
    first.operations.C.api = [{ method: 'POST', path: '/v3/console/zz-unregistered-crud' }];
    expect((await validate(damaged)).some(error => error.includes('Unregistered gateway route:'))).toBe(true);
  });
  it('rejects a nonexistent test reference', async () => {
    const damaged = structuredClone(matrix);
    const first = damaged.entities[0]; if (!first) throw new Error('CRUD entity inventory is empty');
    first.operations.C.tests = [{ file: 'tests/unit/zz-missing-crud-test.test.ts', name: 'missing CRUD test' }];
    expect((await validate(damaged)).some(error => error.includes('Missing test source:'))).toBe(true);
  });
  it('rejects an empty cell and an unlisted pending reason', async () => {
    const damaged = structuredClone(matrix);
    const first = damaged.entities[0]; if (!first) throw new Error('CRUD entity inventory is empty');
    first.operations.C = { status: 'pending', pending_id: 'zz-unlisted-pending' };
    const errors = await validate(damaged);
    expect(errors).toContain(`Unlisted pending cell: ${first.id}.C`);
    expect(errors).toContain(`Unjustified cell: ${first.id}.C`);
  });
});
