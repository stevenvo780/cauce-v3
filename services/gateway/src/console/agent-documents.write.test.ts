import { coordinateWriteFixture, contexto } from './agent-profile.fixtures.js';
import { createHash } from 'node:crypto';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentFactsProbe, GovernanceBatchWrite, GovernanceReadError, GovernanceWritePrecondition,
  TerminalAuditEntry,
} from './agent-documents.routes.js';
import { registerAgentDocumentRoutes } from './agent-documents.routes.js';
import { MARCA_PERFIL_FIN, MARCA_PERFIL_INICIO } from '@cauce/protocol';
import { CONTEXT_APPLY_POLICY } from './context-apply-policy.js';
import { ContextContaminationTelemetry } from './contaminacion-de-contexto.js';
import {
  type GovernanceRelayClient,
  type MeasuredFactsSource, type RelayFileWrite, type RelayFileWriteBatch, type RuntimeFacts,
  TerminalRelayFactsProbe,
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
  it('acepta solo el ACK que acredita ruta, operación, huella y bytes solicitados', async () => {
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

function medidos(facts: RuntimeFacts): AgentFactsProbe['factsFor'] {
  return async () => ({ facts: { ...facts, generation: 'measured-one', containerId: 'container-one' }, source: 'measured' });
}

function sonda(overrides: Partial<AgentFactsProbe> = {}): AgentFactsProbe {
  return {
    factsFor: medidos(CLAUDE),
    readGovernanceDocument: async () => ({
      text: ANTERIOR, bytes: Buffer.byteLength(ANTERIOR, 'utf8'), truncated: false,
      modified_at: '2026-08-25T00:00:00Z', sha: sha(ANTERIOR),
    }),
    listMemoryDirectory: async () => SIN_LECTURA,
    writeGovernanceDocumentDurable: async () => ({
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
    readContext: async () => ({ contexto: contexto({}, 'claude'), exists: false, revision: null, applied_revision: null }),
    readRuntimeExpectation: async () => undefined,
    coordinateWrite: coordinateWriteFixture,
    persistDocumentWrite: async (_client, _document, audit) => { filas.push(audit); },
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

  it('returns the recovery id even if the pool is unavailable for unknown-effect audit', async () => {
    vivo = servidor({ recordAudit: async () => { throw new Error('pool unavailable'); },
      probe: sonda({ writeGovernanceDocumentDurable: async () => ({ sha: 'a'.repeat(64), bytes: 1 }) }),
    });
    const response = await vivo.inject({ method: 'PUT', url: ruta(),
      payload: { content: NUEVO, expected_sha: sha(ANTERIOR), reason: MOTIVO },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ state: 'effect_unknown', audit_recorded: false });
    expect(response.json<{ operation_id: string }>().operation_id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(response.body).not.toContain('pool unavailable');
    expect(response.json()).not.toHaveProperty('ok', true);
  });

  it('la sesión sin atribuir recibe 403 writable_requires_attribution y deja fila', async () => {
    const writeGovernanceDocumentDurable = vi.fn(async () => ({ sha: sha(NUEVO), bytes: 7 }));
    vivo = servidor({
      resolveOperator: () => ANONIMO,
      probe: sonda({ writeGovernanceDocumentDurable }),
    });
    const res = await vivo.inject({
      method: 'PUT', url: ruta(),
      payload: { content: NUEVO, expected_sha: sha(ANTERIOR), reason: MOTIVO },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({
      error: 'forbidden', reason: 'writable_requires_attribution',
    });
    expect(writeGovernanceDocumentDurable).not.toHaveBeenCalled();
    expect(filas).toHaveLength(1);
    expect(unaFila()).toMatchObject({ action: 'agent_document.denied', decision: 'deny' });
    expect(unaFila().metadata).toMatchObject({
      channel: 'write', reason: 'writable_requires_attribution',
      operator: ANONIMO.operator_id, attributed: false,
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
});

/*
 * Los dos `$HOME` compartidos de la flota (ADR-008) hacen que «el CLAUDE.md de este alias» sea a
 * veces el de otro. La guardia se corre AQUÍ, en la escritura, y no solo en la recarga.
 */
describe('la cuarentena de contaminación también cierra la escritura', () => {
  const AJENO = [
    '# CLAUDE.md', MARCA_PERFIL_INICIO, '<!-- alias: Steven/argos -->', 'prosa del contenedor ajeno',
    MARCA_PERFIL_FIN, '',
  ].join('\n');

  it('un alias en cuarentena no puede guardar: 409 con el dueño nombrado y fila', async () => {
    const writeGovernanceDocumentDurable = vi.fn(async () => ({ sha: sha(NUEVO), bytes: 7 }));
    const telemetry = new ContextContaminationTelemetry();
    vivo = servidor({
      telemetry,
      probe: sonda({
        readGovernanceDocument: async () => ({
          text: AJENO, bytes: Buffer.byteLength(AJENO, 'utf8'), truncated: false,
          modified_at: '2026-08-25T00:00:00Z', sha: sha(AJENO),
        }),
        writeGovernanceDocumentDurable,
      }),
    });
    const res = await vivo.inject({
      method: 'PUT', url: ruta(),
      payload: { content: NUEVO, expected_sha: sha(AJENO), reason: MOTIVO },
    });

    expect(res.statusCode).toBe(409);
    const cuerpo = res.json<{
      error: string; contaminacion: { findings: { reason: string; owner: string }[] };
    }>();
    expect(cuerpo.error).toBe('context_contaminated');
    expect(cuerpo.contaminacion.findings[0]).toMatchObject({
      reason: 'foreign_managed_block', owner: 'Steven/argos',
    });
    expect(writeGovernanceDocumentDurable).not.toHaveBeenCalled();
    expect(telemetry.snapshot().foreign_managed_block).toBe(1);
    expect(unaFila()).toMatchObject({ action: 'agent_document.denied', decision: 'deny' });
    expect(unaFila().metadata).toMatchObject({
      channel: 'write', reason: 'context_contaminated',
      contamination: [{ reason: 'foreign_managed_block', owner: 'Steven/argos' }],
    });
    // Ni el cuerpo ni la fila llevan un byte de lo que el bloque ajeno dice.
    expect(JSON.stringify(cuerpo)).not.toContain('prosa del contenedor ajeno');
    expect(JSON.stringify(unaFila().metadata)).not.toContain('prosa del contenedor ajeno');
  });
});
