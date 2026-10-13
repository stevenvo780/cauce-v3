import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerAgentProfileRoutes, type AgentProfileDeps } from '../agent-profile.routes.js';
import { contexto, preparedRuntime, runtimePreflight, profileWriteFixtureDeps } from '../agent-profile.fixtures.js';
import { inspectNativeContextRepository } from './native-inspect.js';
import { fixtureDigest, nativeFiles, NATIVE_PROFILE, NATIVE_ROOT, NATIVE_SCOPE, writeNativeFixture } from './native-test-fixtures.js';

let root: string;
let app: FastifyInstance | undefined;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'cauce-native-apply-')); });
afterEach(async () => { await app?.close(); app = undefined; await rm(root, { recursive: true, force: true }); });

describe('native Git snapshots never reach retired profile writers', () => {
  it.each([true, false])('rejects a forged source PUT with manual present=%s', async (withManual) => {
    const files: Record<string, string> = nativeFiles();
    if (!withManual) Reflect.deleteProperty(files, `${NATIVE_ROOT}/native/claude/CLAUDE.md`);
    const commit = await writeNativeFixture(root, files);
    const before = await fixtureDigest(root);
    const inspection = inspectNativeContextRepository({ repositoryPath: root, scope: NATIVE_SCOPE, commit });
    if (withManual) {
      await expect(inspection).resolves.toMatchObject({ desired: { commit }, applySupported: false });
    } else {
      await expect(inspection).rejects.toMatchObject({ code: 'unexpected_files' });
    }
    const target = { tenant_id: 'Steven', alias: 'helper' };
    const actor = { tenant_id: 'Steven', alias: 'operator' };
    const operator = { operator_id: 'human', attributed: true };
    const reason = 'Review synthetic source';
    const apply = vi.fn();
    const replaceProfile = vi.fn();
    const readContext = vi.fn(async () => ({ contexto: contexto({ ...target, purpose: 'Current' }, 'codex'), exists: true, revision: 4, applied_revision: 3 }));
    const prepareRuntime = vi.fn(async () => runtimePreflight((revision) => preparedRuntime(revision, { apply })));
    const deps: AgentProfileDeps = profileWriteFixtureDeps({
      authorize: vi.fn(async () => actor),
      authorizeTarget: vi.fn(async () => ({ ...target, enabled: true })),
      resolveOperator: vi.fn(async () => operator), recordAudit: vi.fn(async () => undefined),
      readContext, prepareRuntime, replaceProfile,
    }, operator);
    app = Fastify();
    registerAgentProfileRoutes(app, deps);
    const fields = { instance_id: 'fixture', commit, tree: 'a'.repeat(40), profile_sha256: 'b'.repeat(64),
      source_kind: 'git_authored' as const, expected_journal_id: '42', runtime_fingerprint: 'c'.repeat(64) };
    const response = await app.inject({ method: 'PUT', url: '/v3/console/tenants/Steven/agents/helper/perfil',
      payload: { expected_revision: 4, profile: NATIVE_PROFILE, reason,
        context_source: { ...fields, application_id: 'd'.repeat(64) } },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'context_source_retired' });
    expect(readContext).not.toHaveBeenCalled();
    expect(prepareRuntime).not.toHaveBeenCalled();
    expect(replaceProfile).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(await fixtureDigest(root)).toBe(before);
  });
});
