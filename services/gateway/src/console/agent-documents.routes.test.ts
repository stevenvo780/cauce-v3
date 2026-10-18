import { coordinateWriteFixture, contexto, FIXTURE_WRITE_OPERATION } from './agent-profile.fixtures.js';
import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MARCA_FIN, MARCA_INICIO, MARCA_PERFIL_FIN, MARCA_PERFIL_INICIO,
  marcaDeRevisionDelPerfil,
} from '@cauce/protocol';
import type { RuntimeFacts } from './agent-documents.js';
import {
  type AgentFactsProbe, type DocumentsResponse, type FactsSource, registerAgentDocumentRoutes,
  type TerminalAuditEntry
} from './agent-documents.routes.js';
import { CONTEXT_APPLY_POLICY } from './context-apply-policy.js';
import { hechosDelRegistro } from '../terminal/hechos-del-registro.js';
import { AgentRegistry, parseAgentPresence } from '../terminal/registry.js';

/**
 * The route is actually stood up and hit with `app.inject`. Not a test of whatever object a
 * function returns: it is the effect of a GET on a live fastify, which is the only thing that
 * proves the route exists, that it responds, and that the body comes out as expected.
 */

const ACTOR = { tenant_id: 'Steven', alias: 'zeus' };
const OPERADOR = { operator_id: 'operator@example.test', attributed: true };
const MOTIVO = 'reviso el manual del sitio antes de la ola de trabajo';

