import type { FleetCoordinatorTransport } from './coordinator.js';

export function guardFleetTransport(inner: FleetCoordinatorTransport, available: (host: string) => boolean) {
  const active = new Map<string, Set<AbortController>>();
  const run = async <T>(host: string, signal: AbortSignal, call: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    if (!available(host)) throw new Error('Fleet host is unavailable');
    const own = new AbortController(); const set = active.get(host) ?? new Set<AbortController>(); set.add(own); active.set(host, set);
    try { return await call(AbortSignal.any([signal, own.signal])); } finally { set.delete(own); }
  };
  const transport: FleetCoordinatorTransport = {
    perform: (host, step, execution, signal) => run(host, signal, effective => inner.perform(host, step, execution, effective)),
    compensate: (host, execution, signal) => run(host, signal, effective => inner.compensate(host, execution, effective)),
  };
  return { transport, abortHost: (host: string) => { for (const controller of active.get(host) ?? []) controller.abort(); } };
}
