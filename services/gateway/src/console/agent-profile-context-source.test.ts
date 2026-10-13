import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerAgentProfileRoutes, type AgentProfileDeps } from './agent-profile.routes.js';
import { contexto, PERFIL_BODY, PREPARE_RUNTIME, profileWriteFixtureDeps, REPLACE_PROFILE } from './agent-profile.fixtures.js';

let app: FastifyInstance | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

describe('retired V3 profile source', () => {
  it.each([true, false])('rejects legacy source before any profile or runtime write with enabled=%s', async enabled => {
    const current = { contexto: contexto(PERFIL_BODY, 'codex'), exists: true, revision: 4, applied_revision: 3 };
    const before = structuredClone(current);
    const readContext = vi.fn(async () => current);
    const replaceProfile = vi.fn(REPLACE_PROFILE);
    const prepareRuntime = vi.fn(PREPARE_RUNTIME);
    const prepareDraft = vi.fn<NonNullable<AgentProfileDeps['prepareDraft']>>();
    const recordAudit = vi.fn<AgentProfileDeps['recordAudit']>(async () => undefined);
    app = Fastify();
    registerAgentProfileRoutes(app, profileWriteFixtureDeps({
      authorizeTarget: async (_actor, tenant_id, alias) => ({ tenant_id, alias, enabled }),
      readContext, replaceProfile, prepareRuntime, prepareDraft, recordAudit,
    }, { operator_id: 'fixture-human', attributed: true }));
    for (const context_source of [null, { instance_id: 'fixture', commit: 'a'.repeat(40) }]) {
      const response = await app.inject({ method: 'PUT', url: '/v3/console/tenants/Steven/agents/zeus/perfil',
        payload: { expected_revision: 4, profile: PERFIL_BODY, reason: 'Review the versioned context', context_source },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: 'context_source_retired', message: expect.stringContaining('historial versionado') as string });
    }
    expect(readContext).not.toHaveBeenCalled();
    expect(replaceProfile).not.toHaveBeenCalled();
    expect(prepareRuntime).not.toHaveBeenCalled();
    expect(prepareDraft).not.toHaveBeenCalled();
    expect(current).toEqual(before);
    expect(recordAudit).toHaveBeenCalledTimes(2);
    expect(recordAudit.mock.calls.every(([entry]) => entry.decision === 'deny')).toBe(true);
  });
});
