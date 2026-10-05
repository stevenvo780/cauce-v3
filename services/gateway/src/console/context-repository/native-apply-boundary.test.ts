import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerAgentProfileRoutes, type AgentProfileDeps } from '../agent-profile.routes.js';
import { contexto, preparedRuntime, runtimePreflight, profileWriteFixtureDeps } from '../agent-profile.fixtures.js';
import { registerContextSourcePreviewRoute } from './apply-routes.js';
import { confirmContextSource, sourceApplicationId, type ContextSourceDeps } from './apply-preview.js';
import { nativeFiles, NATIVE_PROFILE, NATIVE_ROOT, writeNativeFixture } from './native-test-fixtures.js';

type Handler = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'cauce-native-apply-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('v3 never reaches profile writers', () => {
  it.each([true, false])('rejects preview and forged PUT with manual present=%s', async (withManual) => {
    const files: Record<string, string> = nativeFiles();
    if (!withManual) Reflect.deleteProperty(files, `${NATIVE_ROOT}/native/claude/CLAUDE.md`);
    const commit = await writeNativeFixture(root, files);
    const handlers = new Map<string, Handler>();
    const app = {
      get: () => undefined,
      post: (path: string, handler: Handler) => handlers.set(`POST ${path}`, handler),
      put: (path: string, handler: Handler) => handlers.set(`PUT ${path}`, handler),
    } as unknown as FastifyInstance;
    const target = { tenant_id: 'Steven', alias: 'helper' };
    const actor = { tenant_id: 'Steven', alias: 'operator' };
    const operator = { operator_id: 'human', attributed: true };
    const reason = 'Review synthetic source';
    const apply = vi.fn();
    const replaceProfile = vi.fn();
    const deps: AgentProfileDeps = profileWriteFixtureDeps({
      authorize: vi.fn(async () => actor),
      authorizeTarget: vi.fn(async () => ({ ...target, enabled: true })),
      resolveOperator: vi.fn(async () => operator), recordAudit: vi.fn(async () => undefined),
      readContext: vi.fn(async () => ({ contexto: contexto({ ...target, purpose: 'Current' }, 'codex'), exists: true, revision: 4, applied_revision: 3 })),
      prepareRuntime: vi.fn(async () => runtimePreflight((revision) => preparedRuntime(revision, { apply }))),
      replaceProfile,
    }, operator);
    const sourceDeps: ContextSourceDeps = { binding: { instance_id: 'fixture', repositoryPath: root },
      profile: deps, readProfileRevision: vi.fn() };
    deps.contextSource = { instance_id: 'fixture', readReceipt: vi.fn(async () => undefined),
      confirm: ({ source, profile, current, preflight, ...caller }) => confirmContextSource(sourceDeps, caller, source, profile, current, preflight) };
    registerContextSourcePreviewRoute(app, sourceDeps);
    registerAgentProfileRoutes(app, deps);
    async function call(method: 'POST' | 'PUT', body: unknown) {
      let status = 200;
      let payload: unknown;
      const reply = { header: () => reply, code: (value: number) => { status = value; return reply; },
        send: (value: unknown) => { payload = value; return reply; } };
      const path = `/v3/console/tenants/:tenantId/agents/:alias/${method === 'POST' ? 'context/repository/preview' : 'perfil'}`;
      const handler = handlers.get(`${method} ${path}`);
      if (handler === undefined) throw new Error('Missing handler');
      await handler({ params: { tenantId: 'Steven', alias: 'helper' }, body } as unknown as FastifyRequest, reply as unknown as FastifyReply);
      return { status, payload };
    }
    const error = withManual ? 'unexpected_files' : 'unsupported_schema';
    expect(await call('POST', { commit, reason })).toEqual({ status: 409, payload: { error } });
    const fields = { instance_id: 'fixture', commit, tree: 'a'.repeat(40), profile_sha256: 'b'.repeat(64),
      source_kind: 'git_authored' as const, expected_journal_id: '42', runtime_fingerprint: 'c'.repeat(64) };
    const caller = { actor, operator, tenantId: 'Steven', alias: 'helper', reason };
    const application_id = sourceApplicationId(fields, caller, 4);
    expect(await call('PUT', { expected_revision: 4, profile: NATIVE_PROFILE, reason,
      context_source: { ...fields, application_id } })).toEqual({ status: 409, payload: { error } });
    expect(replaceProfile).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(sourceDeps.readProfileRevision).not.toHaveBeenCalled();
  });
});
