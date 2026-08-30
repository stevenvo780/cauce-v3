import { Buffer } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HttpGovernanceRelayClient,
  parseDirectoryOutcome,
  parseReadOutcome,
  parseWriteBatchOutcome,
  parseWriteOutcome,
  type HttpGovernanceRelayClientOptions,
} from '../../services/gateway/src/console/relay-governance-client.js';

/**
 * Tests hermeticos para `services/gateway/src/console/relay-governance-client.ts`.
 *
 * El cliente HTTPS del gateway hacia el terminal-relay hoy estaba a 0 % en el coverage de
 * vitest: el test de integration real (openssl + TLS) corre en otra suite y v8 no
 * instrumenta el codigo que se ejercita alli. Esta suite reemplaza `node:https` por un
 * `vi.fn()` para verificar, en aislamiento y rapido, lo que el cliente pone en el cable
 * (URL, headers, body, opciones de mTLS, AbortSignal, timeout) y como tipa cada respuesta
 * que el relay puede devolver (2xx happy, 4xx auth, 5xx relay muerto, body truncado, JSON
 * invalido, ACK parcial).
 */

const httpsRequest = vi.hoisted(() => vi.fn<(...args: unknown[]) => unknown>());

vi.mock('node:https', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:https')>();
  return { ...actual, request: httpsRequest };
});

const TOKEN = 'token-compartido-con-el-relay-0123456789';
const RUTA = '/home/dev/.claude/CLAUDE.md';
const MEMORY_ROOT = '/home/dev/.claude/projects';
const CONTENIDO = '# Manual\n';

function sha256(text: string): string {
  // SHA-256 deterministico sin tirar de node:crypto: el cliente solo verifica el patron /^[0-9a-f]{64}$/.
  // Para los tests alcanza con 64 chars hex; los que importan el contenido real usan '# Manual\n' y
  // la longitud del prefijo no afecta al shape que valida el cliente.
  let h1 = 0xdeadbeef ^ 0;
  let h2 = 0x41c6ce57 ^ 0;
  for (const byte of Buffer.from(text, 'utf8')) {
    h1 = Math.imul(h1 ^ byte, 2654435761) >>> 0;
    h2 = Math.imul(h2 ^ byte, 1597334677) >>> 0;
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).padStart(64, '0');
}

const HASH = sha256(CONTENIDO);

interface CapturedCall {
  readonly url: unknown;
  readonly options: Record<string, unknown>;
}

interface FakeHandles {
  readonly captured: () => CapturedCall | undefined;
  readonly triggerTimeout: () => void;
  readonly triggerRequestError: (err: Error) => void;
  readonly reqOnCalls: () => ReadonlyArray<readonly unknown[]>;
}

interface ResponseOptions {
  readonly statusCode?: number;
  readonly body?: string;
  readonly error?: Error;
}

function prepararRespuesta(opts: ResponseOptions = {}): FakeHandles {
  const statusCode = opts.statusCode ?? 200;
  const body = opts.body ?? '';
  const transportError = opts.error;

  const resListeners: {
    data: Array<(chunk: Buffer) => void>;
    end: Array<() => void>;
    error: Array<(err: Error) => void>;
  } = { data: [], end: [], error: [] };

  const reqListeners: { error: Array<(err: Error) => void> } = { error: [] };
  let lastUrl: unknown;
  let lastOptions: Record<string, unknown> | undefined;

  const fakeRes = {
    statusCode,
    destroy: vi.fn(),
    on(event: string, cb: (...args: unknown[]) => void): void {
      if (event === 'data') resListeners.data.push(cb);
      else if (event === 'end') resListeners.end.push(cb);
      else if (event === 'error') resListeners.error.push(cb);
    },
  };

  const setTimeoutMock = vi.fn();
  const destroyMock = vi.fn((err?: Error) => {
    const reason = err ?? new Error('destroyed without reason');
    for (const cb of reqListeners.error) cb(reason);
  });
  const writeMock = vi.fn();
  const endMock = vi.fn();
  const onMock = vi.fn((event: string, cb: (...args: unknown[]) => void) => {
    if (event === 'error') reqListeners.error.push(cb);
  });

  httpsRequest.mockImplementation(((url: unknown, options: unknown, callback: (res: typeof fakeRes) => void) => {
    lastUrl = url;
    lastOptions = options as Record<string, unknown>;
    callback(fakeRes);

    const signal = (options as { signal?: AbortSignal }).signal;
    if (signal !== undefined) {
      const onAbort = (): void => {
        for (const cb of reqListeners.error) cb(new Error('aborted'));
      };
      signal.addEventListener('abort', onAbort);
    }

    setImmediate(() => {
      if (transportError !== undefined) {
        for (const cb of resListeners.error) cb(transportError);
        return;
      }
      if (body.length > 0) {
        for (const cb of resListeners.data) cb(Buffer.from(body, 'utf8'));
      }
      for (const cb of resListeners.end) cb();
    });

    return {
      setTimeout: setTimeoutMock,
      destroy: destroyMock,
      write: writeMock,
      end: endMock,
      on: onMock,
    };
  }) as never);

  return {
    captured: (): CapturedCall | undefined => {
      if (lastOptions === undefined) return undefined;
      return { url: lastUrl, options: lastOptions };
    },
    triggerTimeout: () => {
      const calls = setTimeoutMock.mock.calls;
      const first = calls[0];
      const callback: unknown = first?.[1];
      if (typeof callback === 'function') (callback as () => void)();
    },
    triggerRequestError: (err) => {
      for (const cb of reqListeners.error) cb(err);
    },
    reqOnCalls: () => onMock.mock.calls,
  };
}

