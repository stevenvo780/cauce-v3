import { useEffect, useState } from 'react';
import { useApi } from '../../api/context';
import { useConsoleAccess } from '../../api/console-access';
import type { ConfigurationSnapshot } from '../../api/types';
import type { Resource } from '../../api/use-resource';
import { useConfigMutation, useRevisionEncadenada, type ConfigMutationRunner } from './use-config-mutation';

/** A config write channel bound to a snapshot: after a write it rereads and hands the newer snapshot up. */
export function useSnapshotRunner(
  snapshot: ConfigurationSnapshot, onReloaded: (snapshot: ConfigurationSnapshot) => void, canal: string,
): { runner: ConfigMutationRunner; current: ConfigurationSnapshot } {
  const api = useApi();
  const access = useConsoleAccess();
  const chained = useRevisionEncadenada();
  const [fresh, setFresh] = useState<ConfigurationSnapshot>();
  useEffect(() => { setFresh(undefined); }, [snapshot]);
  const current = fresh ?? snapshot;
  const config: Resource<ConfigurationSnapshot> = {
    data: current,
    loading: false,
    reload: async () => {
      try {
        const data = await api.getConfiguration();
        setFresh(data);
        onReloaded(data);
        return { data };
      } catch (cause) {
        return { error: cause instanceof Error ? cause : new Error('No se pudo releer la configuración.') };
      }
    },
  };
  return { runner: useConfigMutation({ config, access, encadenado: chained, canal }), current };
}
