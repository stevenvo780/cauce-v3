import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentFactsProbe, GovernanceBatchWrite, GovernanceReadError, GovernanceWritePrecondition,
  TerminalAuditEntry,
} from './agent-documents.routes.js';
import { registerAgentDocumentRoutes } from './agent-documents.routes.js';
import { MARCA_FIN, MARCA_INICIO } from '@cauce/protocol';
import { CONTEXT_APPLY_POLICY } from './context-apply-policy.js';
import {
  DEFAULT_CODEX_PROJECT_DOC_MAX_BYTES, effectiveManualPaths, type GovernanceRelayClient,
  MAX_DOCUMENT_BYTES,
  type MeasuredFactsSource, type RelayFileWrite, type RelayFileWriteBatch, type RuntimeFacts,
  TerminalRelayFactsProbe, verifyWritableProfilePath,
} from './agent-documents.js';

const CLAUDE: RuntimeFacts = { harness: 'claude', home: '/home/dev' };
const CLAUDE_PATH = '/home/dev/.claude/CLAUDE.md';
const OPENCLAW: RuntimeFacts = {
  harness: 'openclaw', home: '/home/claw', openclawWorkspace: '/home/claw/workspace',
};
const SIN_HECHOS: MeasuredFactsSource = { factsFor: async () => undefined };
const SIN_LECTURA: GovernanceReadError = { error: 'unavailable', reason: 'no aplica' };

