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

/** Why an environment action cannot run now, or undefined when it can. Mirrors `quotaEnvironmentExecutable`. */
export function quotaEnvironmentActionBlock(
  snapshot: QuotaEnvironmentsSnapshot | undefined,
  environment: QuotaEnvironment,
  action: QuotaEnvironmentAction,
  canWrite: boolean,
  busy: boolean,
): string | undefined {
  if (!canWrite) return 'Tu rol no permite operar entornos de cuotas. Pide a un dueño o administrador de la empresa que lo haga.';
  if (busy) return 'Espera a que termine la operación en curso.';
  if (!snapshot) return 'Todavía no llegó la lectura de entornos. Espera o actualiza cuotas y entornos.';
  if (!snapshot.capabilities.available) return 'No hay un ejecutor de cuotas disponible para esta empresa. Recupera la conexión del ordenador y vuelve a leer los entornos.';
  const current = snapshot.environments.find(entry => entry.id === environment.id && entry.version === environment.version);
  if (!current) return 'Este entorno cambió. Actualiza cuotas y entornos y vuelve a intentarlo.';
  if (['pending', 'running', 'awaiting_auth', 'deleting', 'deleted'].includes(current.status)) {
    return 'El entorno está ocupado o en un estado que no admite esta acción. Espera a que termine y actualiza los entornos.';
  }
  if (snapshot.operations.some(operation => operation.environment_id === environment.id
    && ['pending', 'running', 'awaiting_auth'].includes(operation.status))) {
    return 'Ya hay una operación en curso para este entorno. Espera a que termine.';
  }
  if (!snapshot.capabilities.hosts.some(host => host.host_id === environment.host_id && quotaHostSupports(host, environment.provider, action))) {
    return 'La computadora de este entorno no puede ejecutar esta acción para este proveedor. Revisa que el ordenador esté en línea y el proveedor habilitado.';
  }
  return undefined;
}
