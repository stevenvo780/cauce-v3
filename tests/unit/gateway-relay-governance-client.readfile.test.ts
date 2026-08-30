import { vi, describe, expect, it, beforeEach } from 'vitest';
const httpsRequest = vi.hoisted(() => vi.fn<(...args: unknown[]) => unknown>());

vi.mock('node:https', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:https')>();
  return { ...actual, request: httpsRequest };
});

import { HttpGovernanceRelayClient, opcionesBase, prepararRespuesta, parseReadOutcome, CONTENIDO, HASH, RUTA, setHttpsRequestMock } from './gateway-relay-governance-client-fixtures.js';

describe('readFile: camino feliz', () => {
  beforeEach(() => { httpsRequest.mockReset(); setHttpsRequestMock(httpsRequest); });
  it('hace POST a /v3/terminal/relay/read con tenant_id, alias y path', async () => {
    const handles = prepararRespuesta({
      statusCode: 200,
      body: JSON.stringify({
        path: RUTA, bytes: CONTENIDO.length, truncated: false,
        modified_at: '2026-08-24T10:00:00Z', sha: HASH, content: CONTENIDO,
      }),
    });
    const cliente = new HttpGovernanceRelayClient(opcionesBase());

    await cliente.readFile('Steven', 'zeus', RUTA);

    const url = handles.captured()?.url as URL;
    expect(url.pathname).toBe('/v3/terminal/relay/read');
    expect(httpsRequest).toHaveBeenCalledTimes(1);
  });

  it('devuelve la lectura cuando el relay responde 200 con shape completo', async () => {
    prepararRespuesta({
      statusCode: 200,
      body: JSON.stringify({
        path: RUTA, bytes: CONTENIDO.length, truncated: false,
        modified_at: '2026-08-24T10:00:00Z', sha: HASH, content: CONTENIDO,
      }),
    });
    const cliente = new HttpGovernanceRelayClient(opcionesBase());

    const resultado = await cliente.readFile('Steven', 'zeus', RUTA);

    expect(resultado).toEqual({
      path: RUTA,
      bytes: CONTENIDO.length,
      truncated: false,
      modified_at: '2026-08-24T10:00:00Z',
      sha: HASH,
      content: CONTENIDO,
    });
  });

  it('preserva `truncated` y el tamaño REAL aunque el contenido venga recortado', async () => {
    prepararRespuesta({
      statusCode: 200,
      body: JSON.stringify({
        path: RUTA, bytes: 900_000, truncated: true,
        modified_at: '2026-08-24T10:00:00Z', sha: 'a'.repeat(64), content: 'recortado',
      }),
    });
    const cliente = new HttpGovernanceRelayClient(opcionesBase());

    const resultado = await cliente.readFile('Steven', 'zeus', RUTA);

    expect(resultado).toMatchObject({ truncated: true, bytes: 900_000 });
  });
});

describe('readFile: errores tipados', () => {
  it('permission_denied cuando el relay responde 401', async () => {
    prepararRespuesta({ statusCode: 401, body: '' });
    const cliente = new HttpGovernanceRelayClient(opcionesBase());

    const resultado = await cliente.readFile('Steven', 'zeus', RUTA);

    expect(resultado).toEqual({
      error: 'permission_denied',
      reason: 'el terminal-relay rechazó la credencial del gateway',
    });
  });

  it('permission_denied también cuando el relay responde 403', async () => {
    prepararRespuesta({ statusCode: 403, body: '' });
    const cliente = new HttpGovernanceRelayClient(opcionesBase());

    const resultado = await cliente.readFile('Steven', 'zeus', RUTA);

    expect(resultado).toMatchObject({ error: 'permission_denied' });
  });

  it('unavailable con el código en el reason cuando el relay responde 503', async () => {
    prepararRespuesta({ statusCode: 503, body: '{"error":"unavailable"}' });
    const cliente = new HttpGovernanceRelayClient(opcionesBase());

    const resultado = await cliente.readFile('Steven', 'zeus', RUTA);

    expect(resultado).toEqual({
      error: 'unavailable',
      reason: 'el terminal-relay contestó 503',
    });
  });

  it('timeout cuando el request vence sin responder', async () => {
    const handles = prepararRespuesta({ statusCode: 200, body: '{}' });
    const cliente = new HttpGovernanceRelayClient(opcionesBase({ timeoutMs: 1_000 }));

    const pending = cliente.readFile('Steven', 'zeus', RUTA);
    handles.triggerTimeout();

    const resultado = await pending;
    expect(resultado).toMatchObject({ error: 'timeout' });
    expect((resultado as { reason: string }).reason).toContain('timed out');
  });

  it('cancelled cuando el AbortSignal se cierra antes de que el relay termine', async () => {
    prepararRespuesta({ statusCode: 200, body: '{}' });
    const controller = new AbortController();
    const cliente = new HttpGovernanceRelayClient(opcionesBase());

    const pending = cliente.readFile('Steven', 'zeus', RUTA, controller.signal);
    controller.abort();

    const resultado = await pending;
    expect(resultado).toEqual({
      error: 'cancelled',
      reason: 'se cerró la petición antes de terminar la lectura',
    });
  });

  it('unavailable cuando el request emite un error de red (no timed out)', async () => {
    const handles = prepararRespuesta({ statusCode: 200, body: '{}' });
    const cliente = new HttpGovernanceRelayClient(opcionesBase());

    const pending = cliente.readFile('Steven', 'zeus', RUTA);
    handles.triggerRequestError(new Error('ECONNREFUSED'));

    const resultado = await pending;
    expect(resultado).toMatchObject({ error: 'unavailable' });
    expect((resultado as { reason: string }).reason).toContain('ECONNREFUSED');
  });

  it('too_large cuando el cuerpo acumulado excede el tope de 512 KiB', async () => {
    const huge = 'a'.repeat(600 * 1024);
    prepararRespuesta({
      statusCode: 200,
      body: JSON.stringify({
        path: RUTA, bytes: huge.length, truncated: false,
        modified_at: '2026-08-24T10:00:00Z', sha: 'a'.repeat(64), content: huge,
      }),
    });
    const cliente = new HttpGovernanceRelayClient(opcionesBase());

    const resultado = await cliente.readFile('Steven', 'zeus', RUTA);

    expect(resultado).toEqual({
      error: 'too_large',
      reason: 'el terminal-relay mandó más de lo que esta vía acepta',
    });
  });
});

