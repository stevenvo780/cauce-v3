/** Where a click on an agent leads depends on the section the operator is in. */
export function agentHref(routeId: string, agent: { tenantId: string; alias: string }): string {
  const tenant = encodeURIComponent(agent.tenantId);
  const alias = encodeURIComponent(agent.alias);
  if (routeId === 'terminal') return `/terminal/${tenant}/${alias}`;
  if (routeId === 'live') return `/live?agente=${encodeURIComponent(`${agent.tenantId}/${agent.alias}`)}`;
  return `/messages/${tenant}/${alias}`;
}