function sha(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function relay(options: {
  readonly writeFile?: NonNullable<GovernanceRelayClient['writeFile']>;
  readonly writeFiles?: NonNullable<GovernanceRelayClient['writeFiles']>;
}): GovernanceRelayClient {
  return {
    readFile: vi.fn(async () => SIN_LECTURA),
    ...(options.writeFile === undefined ? {} : { writeFile: options.writeFile }),
    ...(options.writeFiles === undefined ? {} : { writeFiles: options.writeFiles }),
  };
}

function writeAck(content: string, overrides: Partial<RelayFileWrite> = {}): RelayFileWrite {
  return {
    path: CLAUDE_PATH,
    operation: 'create',
    sha: sha(content),
    bytes: Buffer.byteLength(content, 'utf8'),
    ...overrides,
  };
}

describe('la escritura gobernada exige evidencia exacta del relay', () => {
  it('acepta sólo el ACK que acredita ruta, operación, huella y bytes solicitados', async () => {
    const content = '# Directiva\n';
    const writeFile = vi.fn(async () => writeAck(content));
    const probe = new TerminalRelayFactsProbe(SIN_HECHOS, relay({ writeFile }));
    const precondition: GovernanceWritePrecondition = { state: 'absent' };

    expect(await probe.writeGovernanceDocument(
      CLAUDE_PATH, content, precondition, CLAUDE, 'Steven', 'zeus',
    )).toEqual({ sha: sha(content), bytes: Buffer.byteLength(content, 'utf8') });
    expect(writeFile).toHaveBeenCalledWith(
      'Steven', 'zeus', CLAUDE_PATH, content, precondition,
    );
  });

  it.each([
    ['ruta', { path: '/home/dev/.claude/OTRO.md' }],
    ['operación', { operation: 'replace' as const }],
    ['huella', { sha: '0'.repeat(64) }],
    ['bytes', { bytes: 999 }],
  ])('rechaza un ACK con %s distinta de la solicitud', async (_field, override) => {
    const content = '# Directiva\n';
    const probe = new TerminalRelayFactsProbe(SIN_HECHOS, relay({
      writeFile: async () => writeAck(content, override),
    }));

    expect(await probe.writeGovernanceDocument(
      CLAUDE_PATH, content, { state: 'absent' }, CLAUDE, 'Steven', 'zeus',
    )).toEqual({ error: 'unknown', reason: 'el ACK del relay no acredita el contenido solicitado' });
  });
});

describe('el lote gobernado acredita cada fichero una sola vez', () => {
  const content = '# Alma\n';
  const writes: readonly GovernanceBatchWrite[] = [
    {
      mode: 'write', path: '/home/claw/workspace/SOUL.md', content,
      precondition: { state: 'absent' },
    },
    {
      mode: 'verify', path: '/home/claw/workspace/IDENTITY.md',
      precondition: { state: 'present', sha256: 'a'.repeat(64) },
    },
  ];

  function batch(files: RelayFileWriteBatch['files']): RelayFileWriteBatch {
    return { files };
  }

  it('devuelve los dos ACK completos en el orden solicitado', async () => {
    const files: RelayFileWriteBatch['files'] = [
      {
        path: writes[0]?.path ?? expect.unreachable('falta la escritura'),
        operation: 'create', sha: sha(content), bytes: Buffer.byteLength(content, 'utf8'),
      },
      {
        path: writes[1]?.path ?? expect.unreachable('falta la verificación'),
        operation: 'unchanged', sha: 'a'.repeat(64), bytes: 17,
      },
    ];
    const probe = new TerminalRelayFactsProbe(SIN_HECHOS, relay({
      writeFiles: async () => batch(files),
    }));

    expect(await probe.writeGovernanceBatch(writes, OPENCLAW, 'Steven', 'jarvis')).toEqual(files);
  });

  it('rechaza un lote cuyo ACK repite una ruta y omite otra', async () => {
    const repeated = writes[0]?.path ?? expect.unreachable('falta la escritura');
    const probe = new TerminalRelayFactsProbe(SIN_HECHOS, relay({
      writeFiles: async () => batch([
        { path: repeated, operation: 'create', sha: sha(content), bytes: 7 },
        { path: repeated, operation: 'unchanged', sha: 'a'.repeat(64), bytes: 17 },
      ]),
    }));

    expect(await probe.writeGovernanceBatch(writes, OPENCLAW, 'Steven', 'jarvis')).toEqual({
      error: 'unknown', reason: 'el ACK del lote repite documentos',
    });
  });
});

describe('la ruta de perfil queda cerrada al destino medido', () => {
  it('acepta el fichero exacto y rechaza enlaces aunque su nombre solicitado sea válido', () => {
    expect(verifyWritableProfilePath(CLAUDE, CLAUDE_PATH)).toEqual({ allowed: true });
    expect(verifyWritableProfilePath(
      CLAUDE, CLAUDE_PATH, '/datos/agents/shared/.claude/CLAUDE.md',
    )).toEqual({ allowed: false, reason: 'la ruta del perfil es un enlace' });
    expect(verifyWritableProfilePath(
      CLAUDE, CLAUDE_PATH, '/home/dev/.claude/.credentials.json',
    )).toEqual({ allowed: false, reason: 'el destino parece material sensible' });
  });
});

/**
 * Route level: what the PUT leaves behind. The write channel is the only cross-tenant door that
 * rewrites the effective manual of an alias, so success AND every state denial must land a row in
 * `audit_events`, and no row may carry a byte of the document.
 */

const ACTOR = { tenant_id: 'Steven', alias: 'zeus' };
const OPERADOR = { operator_id: 'steven@elenxos', attributed: true };
const ANONIMO = { operator_id: 'unattributed:console-basic-auth', attributed: false };
const MOTIVO = 'ajusto la directiva porque el arranque nativo cambió de bandera';
const ANTERIOR = '# viejo\n';
const NUEVO = '# nuevo\n';
const CODEX: RuntimeFacts = {
  harness: 'codex', home: '/home/dev', projectDocMaxBytes: 64,
  projectDocFallbackFilenames: ['TEAM.md'],
};
const CODEX_PATH = '/home/dev/.codex/AGENTS.md';

function medidos(facts: RuntimeFacts): AgentFactsProbe['factsFor'] {
  return async () => ({ facts, source: 'measured' });
}

function sonda(overrides: Partial<AgentFactsProbe> = {}): AgentFactsProbe {
  return {
    factsFor: medidos(CLAUDE),
    readGovernanceDocument: async () => ({
      text: ANTERIOR, bytes: Buffer.byteLength(ANTERIOR, 'utf8'), truncated: false,
      modified_at: '2026-08-25T00:00:00Z', sha: sha(ANTERIOR),
    }),
    listMemoryDirectory: async () => SIN_LECTURA,
    writeGovernanceDocument: async () => ({
      sha: sha(NUEVO), bytes: Buffer.byteLength(NUEVO, 'utf8'),
    }),
    ...overrides,
  };
}

const filas: TerminalAuditEntry[] = [];

function servidor(deps: Partial<Parameters<typeof registerAgentDocumentRoutes>[1]> = {}) {
  const app = Fastify();
  registerAgentDocumentRoutes(app, {
    authorize: async () => ACTOR,
    resolveOperator: () => OPERADOR,
    authorizeTarget: async (_actor, tenant_id, alias) => ({
      tenant_id, alias, harness_id: 'claude', home_directory: '/home/dev', enabled: true,
    }),
    recordAudit: async (entry) => { filas.push(entry); },
    probe: sonda(),
    ...deps,
  });
  return app;
}

function unaFila(): TerminalAuditEntry {
  const fila = filas[0];
  if (fila === undefined) throw new Error('se esperaba una fila de auditoría y no la hubo');
  return fila;
}

function ruta(kind = 'directive'): string {
  return `/v3/console/tenants/Miguel/agents/kant/documents/${kind}/content`;
}

let vivo: ReturnType<typeof servidor> | undefined;
afterEach(async () => { await vivo?.close(); vivo = undefined; filas.length = 0; });

/*
 * Escribir en el HOME de un alias es el mismo acto de autoridad que abrirle una terminal, así que
 * pide lo mismo: una persona con nombre y un motivo tecleado. Sin eso la fila de auditoría no
 * acusa a nadie y el interruptor del runbook no cierra esta puerta.
 */
describe('el PUT gobernado exige persona con nombre y motivo tecleado', () => {
  it('la sesión sin atribuir recibe 403 writable_requires_attribution y deja fila', async () => {
    const writeGovernanceDocument = vi.fn(async () => ({ sha: sha(NUEVO), bytes: 7 }));
    vivo = servidor({
      resolveOperator: () => ANONIMO,
      probe: sonda({ writeGovernanceDocument }),
    });
    const res = await vivo.inject({
      method: 'PUT', url: ruta(),
      payload: { content: NUEVO, expected_sha: sha(ANTERIOR), reason: MOTIVO },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({
      error: 'forbidden', reason: 'writable_requires_attribution',
    });
    expect(writeGovernanceDocument).not.toHaveBeenCalled();
    expect(filas).toHaveLength(1);
    expect(unaFila()).toMatchObject({ action: 'agent_document.denied', decision: 'deny' });
    expect(unaFila().metadata).toMatchObject({
      channel: 'write', reason: 'writable_requires_attribution',
      operator: ANONIMO.operator_id, attributed: false,
    });
  });

  it('CONTROL NEGATIVO: sin resolutor de operador cableado nadie escribe', async () => {
    const app = Fastify();
    registerAgentDocumentRoutes(app, {
      authorize: async () => ACTOR,
      authorizeTarget: async (_actor, tenant_id, alias) => ({
        tenant_id, alias, harness_id: 'claude', home_directory: '/home/dev', enabled: true,
      }),
      recordAudit: async (entry) => { filas.push(entry); },
      probe: sonda(),
    });
    vivo = app;
    const res = await vivo.inject({
      method: 'PUT', url: ruta(),
      payload: { content: NUEVO, expected_sha: sha(ANTERIOR), reason: MOTIVO },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ reason: 'writable_requires_attribution' });
  });

  it.each([
    ['sin motivo', undefined],
    ['motivo de siete caracteres', 'siete c'],
    ['motivo que sólo es espacio en blanco', '                    '],
    ['motivo que al recortar baja del mínimo', '   siete c   '],
    ['motivo de 281 caracteres', 'x'.repeat(281)],
    ['motivo que no es texto', 42],
  ])('%s: 400 sin tocar el disco ni la auditoría', async (_caso, motivo) => {
    const writeGovernanceDocument = vi.fn(async () => ({ sha: sha(NUEVO), bytes: 7 }));
    vivo = servidor({ probe: sonda({ writeGovernanceDocument }) });
    const res = await vivo.inject({
      method: 'PUT', url: ruta(),
      payload: {
        content: NUEVO, expected_sha: sha(ANTERIOR),
        ...(motivo === undefined ? {} : { reason: motivo }),
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_input' });
    expect(writeGovernanceDocument).not.toHaveBeenCalled();
    expect(filas).toEqual([]);
  });

  it('acepta el motivo mínimo de ocho caracteres y lo audita tal cual se tecleó', async () => {
    vivo = servidor();
    const res = await vivo.inject({
      method: 'PUT', url: ruta(),
      payload: { content: NUEVO, expected_sha: sha(ANTERIOR), reason: '  ocho car  ' },
    });

    expect(res.statusCode).toBe(202);
    expect(unaFila().metadata).toMatchObject({ operator_reason: 'ocho car' });
  });

  it('el motivo viaja a la fila de las denegaciones posteriores, no sólo a la del éxito', async () => {
    vivo = servidor({ probe: sonda({ factsFor: async () => undefined }) });
    const res = await vivo.inject({
      method: 'PUT', url: ruta(),
      payload: { content: NUEVO, expected_sha: sha(ANTERIOR), reason: MOTIVO },
    });

    expect(res.statusCode).toBe(409);
    expect(unaFila().metadata).toMatchObject({
      reason: 'no_medido', operator_reason: MOTIVO, operator: OPERADOR.operator_id,
    });
  });
});

describe('el PUT gobernado audita su éxito y responde con vocabulario honesto', () => {
  it('responde 202 written_pending_session y deja una fila agent_document.write', async () => {
    vivo = servidor();
    const res = await vivo.inject({
      method: 'PUT', url: ruta(),
      payload: { content: NUEVO, expected_sha: sha(ANTERIOR), reason: MOTIVO },
    });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({
      ok: true, state: 'written_pending_session', evidence: 'probe_write_ack',
      path: CLAUDE_PATH, sha: sha(NUEVO), bytes: Buffer.byteLength(NUEVO, 'utf8'),
    });
    expect(CONTEXT_APPLY_POLICY.written_pending_session.sessionReloaded).toBe(false);
    expect(filas).toHaveLength(1);
    expect(unaFila()).toMatchObject({
      tenant_id: 'Steven', actor_alias: 'zeus',
      action: 'agent_document.write', decision: 'allow',
    });
    expect(unaFila().metadata).toEqual({
      operator_id: 'Steven:zeus', target_tenant: 'Miguel', target_alias: 'kant',
      harness_id: 'claude', home_directory: '/home/dev', facts_source: 'measured',
      kind: 'directive', path: CLAUDE_PATH, sha_before: sha(ANTERIOR), sha_after: sha(NUEVO),
      bytes: Buffer.byteLength(NUEVO, 'utf8'),
      operator: OPERADOR.operator_id, attributed: true, operator_reason: MOTIVO,
    });
  });

  it('la fila no lleva el cuerpo del documento ni un byte de él', async () => {
    const secreto = '# el secreto que no puede viajar a audit_events\n';
    vivo = servidor({
      probe: sonda({
        writeGovernanceDocument: async () => ({
          sha: sha(secreto), bytes: Buffer.byteLength(secreto, 'utf8'),
        }),
      }),
    });
    await vivo.inject({
      method: 'PUT', url: ruta(),
      payload: { content: secreto, expected_sha: sha(ANTERIOR), reason: MOTIVO },
    });

    expect(filas).toHaveLength(1);
    const serializada = JSON.stringify(unaFila().metadata);
    expect(serializada).not.toContain('secreto');
    expect(serializada).not.toContain(ANTERIOR.trim());
    expect(unaFila().metadata).not.toHaveProperty('content');
    expect(unaFila().metadata).not.toHaveProperty('container_id');
  });
});

describe('cada denegación de estado del PUT deja fila agent_document.denied', () => {
  it.each([
    ['sin hechos medidos', 409, 'no_medido', { factsFor: async () => undefined }, {}],
    ['carrera de SHA', 409, 'conflict', {}, { expected_sha: 'c'.repeat(64) }],
    ['fichero ya presente', 409, 'conflict', {}, {
      create_if_absent: true, expected_sha: undefined,
    }],
    ['ACK que no acredita los bytes', 502, 'invalid_ack', {
      writeGovernanceDocument: async () => ({ sha: 'd'.repeat(64), bytes: 7 }),
    }, {}],
  ] as const)('%s', async (_caso, status, error, overrides, payload) => {
    vivo = servidor({ probe: sonda(overrides) });
    const res = await vivo.inject({
      method: 'PUT',
      url: ruta(),
      payload: { content: NUEVO, expected_sha: sha(ANTERIOR), reason: MOTIVO, ...payload },
    });

    expect(res.statusCode).toBe(status);
    expect(res.json()).toMatchObject({ error });
    expect(filas).toHaveLength(1);
    expect(unaFila()).toMatchObject({
      action: 'agent_document.denied', decision: 'deny',
    });
    expect(unaFila().metadata).toMatchObject({
      operator_id: 'Steven:zeus', target_tenant: 'Miguel', target_alias: 'kant',
      kind: 'directive', reason: error,
    });
  });

  it('sin canal de escritura responde 503 honesto y deja fila', async () => {
    const completa = sonda();
    const sinEscritura: AgentFactsProbe = {
      factsFor: (tenantId, alias) => completa.factsFor(tenantId, alias),
      readGovernanceDocument: (path, facts, tenantId, alias) =>
        completa.readGovernanceDocument(path, facts, tenantId, alias),
      listMemoryDirectory: (root, facts, tenantId, alias) =>
        completa.listMemoryDirectory(root, facts, tenantId, alias),
    };
    vivo = servidor({ probe: sinEscritura });
    const res = await vivo.inject({
      method: 'PUT', url: ruta(),
      payload: { content: NUEVO, expected_sha: sha(ANTERIOR), reason: MOTIVO },
    });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: 'unavailable' });
    expect(unaFila().metadata).toMatchObject({ reason: 'unavailable' });
  });

  it('el alias apagado falla cerrado y también deja fila', async () => {
    vivo = servidor({
      authorizeTarget: async (_actor, tenant_id, alias) => ({
        tenant_id, alias, harness_id: 'claude', home_directory: '/home/dev', enabled: false,
      }),
    });
    const res = await vivo.inject({
      method: 'PUT', url: ruta(),
      payload: { content: NUEVO, expected_sha: sha(ANTERIOR), reason: MOTIVO },
    });

    expect(res.statusCode).toBe(409);
    expect(unaFila().metadata).toMatchObject({ reason: 'agent_disabled' });
  });

  it('el conflicto de bloque gestionado deja fila con el conflicto exacto', async () => {
    const gestionado = `${MARCA_INICIO}\ncontrato\n${MARCA_FIN}\n`;
    vivo = servidor({
      probe: sonda({
        readGovernanceDocument: async () => ({ error: 'not_found', reason: 'no existe' }),
      }),
    });
    const res = await vivo.inject({
      method: 'PUT', url: ruta(),
      payload: { content: gestionado, create_if_absent: true, reason: MOTIVO },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: 'managed_context_conflict', conflict: 'reserved_markers_on_create',
    });
    expect(unaFila().metadata).toMatchObject({
      reason: 'managed_context_conflict', conflict: 'reserved_markers_on_create',
    });
  });

  it('una ruta no escribible deja fila antes de tocar el disco', async () => {
    const writeGovernanceDocument = vi.fn(async () => ({ sha: sha(NUEVO), bytes: 7 }));
    vivo = servidor({
      probe: sonda({ factsFor: medidos(OPENCLAW), writeGovernanceDocument }),
    });
    const res = await vivo.inject({
      method: 'PUT', url: ruta('identity'),
      payload: { content: NUEVO, expected_sha: sha(ANTERIOR), reason: MOTIVO },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'forbidden' });
    expect(writeGovernanceDocument).not.toHaveBeenCalled();
    expect(unaFila().metadata).toMatchObject({ reason: 'forbidden', kind: 'identity' });
  });

  it('el tope genérico de 256 KiB se evalúa antes que el del arnés', async () => {
    vivo = servidor({ probe: sonda({ factsFor: medidos(CODEX) }) });
    const res = await vivo.inject({
      method: 'PUT', url: ruta(),
      payload: {
        content: 'a'.repeat(MAX_DOCUMENT_BYTES + 1), expected_sha: sha(ANTERIOR), reason: MOTIVO,
      },
    });

    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ error: 'too_large' });
    expect(unaFila().metadata).toMatchObject({ reason: 'too_large' });
  });
});

describe('el manual de ámbito de usuario de codex no se mide contra el tope de proyecto', () => {
  /*
   * `project_doc_max_bytes` topa el AGREGADO de los manuales de ámbito WORKSPACE — así lo aplica
   * el lector en `agent-directive.routes.ts` — y el único documento que este canal escribe para
   * codex es `$CODEX_HOME/AGENTS.md`, que `effectiveManualPaths` clasifica como `user`. Toparlo
   * aquí rechazaría con un 413 una escritura legítima y con un mensaje falso para ese fichero.
   */
  it('escribe entero un AGENTS.md mayor que el project_doc_max_bytes medido', async () => {
    const grande = 'x'.repeat(65);
    vivo = servidor({
      probe: sonda({
        factsFor: medidos(CODEX),
        writeGovernanceDocument: async () => ({
          sha: sha(grande), bytes: Buffer.byteLength(grande, 'utf8'),
        }),
      }),
    });
    const res = await vivo.inject({
      method: 'PUT', url: ruta(),
      payload: { content: grande, expected_sha: sha(ANTERIOR), reason: MOTIVO },
    });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ path: CODEX_PATH, state: 'written_pending_session' });
    expect(res.json()).not.toMatchObject({ error: 'exceeds_harness_budget' });
    expect(effectiveManualPaths(CODEX).find((manual) => manual.path === CODEX_PATH)?.scope)
      .toBe('user');
    expect(unaFila().action).toBe('agent_document.write');
  });

  it('tampoco topa cuando codex no publicó proyección y regiría el defecto de 32 KiB', async () => {
    const sinConfig: RuntimeFacts = { harness: 'codex', home: '/home/dev' };
    const grande = 'x'.repeat(DEFAULT_CODEX_PROJECT_DOC_MAX_BYTES + 1);
    vivo = servidor({
      probe: sonda({
        factsFor: medidos(sinConfig),
        writeGovernanceDocument: async () => ({
          sha: sha(grande), bytes: Buffer.byteLength(grande, 'utf8'),
        }),
      }),
    });
    const res = await vivo.inject({
      method: 'PUT', url: ruta(),
      payload: { content: grande, expected_sha: sha(ANTERIOR), reason: MOTIVO },
    });

    expect(res.statusCode).toBe(202);
    expect(unaFila().action).toBe('agent_document.write');
  });
});

