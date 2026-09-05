export function agentContextReconcileLockKey(tenantId: string, alias: string): string {
  return `agent-context-reconcile:${tenantId}:${alias}`;
}
