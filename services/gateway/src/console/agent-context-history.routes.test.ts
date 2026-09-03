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
    listProfileRevisions: async () => ({ entries: [PERFIL], next_cursor: null }),
    listDocumentRevisions: async () => ({ entries: [DOCUMENTO], next_cursor: null }),
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
    const listProfileRevisions = vi.fn(async () => ({ entries: [PERFIL], next_cursor: null }));
    vivo = servidor({ listProfileRevisions });
    const ok = await vivo.inject({ method: 'GET', url: `${rutaPerfil()}?limit=25` });
    expect(ok.statusCode).toBe(200);
    expect(listProfileRevisions).toHaveBeenCalledWith('Steven', 'argos', 25, undefined);
    const excessive = await vivo.inject({ method: 'GET', url: `${rutaPerfil()}?limit=5000` });
    expect(excessive.statusCode).toBe(400);
    expect(excessive.json<{ error: string }>().error).toBe('invalid_input');
    expect(listProfileRevisions).toHaveBeenCalledTimes(1);
  });

  it('reads the journal with the CANONICAL identity the authorization resolved', async () => {
    const listProfileRevisions = vi.fn(async () => ({ entries: [PERFIL], next_cursor: null }));
    vivo = servidor({
      listProfileRevisions,
      authorizeTarget: async () => ({ tenant_id: 'Steven', alias: 'argos', enabled: true }),
    });
    const response = await vivo.inject({ method: 'GET', url: rutaPerfil('Steven', 'argos-suplente') });
    expect(response.statusCode).toBe(404);
    expect(listProfileRevisions).not.toHaveBeenCalled();
  });

  it('does not confirm the alias exists when the ACL hides it', async () => {
    const listProfileRevisions = vi.fn(async () => ({ entries: [PERFIL], next_cursor: null }));
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
    const listDocumentRevisions = vi.fn(async () => ({ entries: [DOCUMENTO], next_cursor: null }));
    vivo = servidor({ listDocumentRevisions });
    const response = await vivo.inject({ method: 'GET', url: rutaDocumento('credenciales') });
    expect(response.statusCode).toBe(400);
    expect(listDocumentRevisions).not.toHaveBeenCalled();
  });

  it('passes the kind through to the journal', async () => {
    const listDocumentRevisions = vi.fn(async () => ({ entries: [], next_cursor: null }));
    vivo = servidor({ listDocumentRevisions });
    const response = await vivo.inject({ method: 'GET', url: rutaDocumento('memory') });
    expect(response.statusCode).toBe(200);
    expect(listDocumentRevisions).toHaveBeenCalledWith('Steven', 'argos', 'memory', 100, undefined);
  });
});

/**
 * The console caps its own window at 200 and, without a cursor, stops there saying «ventana
 * agotada». What is asserted here is that the walk CONTINUES: three pages of two over a journal of
 * six, driven only by what the previous answer published.
 */
