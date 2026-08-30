// Shared fixtures for relay-governance-client test files.
// Not a test file: not picked up by vitest.

import { type HttpGovernanceRelayClientOptions } from '../../services/gateway/src/console/relay-governance-client.js';
export {
  HttpGovernanceRelayClient,
  parseDirectoryOutcome,
  parseReadOutcome,
  parseWriteBatchOutcome,
  parseWriteOutcome,
} from '../../services/gateway/src/console/relay-governance-client.js';
import { Buffer } from 'node:buffer';
import { vi } from 'vitest';

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

let httpsRequestMock: ReturnType<typeof vi.fn<(...args: unknown[]) => unknown>> | undefined;

export function setHttpsRequestMock(m: ReturnType<typeof vi.fn<(...args: unknown[]) => unknown>>): void {
  httpsRequestMock = m;
}

function requireMock(): ReturnType<typeof vi.fn<(...args: unknown[]) => unknown>> {
  if (httpsRequestMock === undefined) {
    throw new Error('httpsRequest mock not initialized; call setHttpsRequestMock first');
  }
  return httpsRequestMock;
}

export const TOKEN = 'token-compartido-con-el-relay-0123456789';
export const RUTA = '/home/dev/.claude/CLAUDE.md';
export const MEMORY_ROOT = '/home/dev/.claude/projects';
export const CONTENIDO = '# Manual\n';

export function sha256(text: string): string {
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

export const HASH = sha256(CONTENIDO);

export interface CapturedCall {
  readonly url: unknown;
  readonly options: Record<string, unknown>;
}

export interface FakeHandles {
  readonly captured: () => CapturedCall | undefined;
  readonly triggerTimeout: () => void;
  readonly triggerRequestError: (err: Error) => void;
  readonly reqOnCalls: () => readonly (readonly unknown[])[];
}

export interface ResponseOptions {
  readonly statusCode?: number;
  readonly body?: string;
  readonly error?: Error;
}

export function prepararRespuesta(opts: ResponseOptions = {}): FakeHandles {
  const statusCode = opts.statusCode ?? 200;
  const body = opts.body ?? '';
  const transportError = opts.error;
  const httpsRequest = requireMock();

  const resListeners: {
    data: ((chunk: Buffer) => void)[];
    end: (() => void)[];
    error: ((err: Error) => void)[];
  } = { data: [], end: [], error: [] };

  const reqListeners: { error: ((err: Error) => void)[] } = { error: [] };
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

export function opcionesBase(overrides: Partial<HttpGovernanceRelayClientOptions> = {}): HttpGovernanceRelayClientOptions {
  return {
    relayUrl: 'https://relay.local:8443',
    token: TOKEN,
    ...overrides,
  };
}
