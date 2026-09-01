import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ficherosDelArnes, type ContextoDeAlias } from '@cauce/protocol';
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
  withGeneration = true,
): AgentFactsProbe {
  const measured: RuntimeFacts = {
    ...(withGeneration ? { generation: 'gen-1' } : {}), containerId: 'ws-test', ...facts,
  };
  const live = new Map(reads);
  return {
    factsFor: async () => ({ facts: measured, source: 'measured' }),
    readGovernanceDocument: async (path) => live.get(path)
      ?? { error: 'not_found', reason: 'no existe' },
    listMemoryDirectory: async () => ({ error: 'unavailable', reason: 'no aplica' }),
    writeGovernanceBatch: async (writes) => {
      const result = await batch(writes);
      if (Array.isArray(result)) {
        for (const write of writes) {
          if (write.mode === 'write') live.set(write.path, read(write.content));
        }
      }
      return result;
    },
  };
}

async function prepareRevision(
  p: AgentFactsProbe,
  tenantId: string,
  alias: string,
  context: ContextoDeAlias,
  revision = 7,
) {
  return (await prepareAgentProfileRuntime(p, tenantId, alias, context)).materialize(revision);
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
    const prepared = await prepareRevision(
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
    expect(write.content).not.toContain('CAUCE:REVISION-PERFIL');
    expect(acks).toEqual([{
      name: 'AGENTS.md', path, state: 'written',
      sha: sha(write.content), bytes: Buffer.byteLength(write.content, 'utf8'),
      generation: 'gen-1', container_id: 'ws-test',
    }]);
    await expect(prepared.apply()).rejects.toMatchObject({ code: 'conflict' });
    expect(batch).toHaveBeenCalledOnce();
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
    const prepared = await prepareRevision(
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
    const agentsWrite = writes.find((write) => write.path.endsWith('/AGENTS.md'));
    expect(agentsWrite?.mode).toBe('write');
    if (agentsWrite?.mode !== 'write') throw new Error('AGENTS.md no se materializó');
    expect(agentsWrite.content).toContain('<!-- CAUCE:REVISION-PERFIL v1 revision=7 -->');
    for (const write of writes) {
      if (write.mode === 'write' && !write.path.endsWith('/AGENTS.md')) {
        expect(write.content).not.toContain('CAUCE:REVISION-PERFIL');
      }
    }
    expect(acks).toHaveLength(7);
    expect(acks.find((ack) => ack.name === 'MEMORY.md')).toMatchObject({
      state: 'preserved', sha: sha('memoria del agente'),
    });
    expect(acks.find((ack) => ack.name === 'HEARTBEAT.md')).toMatchObject({
      state: 'preserved', sha: sha('latido del agente'),
    });
  });

  it('MEMORY.md grande se acredita por SHA/tamaño sin copiar ni reescribir su prefijo', async () => {
    const workspace = '/home/claw/.openclaw/workspace-kant';
    const memory = `${workspace}/MEMORY.md`;
    const prefix = 'memoria visible'.repeat(100);
    const fullBytes = 900_000;
    const fullSha = 'd'.repeat(64);
    const batch = vi.fn(async (writes: readonly GovernanceBatchWrite[]) => ackFor(writes));
    const prepared = await prepareRevision(
      probe(
        { harness: 'openclaw', home: '/home/claw', openclawWorkspace: workspace },
        new Map([[memory, read(prefix, {
          truncated: true, bytes: fullBytes, sha: fullSha,
        })]]),
        batch,
      ),
      'Steven', 'kant', contexto('kant', 'openclaw'),
    );

    const memoryPreview = prepared.preview.find((file) => file.nombre === 'MEMORY.md');
    expect(memoryPreview).toMatchObject({ politica: 'solo-si-falta', texto: '' });
    expect(prepared.verification.documents.find((file) => file.name === 'MEMORY.md')).toMatchObject({
      expected_sha: fullSha, observed_sha: fullSha,
      expected_bytes: fullBytes, observed_bytes: fullBytes, current: true,
    });

    const acknowledgements = await prepared.apply();
    const memoryWrite = batch.mock.calls[0]?.[0].find((write) => write.path === memory);
    expect(memoryWrite).toEqual({
      mode: 'verify', path: memory, precondition: { state: 'present', sha256: fullSha },
    });
    expect(acknowledgements.find((ack) => ack.name === 'MEMORY.md')).toMatchObject({
      state: 'preserved', sha: fullSha, bytes: fullBytes,
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
      const prepared = await prepareRevision(p, 'Steven', alias, contexto(alias, 'codex'));
      await prepared.apply();
    };

    await run('kratos', '/home/dev/.codex-kratos');
    await run('atlas', '/home/dev/.codex-atlas');

    expect(paths).toEqual([
      '/home/dev/.codex-kratos/AGENTS.md', '/home/dev/.codex-atlas/AGENTS.md',
    ]);
  });

  it('un fallo de lote se propaga y no produce un ACK parcial', async () => {
    const prepared = await prepareRevision(
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
      + '<!-- alias: Steven/atlas -->\najeno\n<!-- alias: Steven/kratos -->\n'
      + '<!-- CAUCE:FIN-PERFIL -->';
    await expect(prepareAgentProfileRuntime(
      probe(
        { harness: 'codex', home: '/home/dev' },
        new Map([[path, read(foreign)]]),
        async (writes) => ackFor(writes),
      ),
      'Steven', 'kratos', contexto('kratos', 'codex'),
    )).rejects.toMatchObject({ name: 'ProfileRuntimeError', code: 'conflict' });
  });

  it('una topología gestionada solapada falla antes del CAS y del lote', async () => {
    const path = '/home/dev/.claude/CLAUDE.md';
    const overlapping = '<!-- CAUCE:CONTEXTO-FIJO v1 — generado, no editar dentro de este bloque -->\n'
      + '<!-- CAUCE:PERFIL v1 — generado desde la configuración, no editar dentro de este bloque -->\n'
      + '<!-- alias: Steven/kant -->\n<!-- CAUCE:FIN-CONTEXTO-FIJO -->\n'
      + '<!-- CAUCE:FIN-PERFIL -->\n';
    const batch = vi.fn(async (writes: readonly GovernanceBatchWrite[]) => ackFor(writes));
    await expect(prepareAgentProfileRuntime(
      probe(
        { harness: 'claude', home: '/home/dev' },
        new Map([[path, read(overlapping)]]),
        batch,
      ),
      'Steven', 'kant', contexto('kant', 'claude'),
    )).rejects.toMatchObject({ name: 'ProfileRuntimeError', code: 'conflict' });
    expect(batch).not.toHaveBeenCalled();
  });

  it('una foto de runtime sólo permite aplicar una de sus materializaciones', async () => {
    const path = '/home/dev/.codex/AGENTS.md';
    const batch = vi.fn(async (writes: readonly GovernanceBatchWrite[]) => ackFor(writes));
    const preflight = await prepareAgentProfileRuntime(
      probe(
        { harness: 'codex', home: '/home/dev' },
        new Map([[path, read('# manual\n')]]),
        batch,
      ),
      'Steven', 'kant', contexto('kant', 'codex'),
    );
    const revisionDos = preflight.materialize(2);
    const revisionTres = preflight.materialize(3);

    await revisionDos.apply();
    await expect(revisionTres.apply()).rejects.toMatchObject({ code: 'conflict' });
    expect(batch).toHaveBeenCalledOnce();
  });

  it('GET puede distinguir bytes actuales de drift sin escribir nada', async () => {
    const path = '/home/dev/.codex/AGENTS.md';
    const batch = vi.fn(async (writes: readonly GovernanceBatchWrite[]) => ackFor(writes));
    const prepared = await prepareRevision(
      probe(
        { harness: 'codex', home: '/home/dev' },
        new Map([[path, read('# manual\n')]]),
        batch,
      ),
      'Steven', 'kant', contexto('kant', 'codex'),
    );

    expect(prepared.verification).toMatchObject({
      state: 'drifted', generation: 'gen-1', container_id: 'ws-test',
      documents: [{ name: 'AGENTS.md', path, current: false, observed_sha: sha('# manual\n') }],
    });
    expect(prepared.preview[0]?.texto).toContain('# manual');
    expect(batch).not.toHaveBeenCalled();
  });

  it('editar texto manual fuera del bloque conserva el perfil current', async () => {
    const path = '/home/dev/.claude/CLAUDE.md';
    const ctx = contexto('zeus', 'claude');
    const projected = ficherosDelArnes(
      'claude', ctx, new Map([['CLAUDE.md', '# manual anterior\n']]), { revision: 7 },
    )[0]?.texto;
    if (projected === undefined) throw new Error('CLAUDE.md no se proyectó');
    const manuallyEdited = projected.replace('# manual anterior', '# manual actualizado');
    const batch = vi.fn(async (writes: readonly GovernanceBatchWrite[]) => ackFor(writes));

    const prepared = await prepareRevision(
      probe(
        { harness: 'claude', home: '/home/dev' },
        new Map([[path, read(manuallyEdited)]]),
        batch,
      ),
      'Steven', 'zeus', ctx,
    );

    expect(prepared.verification).toMatchObject({
      state: 'current',
      documents: [{ name: 'CLAUDE.md', current: true, observed_sha: sha(manuallyEdited) }],
    });
    expect(prepared.preview[0]?.texto).toBe(manuallyEdited);
    expect(batch).not.toHaveBeenCalled();
  });

  it('sin generación permite inspeccionar pero se niega a afirmar applied o escribir', async () => {
    const path = '/home/dev/.codex/AGENTS.md';
    const p = probe(
      { harness: 'codex', home: '/home/dev' },
      new Map([[path, read('# manual\n')]]),
      async (writes) => ackFor(writes),
      false,
    );
    const prepared = await prepareRevision(p, 'Steven', 'kant', contexto('kant', 'codex'));

    expect(prepared.verification.state).toBe('unverified');
    await expect(prepared.apply()).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('un recreate entre write y relectura invalida el ACK de la generación anterior', async () => {
    const path = '/home/dev/.codex/AGENTS.md';
    let calls = 0;
    const live = new Map<string, GovernanceDocumentContent | GovernanceReadError>([
      [path, read('# manual\n')],
    ]);
    const p: AgentFactsProbe = {
      factsFor: async () => ({
        facts: {
          harness: 'codex', home: '/home/dev', generation: calls++ === 0 ? 'gen-1' : 'gen-2',
          containerId: 'ws-test',
        },
        source: 'measured',
      }),
      readGovernanceDocument: async (candidate) => live.get(candidate)
        ?? { error: 'not_found', reason: 'no existe' },
      listMemoryDirectory: async () => ({ error: 'unavailable', reason: 'no aplica' }),
      writeGovernanceBatch: async (writes) => {
        for (const write of writes) if (write.mode === 'write') live.set(write.path, read(write.content));
        return ackFor(writes);
      },
    };
    const prepared = await prepareRevision(p, 'Steven', 'kant', contexto('kant', 'codex'));

    await expect(prepared.apply()).rejects.toMatchObject({ code: 'conflict' });
  });
});
