import { useCallback } from 'react';
import { redirect, useRouteSearch } from '../../router';

export function prepareAgentHref(tenantId: string, alias: string, action?: 'start' | 'stop'): string {
  const params = new URLSearchParams({ seccion: 'agentes', agente: `${tenantId}/${alias}`, ficha: 'operacion' });
  if (action) params.set('accion', action);
  return `/config?${params.toString()}`;
}

/** The agent whose sheet is open lives in `?agente=<tenant>/<alias>`, so a reload keeps the context. */
export function useAgentParam(): [string | undefined, (ref: string | undefined) => void] {
  const search = useRouteSearch();
  const current = new URLSearchParams(search).get('agente') ?? undefined;
  const set = useCallback((ref: string | undefined) => {
    const params = new URLSearchParams(window.location.search);
    if (ref) params.set('agente', ref); else params.delete('agente');
    params.delete('accion');
    if (!params.has('seccion')) params.set('seccion', 'agentes');
    redirect(`${window.location.pathname}?${params.toString()}`);
  }, []);
  return [current, set];
}
