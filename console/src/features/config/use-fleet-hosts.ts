import { useCallback, useEffect, useRef, useState } from 'react';
import { fleetHostUsable, type FleetHost } from '@cauce/protocol/fleet-hosts';
import { ApiError } from '../../api/client/core';
import { useApi } from '../../api/context';

const READ_ERROR = 'No se pudo leer el registro de computadoras. Reintenta la lectura.';

/** `revision` is the configuration revision; a change means the registry may have moved, so the list is read again. */
export function useFleetHosts(open = true, revision?: number | null) {
  const api = useApi();
  const [hosts, setHosts] = useState<FleetHost[]>();
  const [error, setError] = useState<string>();
  const [forbidden, setForbidden] = useState(false);
  const [loading, setLoading] = useState(false);
  const sequence = useRef(0);
  const reload = useCallback(async () => {
    const turn = ++sequence.current;
    setLoading(true);
    try {
      const value = await api.listFleetHosts();
      if (turn === sequence.current) { setHosts(value); setError(undefined); setForbidden(false); }
    } catch (cause) {
      if (turn === sequence.current) {
        setForbidden(cause instanceof ApiError && cause.status === 403);
        setError(READ_ERROR);
      }
    } finally {
      if (turn === sequence.current) setLoading(false);
    }
  }, [api]);
  useEffect(() => {
    if (!open) return undefined;
    void reload();
    return () => { sequence.current += 1; };
  }, [open, reload, revision]);
  return { hosts, error, forbidden, loading, reload };
}

export function hostById(hosts: readonly FleetHost[] | undefined, hostId: string | null | undefined): FleetHost | undefined {
  return hostId ? hosts?.find(host => host.host_id === hostId) : undefined;
}

export function hostUnavailableReason(host: FleetHost | undefined): string | undefined {
  if (!host || fleetHostUsable(host)) return undefined;
  return host.enabled ? `La computadora ${host.display_name} está sin conexión.` : `La computadora ${host.display_name} está deshabilitada.`;
}