describe('la fila nombra el arnés y el HOME MEDIDOS, no los del registro', () => {
  it('el registro que se equivoca de arnés no contamina la auditoría', async () => {
    vivo = servidor({
      authorizeTarget: async (_actor, tenant_id, alias) => ({
        tenant_id, alias, harness_id: 'codex', home_directory: '/home/otro', enabled: true,
      }),
    });
    const res = await vivo.inject({
      method: 'PUT', url: ruta(),
      payload: { content: NUEVO, expected_sha: sha(ANTERIOR), reason: MOTIVO },
    });

    expect(res.statusCode).toBe(202);
    expect(unaFila().metadata).toMatchObject({
      harness_id: 'claude', home_directory: '/home/dev', facts_source: 'measured',
    });
  });

  it('sin medición la fila cae al registro y lo declara con facts_source', async () => {
    vivo = servidor({
      authorizeTarget: async (_actor, tenant_id, alias) => ({
        tenant_id, alias, harness_id: 'codex', home_directory: '/home/otro', enabled: true,
      }),
      probe: sonda({ factsFor: async () => undefined }),
    });
    const res = await vivo.inject({
      method: 'PUT', url: ruta(),
      payload: { content: NUEVO, expected_sha: sha(ANTERIOR), reason: MOTIVO },
    });

    expect(res.statusCode).toBe(409);
    expect(unaFila().metadata).toMatchObject({
      harness_id: 'codex', home_directory: '/home/otro', facts_source: null,
      reason: 'no_medido', channel: 'write',
    });
  });
});

describe('el destino que no se ve deja fila antes de contestar 404', () => {
  it('la sonda de enumeración de alias no pasa sin rastro', async () => {
    vivo = servidor({ authorizeTarget: async () => undefined });
    const res = await vivo.inject({
      method: 'PUT', url: ruta(),
      payload: { content: NUEVO, expected_sha: sha(ANTERIOR), reason: MOTIVO },
    });

    expect(res.statusCode).toBe(404);
    expect(filas).toHaveLength(1);
    expect(unaFila()).toMatchObject({
      tenant_id: 'Steven', actor_alias: 'zeus',
      action: 'agent_document.denied', decision: 'deny',
    });
    expect(unaFila().metadata).toMatchObject({
      target_tenant: 'Miguel', target_alias: 'kant', kind: 'directive',
      reason: 'not_found', channel: 'write', harness_id: null, home_directory: null,
    });
  });
});
