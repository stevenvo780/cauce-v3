import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';
import { describe, expect, it, vi } from 'vitest';

interface FakeCAresResolver {
  readonly options: unknown;
  cancelled: boolean;
  settle4(addresses: string[]): void;
  settle6(addresses: string[]): void;
}

const { fakeResolverInstances } = vi.hoisted(() => ({ fakeResolverInstances: [] as FakeCAresResolver[] }));

// exercises the real default resolver wired in oauth-client-fetch.ts against a fake c-ares
// Resolver instead of real DNS, so the wiring (constructor options, cancel() on abort, combining
// resolve4 + resolve6) is proven without any network access.
vi.mock('node:dns/promises', () => {
  class MockResolver implements FakeCAresResolver {
    readonly options: unknown;
    cancelled = false;
    private pending4?: { resolve: (addresses: string[]) => void; reject: (error: unknown) => void };
    private pending6?: { resolve: (addresses: string[]) => void; reject: (error: unknown) => void };
    constructor(options: unknown) {
      this.options = options;
      fakeResolverInstances.push(this);
    }
    resolve4(): Promise<string[]> { return new Promise((resolve, reject) => { this.pending4 = { resolve, reject }; }); }
    resolve6(): Promise<string[]> { return new Promise((resolve, reject) => { this.pending6 = { resolve, reject }; }); }
    settle4(addresses: string[]): void { this.pending4?.resolve(addresses); }
    settle6(addresses: string[]): void { this.pending6?.resolve(addresses); }
    cancel(): void {
      this.cancelled = true;
      const error = Object.assign(new Error('queryA ECANCELLED'), { code: 'ECANCELLED' });
      this.pending4?.reject(error);
      this.pending6?.reject(error);
    }
  }
  return { Resolver: MockResolver };
});

import { createOAuthMetadataFetch, publicOAuthAddress } from './oauth-client-fetch.js';

const publicRecord = [{ address: '93.184.216.34', family: 4 }];
type Transport = NonNullable<NonNullable<Parameters<typeof createOAuthMetadataFetch>[0]>['transport']>;
function fixture(statusCode = 200, contentType = 'application/json', body = '{}', encoding?: string) {
  let captured: RequestOptions | undefined;
  const transport: Transport = (_url, options, callback) => {
    captured = options;
    const request = new EventEmitter();
    Object.assign(request, { end: () => {
      const stream = new PassThrough();
      Object.assign(stream, { statusCode, headers: { 'content-type': contentType,
        ...(encoding ? { 'content-encoding': encoding } : {}) } });
      callback(stream as unknown as IncomingMessage);
      stream.end(Buffer.from(body));
    } });
    return request as ReturnType<Transport>;
  };
  return { transport, captured: () => captured };
}

describe('CIMD network boundary with injected transport', () => {
  it.each(['127.0.0.1', '10.0.0.1', '100.64.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1',
    '198.18.0.1', '203.0.113.1', '224.0.0.1', '::1', '::ffff:93.184.216.34', 'fc00::1', '2001:db8::1', '2002::1']) (
    'rejects private, reserved or transitional address %s', (address) => { expect(publicOAuthAddress(address)).toBe(false); },
  );
  it('pins an approved DNS address while preserving TLS hostname verification', async () => {
    const fake = fixture();
    expect(await createOAuthMetadataFetch({ resolve: async () => publicRecord, transport: fake.transport })('https://client.example/doc')).toEqual({ body: '{}' });
    const options = fake.captured();
    expect(options).toMatchObject({ servername: 'client.example', rejectUnauthorized: true, agent: false, family: 4 });
    const callback = vi.fn();
    options?.lookup?.('client.example', { family: 4 }, callback);
    expect(callback).toHaveBeenCalledWith(null, '93.184.216.34', 4);
  });
  it('rejects the whole DNS result if one record is private', async () => {
    const transport = vi.fn<Transport>();
    await expect(createOAuthMetadataFetch({ resolve: async () => [...publicRecord, { address: '127.0.0.1', family: 4 }], transport })('https://client.example/doc')).rejects.toThrow('invalid_client');
    expect(transport).not.toHaveBeenCalled();
  });
  it.each(['https://127.0.0.1/doc', 'https://localhost/doc', 'https://client.example./doc'])('rejects unsafe hosts %s', async (url) => {
    const resolve = vi.fn(async () => publicRecord);
    await expect(createOAuthMetadataFetch({ resolve })(url)).rejects.toThrow('invalid_client');
    expect(resolve).not.toHaveBeenCalled();
  });
  it.each([[302, 'application/json', '{}', undefined], [200, 'text/html', '{}', undefined],
    [200, 'application/json', '{}', 'gzip'], [200, 'application/json', 'x'.repeat(16385), undefined]] as const)(
    'rejects redirects, wrong content, compression or excessive body', async (status, type, body, encoding) => {
      const fake = fixture(status, type, body, encoding);
      await expect(createOAuthMetadataFetch({ resolve: async () => publicRecord, transport: fake.transport })('https://client.example/doc')).rejects.toThrow('invalid_client');
    },
  );
});

describe('DNS lookup cancellation bounds abandoned work', () => {
  it('forwards the shared abort signal to an injected resolver so a losing lookup settles instead of running unbounded', async () => {
    let receivedSignal: AbortSignal | undefined;
    let settledAfterAbort = false;
    const resolve = vi.fn((_hostname: string, signal: AbortSignal) => new Promise<typeof publicRecord>((_resolve, reject) => {
      receivedSignal = signal;
      signal.addEventListener('abort', () => { settledAfterAbort = true; reject(new Error('cancelled')); }, { once: true });
    }));
    await expect(createOAuthMetadataFetch({ resolve, timeoutMs: 20 })('https://client.example/doc')).rejects.toThrow('invalid_client');
    expect(receivedSignal?.aborted).toBe(true);
    expect(settledAfterAbort).toBe(true);
  });
});

describe('default resolver (c-ares) wiring against a fake Resolver', () => {
  it('combines resolve4 and resolve6 results from the real default resolver', async () => {
    fakeResolverInstances.length = 0;
    const fake = fixture();
    const result = createOAuthMetadataFetch({ transport: fake.transport })('https://client.example/doc');
    await Promise.resolve();
    await Promise.resolve();
    const resolver = fakeResolverInstances[0];
    expect(resolver).toBeDefined();
    resolver?.settle4(['93.184.216.34']);
    resolver?.settle6([]);
    await expect(result).resolves.toEqual({ body: '{}' });
    expect(fake.captured()).toMatchObject({ family: 4 });
  });
  it('cancels the real resolver instead of leaving the DNS query to run unbounded when the timeout wins the race', async () => {
    fakeResolverInstances.length = 0;
    await expect(createOAuthMetadataFetch({ timeoutMs: 20 })('https://client.example/doc')).rejects.toThrow('invalid_client');
    const resolver = fakeResolverInstances[0];
    expect(resolver).toBeDefined();
    expect(resolver?.cancelled).toBe(true);
  });
});
