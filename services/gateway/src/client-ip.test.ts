import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildGateway } from './app.js';
import { fakePool, fakeRepository, FixedAuthProvider, noDeliveryWakes, testPrincipal } from './test-support/gateway-doubles.js';

let app: Awaited<ReturnType<typeof buildGateway>> | undefined;
afterEach(async () => { await app?.close(); app = undefined; vi.unstubAllEnvs(); });

async function gateway(cidrs: string | undefined) {
  vi.stubEnv('CAUCE_TRUSTED_PROXY_CIDRS', cidrs);
  app = await buildGateway({ pool: fakePool(), repository: fakeRepository(), deliveryWakeSubscriber: noDeliveryWakes,
    authProvider: new FixedAuthProvider(testPrincipal()) });
  app.get('/client-ip', request => ({ ip: request.ip, ips: request.ips, host: request.host, protocol: request.protocol }));
  return app;
}

describe('gateway trusted client IP configuration', () => {
  it.each([
    ['172.18.0.2', '198.51.100.1', '198.51.100.1'],
    ['::ffff:172.18.0.2', '198.51.100.1', '198.51.100.1'],
    ['127.0.0.1', '2001:db8::1', '2001:db8::1'],
    ['172.18.0.2', '198.51.100.1, 172.18.0.3', '172.18.0.3'],
    ['203.0.113.1', '198.51.100.1', '203.0.113.1'],
    ['172.19.0.2', '198.51.100.1', '172.19.0.2'],
    ['172.18.0.2', '', '172.18.0.2'],
  ])('resolves socket %s and forwarded %s to %s', async (remoteAddress, forwardedFor, ip) => {
    const server = await gateway(' 127.0.0.1/32 , 172.18.0.0/16 ');
    const response = await server.inject({ url: '/client-ip', remoteAddress,
      headers: { 'x-forwarded-for': forwardedFor, 'x-real-ip': '198.51.100.99' } });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ ip: string }>().ip).toBe(ip);
  });

  it('ignores X-Real-IP when the forwarding header is absent', async () => {
    const server = await gateway('172.18.0.0/16');
    const response = await server.inject({ url: '/client-ip', remoteAddress: '172.18.0.2',
      headers: { 'x-real-ip': '198.51.100.99' } });
    expect(response.json<{ ip: string }>().ip).toBe('172.18.0.2');
  });

  it.each(['127.0.0.1', '::1'])('defaults to trusting the immediate loopback proxy %s', async remoteAddress => {
    const server = await gateway(undefined);
    const response = await server.inject({ url: '/client-ip', remoteAddress, headers: { 'x-forwarded-for': '198.51.100.1' } });
    expect(response.json<{ ip: string }>().ip).toBe('198.51.100.1');
  });

  it.each(['10.0.0.2', '192.168.1.2', '172.18.0.2', '203.0.113.1'])('does not trust network client %s by default', async remoteAddress => {
    const server = await gateway(undefined);
    const response = await server.inject({ url: '/client-ip', remoteAddress, headers: { 'x-forwarded-for': '198.51.100.1' } });
    expect(response.json<{ ip: string }>().ip).toBe(remoteAddress);
  });

  it('allows explicit IPv6 proxy subnets', async () => {
    const server = await gateway('fd00:1234::/64');
    const response = await server.inject({ url: '/client-ip', remoteAddress: 'fd00:1234::2',
      headers: { 'x-forwarded-for': '2001:db8::1, fd00:1234::3' } });
    expect(response.json<{ ip: string }>().ip).toBe('fd00:1234::3');
  });

  it('disables proxy trust when the configured list is empty', async () => {
    const server = await gateway('');
    const response = await server.inject({ url: '/client-ip', remoteAddress: '127.0.0.1',
      headers: { host: 'localhost', 'x-forwarded-for': '198.51.100.1', 'x-forwarded-host': 'forged.example', 'x-forwarded-proto': 'https' } });
    expect(response.json()).toMatchObject({ ip: '127.0.0.1', host: 'localhost', protocol: 'http' });
  });

  it.each([
    'loopback', 'true', '172.18.0.0', 'not-an-ip/24', '172.18.0.0/33', '::1/129', '172.18.0.0/-1', '172.18.0.0/24,',
  ])('rejects invalid proxy CIDRs at construction: %s', async cidrs => {
    const error: unknown = await gateway(cidrs).then(() => undefined, (failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('CAUCE_TRUSTED_PROXY_CIDRS');
  });
});
