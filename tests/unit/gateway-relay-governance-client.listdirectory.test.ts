import { vi, describe, expect, it, beforeEach } from 'vitest';
const httpsRequest = vi.hoisted(() => vi.fn<(...args: unknown[]) => unknown>());

vi.mock('node:https', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:https')>();
  return { ...actual, request: httpsRequest };
});

import { HttpGovernanceRelayClient, opcionesBase, prepararRespuesta, parseDirectoryOutcome, MEMORY_ROOT, setHttpsRequestMock } from './gateway-relay-governance-client-fixtures.js';

describe('listDirectory: camino feliz y shape', () => {
  beforeEach(() => { httpsRequest.mockReset(); setHttpsRequestMock(httpsRequest); });
  function listingValido(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      path: MEMORY_ROOT,
      total: 1,
      observed_at_least: 1,
      truncated: false,
      entries: [{
        path: `${MEMORY_ROOT}/sesion.md`, bytes: 12, modified_at: '2026-08-24T10:00:00Z',
      }],
      ...overrides,
    };
  }

  it('hace POST a /v3/terminal/relay/list con tenant_id, alias y path', async () => {
    const handles = prepararRespuesta({ statusCode: 200, body: JSON.stringify(listingValido()) });
    const cliente = new HttpGovernanceRelayClient(opcionesBase());

    await cliente.listDirectory('Steven', 'zeus', MEMORY_ROOT);

    const url = handles.captured()?.url as URL;
    expect(url.pathname).toBe('/v3/terminal/relay/list');
  });

  it('acepta metadata absoluta, acotada y coherente', async () => {
    prepararRespuesta({ statusCode: 200, body: JSON.stringify(listingValido()) });
    const cliente = new HttpGovernanceRelayClient(opcionesBase());

    const resultado = await cliente.listDirectory('Steven', 'zeus', MEMORY_ROOT);

    expect(resultado).toEqual(listingValido());
  });

  it('conserva un límite inferior (total=null + truncated=true) cuando el cap impidió el total exacto', async () => {
    const lowerBound = listingValido({ total: null, observed_at_least: 5_000, truncated: true, entries: [] });
    prepararRespuesta({ statusCode: 200, body: JSON.stringify(lowerBound) });
    const cliente = new HttpGovernanceRelayClient(opcionesBase());

    const resultado = await cliente.listDirectory('Steven', 'zeus', MEMORY_ROOT);

    expect(resultado).toEqual(lowerBound);
  });

  it('rechaza con unknown un directorio con más de 200 entradas (MAX_DIRECTORY_ENTRIES)', () => {
    const listing = listingValido({
      total: 201, truncated: true,
      entries: Array.from({ length: 201 }, (_, index) => ({
        path: `${MEMORY_ROOT}/${String(index)}.md`, bytes: index, modified_at: '2026-08-24T10:00:00Z',
      })),
    });
    expect(parseDirectoryOutcome(JSON.stringify(listing))).toMatchObject({ error: 'unknown' });
  });

  it('rechaza con unknown totales incoherentes (total=0 con entries=[] o total=2 con truncated=false)', () => {
    expect(parseDirectoryOutcome(JSON.stringify(listingValido({ total: 0 })))).toMatchObject({ error: 'unknown' });
    expect(parseDirectoryOutcome(JSON.stringify(listingValido({ total: 2, truncated: false })))).toMatchObject({ error: 'unknown' });
    expect(parseDirectoryOutcome(JSON.stringify(listingValido({ total: -1, entries: [] })))).toMatchObject({ error: 'unknown' });
  });

  it('rechaza con unknown entradas con path fuera de la raíz, duplicadas o con fecha inválida', () => {
    const outside = JSON.stringify(listingValido({ entries: [{
      path: `${MEMORY_ROOT}/../auth.json`, bytes: 1, modified_at: '2026-08-24T10:00:00Z',
    }] }));
    expect(parseDirectoryOutcome(outside)).toMatchObject({ error: 'unknown' });

    const collision = JSON.stringify(listingValido({ entries: [{
      path: `${MEMORY_ROOT}-otra/a.md`, bytes: 1, modified_at: '2026-08-24T10:00:00Z',
    }] }));
    expect(parseDirectoryOutcome(collision)).toMatchObject({ error: 'unknown' });

    const dup = JSON.stringify(listingValido({ total: 2, entries: [
      { path: `${MEMORY_ROOT}/a.md`, bytes: 1, modified_at: '2026-08-24T10:00:00Z' },
      { path: `${MEMORY_ROOT}/a.md`, bytes: 1, modified_at: '2026-08-24T10:00:00Z' },
    ] }));
    expect(parseDirectoryOutcome(dup)).toMatchObject({ error: 'unknown' });

    const invalidDate = JSON.stringify(listingValido({ entries: [{
      path: `${MEMORY_ROOT}/a.md`, bytes: 1, modified_at: '2026-02-30T10:00:00Z',
    }] }));
    expect(parseDirectoryOutcome(invalidDate)).toMatchObject({ error: 'unknown' });
  });

  it('rechaza con permission_denied una entrada con basename sensible (credenciales)', () => {
    const credential = JSON.stringify(listingValido({ entries: [{
      path: `${MEMORY_ROOT}/id_ed25519`, bytes: 1, modified_at: '2026-08-24T10:00:00Z',
    }] }));
    expect(parseDirectoryOutcome(credential)).toEqual({
      error: 'permission_denied',
      reason: 'el índice intentó publicar metadata de credenciales',
    });
  });

  it('rechaza con symlink_detected una entrada marcada como symlink', () => {
    const symlink = JSON.stringify(listingValido({ entries: [{
      path: `${MEMORY_ROOT}/a.md`, bytes: 1, modified_at: '2026-08-24T10:00:00Z', symlink: true,
    }] }));
    expect(parseDirectoryOutcome(symlink)).toEqual({
      error: 'symlink_detected',
      reason: 'el índice intentó publicar un enlace simbólico',
    });
  });

  it('rechaza con unknown un cuerpo con campos extra o un fallo deforme', () => {
    expect(parseDirectoryOutcome(JSON.stringify({ ...listingValido(), extra: true }))).toMatchObject({ error: 'unknown' });
    expect(parseDirectoryOutcome(JSON.stringify({
      error: 'timeout', reason: 'tarde', extra: true,
    }))).toEqual({
      error: 'unknown', reason: 'el terminal-relay contestó un fallo de índice inválido',
    });
  });
});

