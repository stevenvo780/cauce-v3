import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ContextoDeAlias } from '@cauce/protocol';
import type {
  AgentFactsProbe, GovernanceBatchWrite, GovernanceBatchWriteAck, GovernanceDocumentContent,
  GovernanceReadError,
} from './agent-documents.routes.js';
import type { RuntimeFacts } from './agent-documents.js';
import { prepareAgentProfileRuntime } from './agent-profile-runtime.js';

function sha(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function read(text: string, overrides: Partial<GovernanceDocumentContent> = {}): GovernanceDocumentContent {
  return {
    text,
    bytes: Buffer.byteLength(text, 'utf8'),
    truncated: false,
    modified_at: '2026-08-25T00:00:00Z',
    sha: sha(text),
    ...overrides,
  };
}

function contexto(alias: string, harness: string): ContextoDeAlias {
  return {
    perfil: {
      tenant_id: 'Steven', alias,
      purpose: 'coordinar', role_summary: 'coordinador', human_brief: 'Steven',
      responsibilities: ['reparar'], restrictions: ['no secretos'], tools: ['cauce'],
      operating_rules: ['verificar'],
    },
    hechos: {
      permisos: { ruta: true, lectura: true, control: true, notificacion: false },
      cuotas: [],
      arnes: { harness, home: '/declarado/no-medido', capacidades: [] },
      destinos: [],
    },
  };
}

function probe(
  facts: RuntimeFacts,
  reads: ReadonlyMap<string, GovernanceDocumentContent | GovernanceReadError>,
  batch: (writes: readonly GovernanceBatchWrite[]) => Promise<
    readonly GovernanceBatchWriteAck[] | GovernanceReadError | { error: 'conflict'; reason: string }
  >,
): AgentFactsProbe {
  return {
    factsFor: async () => ({ facts, source: 'measured' }),
    readGovernanceDocument: async (path) => reads.get(path)
      ?? { error: 'not_found', reason: 'no existe' },
    listMemoryDirectory: async () => ({ error: 'unavailable', reason: 'no aplica' }),
    writeGovernanceBatch: async (writes) => batch(writes),
  };
}

function ackFor(writes: readonly GovernanceBatchWrite[]): readonly GovernanceBatchWriteAck[] {
  return writes.map((write) => {
    if (write.mode === 'verify') {
      return write.precondition.state === 'present'
        ? { path: write.path, operation: 'unchanged', sha: write.precondition.sha256, bytes: 17 }
        : { path: write.path, operation: 'absent', sha: null, bytes: 0 };
    }
    return {
      path: write.path,
      operation: write.precondition.state === 'present' ? 'replace' : 'create',
      sha: sha(write.content),
      bytes: Buffer.byteLength(write.content, 'utf8'),
    };
  });
}

describe('prepareAgentProfileRuntime', () => {
  it('compone contra el fichero real y sólo acredita el ACK SHA/bytes del lote', async () => {
    const path = '/home/dev/.codex-kant/AGENTS.md';
    const before = '# manual humano\n';
    const batch = vi.fn(async (writes: readonly GovernanceBatchWrite[]) => ackFor(writes));
    const prepared = await prepareAgentProfileRuntime(
      probe(
        { harness: 'codex', home: '/home/dev', codexHome: '/home/dev/.codex-kant' },
        new Map([[path, read(before)]]),
        batch,
      ),
      'Steven', 'kant', contexto('kant', 'codex'),
    );

    const acks = await prepared.apply();

    expect(batch).toHaveBeenCalledOnce();
    const writes = batch.mock.calls[0]?.[0] ?? [];
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      mode: 'write',
      path,
      precondition: { state: 'present', sha256: sha(before) },
    });
    const write = writes[0];
    expect(write?.mode).toBe('write');
    if (write?.mode !== 'write') throw new Error('el lote no trajo una escritura');
    expect(write.content).toContain('# manual humano');
    expect(write.content).toContain('<!-- alias: Steven/kant -->');
    expect(acks).toEqual([{
      name: 'AGENTS.md', path, state: 'written',
      sha: sha(write.content), bytes: Buffer.byteLength(write.content, 'utf8'),
    }]);
  });

  it('un documento truncado aborta en preflight antes de persistir o escribir', async () => {
    const path = '/home/dev/.claude/CLAUDE.md';
    const batch = vi.fn(async (writes: readonly GovernanceBatchWrite[]) => ackFor(writes));
    await expect(prepareAgentProfileRuntime(
      probe(
        { harness: 'claude', home: '/home/dev' },
        new Map([[path, read('prefijo', { truncated: true, bytes: 500_000 })]]),
        batch,
      ),
      'Steven', 'zeus', contexto('zeus', 'claude'),
    )).rejects.toMatchObject({ name: 'ProfileRuntimeError', code: 'truncated' });
    expect(batch).not.toHaveBeenCalled();
  });

  it('OpenClaw acredita sus siete documentos en un lote y preserva memoria/latido con verify', async () => {
    const workspace = '/home/claw/.openclaw/workspace-kant';
    const memory = `${workspace}/MEMORY.md`;
    const heartbeat = `${workspace}/HEARTBEAT.md`;
    const batch = vi.fn(async (writes: readonly GovernanceBatchWrite[]) => ackFor(writes));
    const prepared = await prepareAgentProfileRuntime(
      probe(
        { harness: 'openclaw', home: '/home/claw', openclawWorkspace: workspace },
        new Map([
          [memory, read('memoria del agente')],
          [heartbeat, read('latido del agente')],
        ]),
        batch,
      ),
      'Steven', 'kant', contexto('kant', 'openclaw'),
    );

    const acks = await prepared.apply();
    const writes = batch.mock.calls[0]?.[0] ?? [];
    expect(writes.map((write) => ({
      name: write.path.slice(write.path.lastIndexOf('/') + 1), mode: write.mode,
    }))).toEqual([
      { name: 'SOUL.md', mode: 'write' },
      { name: 'IDENTITY.md', mode: 'write' },
      { name: 'USER.md', mode: 'write' },
      { name: 'MEMORY.md', mode: 'verify' },
      { name: 'HEARTBEAT.md', mode: 'verify' },
      { name: 'AGENTS.md', mode: 'write' },
      { name: 'TOOLS.md', mode: 'write' },
    ]);
    expect(acks).toHaveLength(7);
    expect(acks.find((ack) => ack.name === 'MEMORY.md')).toMatchObject({
      state: 'preserved', sha: sha('memoria del agente'),
    });
    expect(acks.find((ack) => ack.name === 'HEARTBEAT.md')).toMatchObject({
      state: 'preserved', sha: sha('latido del agente'),
    });
  });

  it('dos alias con HOME compartido escriben sólo en su CODEX_HOME medido', async () => {
    const paths: string[] = [];
    const run = async (alias: string, codexHome: string) => {
      const p = probe(
        { harness: 'codex', home: '/home/dev', codexHome }, new Map(),
        async (writes) => {
          paths.push(...writes.map((write) => write.path));
          return ackFor(writes);
        },
      );
      const prepared = await prepareAgentProfileRuntime(p, 'Steven', alias, contexto(alias, 'codex'));
      await prepared.apply();
    };

    await run('kratos', '/home/dev/.codex-kratos');
    await run('atlas', '/home/dev/.codex-atlas');

    expect(paths).toEqual([
      '/home/dev/.codex-kratos/AGENTS.md', '/home/dev/.codex-atlas/AGENTS.md',
    ]);
  });

  it('un fallo de lote se propaga y no produce un ACK parcial', async () => {
    const prepared = await prepareAgentProfileRuntime(
      probe(
        { harness: 'openclaw', home: '/home/claw', openclawWorkspace: '/home/claw/ws' },
        new Map(),
        async () => ({ error: 'conflict', reason: 'rollback completo' }),
      ),
      'Steven', 'kant', contexto('kant', 'openclaw'),
    );
    await expect(prepared.apply()).rejects.toMatchObject({
      name: 'ProfileRuntimeError', code: 'conflict', message: 'rollback completo',
    });
  });

  it('un bloque de otro alias falla cerrado antes del lote', async () => {
    const path = '/home/dev/.codex/AGENTS.md';
    const foreign = '<!-- CAUCE:PERFIL v1 — generado desde la configuración, no editar dentro de este bloque -->\n'
      + '<!-- alias: Steven/atlas -->\najeno\n<!-- CAUCE:FIN-PERFIL -->';
    await expect(prepareAgentProfileRuntime(
      probe(
        { harness: 'codex', home: '/home/dev' },
        new Map([[path, read(foreign)]]),
        async (writes) => ackFor(writes),
      ),
      'Steven', 'kratos', contexto('kratos', 'codex'),
    )).rejects.toMatchObject({ name: 'ProfileRuntimeError', code: 'conflict' });
  });
});
