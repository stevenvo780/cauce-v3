import { useCallback, useEffect, useRef, useState } from 'react';
import { useApi } from '../../api/context';
import type { ConfigurationSnapshot } from '../../api/types';
import type { Resource } from '../../api/use-resource';
import type { PermissionState } from '../../lib';
import { measureNativeReload, reloadNativeAgent } from './native-reload';

export function useNativeReload(tenantId: string, alias: string, configuration: Resource<ConfigurationSnapshot>, permission: PermissionState) {
  const api = useApi();
  const control = permission === 'allowed' && configuration.data?.capabilities?.actor.can_control === true && !configuration.error;
  const [verified, setVerified] = useState<string>();
  const lifetime = useRef<AbortController | undefined>(undefined);
  const pending = useRef(false);
  const current = useRef(configuration); current.current = configuration;
  const identity = `${tenantId}/${alias}`;
  const scope = useRef({ identity, control }); scope.current = { identity, control };
  const controller = lifetime.current;
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    const unsubscribe = api.onAuthGenerationChange(() => { controller.abort(); setVerified(undefined); });
    return () => { controller.abort(); unsubscribe(); };
  }, [api, identity, control]);
  useEffect(() => {
    let active = true; setVerified(undefined);
    if (control && configuration.data) void measureNativeReload(api, configuration.data, { resource: 'agent', tenant_id: tenantId, alias }).then(
      () => { if (active && !lifetime.current?.signal.aborted) setVerified(identity); }, () => { if (active) setVerified(undefined); });
    return () => { active = false; };
  }, [api, control, configuration.data, identity, tenantId, alias]);
  const reload = useCallback(async () => {
    const signal = controller?.signal;
    if (!control || !scope.current.control || scope.current.identity !== identity || lifetime.current !== controller
      || verified !== identity || !signal || signal.aborted || pending.current) throw new Error('La capacidad de reinicio ya no está acreditada. Relee esta vista.');
    pending.current = true;
    try { await reloadNativeAgent(api, current.current, { resource: 'agent', tenant_id: tenantId, alias }, signal); }
    finally { pending.current = false; }
  }, [api, control, verified, identity, tenantId, alias, controller]);
  return control && verified === identity && !lifetime.current?.signal.aborted ? reload : undefined;
}
