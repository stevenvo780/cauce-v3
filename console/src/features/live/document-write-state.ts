import { useCallback, useSyncExternalStore } from 'react';
import type { CauceApi } from '../../api/client';

interface PendingWrite { busy: boolean; listeners: Set<() => void> }
const writes = new WeakMap<CauceApi, Map<string, PendingWrite>>();

/** A document write remains locked when its accordion or editor is unmounted. */
export function useDocumentWrite(api: CauceApi, key: string): [boolean, (busy: boolean) => void] {
  let registry = writes.get(api);
  if (!registry) { registry = new Map(); writes.set(api, registry); }
  let pending = registry.get(key);
  if (!pending) { pending = { busy: false, listeners: new Set() }; registry.set(key, pending); }
  const entry = pending;
  const subscribe = useCallback((listener: () => void) => {
    entry.listeners.add(listener);
    return () => { entry.listeners.delete(listener); };
  }, [entry]);
  const busy = useSyncExternalStore(subscribe, () => entry.busy);
  const setBusy = useCallback((value: boolean) => {
    entry.busy = value;
    for (const listener of entry.listeners) listener();
  }, [entry]);
  return [busy, setBusy];
}