describe('cursor pagination of the journal', () => {
  const DIARIO = [60, 50, 40, 30, 20, 10].map((id) => ({
    ...PERFIL, id: String(id), revision: id,
  }));

  function tramo(alias: string, limit: number, cursor?: string) {
    const visibles = DIARIO
      .filter((entry) => entry.alias === alias)
      .filter((entry) => cursor === undefined || BigInt(entry.id) < BigInt(cursor));
    const entries = visibles.slice(0, limit);
    const last = entries[entries.length - 1];
    return {
      entries,
      next_cursor: visibles.length > limit && last !== undefined ? last.id : null,
    };
  }

  it('walks three pages of two and only stops when the answer says there is no more', async () => {
    const listProfileRevisions = vi.fn(
      async (_t: string, alias: string, limit: number, cursor?: string) =>
        tramo(alias, limit, cursor),
    );
    vivo = servidor({ listProfileRevisions });
    const recorridas: string[] = [];
    let cursor: string | null = null;
    let paginas = 0;
    do {
      const query = new URLSearchParams({ limit: '2' });
      if (cursor !== null) query.set('cursor', cursor);
      const response = await vivo.inject({
        method: 'GET', url: `${rutaPerfil()}?${query.toString()}`,
      });
      expect(response.statusCode).toBe(200);
      const body = response.json<{ entries: { id: string }[]; next_cursor: string | null }>();
      for (const entry of body.entries) recorridas.push(entry.id);
      cursor = body.next_cursor;
      paginas += 1;
    } while (cursor !== null && paginas < 6);

    expect(paginas).toBe(3);
    expect(recorridas).toEqual(['60', '50', '40', '30', '20', '10']);
    expect(new Set(recorridas).size).toBe(6);
    expect(listProfileRevisions.mock.calls.map((call) => call[3]))
      .toEqual([undefined, '50', '30']);
  });

  it('publishes next_cursor as the id of the last row it returned, and null at the end', async () => {
    vivo = servidor({
      listProfileRevisions: async (_t, alias, limit, cursor) => tramo(alias, limit, cursor),
    });
    const primera = await vivo.inject({ method: 'GET', url: `${rutaPerfil()}?limit=2` });
    expect(primera.json<{ next_cursor: string | null }>().next_cursor).toBe('50');
    const ultima = await vivo.inject({ method: 'GET', url: `${rutaPerfil()}?limit=200` });
    expect(ultima.json<{ next_cursor: string | null }>().next_cursor).toBeNull();
  });

  it('publishes next_cursor on the document journal too', async () => {
    vivo = servidor({
      listDocumentRevisions: async () => ({ entries: [DOCUMENTO], next_cursor: '7' }),
    });
    const response = await vivo.inject({ method: 'GET', url: `${rutaDocumento()}?cursor=99` });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ next_cursor: string | null }>().next_cursor).toBe('7');
  });

  it.each([
    ['no numérico', 'abc'],
    ['con cero a la izquierda', '007'],
    ['negativo', '-1'],
    ['vacío', ''],
    ['fuera del rango de bigint', '9223372036854775808'],
    ['de longitud desbordada', '1'.repeat(40)],
    ['con una inyección', "1 OR 1=1"],
  ])('refuses a %s cursor with a 400 that names the field', async (_caso, cursor) => {
    const listProfileRevisions = vi.fn(async () => ({ entries: [PERFIL], next_cursor: null }));
    const listDocumentRevisions = vi.fn(async () => ({ entries: [DOCUMENTO], next_cursor: null }));
    vivo = servidor({ listProfileRevisions, listDocumentRevisions });
    for (const url of [rutaPerfil(), rutaDocumento()]) {
      const response = await vivo.inject({
        method: 'GET', url: `${url}?cursor=${encodeURIComponent(cursor)}`,
      });
      expect(response.statusCode).toBe(400);
      const body = response.json<{ error: string; message: string }>();
      expect(body.error).toBe('invalid_input');
      expect(body.message).toMatch(/cursor/u);
    }
    expect(listProfileRevisions).not.toHaveBeenCalled();
    expect(listDocumentRevisions).not.toHaveBeenCalled();
  });

  /** A cursor is a position inside the window, never a way to reach another alias' rows. */
  it('hands the journal the CANONICAL identity even when a cursor rides along', async () => {
    const listProfileRevisions = vi.fn(
      async (_t: string, alias: string, limit: number, cursor?: string) =>
        tramo(alias, limit, cursor),
    );
    vivo = servidor({
      listProfileRevisions,
      authorizeTarget: async () => ({ tenant_id: 'Steven', alias: 'argos', enabled: true }),
    });
    const response = await vivo.inject({
      method: 'GET', url: `${rutaPerfil('Steven', 'argos')}?limit=2&cursor=40`,
    });
    expect(response.statusCode).toBe(200);
    expect(listProfileRevisions).toHaveBeenCalledWith('Steven', 'argos', 2, '40');
    expect(response.json<{ entries: { id: string }[] }>().entries.map((entry) => entry.id))
      .toEqual(['30', '20']);
  });
});