function opcionesBase(overrides: Partial<HttpGovernanceRelayClientOptions> = {}): HttpGovernanceRelayClientOptions {
  return {
    relayUrl: 'https://relay.local:8443',
    token: TOKEN,
    ...overrides,
  };
}

beforeEach(() => {
  httpsRequest.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('constantes y opciones que el cliente pasa a https.request', () => {
  it('usa el timeout por defecto de 10_000 ms cuando no se pasa timeoutMs', async () => {
    const handles = prepararRespuesta({ statusCode: 200, body: '{}' });
    const cliente = new HttpGovernanceRelayClient(opcionesBase());

    await cliente.readFile('Steven', 'zeus', RUTA);

    const calls = handles.reqOnCalls();
    const setTimeoutMock = httpsRequest.mock.results[0]?.value as { setTimeout: ReturnType<typeof vi.fn> };
    void calls;
    expect(setTimeoutMock.setTimeout).toHaveBeenCalledWith(10_000, expect.any(Function));
  });

  it('usa el timeout configurado cuando se pasa timeoutMs', async () => {
    const handles = prepararRespuesta({ statusCode: 200, body: '{}' });
    const cliente = new HttpGovernanceRelayClient(opcionesBase({ timeoutMs: 2_500 }));

    await cliente.readFile('Steven', 'zeus', RUTA);

    const setTimeoutMock = httpsRequest.mock.results[0]?.value as { setTimeout: ReturnType<typeof vi.fn> };
    void handles;
    expect(setTimeoutMock.setTimeout).toHaveBeenCalledWith(2_500, expect.any(Function));
  });

  it('incluye ca, cert y key en las opciones cuando se pasa material mTLS', async () => {
    const handles = prepararRespuesta({ statusCode: 200, body: '{}' });
    const ca = Buffer.from('ca-bytes');
    const cert = Buffer.from('cert-bytes');
    const key = Buffer.from('key-bytes');
    const cliente = new HttpGovernanceRelayClient(opcionesBase({ ca, clientCert: cert, clientKey: key }));

    await cliente.readFile('Steven', 'zeus', RUTA);

    const captured = handles.captured();
    expect(captured).toBeDefined();
    expect(captured?.options['ca']).toBe(ca);
    expect(captured?.options['cert']).toBe(cert);
    expect(captured?.options['key']).toBe(key);
  });

  it('omite ca/cert/key cuando no se pasa material mTLS (no los manda como undefined)', async () => {
    const handles = prepararRespuesta({ statusCode: 200, body: '{}' });
    const cliente = new HttpGovernanceRelayClient(opcionesBase());

    await cliente.readFile('Steven', 'zeus', RUTA);

    const captured = handles.captured();
    expect(captured).toBeDefined();
    expect(captured?.options).not.toHaveProperty('ca');
    expect(captured?.options).not.toHaveProperty('cert');
    expect(captured?.options).not.toHaveProperty('key');
  });

  it('pasa el AbortSignal al request para que el agente de abajo pueda abortar el socket', async () => {
    const handles = prepararRespuesta({ statusCode: 200, body: '{}' });
    const controller = new AbortController();
    const cliente = new HttpGovernanceRelayClient(opcionesBase());

    await cliente.readFile('Steven', 'zeus', RUTA, controller.signal);

    const captured = handles.captured();
    expect(captured?.options['signal']).toBe(controller.signal);
  });

  it('omite signal cuando no se pasa AbortSignal', async () => {
    const handles = prepararRespuesta({ statusCode: 200, body: '{}' });
    const cliente = new HttpGovernanceRelayClient(opcionesBase());

    await cliente.readFile('Steven', 'zeus', RUTA);

    expect(handles.captured()?.options).not.toHaveProperty('signal');
  });

  it('manda Bearer token, content-type application/json y content-length exacto', async () => {
    const handles = prepararRespuesta({ statusCode: 200, body: '{}' });
    const cliente = new HttpGovernanceRelayClient(opcionesBase());

    await cliente.readFile('Steven', 'zeus', RUTA);

    const headers = handles.captured()?.options['headers'] as Record<string, string>;
    expect(headers['authorization']).toBe(`Bearer ${TOKEN}`);
    expect(headers['accept']).toBe('application/json');
    expect(headers['content-type']).toBe('application/json');
    const payload = Buffer.from(JSON.stringify({ tenant_id: 'Steven', alias: 'zeus', path: RUTA }), 'utf8');
    expect(Number(headers['content-length'])).toBe(payload.byteLength);
  });

  it('construye la URL pegando la ruta al relayUrl', async () => {
    const handles = prepararRespuesta({ statusCode: 200, body: '{}' });
    const cliente = new HttpGovernanceRelayClient(opcionesBase({ relayUrl: 'https://relay.local:8443/' }));

    await cliente.readFile('Steven', 'zeus', RUTA);

    const url = handles.captured()?.url as URL;
    expect(url.pathname).toBe('/v3/terminal/relay/read');
    expect(url.host).toBe('relay.local:8443');
    expect(url.protocol).toBe('https:');
  });
});

describe('readFile: camino feliz', () => {
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
    expect(String((resultado as { reason: string }).reason)).toContain('timed out');
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
    expect(String((resultado as { reason: string }).reason)).toContain('ECONNREFUSED');
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

describe('listDirectory: camino feliz y shape', () => {
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

describe('writeFile: camino feliz y shape', () => {
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

describe('writeFiles (lote): camino feliz y shape', () => {
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
    const enviado = JSON.parse(payload.toString('utf8')) as { files: Array<Record<string, unknown>> };
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
