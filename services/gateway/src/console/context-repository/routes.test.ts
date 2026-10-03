import Fastify, { type FastifyInstance } from 'fastify';
import { buildTestGateway, fakePool, fakeRepository } from '../../test-support/gateway-doubles.js';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deflateSync } from 'node:zlib';
import type { ProfileRevisionEntry } from '@cauce/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthError, AuthorizationError } from '../../auth.js';
import { registerContextRepositoryRoutes, type ContextRepositoryRouteDeps } from './routes.js';

const PROFILE = {
  purpose: 'Review synthetic context', role_summary: null, human_brief: null,
  responsibilities: ['Review'], restrictions: [], tools: [], operating_rules: [],
};
const JOURNAL: ProfileRevisionEntry = {
  ...PROFILE, tenant_id: 'Steven', alias: 'helper', id: '42', revision: 1,
  operation: 'insert', actor_tenant: 'private-actor', actor_alias: 'private-actor', changed_at: 'private-time',
};
const BASE = '/v3/console/tenants/Steven/agents/helper/context/repository';

describe('authorized Git context reads', () => {
  let root: string;
  let commit: string;
  let app: FastifyInstance;

  async function object(type: string, body: Buffer): Promise<string> {
    const raw = Buffer.concat([Buffer.from(`${type} ${String(body.length)}\0`), body]);
    const oid = createHash('sha1').update(raw).digest('hex');
    const directory = join(root, '.git', 'objects', oid.slice(0, 2));
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, oid.slice(2)), deflateSync(raw));
    return oid;
  }

  async function tree(name: string, oid: string, mode = '40000'): Promise<string> {
    return object('tree', Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.from(oid, 'hex')]));
  }

  async function fixture(purpose = PROFILE.purpose, instance_id = 'fixture'): Promise<string> {
    const profile = await object('blob', Buffer.from(JSON.stringify({ ...PROFILE, purpose })));
    const helper = await tree('profile.json', profile, '100644');
    const agents = await tree('helper', helper);
    const tenant = await tree('agents', agents);
    const tenants = await tree('Steven', tenant);
    const manifest = await object('blob', Buffer.from(JSON.stringify({ schema_version: 1, instance_id,
      agents: [{ tenant_id: 'Steven', alias: 'helper', source_journal: { id: '42', revision: 1 } }],
    })));
    const rootTree = await object('tree', Buffer.concat([
      Buffer.from('100644 context.json\0'), Buffer.from(manifest, 'hex'),
      Buffer.from('40000 tenants\0'), Buffer.from(tenants, 'hex'),
    ]));
    return object('commit', Buffer.from(`tree ${rootTree}\n\nSynthetic snapshot\n`));
  }

  function server(overrides: Partial<ContextRepositoryRouteDeps> = {}, configured = true) {
    const deps: ContextRepositoryRouteDeps = {
      ...(configured ? { binding: { instance_id: 'fixture', repositoryPath: root } } : {}),
      authorize: vi.fn(async () => ({ tenant_id: 'Steven', alias: 'operator' })),
      authorizeTarget: vi.fn<ContextRepositoryRouteDeps['authorizeTarget']>(async (_actor, tenant_id, alias) => ({ tenant_id, alias })),
      readProfileRevision: vi.fn(async () => JOURNAL), ...overrides,
    };
    app = Fastify();
    registerContextRepositoryRoutes(app, deps);
    return deps;
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cauce-context-http-'));
    await mkdir(join(root, '.git/objects/info'), { recursive: true });
    await mkdir(join(root, '.git/objects/pack'), { recursive: true });
    commit = await fixture();
  });
  afterEach(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });

  it('reports configured, without claiming source observation or exposing the local path', async () => {
    const deps = server();
    const response = await app.inject({ url: BASE });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({ tenant_id: 'Steven', alias: 'helper', state: 'configured',
      instance_id: 'fixture', storage: 'loose_objects_only', sourceState: 'not_observed', application: 'not_evaluated' });
    expect(response.body).not.toContain(root);
    expect(deps.readProfileRevision).not.toHaveBeenCalled();
  });

  it('reads real loose objects through HTTP and compares the canonical journal, without effects', async () => {
    const deps = server();
    const before = await readdir(root, { recursive: true });
    const response = await app.inject({ url: `${BASE}/inspect?commit=${commit}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ tenant_id: 'Steven', alias: 'helper',
      sourceState: 'not_observed', application: 'not_evaluated',
      desired: { commit, profile: { ...PROFILE, tenant_id: 'Steven', alias: 'helper' }, provenanceVerification: 'not_evaluated' },
      journalVerification: { desired: 'journal_match', previous: null }, previous: null, changes: null });
    expect(deps.readProfileRevision).toHaveBeenCalledWith('Steven', 'helper', 1);
    expect(deps.authorizeTarget).toHaveBeenCalledTimes(2);
    expect(response.body).not.toContain('private-');
    expect(response.body).not.toContain(root);
    expect(await readdir(root, { recursive: true })).toEqual(before);
  });

  it('compares two explicit immutable commits and distinguishes changed authoring from journal provenance', async () => {
    server();
    const newer = await fixture('Changed synthetic context');
    const response = await app.inject({ url: `${BASE}/inspect?commit=${newer}&previous_commit=${commit}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ journalVerification: { desired: 'journal_mismatch', previous: 'journal_match' },
      desired: { commit: newer }, previous: { commit }, changes: [{ kind: 'modified' }] });
  });

  it.each([
    { id: '99' }, { revision: 2 }, { tenant_id: 'steven' }, { alias: 'other' },
    { operation: 'delete' as const }, { purpose: 'Another profile' },
  ])('does not certify mismatched or recreated journal identity/content %#', async (override) => {
    server({ readProfileRevision: async () => ({ ...JOURNAL, ...override }) });
    const response = await app.inject({ url: `${BASE}/inspect?commit=${commit}` });
    expect(response.json()).toMatchObject({ journalVerification: { desired: 'journal_mismatch' } });
  });

  it('keeps a missing journal explicit', async () => {
    server({ readProfileRevision: async () => undefined });
    const response = await app.inject({ url: `${BASE}/inspect?commit=${commit}` });
    expect(response.json()).toMatchObject({ journalVerification: { desired: 'journal_unavailable' } });
  });

  it.each([new AuthError('private-auth-detail'), new AuthorizationError('private-denial')])(
    'authenticates before touching an unavailable filesystem', async (error) => {
      const deps = server({ authorize: async () => { throw error; },
        binding: { instance_id: 'fixture', repositoryPath: '/synthetic/missing' } });
      const response = await app.inject({ url: `${BASE}/inspect?commit=${commit}` });
      expect([401, 403]).toContain(response.statusCode);
      expect(response.body).not.toContain('private-');
      expect(deps.authorizeTarget).not.toHaveBeenCalled();
      expect(deps.readProfileRevision).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, { tenant_id: 'steven', alias: 'helper' }, { tenant_id: 'Steven', alias: 'other' }])(
    'hides inaccessible and nonexact targets before filesystem access %#', async (target) => {
      const deps = server({ authorizeTarget: async () => target,
        binding: { instance_id: 'fixture', repositoryPath: '/synthetic/missing' } });
      const response = await app.inject({ url: `${BASE}/inspect?commit=${commit}` });
      expect(response.statusCode).toBe(404);
      expect(deps.readProfileRevision).not.toHaveBeenCalled();
    },
  );

  it('rechecks authorization before disclosing the completed inspection', async () => {
    let calls = 0;
    server({ authorizeTarget: async () => ++calls === 1 ? { tenant_id: 'Steven', alias: 'helper' } : undefined });
    const response = await app.inject({ url: `${BASE}/inspect?commit=${commit}` });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain(PROFILE.purpose);
  });

  it.each(['root=/tmp', 'repositoryPath=/tmp', 'instance_id=other', 'commit=HEAD', 'commit=abc', 'commit=--help',
    'commit=../outside', `commit=${'a'.repeat(40)}&previous_commit=HEAD`])('rejects client path/ref inputs %s', async (query) => {
    const deps = server();
    const response = await app.inject({ url: `${BASE}/inspect?${query}` });
    expect([400, 422]).toContain(response.statusCode);
    expect(deps.readProfileRevision).not.toHaveBeenCalled();
  });

  it('rejects unknown query fields even with a valid commit', async () => {
    server();
    expect((await app.inject({ url: `${BASE}/inspect?commit=${commit}&repositoryPath=/tmp` })).statusCode).toBe(400);
    expect((await app.inject({ url: `${BASE}?root=/tmp` })).statusCode).toBe(400);
  });

  it('reports absent binding and refuses inspection without creating one', async () => {
    server({}, false);
    expect((await app.inject({ url: BASE })).json()).toMatchObject({ state: 'not_configured', instance_id: null });
    expect((await app.inject({ url: `${BASE}/inspect?commit=${commit}` })).statusCode).toBe(409);
  });

  it('refuses the wrong repository instance and unsupported storage without root disclosure', async () => {
    server();
    const wrong = await fixture(PROFILE.purpose, 'other');
    expect((await app.inject({ url: `${BASE}/inspect?commit=${wrong}` })).json()).toMatchObject({ reason: 'scope_unavailable' });
    await writeFile(join(root, '.git/objects/pack/inert.pack'), 'inert');
    const response = await app.inject({ url: `${BASE}/inspect?commit=${commit}` });
    expect(response.statusCode).toBe(422);
    expect(response.body).not.toContain(root);
  });

  it('wires the server binding, canonical ACL and real journal repository through buildGateway', async () => {
    const pool = fakePool({ ...JOURNAL, changed_at: new Date('2026-01-01T00:00:00Z') });
    const repository = fakeRepository();
    const query = vi.spyOn(pool, 'query');
    app = await buildTestGateway({ pool, repository,
      contextRepository: { instance_id: 'fixture', repositoryPath: root }, outboxPollMs: 60_000 });
    const response = await app.inject({ url: `${BASE}/inspect?commit=${commit}`,
      headers: { 'x-cauce-tenant': 'Steven', 'x-cauce-alias': 'operator' } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ journalVerification: { desired: 'journal_match' } });
    expect(repository.authorizeAgentTarget).toHaveBeenCalledWith('Steven', 'operator', 'Steven', 'helper', 'read');
    expect(query).toHaveBeenCalledWith(expect.stringContaining('FROM agent_profile_revisions'), ['Steven', 'helper', 1]);
  });

  it('sanitizes database failures and publishes no mutation route', async () => {
    server({ readProfileRevision: async () => { throw new Error(`private ${root}`); } });
    const response = await app.inject({ url: `${BASE}/inspect?commit=${commit}` });
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain(root);
    for (const method of ['POST', 'PUT', 'DELETE'] as const) {
      expect((await app.inject({ method, url: `${BASE}/inspect`, payload: {} })).statusCode).toBe(404);
    }
    expect(await readFile(join(root, '.git/objects', commit.slice(0, 2), commit.slice(2)))).toBeTruthy();
  });
});
