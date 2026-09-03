import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  registerAgentContextHistoryRoutes, type AgentContextHistoryDeps,
} from './agent-context-history.routes.js';

/**
 * The routes are stood up and hit with `app.inject`: what is asserted is the effect of a GET on a
 * live fastify, never the return value of a handler called by hand.
 */

const ACTOR = { tenant_id: 'Steven', alias: 'zeus' };

const PERFIL = {
  id: '12',
  tenant_id: 'Steven',
  alias: 'argos',
  revision: 4,
  operation: 'update' as const,
  purpose: 'perseguir lo pendiente',
  role_summary: 'PMO de la flota',
  human_brief: 'Steven',
  responsibilities: ['perseguir'],
  restrictions: ['no desplegar'],
  tools: ['bus'],
  operating_rules: ['acuse corto'],
  actor_tenant: 'Steven',
  actor_alias: 'zeus',
  changed_at: '2026-09-01T10:00:00.000Z',
};

const DOCUMENTO = {
  id: '7',
  tenant_id: 'Steven',
  alias: 'argos',
  kind: 'directive',
  path: '/home/dev/CLAUDE.md',
  sha256: 'a'.repeat(64),
  bytes: 2048,
  actor_tenant: 'Steven',
  actor_alias: 'zeus',
  written_at: '2026-09-01T10:05:00.000Z',
};

function servidor(deps: Partial<AgentContextHistoryDeps> = {}) {
  const app = Fastify();
  registerAgentContextHistoryRoutes(app, {
    authorize: async () => ACTOR,
    authorizeTarget: async (_actor, tenantId, alias) => ({ tenant_id: tenantId, alias, enabled: true }),
    listProfileRevisions: async () => [PERFIL],
    listDocumentRevisions: async () => [DOCUMENTO],
    ...deps,
  });
  return app;
}

function rutaPerfil(tenantId = 'Steven', alias = 'argos'): string {
  return `/v3/console/tenants/${tenantId}/agents/${alias}/perfil/revisions`;
}

function rutaDocumento(kind = 'directive'): string {
  return `/v3/console/tenants/Steven/agents/argos/documents/${kind}/revisions`;
}

let vivo: ReturnType<typeof servidor> | undefined;
afterEach(async () => { await vivo?.close(); vivo = undefined; });

describe('GET .../perfil/revisions', () => {
  it('returns the seven authored fields of every version so a restore can replay them', async () => {
    vivo = servidor();
    const response = await vivo.inject({ method: 'GET', url: rutaPerfil() });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ entries: Record<string, unknown>[] }>();
    expect(body.entries).toHaveLength(1);
    const entry = body.entries[0] ?? {};
    for (const field of [
      'purpose', 'role_summary', 'human_brief', 'responsibilities', 'restrictions', 'tools',
      'operating_rules',
    ]) {
      expect(Object.keys(entry)).toContain(field);
    }
    expect(entry.revision).toBe(4);
    expect(entry.operation).toBe('update');
    expect(entry.actor_alias).toBe('zeus');
  });

  it('asks the journal for the requested page size and refuses one out of range', async () => {
    const listProfileRevisions = vi.fn(async () => [PERFIL]);
    vivo = servidor({ listProfileRevisions });
    const ok = await vivo.inject({ method: 'GET', url: `${rutaPerfil()}?limit=25` });
    expect(ok.statusCode).toBe(200);
    expect(listProfileRevisions).toHaveBeenCalledWith('Steven', 'argos', 25);
    const excessive = await vivo.inject({ method: 'GET', url: `${rutaPerfil()}?limit=5000` });
    expect(excessive.statusCode).toBe(400);
    expect(excessive.json<{ error: string }>().error).toBe('invalid_input');
    expect(listProfileRevisions).toHaveBeenCalledTimes(1);
  });

  it('reads the journal with the CANONICAL identity the authorization resolved', async () => {
    const listProfileRevisions = vi.fn(async () => [PERFIL]);
    vivo = servidor({
      listProfileRevisions,
      authorizeTarget: async () => ({ tenant_id: 'Steven', alias: 'argos', enabled: true }),
    });
    const response = await vivo.inject({ method: 'GET', url: rutaPerfil('Steven', 'argos-suplente') });
    expect(response.statusCode).toBe(404);
    expect(listProfileRevisions).not.toHaveBeenCalled();
  });

  it('does not confirm the alias exists when the ACL hides it', async () => {
    const listProfileRevisions = vi.fn(async () => [PERFIL]);
    vivo = servidor({ listProfileRevisions, authorizeTarget: async () => undefined });
    const response = await vivo.inject({ method: 'GET', url: rutaPerfil() });
    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: string }>().error).toBe('not_found');
    expect(listProfileRevisions).not.toHaveBeenCalled();
  });

  it('reads the journal of a disabled alias: its past does not disappear with its runtime', async () => {
    vivo = servidor({
      authorizeTarget: async (_actor, tenantId, alias) => ({ tenant_id: tenantId, alias, enabled: false }),
    });
    const response = await vivo.inject({ method: 'GET', url: rutaPerfil() });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ entries: unknown[] }>().entries).toHaveLength(1);
  });

  it('rejects an alias that is not a valid identity before authorizing anything', async () => {
    const authorize = vi.fn<AgentContextHistoryDeps['authorize']>(async () => ACTOR);
    vivo = servidor({ authorize });
    const response = await vivo.inject({ method: 'GET', url: rutaPerfil('Steven', 'no valido') });
    expect(response.statusCode).toBe(400);
    expect(authorize).not.toHaveBeenCalled();
  });

  it('requires the read permission, never the control one', async () => {
    const authorize = vi.fn<AgentContextHistoryDeps['authorize']>(async () => ACTOR);
    vivo = servidor({ authorize });
    await vivo.inject({ method: 'GET', url: rutaPerfil() });
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(authorize.mock.calls[0]?.[1]).toBe('read');
  });
});

describe('GET .../documents/:kind/revisions', () => {
  it('returns fingerprint and metadata, and has no column able to carry a body', async () => {
    vivo = servidor();
    const response = await vivo.inject({ method: 'GET', url: rutaDocumento() });
    expect(response.statusCode).toBe(200);
    const entry = response.json<{ entries: Record<string, unknown>[] }>().entries[0] ?? {};
    expect(entry).toEqual({
      id: '7',
      tenant_id: 'Steven',
      alias: 'argos',
      kind: 'directive',
      path: '/home/dev/CLAUDE.md',
      sha256: 'a'.repeat(64),
      bytes: 2048,
      actor_tenant: 'Steven',
      actor_alias: 'zeus',
      written_at: '2026-09-01T10:05:00.000Z',
    });
  });

  it('refuses a kind that is not in the document vocabulary', async () => {
    const listDocumentRevisions = vi.fn(async () => [DOCUMENTO]);
    vivo = servidor({ listDocumentRevisions });
    const response = await vivo.inject({ method: 'GET', url: rutaDocumento('credenciales') });
    expect(response.statusCode).toBe(400);
    expect(listDocumentRevisions).not.toHaveBeenCalled();
  });

  it('passes the kind through to the journal', async () => {
    const listDocumentRevisions = vi.fn(async () => []);
    vivo = servidor({ listDocumentRevisions });
    const response = await vivo.inject({ method: 'GET', url: rutaDocumento('memory') });
    expect(response.statusCode).toBe(200);
    expect(listDocumentRevisions).toHaveBeenCalledWith('Steven', 'argos', 'memory', 100);
  });
});
