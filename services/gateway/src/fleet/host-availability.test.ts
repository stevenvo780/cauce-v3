import { describe, expect, it } from 'vitest';
import type { FleetExecution } from './executor.js';
import { guardFleetTransport } from './host-availability.js';

const execution = {} as FleetExecution;
describe('fleet transport availability guard', () => {
  it('refuses unavailable hosts without touching the inner transport and lets healthy hosts through', async () => {
    const calls: string[] = [];
    const { transport } = guardFleetTransport({ perform: async host => { calls.push(host); return { evidence: {} }; },
      compensate: async host => { calls.push(host); return {}; } }, host => host !== 'dead');
    await expect(transport.perform('dead', 'stop', execution, new AbortController().signal)).rejects.toThrow('unavailable');
    await expect(transport.compensate('dead', execution, new AbortController().signal)).rejects.toThrow('unavailable');
    await expect(transport.perform('alive', 'stop', execution, new AbortController().signal)).resolves.toEqual({ evidence: {} });
    expect(calls).toEqual(['alive']);
  });
  it('aborts only the in-flight effects of the host that was lost', async () => {
    const aborted: string[] = [];
    const pending = (host: string, signal: AbortSignal) => new Promise<never>((_, reject) => {
      signal.addEventListener('abort', () => { aborted.push(host); reject(new Error('aborted')); }, { once: true });
    });
    const { transport, abortHost } = guardFleetTransport({ perform: (host, _step, _execution, signal) => pending(host, signal),
      compensate: (host, _execution, signal) => pending(host, signal) }, () => true);
    const a = transport.perform('a', 'stop', execution, new AbortController().signal); const b = transport.perform('b', 'stop', execution, new AbortController().signal);
    abortHost('a'); await expect(a).rejects.toThrow('aborted'); expect(aborted).toEqual(['a']);
    const outer = new AbortController(); const c = transport.compensate('c', execution, outer.signal); outer.abort();
    await expect(c).rejects.toThrow('aborted'); expect(aborted).toEqual(['a', 'c']);
    void b.catch(() => undefined);
  });
  it('refuses retirement on an unavailable host and aborts only its active retirement when the channel is lost', async () => {
    const calls: string[] = [];
    const { transport, abortHost } = guardFleetTransport({ perform: async () => ({ evidence: {} }), compensate: async () => ({}),
      retire: async (host, _execution, signal) => {
        calls.push(host);
        return new Promise<never>((_, reject) => { signal.addEventListener('abort', () => { reject(new Error('aborted')); }, { once: true }); });
      } }, host => host !== 'dead');
    if (!transport.retire) throw new Error('retirement guard absent');
    await expect(transport.retire('dead', execution, new AbortController().signal)).rejects.toThrow('unavailable');
    expect(calls).toEqual([]);
    const a = transport.retire('a', execution, new AbortController().signal);
    const outer = new AbortController(); const b = transport.retire('b', execution, outer.signal);
    abortHost('a'); await expect(a).rejects.toThrow('aborted');
    outer.abort(); await expect(b).rejects.toThrow('aborted');
    expect(calls).toEqual(['a', 'b']);
  });
});