function sha(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

const MANAGED_DIRECTIVE = [
  '# Manual anterior',
  MARCA_INICIO,
  'contrato sellado',
  MARCA_FIN,
  marcaDeRevisionDelPerfil(7),
  MARCA_PERFIL_INICIO,
  'perfil proyectado',
  MARCA_PERFIL_FIN,
  'cola anterior',
  '',
].join('\n');

function probe(entradas: Record<string, { facts: RuntimeFacts; source: FactsSource }>): AgentFactsProbe {
  return {
    async factsFor(tenantId, alias) {
      return entradas[`${tenantId}:${alias}`];
    },
    // This route is the INVENTORY: it says which file is what and where it lives, never its content.
    // The doubles reject it so the day this route starts reading, the test notices.
    async readGovernanceDocument() {
      return { error: 'unavailable', reason: 'el inventario no lee contenido' };
    },
    async listMemoryDirectory() {
      return { error: 'unavailable', reason: 'el inventario no lee memoria' };
    },
  };
}

const auditoria: TerminalAuditEntry[] = [];

function servidor(deps: Partial<Parameters<typeof registerAgentDocumentRoutes>[1]> = {}) {
  const app = Fastify();
  const currentProbe = deps.probe ?? probe({});
  registerAgentDocumentRoutes(app, {
    authorize: async () => ACTOR,
    resolveOperator: () => OPERADOR,
    recordAudit: async (entry) => { auditoria.push(entry); },
    authorizeTarget: async (_actor, tenantId, alias) => ({
      tenant_id: tenantId, alias, harness_id: null, home_directory: null, enabled: true,
    }),
    probe: currentProbe,
    readContext: async () => ({ contexto: contexto({}, 'claude'), exists: false, revision: null, applied_revision: null }),
    readRuntimeExpectation: async () => undefined,
    coordinateWrite: async (input) => coordinateWriteFixture(input, undefined,
      (await currentProbe.factsFor(input.tenantId, input.alias))?.facts.generation ?? 'unmeasured'),
    persistDocumentWrite: async (_client, _document, audit) => { auditoria.push(audit); },
    ...deps,
  });
  return app;
}

function rutaMapa(tenantId: string, alias: string): string {
  return `/v3/console/tenants/${tenantId}/agents/${alias}/documents`;
}

function rutaContenido(tenantId: string, alias: string, kind = 'directive'): string {
  return `${rutaMapa(tenantId, alias)}/${kind}/content`;
}

let vivo: ReturnType<typeof servidor> | undefined;
afterEach(async () => { await vivo?.close(); vivo = undefined; auditoria.length = 0; });

describe('GET tenant-qualified del mapa de documentos', () => {
  it('con hechos MEDIDOS devuelve rutas editables', async () => {
    vivo = servidor({
      probe: probe({
        'Steven:zeus': { facts: { harness: 'claude', home: '/home/dev' }, source: 'measured' },
      }),
    });
    const res = await vivo.inject({ method: 'GET', url: rutaMapa('Steven', 'zeus') });
    expect(res.statusCode).toBe(200);
    const body = res.json<DocumentsResponse>();
    expect(body.facts_source).toBe('measured');
    expect(body.caveat).toBeUndefined();
    const directiva = body.items.find((d) => d.kind === 'directive');
    expect(directiva?.path).toBe('/home/dev/.claude/CLAUDE.md');
    expect(directiva?.readable).toBe(true);
    expect(directiva?.editable).toBe(true);
    expect(body.items.find((d) => d.kind === 'tools')?.readable).toBe(false);
    expect(body.items.find((d) => d.kind === 'prompts')?.readable).toBe(false);
    expect(body.items.find((d) => d.kind === 'mcp')?.readable).toBe(false);
  });

  /**
   * Negative control of the whole design: if the facts come from the registry, NOTHING comes out
   * editable, and the warning travels in the body. A field that looks editable and writes to the
   * wrong file is worse than not having an editor.
   */
  it('sin medición nada es editable y el aviso viaja en el cuerpo', async () => {
    vivo = servidor({
      authorizeTarget: async () => ({
        tenant_id: 'Steven', alias: 'kant', harness_id: 'codex', home_directory: '/home/dev',
      }),
    });
    const res = await vivo.inject({ method: 'GET', url: rutaMapa('Steven', 'kant') });
    expect(res.statusCode).toBe(200);
    const body = res.json<DocumentsResponse>();
    expect(body.facts_source).toBe('database');
    expect(body.caveat).toMatch(/5 de los 14/);
    expect(body.items.every((d) => !d.readable)).toBe(true);
    expect(body.items.every((d) => !d.editable)).toBe(true);
    // On top of that, the path the DB gives is the wrong one: kant runs claude.js, not codex.
    expect(body.items.find((d) => d.kind === 'directive')?.path).toBe('/home/dev/.codex/AGENTS.md');
  });

  it('el mismo alias en dos tenants usa únicamente el tenant de la URL', async () => {
    vivo = servidor({
      probe: probe({
        'Steven:kant': { facts: { harness: 'claude', home: '/home/dev' }, source: 'measured' },
        'Miguel:kant': { facts: { harness: 'codex', home: '/home/zz-canary-operator' }, source: 'measured' },
      }),
    });

    const body = (await vivo.inject({ method: 'GET', url: rutaMapa('Miguel', 'kant') }))
      .json<DocumentsResponse>();

    expect(body).toMatchObject({ tenant_id: 'Miguel', alias: 'kant', harness: 'codex' });
    expect(body.items.find((item) => item.kind === 'directive')?.path)
      .toBe('/home/zz-canary-operator/.codex/AGENTS.md');
  });

  it('un destino denegado no llega ni a la sonda', async () => {
    const factsFor = vi.fn(async () => undefined);
    vivo = servidor({
      authorizeTarget: async () => undefined,
      probe: { ...probe({}), factsFor },
    });

    const res = await vivo.inject({ method: 'GET', url: rutaMapa('Miguel', 'kant') });

    expect(res.statusCode).toBe(404);
    expect(factsFor).not.toHaveBeenCalled();
  });
});

describe('contenido y escritura tenant-qualified', () => {
  it('un hello base sin marcador observado conserva terminal pero autoriza cero lecturas', async () => {
    const registry = new AgentRegistry();
    registry.observe({
      relay_instance_id: 'a'.repeat(64),
      relay_boot_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    }, [parseAgentPresence({
      tenant_id: 'Steven', alias: 'zeus', container_id: 'ws-zeus', generation: '1',
      image_id: 'img', runtime_user: 'dev', runtime_uid: 1000, harness: 'claude',
      // Even with plausible roots from the bundle, without explicit observation they are not authority.
      home: '/home/dev', claude_config_dir: '/home/dev/.claude',
      modes: ['shell', 'harness'], connected_since: '2026-08-26T00:00:00.000Z',
    })]);
    const read = vi.fn(async () => ({ error: 'unavailable' as const, reason: 'no debe ocurrir' }));
    const measuredFacts = hechosDelRegistro(registry);
    vivo = servidor({
      probe: {
        factsFor: (tenantId, alias) => measuredFacts.factsFor(tenantId, alias),
        readGovernanceDocument: read,
        listMemoryDirectory: async () => ({ error: 'unavailable', reason: 'no debe ocurrir' }),
      },
    });
    expect(registry.state('Steven', 'zeus')).toBe('online');
    const response = await vivo.inject({
      method: 'GET', url: rutaContenido('Steven', 'zeus'),
    });
    expect(response.statusCode).toBe(409);
    expect(read).not.toHaveBeenCalled();
  });

  const FACTS: RuntimeFacts = {
    harness: 'claude', home: '/home/dev', generation: 'measured-one', containerId: 'container-one',
  };

  it('lee el contenido del tenant objetivo, no del tenant del actor', async () => {
    const readGovernanceDocument = vi.fn(async () => ({
      text: '# Miguel\n', bytes: 9, truncated: false, modified_at: '2026-08-25T00:00:00Z',
      sha: sha('# Miguel\n'),
    }));
    vivo = servidor({
      probe: {
        ...probe({ 'Miguel:kant': { facts: FACTS, source: 'measured' } }),
        readGovernanceDocument,
      },
    });

    const res = await vivo.inject({ method: 'GET', url: rutaContenido('Miguel', 'kant') });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      tenant_id: 'Miguel', alias: 'kant', content: '# Miguel\n', exists: true, projected: false,
    });
    expect(readGovernanceDocument).toHaveBeenCalledWith(
      '/home/dev/.claude/CLAUDE.md', FACTS, 'Miguel', 'kant',
    );
  });

  it('sólo afirma applied cuando recibió el ACK de escritura de la sonda', async () => {
    let permiso: string | undefined;
    const anterior = '# viejo';
    const nuevo = '# nuevo';
    const writeGovernanceDocumentDurable = vi.fn(async () => ({ sha: sha(nuevo), bytes: 7 }));
    vivo = servidor({
      authorize: async (_request, requested) => {
        permiso = requested;
        return ACTOR;
      },
      probe: {
        ...probe({ 'Miguel:kant': { facts: FACTS, source: 'measured' } }),
        readGovernanceDocument: async () => ({
          text: anterior, bytes: 7, truncated: false, modified_at: '2026-08-25T00:00:00Z',
          sha: sha(anterior),
        }),
        writeGovernanceDocumentDurable,
      },
    });

    const res = await vivo.inject({
      method: 'PUT',
      url: rutaContenido('Miguel', 'kant'),
      payload: { content: nuevo, expected_sha: sha(anterior), reason: MOTIVO },
    });

    expect(res.statusCode).toBe(202);
    expect(permiso).toBe('control');
    expect(res.json()).toEqual({
      ok: true,
      state: 'written_pending_session',
      evidence: 'probe_write_ack',
      message: CONTEXT_APPLY_POLICY.written_pending_session.message,
      path: '/home/dev/.claude/CLAUDE.md',
      sha: sha(nuevo),
      bytes: 7,
    });
    expect(writeGovernanceDocumentDurable).toHaveBeenCalledWith(
      '/home/dev/.claude/CLAUDE.md', nuevo,
      { state: 'present', sha256: sha(anterior) }, FACTS, 'Miguel', 'kant',
      expect.objectContaining({ ...FIXTURE_WRITE_OPERATION, runtimeGeneration: 'measured-one', signal: expect.any(AbortSignal) as unknown }),
    );
  });

  it('permite cambiar texto manual externo y conserva los bloques gestionados con ACK exacto', async () => {
    const nuevo = MANAGED_DIRECTIVE
      .replace('# Manual anterior', '# Manual nuevo')
      .replace('cola anterior', 'cola nueva');
    const writeGovernanceDocumentDurable = vi.fn(async () => ({
      sha: sha(nuevo), bytes: Buffer.byteLength(nuevo, 'utf8'),
    }));
    vivo = servidor({
      probe: {
        ...probe({ 'Miguel:kant': { facts: FACTS, source: 'measured' } }),
        readGovernanceDocument: async () => ({
          text: MANAGED_DIRECTIVE,
          bytes: Buffer.byteLength(MANAGED_DIRECTIVE, 'utf8'),
          truncated: false,
          modified_at: '2026-08-25T00:00:00Z',
          sha: sha(MANAGED_DIRECTIVE),
        }),
        writeGovernanceDocumentDurable,
      },
    });

    const res = await vivo.inject({
      method: 'PUT', url: rutaContenido('Miguel', 'kant'),
      payload: { content: nuevo, expected_sha: sha(MANAGED_DIRECTIVE), reason: MOTIVO },
    });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({
      ok: true, state: 'written_pending_session', evidence: 'probe_write_ack', sha: sha(nuevo),
    });
    expect(writeGovernanceDocumentDurable).toHaveBeenCalledWith(
      '/home/dev/.claude/CLAUDE.md', nuevo,
      { state: 'present', sha256: sha(MANAGED_DIRECTIVE) }, FACTS, 'Miguel', 'kant',
      expect.objectContaining({ ...FIXTURE_WRITE_OPERATION, runtimeGeneration: 'measured-one', signal: expect.any(AbortSignal) as unknown }),
    );
  });

  it('mantiene el CAS: una carrera de SHA responde 409 antes de comparar o escribir', async () => {
    const actual = '# cambio concurrente\n';
    const writeGovernanceDocumentDurable = vi.fn(async () => ({ sha: sha('nuevo'), bytes: 5 }));
    vivo = servidor({
      probe: {
        ...probe({ 'Miguel:kant': { facts: FACTS, source: 'measured' } }),
        readGovernanceDocument: async () => ({
          text: actual, bytes: Buffer.byteLength(actual, 'utf8'), truncated: false,
          modified_at: '2026-08-25T00:00:00Z', sha: sha(actual),
        }),
        writeGovernanceDocumentDurable,
      },
    });

    const res = await vivo.inject({
      method: 'PUT', url: rutaContenido('Miguel', 'kant'),
      payload: { content: '# nuevo\n', expected_sha: sha('# versión abierta\n'), reason: MOTIVO },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'conflict' });
    expect(writeGovernanceDocumentDurable).not.toHaveBeenCalled();
  });

  it('crea sólo cuando GET observó ausencia y el cliente manda create_if_absent', async () => {
    const writeGovernanceDocumentDurable = vi.fn(async () => ({ sha: sha('# primero'), bytes: 9 }));
    vivo = servidor({
      probe: {
        ...probe({ 'Miguel:kant': { facts: FACTS, source: 'measured' } }),
        readGovernanceDocument: async () => ({ error: 'not_found', reason: 'no existe' }),
        writeGovernanceDocumentDurable,
      },
    });

    const res = await vivo.inject({
      method: 'PUT', url: rutaContenido('Miguel', 'kant'),
      payload: { content: '# primero', create_if_absent: true, reason: MOTIVO },
    });

    expect(res.statusCode).toBe(202);
    expect(writeGovernanceDocumentDurable).toHaveBeenCalledWith(
      '/home/dev/.claude/CLAUDE.md', '# primero', { state: 'absent' }, FACTS, 'Miguel', 'kant',
      expect.objectContaining({ ...FIXTURE_WRITE_OPERATION, runtimeGeneration: 'measured-one', signal: expect.any(AbortSignal) as unknown }),
    );
  });

  it('un prefijo truncado nunca se puede reemplazar, aun con el SHA real', async () => {
    const writeGovernanceDocumentDurable = vi.fn(async () => ({ sha: sha('nuevo'), bytes: 5 }));
    vivo = servidor({
      probe: {
        ...probe({ 'Miguel:kant': { facts: FACTS, source: 'measured' } }),
        readGovernanceDocument: async () => ({
          text: 'prefijo', bytes: 900_000, truncated: true,
          modified_at: '2026-08-25T00:00:00Z', sha: 'c'.repeat(64),
        }),
        writeGovernanceDocumentDurable,
      },
    });

    const res = await vivo.inject({
      method: 'PUT', url: rutaContenido('Miguel', 'kant'),
      payload: { content: 'nuevo', expected_sha: 'c'.repeat(64), reason: MOTIVO },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'truncated_source' });
    expect(writeGovernanceDocumentDurable).not.toHaveBeenCalled();
  });

  it('un 2xx interno sin ACK exacto se transforma en error y no en applied', async () => {
    const anterior = 'viejo';
    vivo = servidor({
      probe: {
        ...probe({ 'Miguel:kant': { facts: FACTS, source: 'measured' } }),
        readGovernanceDocument: async () => ({
          text: anterior, bytes: 5, truncated: false,
          modified_at: '2026-08-25T00:00:00Z', sha: sha(anterior),
        }),
        writeGovernanceDocumentDurable: async () => ({ sha: 'd'.repeat(64), bytes: 5 }),
      },
    });

    const res = await vivo.inject({
      method: 'PUT', url: rutaContenido('Miguel', 'kant'),
      payload: { content: 'nuevo', expected_sha: sha(anterior), reason: MOTIVO },
    });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: 'document_write_unconfirmed', state: 'effect_unknown' });
  });
});
