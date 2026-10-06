import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DevOnlyAuthProvider, type PrincipalPermission, type PrincipalRole } from '../../auth.js';
import { registerConsoleOperationsRoutes } from './operations.js';
import type { ConsoleRoutes } from './contracts.js';

const apps: FastifyInstance[] = [];
const headers = { 'x-cauce-tenant': 'CompanyA', 'x-cauce-alias': 'operator' };
const mutation = { resource: 'agent_behavior_policy', action: 'create', tenant_id: 'CompanyA', room_id: 'support', alias: 'worker',
  value: { version: 1, coordination_mode: 'executor', fanin_receipt_mode: 'technical' } };
function gateway(roles: PrincipalRole[] = ['operator'], permissions: PrincipalPermission[] = ['control']) {
  const app = Fastify();
  const apply = vi.fn(async () => ({ applied: true, dry_run: false, revision: 1, rolled_back_revision_id: null,
    summary: 'policy saved', mutation, inverse_mutation: { ...mutation, action: 'delete', value: undefined } }));
  const context = { options: { authProvider: DevOnlyAuthProvider.forTests({ roles, permissions }) },
    repository: { applyConfigurationChange: apply }, allowedJobKinds: new Set<string>() } as unknown as ConsoleRoutes;
  registerConsoleOperationsRoutes(app, context);
  apps.push(app);
  return { app, apply };
}
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

describe('behavior policy operator HTTP editor', () => {
  it.each([
    { roles: ['agent'] as PrincipalRole[], permissions: ['control'] as PrincipalPermission[] },
    { roles: ['operator'] as PrincipalRole[], permissions: ['read'] as PrincipalPermission[] },
  ])('requires authenticated operator and control permission', async ({ roles, permissions }) => {
    const { app, apply } = gateway(roles, permissions);
    const response = await app.inject({ method: 'POST', url: '/v3/console/config/changes', headers,
      payload: { dry_run: false, expected_revision: 0, mutation } });
    expect(response.statusCode).toBe(403);
    expect(apply).not.toHaveBeenCalled();
  });

  it('rejects missing CAS and injected policy authority before touching store', async () => {
    const { app, apply } = gateway();
    for (const payload of [
      { dry_run: false, mutation },
      { dry_run: false, expected_revision: 0, mutation: { ...mutation, value: { ...mutation.value, revision: '99', scope: {} } } },
    ]) {
      const response = await app.inject({ method: 'POST', url: '/v3/console/config/changes', headers, payload });
      expect(response.statusCode).toBe(400);
    }
    expect(apply).not.toHaveBeenCalled();
  });

  it('uses authenticated editor identity and forwards explicit CAS', async () => {
    const { app, apply } = gateway();
    const response = await app.inject({ method: 'POST', url: '/v3/console/config/changes', headers,
      payload: { dry_run: false, expected_revision: 0, mutation } });
    expect(response.statusCode).toBe(201);
    expect(apply).toHaveBeenCalledWith('CompanyA', 'operator', mutation, false, 0);
  });
});
