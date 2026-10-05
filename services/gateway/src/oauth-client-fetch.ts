import { Resolver as CaresResolver } from 'node:dns/promises';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { BlockList, isIP } from 'node:net';
import type { IncomingMessage } from 'node:http';
import { OAuthError, httpsUrl } from './oauth-authorization-types.js';

const denied = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 3],
] as const) denied.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16]] as const) {
  denied.addSubnet(address, prefix, 'ipv6');
}

export function publicOAuthAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !denied.check(address, 'ipv4');
  if (family !== 6 || !/^[23][0-9a-f]{3}:/iu.test(address)) return false;
  return !denied.check(address, 'ipv6');
}

export interface OAuthMetadataResponse {
  readonly body: string;
  readonly cacheControl?: string;
}

export type OAuthMetadataFetch = (url: string) => Promise<OAuthMetadataResponse>;
type Resolver = (hostname: string, signal: AbortSignal) => Promise<readonly { address: string; family: number }[]>;
type Transport = (url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => ReturnType<typeof httpsRequest>;

const RESOLVER_QUERY_TIMEOUT_MS = 1500;
const RESOLVER_QUERY_TRIES = 2;

// c-ares (dns.promises.Resolver) resolves off the libuv threadpool, unlike dns.lookup's getaddrinfo.
// resolver.cancel() on abort frees the in-flight query instead of leaving it to run to completion.
const resolveWithCAres: Resolver = async (hostname, signal) => {
  const resolver = new CaresResolver({ timeout: RESOLVER_QUERY_TIMEOUT_MS, tries: RESOLVER_QUERY_TRIES });
  const cancel = () => { resolver.cancel(); };
  if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true });
  try {
    const [v4, v6] = await Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]);
    const addresses: { address: string; family: number }[] = [];
    if (v4.status === 'fulfilled') for (const address of v4.value) addresses.push({ address, family: 4 });
    if (v6.status === 'fulfilled') for (const address of v6.value) addresses.push({ address, family: 6 });
    if (!addresses.length) throw (v4.status === 'rejected' ? v4.reason : v6.status === 'rejected' ? v6.reason : new OAuthError('invalid_client'));
    return addresses;
  } finally {
    signal.removeEventListener('abort', cancel);
  }
};

export function createOAuthMetadataFetch(options: { resolve?: Resolver; transport?: Transport; timeoutMs?: number } = {}): OAuthMetadataFetch {
  const resolve = options.resolve ?? resolveWithCAres;
  const transport = options.transport ?? httpsRequest;
  const timeoutMs = options.timeoutMs ?? 3000;
  return async (value) => {
    const url = httpsUrl(value);
    if (isIP(url.hostname) || url.hostname.includes(':') || !url.hostname.includes('.')
        || url.hostname.endsWith('.')) throw new OAuthError('invalid_client');
    const signal = AbortSignal.timeout(timeoutMs);
    const lookup = resolve(url.hostname, signal);
    // the dedicated abort listener below may lose the race against `lookup` settling with its own
    // reason first (a resolver that reacts to the signal itself); either way normalize to invalid_client
    // here instead of leaking that reason, and consume it so losing the race never surfaces as unhandled.
    lookup.catch(() => undefined);
    let addresses: readonly { address: string; family: number }[];
    try {
      addresses = await Promise.race([
        lookup,
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => { reject(new OAuthError('invalid_client')); }, { once: true });
        }),
      ]);
    } catch { throw new OAuthError('invalid_client'); }
    signal.throwIfAborted();
    if (!addresses.length || addresses.length > 16
        || addresses.some((item) => !publicOAuthAddress(item.address) || isIP(item.address) !== item.family)) {
      throw new OAuthError('invalid_client');
    }
    const selected = addresses[0];
    if (!selected) throw new OAuthError('invalid_client');
    return new Promise<OAuthMetadataResponse>((resolve, reject) => {
      const request = transport(url, {
        agent: false, servername: url.hostname, rejectUnauthorized: true, signal, maxHeaderSize: 8192,
        family: selected.family,
        headers: { accept: 'application/json', 'accept-encoding': 'identity' },
        lookup: (_host, _options, callback) => { callback(null, selected.address, selected.family); },
      }, (response) => {
        const contentType = response.headers['content-type']?.split(';')[0]?.trim().toLowerCase();
        if (response.statusCode !== 200 || contentType !== 'application/json'
            || (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')) {
          response.destroy();
          reject(new OAuthError('invalid_client'));
          return;
        }
        let size = 0;
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 16384) {
            response.destroy();
            reject(new OAuthError('invalid_client'));
          } else chunks.push(chunk);
        });
        response.on('error', () => { reject(new OAuthError('invalid_client')); });
        response.on('aborted', () => { reject(new OAuthError('invalid_client')); });
        response.on('end', () => {
          resolve({ body: Buffer.concat(chunks).toString('utf8'),
            ...(response.headers['cache-control'] ? { cacheControl: response.headers['cache-control'] } : {}) });
        });
      });
      request.on('error', () => { reject(new OAuthError('invalid_client')); });
      request.end();
    });
  };
}
