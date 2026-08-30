import { vi, describe, expect, it, beforeEach } from 'vitest';
const httpsRequest = vi.hoisted(() => vi.fn<(...args: unknown[]) => unknown>());

vi.mock('node:https', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:https')>();
  return { ...actual, request: httpsRequest };
});

import { HttpGovernanceRelayClient, opcionesBase, prepararRespuesta, parseWriteOutcome, RUTA, setHttpsRequestMock } from './gateway-relay-governance-client-fixtures.js';

describe('writeFile: camino feliz y shape', () => {
  beforeEach(() => { httpsRequest.mockReset(); setHttpsRequestMock(httpsRequest); });
  it('manda POST a /write con content_base64 y la precondición exacta', async () => {
    const nuevo = '# nuevo\nacción\n';
    const nuevoB64 = Buffer.from(nuevo, 'utf8').toString('base64');
    const handles = prepararRespuesta({
      statusCode: 200,
      body: JSON.stringify({
        path: RUTA, operation: 'replace', sha: 'a'.repeat(64), bytes: Buffer.byteLength(nuevo),
      }),
    });
    const cliente = new HttpGovernanceRelayClient(opcionesBase());

    await cliente.writeFile(
      'Steven', 'zeus', RUTA, nuevo, { state: 'present', sha256: 'a'.repeat(64) },
    );

    const url = handles.captured()?.url as URL;
    expect(url.pathname).toBe('/v3/terminal/relay/write');
    const writeCall = httpsRequest.mock.results[0]?.value as { write: ReturnType<typeof vi.fn> };
    const payload = writeCall.write.mock.calls[0]?.[0] as Buffer;
    expect(JSON.parse(payload.toString('utf8'))).toEqual({
      tenant_id: 'Steven', alias: 'zeus', path: RUTA,
      content_base64: nuevoB64,
      precondition: { state: 'present', sha256: 'a'.repeat(64) },
    });
  });

  it('propaga conflict del relay tal cual', async () => {
    prepararRespuesta({ statusCode: 200, body: JSON.stringify({ error: 'conflict', reason: 'la huella cambió' }) });
    const cliente = new HttpGovernanceRelayClient(opcionesBase());

    const resultado = await cliente.writeFile(
      'Steven', 'zeus', RUTA, 'x', { state: 'present', sha256: 'a'.repeat(64) },
    );

    expect(resultado).toEqual({ error: 'conflict', reason: 'la huella cambió' });
  });

  it('una creación viaja como absent y el ACK operation=create pasa tal cual', async () => {
    prepararRespuesta({
      statusCode: 200,
      body: JSON.stringify({ path: RUTA, operation: 'create', sha: 'a'.repeat(64), bytes: 1 }),
    });
    const cliente = new HttpGovernanceRelayClient(opcionesBase());

    const resultado = await cliente.writeFile(
      'Steven', 'zeus', RUTA, 'x', { state: 'absent' },
    );

    expect(resultado).toMatchObject({ operation: 'create', bytes: 1 });
  });

  it('unknown cuando el ACK de 2xx no trae operation válida (replace|create)', () => {
    expect(parseWriteOutcome(JSON.stringify({
      path: RUTA, operation: 'merge', sha: 'a'.repeat(64), bytes: 1,
    }))).toEqual({
      error: 'unknown',
      reason: 'el ACK de escritura vino sin ruta u operación válida',
    });
  });

  it('unknown cuando el ACK de 2xx no trae SHA-256 válido', () => {
    expect(parseWriteOutcome(JSON.stringify({
      path: RUTA, operation: 'replace', sha: 'no-es-sha', bytes: 1,
    }))).toEqual({
      error: 'unknown',
      reason: 'el ACK de escritura vino sin una huella SHA-256 válida',
    });
  });

  it('unknown cuando el ACK tiene bytes negativos', () => {
    expect(parseWriteOutcome(JSON.stringify({
      path: RUTA, operation: 'replace', sha: 'a'.repeat(64), bytes: -1,
    }))).toEqual({
      error: 'unknown',
      reason: 'el ACK de escritura vino sin un tamaño creíble',
    });
  });

  it('unknown cuando el ACK 2xx no es JSON', () => {
    expect(parseWriteOutcome('<html>')).toEqual({
      error: 'unknown',
      reason: 'el terminal-relay contestó algo que no es JSON',
    });
  });

  it('unavailable en 503 desde writeFile', async () => {
    prepararRespuesta({ statusCode: 503, body: '' });
    const cliente = new HttpGovernanceRelayClient(opcionesBase());

    const resultado = await cliente.writeFile(
      'Steven', 'zeus', RUTA, 'x', { state: 'absent' },
    );

    expect(resultado).toEqual({
      error: 'unavailable',
      reason: 'el terminal-relay contestó 503',
    });
  });
});
