import { vi, describe, expect, it, beforeEach } from 'vitest';
const httpsRequest = vi.hoisted(() => vi.fn<(...args: unknown[]) => unknown>());

vi.mock('node:https', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:https')>();
  return { ...actual, request: httpsRequest };
});

import { HttpGovernanceRelayClient, opcionesBase, prepararRespuesta, parseWriteBatchOutcome, setHttpsRequestMock } from './gateway-relay-governance-client-fixtures.js';

describe('writeFiles (lote): camino feliz y shape', () => {
  beforeEach(() => { httpsRequest.mockReset(); setHttpsRequestMock(httpsRequest); });
  it('manda POST a /write-batch con la lista de files y content_base64 solo en mode=write', async () => {
    const soul = '/home/claw/workspace/SOUL.md';
    const agents = '/home/claw/workspace/AGENTS.md';
    const handles = prepararRespuesta({
      statusCode: 200,
      body: JSON.stringify({ files: [
        { path: soul, operation: 'create', sha: 'a'.repeat(64), bytes: 4 },
        { path: agents, operation: 'replace', sha: 'b'.repeat(64), bytes: 6 },
      ] }),
    });
    const cliente = new HttpGovernanceRelayClient(opcionesBase());

    await cliente.writeFiles('Steven', 'jarvis', [
      { mode: 'write', path: soul, content: 'alma', precondition: { state: 'absent' } },
      { mode: 'write', path: agents, content: 'reglas', precondition: { state: 'present', sha256: 'c'.repeat(64) } },
    ]);

    const url = handles.captured()?.url as URL;
    expect(url.pathname).toBe('/v3/terminal/relay/write-batch');
    const writeCall = httpsRequest.mock.results[0]?.value as { write: ReturnType<typeof vi.fn> };
    const payload = writeCall.write.mock.calls[0]?.[0] as Buffer;
    expect(JSON.parse(payload.toString('utf8'))).toEqual({
      tenant_id: 'Steven', alias: 'jarvis',
      files: [
        { mode: 'write', path: soul, content_base64: Buffer.from('alma').toString('base64'), precondition: { state: 'absent' } },
        { mode: 'write', path: agents, content_base64: Buffer.from('reglas').toString('base64'),
          precondition: { state: 'present', sha256: 'c'.repeat(64) } },
      ],
    });
  });

  it('manda verify sin content_base64 y acepta unchanged con sha preservado', async () => {
    const memory = '/home/claw/workspace/MEMORY.md';
    const before = 'd'.repeat(64);
    prepararRespuesta({
      statusCode: 200,
      body: JSON.stringify({ files: [
        { path: memory, operation: 'unchanged', sha: before, bytes: 123 },
      ] }),
    });
    const cliente = new HttpGovernanceRelayClient(opcionesBase());

    const resultado = await cliente.writeFiles('Steven', 'jarvis', [{
      mode: 'verify', path: memory, precondition: { state: 'present', sha256: before },
    }]);

    expect(resultado).toEqual({ files: [{ path: memory, operation: 'unchanged', sha: before, bytes: 123 }] });
    const writeCall = httpsRequest.mock.results[0]?.value as { write: ReturnType<typeof vi.fn> };
    const payload = writeCall.write.mock.calls[0]?.[0] as Buffer;
    const enviado = JSON.parse(payload.toString('utf8')) as { files: Record<string, unknown>[] };
    expect(enviado.files[0]).not.toHaveProperty('content_base64');
    expect(enviado.files[0]).toMatchObject({
      mode: 'verify', path: memory, precondition: { state: 'present', sha256: before },
    });
  });

  it('rechaza un lote con files vacío', () => {
    expect(parseWriteBatchOutcome(JSON.stringify({ files: [] }))).toMatchObject({ error: 'unknown' });
  });

  it('rechaza un lote con más de 7 ficheros', () => {
    const acks = Array.from({ length: 8 }, (_, index) => ({
      path: `/tmp/file-${String(index)}.md`, operation: 'create', sha: 'a'.repeat(64), bytes: 1,
    }));
    expect(parseWriteBatchOutcome(JSON.stringify({ files: acks }))).toMatchObject({ error: 'unknown' });
  });

  it('rechaza un lote con paths duplicados en el ACK', () => {
    const soul = '/home/claw/workspace/SOUL.md';
    expect(parseWriteBatchOutcome(JSON.stringify({ files: [
      { path: soul, operation: 'create', sha: 'a'.repeat(64), bytes: 4 },
      { path: soul, operation: 'create', sha: 'a'.repeat(64), bytes: 4 },
    ] }))).toMatchObject({ error: 'unknown' });
  });

  it('rechaza un ACK absent con sha no null (la huella del ausente es null, no cero)', () => {
    expect(parseWriteBatchOutcome(JSON.stringify({ files: [
      { path: '/tmp/x.md', operation: 'absent', sha: 'a'.repeat(64), bytes: 0 },
    ] }))).toMatchObject({ error: 'unknown' });
  });

  it('acepta un ACK absent con sha=null y bytes=0', () => {
    expect(parseWriteBatchOutcome(JSON.stringify({ files: [
      { path: '/tmp/x.md', operation: 'absent', sha: null, bytes: 0 },
    ] }))).toEqual({ files: [{ path: '/tmp/x.md', operation: 'absent', sha: null, bytes: 0 }] });
  });

  it('rechaza un ACK con operation que no está en el set cerrado', () => {
    expect(parseWriteBatchOutcome(JSON.stringify({ files: [
      { path: '/tmp/x.md', operation: 'merge', sha: 'a'.repeat(64), bytes: 1 },
    ] }))).toMatchObject({ error: 'unknown' });
  });

  it('propaga conflict del lote tal cual', () => {
    expect(parseWriteBatchOutcome(JSON.stringify({
      error: 'conflict', reason: 'el lote entró en conflicto',
    }))).toEqual({ error: 'conflict', reason: 'el lote entró en conflicto' });
  });
});