describe('readFile: shape del cuerpo (parseReadOutcome)', () => {
  it('unknown cuando el cuerpo no es JSON', () => {
    expect(parseReadOutcome('<html>vaya</html>')).toEqual({
      error: 'unknown', reason: 'el terminal-relay contestó algo que no es JSON',
    });
  });

  it('unknown cuando el cuerpo no es un objeto (es un array)', () => {
    expect(parseReadOutcome(JSON.stringify(['path', 'content']))).toEqual({
      error: 'unknown', reason: 'el terminal-relay contestó algo que no es un objeto',
    });
  });

  it('unknown cuando faltan path/modified_at/content/sha', () => {
    const body = JSON.stringify({ bytes: 9, truncated: false });
    expect(parseReadOutcome(body)).toEqual({
      error: 'unknown', reason: 'la lectura vino sin ruta, fecha, contenido o huella SHA-256',
    });
  });

  it('unknown cuando `bytes` no es entero no negativo', () => {
    const body = JSON.stringify({
      path: RUTA, modified_at: '2026-08-24T10:00:00Z', sha: HASH, content: CONTENIDO, truncated: false,
    });
    expect(parseReadOutcome(body)).toEqual({
      error: 'unknown', reason: 'la lectura vino sin un tamaño creíble',
    });
  });

  it('unknown cuando `truncated` no es booleano', () => {
    const body = JSON.stringify({
      path: RUTA, bytes: 9, modified_at: '2026-08-24T10:00:00Z', sha: HASH, content: CONTENIDO,
    });
    expect(parseReadOutcome(body)).toEqual({
      error: 'unknown', reason: 'la lectura no dice si viene recortada',
    });
  });

  it('unknown cuando el sha no encaja en el patrón SHA-256 hex de 64 chars', () => {
    const body = JSON.stringify({
      path: RUTA, bytes: 9, truncated: false,
      modified_at: '2026-08-24T10:00:00Z', sha: 'no-es-sha', content: CONTENIDO,
    });
    expect(parseReadOutcome(body)).toEqual({
      error: 'unknown', reason: 'la lectura no trae una huella SHA-256 válida',
    });
  });

  it('propaga un código de error que sí reconoce (symlink_detected) tal cual', () => {
    const body = JSON.stringify({ error: 'symlink_detected', reason: 'apunta fuera' });
    expect(parseReadOutcome(body)).toEqual({ error: 'symlink_detected', reason: 'apunta fuera' });
  });

  it('convierte en `unknown` un código de error que NO reconoce, conservando el reason', () => {
    const body = JSON.stringify({ error: 'te_lo_invento', reason: 'lo que sea' });
    expect(parseReadOutcome(body)).toEqual({ error: 'unknown', reason: 'lo que sea' });
  });

  it('rellena el reason genérico cuando el relay solo manda `error`', () => {
    const body = JSON.stringify({ error: 'busy' });
    expect(parseReadOutcome(body)).toEqual({
      error: 'busy', reason: 'el terminal-relay no explicó el fallo',
    });
  });
});
