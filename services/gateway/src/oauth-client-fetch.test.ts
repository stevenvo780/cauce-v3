import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';
import { describe, expect, it, vi } from 'vitest';
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
