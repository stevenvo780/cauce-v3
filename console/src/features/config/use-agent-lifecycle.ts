import { useCallback, useEffect, useRef, useState } from 'react';
import { FleetTargetSchema, type FleetCapability, type FleetOperation, type FleetTarget } from '@cauce/protocol/fleet-operation';
import { useApi } from '../../api/context';

const pending = (operation: FleetOperation | undefined) => operation && ['queued', 'running', 'awaiting_auth', 'cancelling'].includes(operation.status);
export function useAgentLifecycle(open: boolean, target?: FleetTarget) {
  const api = useApi();
  const [capability, setCapability] = useState<FleetCapability>();
  const [capabilityError, setCapabilityError] = useState<string>();
  const [history, setHistory] = useState<FleetOperation[]>();
  const [historyError, setHistoryError] = useState<string>();
  const [operation, setOperation] = useState<FleetOperation>();
  const [readError, setReadError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const sequence = useRef(0);
  const accepted = useRef<FleetOperation | undefined>(undefined);
  const targetKey = JSON.stringify(target);
  useEffect(() => {
    if (!open) return undefined;
    let active = true;
    setBusy(false);
    setCapability(undefined);
    setCapabilityError(undefined);
    void api.getFleetCapability().then((value) => { if (active) setCapability(value); }, () => {
      if (active) setCapabilityError('El servidor no acredita capacidades operativas de flota. Reintenta la lectura o habilita el ejecutor y su catálogo de hosts.');
    });
    if (targetKey) void api.listFleetOperations(FleetTargetSchema.parse(JSON.parse(targetKey))).then((value) => { if (active) { setHistory((observed) => {
      const merged = new Map(value.map((operation) => [operation.id, operation]));
      for (const operation of observed ?? []) {
        const stored = merged.get(operation.id);
        if (!stored || operation.version > stored.version) merged.set(operation.id, operation);
      }
      return [...merged.values()].sort((left, right) => right.created_at.localeCompare(left.created_at)).slice(0, 100);
    }); setHistoryError(undefined);
    // The newest operation, when it failed or is still running, is what the operator came back for.
    const latest = [...value].sort((left, right) => right.created_at.localeCompare(left.created_at)).at(0);
    if (latest && !accepted.current && (latest.status === 'failed' || pending(latest))) { accepted.current = latest; setOperation(latest); } } }, () => {
      if (active) setHistoryError('No se pudo leer el historial durable. Las operaciones de esta pestaña conservan su recibo.');
    });
    return () => { active = false; sequence.current += 1; };
  }, [api, open, targetKey]);
  function accept(value: FleetOperation) {
    const previous = accepted.current;
    if (previous?.id === value.id && (value.version < previous.version || value.request_sha256 !== previous.request_sha256
      || JSON.stringify(value.target) !== JSON.stringify(previous.target) || value.kind !== previous.kind)) {
      setReadError('El servidor devolvió un estado distinto del recibo o una versión anterior.');
      return;
    }
    accepted.current = value;
    setReadError(undefined);
    setOperation(value);
    // Updated in place: moving the row the operator just pressed would re-insert its button in the DOM and drop its focus.
    setHistory((rows) => rows?.some((entry) => entry.id === value.id)
      ? rows.map((entry) => entry.id === value.id ? value : entry) : [value, ...(rows ?? [])].slice(0, 100));
  }
  const refresh = useCallback(async () => {
    if (!operation || busy) return;
    const read = ++sequence.current;
    setBusy(true);
    try {
      const value = await api.getFleetOperation(operation.id);
      if (read === sequence.current) accept(value);
    } catch { if (read === sequence.current) setReadError('No se pudo releer el estado durable de la operación.'); }
    finally { if (read === sequence.current) setBusy(false); }
  }, [api, busy, operation]);
  useEffect(() => {
    if (!open || busy || !pending(operation)) return undefined;
    const timer = setTimeout(() => { void refresh(); }, 2500);
    return () => { clearTimeout(timer); };
  }, [busy, open, operation, refresh]);
  async function control(action: 'cancel' | 'resume') {
    if (!operation || busy || readError) return;
    const read = ++sequence.current;
    setBusy(true);
    try {
      const value = await (action === 'cancel' ? api.cancelFleetOperation(operation.id, operation.version)
        : api.resumeFleetOperation(operation.id, operation.version));
      if (read === sequence.current) accept(value);
    } catch (cause) {
      if (read === sequence.current) setReadError(cause instanceof Error ? cause.message : 'No se pudo recuperar la operación. Relee su versión actual.');
    } finally { if (read === sequence.current) setBusy(false); }
  }
  return { capability, capabilityError, history, historyError, operation, readError, busy, accept, refresh, control };
}