describe('listDirectory: errores de transporte', () => {
  it('permission_denied cuando el relay responde 401 al listado', async () => {
    prepararRespuesta({ statusCode: 401, body: '' });
    const cliente = new HttpGovernanceRelayClient(opcionesBase());

    const resultado = await cliente.listDirectory('Steven', 'zeus', MEMORY_ROOT);

    expect(resultado).toEqual({
      error: 'permission_denied',
      reason: 'el terminal-relay rechazó la credencial del gateway',
    });
  });

  it('timeout cuando el listado vence sin responder', async () => {
    const handles = prepararRespuesta({ statusCode: 200, body: '{}' });
    const cliente = new HttpGovernanceRelayClient(opcionesBase({ timeoutMs: 500 }));

    const pending = cliente.listDirectory('Steven', 'zeus', MEMORY_ROOT);
    handles.triggerTimeout();

    const resultado = await pending;
    expect(resultado).toMatchObject({ error: 'timeout' });
  });

  it('too_large cuando el listado acumulado excede el tope', async () => {
    prepararRespuesta({
      statusCode: 200,
      body: JSON.stringify({
        path: MEMORY_ROOT, total: 1, observed_at_least: 1, truncated: false,
        entries: [], extra: 'a'.repeat(600 * 1024),
      }),
    });
    const cliente = new HttpGovernanceRelayClient(opcionesBase());

    const resultado = await cliente.listDirectory('Steven', 'zeus', MEMORY_ROOT);

    expect(resultado).toMatchObject({ error: 'too_large' });
  });
});
