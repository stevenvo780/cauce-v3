import type { QuotaEnvironment, QuotaEnvironmentAction, QuotaEnvironmentsSnapshot, QuotaHostCapabilities, QuotaProvider } from '../../api/client/my-quotas-client';

export const EXECUTABLE_QUOTA_PROVIDERS = new Set<QuotaProvider>(['claude', 'codex', 'grok']);

export function quotaHostSupports(host: QuotaHostCapabilities, provider: string, action: QuotaEnvironmentAction): boolean {
  return EXECUTABLE_QUOTA_PROVIDERS.has(provider as QuotaProvider)
    && host.providers.some(value => value === provider)
    && Object.entries(host.provider_actions).some(([value, actions]) => value === provider && Array.isArray(actions) && actions.includes(action));
}

export function quotaEnvironmentExecutable(snapshot: QuotaEnvironmentsSnapshot | undefined, environment: QuotaEnvironment, action: QuotaEnvironmentAction): boolean {
  return snapshot?.capabilities.available === true
    && snapshot.environments.some(current => current.id === environment.id && current.version === environment.version
      && !['pending', 'running', 'awaiting_auth', 'deleting', 'deleted'].includes(current.status))
    && !snapshot.operations.some(operation => operation.environment_id === environment.id
      && ['pending', 'running', 'awaiting_auth'].includes(operation.status))
    && snapshot.capabilities.hosts.some(host => host.host_id === environment.host_id && quotaHostSupports(host, environment.provider, action));
}
