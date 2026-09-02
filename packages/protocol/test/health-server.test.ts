import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderCounters, startHealthServer, type HealthAnswer, type HealthServerOptions } from '../src/index.js';

const servers: Server[] = [];

async function listen(options: Omit<HealthServerOptions, 'port' | 'host'>): Promise<string> {
  const server = startHealthServer({ ...options, port: 0, host: '127.0.0.1' });
  servers.push(server);
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${String(address.port)}`;
}

const live = (): HealthAnswer => ({ ok: true, body: { status: 'live' } });
const ready = (): HealthAnswer => ({ ok: true, body: { status: 'ready' } });

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => { resolve(); });
  })));
});

describe('shared health server', () => {
  it('rejects every method other than GET without consulting the probes', async () => {
    const probe = vi.fn(live);
    const base = await listen({ live: probe, ready });
    const response = await fetch(`${base}/health/live`, { method: 'POST' });
    expect(response.status).toBe(405);
    expect(await response.json()).toEqual({ status: 'method_not_allowed' });
    expect(probe).not.toHaveBeenCalled();
  });

  it('strips the query string so a probed path still reaches its handler', async () => {
    const probe = vi.fn(ready);
    const base = await listen({ live, ready: probe });
    const response = await fetch(`${base}/health/ready?x=1`);
    expect(response.status).toBe(200);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('publishes the caller body untouched under a 503 when the answer is not ok', async () => {
    const body = { status: 'not_ready', reason: 'presence_stale', pollers: 3, nested: { a: [1, 2] } };
    const base = await listen({ live, ready: () => ({ ok: false, body }) });
    const response = await fetch(`${base}/health/ready`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(body);
  });

  it('declares a content-length equal to the byte length of the payload', async () => {
    const base = await listen({ live, ready: () => ({ ok: true, body: { reason: 'árbol caído' } }) });
    const response = await fetch(`${base}/health/ready`);
    const text = await response.text();
    expect(response.headers.get('content-length')).toBe(String(Buffer.byteLength(text, 'utf8')));
    expect(Buffer.byteLength(text, 'utf8')).toBeGreaterThan(text.length);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('serves /metrics only when a metrics function is supplied', async () => {
    const withoutMetrics = await listen({ live, ready });
    const absent = await fetch(`${withoutMetrics}/metrics`);
    expect(absent.status).toBe(404);
    expect(await absent.json()).toEqual({ status: 'not_found' });

    const withMetrics = await listen({ live, ready, metrics: () => 'cauce_x 1\n' });
    const present = await fetch(`${withMetrics}/metrics`);
    expect(present.status).toBe(200);
    expect(present.headers.get('content-type')).toBe('text/plain; version=0.0.4; charset=utf-8');
    expect(await present.text()).toBe('cauce_x 1\n');
  });

  it('honours an explicit metrics content type', async () => {
    const base = await listen({
      live, ready, metrics: () => 'x 1\n', metricsContentType: 'text/plain; version=0.0.4',
    });
    const response = await fetch(`${base}/metrics`);
    expect(response.headers.get('content-type')).toBe('text/plain; version=0.0.4');
  });

  it('answers unavailable instead of hanging when a probe rejects', async () => {
    const base = await listen({ live, ready: () => Promise.reject(new Error('pool down')) });
    const response = await fetch(`${base}/health/ready`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: 'probe_failed' });
  });

  it('answers an unknown path with 404 and keeps serving', async () => {
    const base = await listen({ live, ready });
    expect((await fetch(`${base}/`)).status).toBe(404);
    expect((await fetch(`${base}/health/live`)).status).toBe(200);
  });
});

describe('counter rendering', () => {
  it('keeps zeroed series so a rate() over the family never breaks', () => {
    const counters = new Map([['allowed', 2], ['denied', 0]]);
    expect(renderCounters('cauce_x_total', 'Outcomes without identifying labels.', counters)).toBe(
      '# HELP cauce_x_total Outcomes without identifying labels.\n'
      + '# TYPE cauce_x_total counter\n'
      + 'cauce_x_total{result="allowed"} 2\n'
      + 'cauce_x_total{result="denied"} 0\n',
    );
  });

  it('emits one scrapable block per family when several are concatenated', () => {
    const block = renderCounters('a_total', 'A.', new Map([['ok', 1]]))
      + renderCounters('b_total', 'B.', new Map([['ok', 1]]));
    expect(block.split('\n').filter((line) => line === '')).toHaveLength(1);
    expect(block).toContain('a_total{result="ok"} 1\n# HELP b_total B.');
  });

  it('escapes a label value that would otherwise corrupt the exposition', () => {
    expect(renderCounters('a_total', 'A.', new Map([['we"ird', 1]])))
      .toContain('a_total{result="we\\"ird"} 1');
  });
});