describe('writeFiles (lote): errores de transporte', () => {
  it('permission_denied cuando el relay responde 401 al lote', async () => {
    prepararRespuesta({ statusCode: 401, body: '' });
    const cliente = new HttpGovernanceRelayClient(opcionesBase());

    const resultado = await cliente.writeFiles('Steven', 'jarvis', [
      { mode: 'write', path: '/tmp/x.md', content: 'y', precondition: { state: 'absent' } },
    ]);

    expect(resultado).toMatchObject({ error: 'permission_denied' });
  });

  it('timeout cuando el lote vence sin responder', async () => {
    const handles = prepararRespuesta({ statusCode: 200, body: '{}' });
    const cliente = new HttpGovernanceRelayClient(opcionesBase({ timeoutMs: 500 }));

    const pending = cliente.writeFiles('Steven', 'jarvis', [
      { mode: 'write', path: '/tmp/x.md', content: 'y', precondition: { state: 'absent' } },
    ]);
    handles.triggerTimeout();

    const resultado = await pending;
    expect(resultado).toMatchObject({ error: 'timeout' });
  });

  it('too_large cuando el ACK del lote acumulado excede el tope', async () => {
    prepararRespuesta({
      statusCode: 200,
      body: JSON.stringify({
        files: [{ path: '/tmp/x.md', operation: 'create', sha: 'a'.repeat(64), bytes: 1 }],
        extra: 'a'.repeat(600 * 1024),
      }),
    });
    const cliente = new HttpGovernanceRelayClient(opcionesBase());

    const resultado = await cliente.writeFiles('Steven', 'jarvis', [
      { mode: 'write', path: '/tmp/x.md', content: 'y', precondition: { state: 'absent' } },
    ]);

    expect(resultado).toMatchObject({ error: 'too_large' });
  });
});
