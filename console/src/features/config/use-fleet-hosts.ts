import { useCallback, useEffect, useRef, useState } from 'react';
import { fleetHostUsable, type FleetHost } from '@cauce/protocol/fleet-hosts';
import { useApi } from '../../api/context';

const READ_ERROR = 'No se pudo leer el registro de computadoras. Reintenta la lectura.';

export function useFleetHosts(open = true) {
  const api = useApi();
  const [hosts, setHosts] = useState<FleetHost[]>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const sequence = useRef(0);
  const reload = useCallback(async () => {
    const turn = ++sequence.current;
    setLoading(true);
    try {
      const value = await api.listFleetHosts();
      if (turn === sequence.current) { setHosts(value); setError(undefined); }
    } catch {
      if (turn === sequence.current) setError(READ_ERROR);
    } finally {
      if (turn === sequence.current) setLoading(false);
    }
  }, [api]);
  useEffect(() => {
    if (!open) return undefined;
    void reload();
    return () => { sequence.current += 1; };
  }, [open, reload]);
  return { hosts, error, loading, reload };
}

export function hostById(hosts: readonly FleetHost[] | undefined, hostId: string | null | undefined): FleetHost | undefined {
  return hostId ? hosts?.find(host => host.host_id === hostId) : undefined;
}

export function hostUnavailableReason(host: FleetHost | undefined): string | undefined {
  if (!host || fleetHostUsable(host)) return undefined;
  return host.enabled ? `La computadora ${host.display_name} está sin conexión.` : `La computadora ${host.display_name} está deshabilitada.`;
}
