import type { ConfigMutation, ConfigurationSnapshot } from '../../api/types';

export interface AgentRegistryCreateDraft {
  tenantId: string;
  alias: string;
  displayName: string;
  harnessId: string;
  capacity: string;
  containerName: string;
  runtimeUser: string;
  homeDirectory: string;
  stateDirectory: string;
}

export const EMPTY_AGENT_REGISTRY_DRAFT: AgentRegistryCreateDraft = {
  tenantId: '', alias: '', displayName: '', harnessId: '', capacity: '2',
  containerName: '', runtimeUser: '', homeDirectory: '', stateDirectory: '',
};

const SLUG = /^[a-z][a-z0-9_-]{0,63}$/u;
const PLACEMENT_FIELDS = [
  ['containerName', 'container_name', 'nombre del contenedor'],
  ['runtimeUser', 'runtime_user', 'usuario de ejecución'],
  ['homeDirectory', 'home_directory', 'directorio personal'],
  ['stateDirectory', 'state_directory', 'directorio de estado'],
] as const;

export function agentRegistryCreateError(
  draft: AgentRegistryCreateDraft, snapshot?: ConfigurationSnapshot,
): string | undefined {
  if (!draft.tenantId) return 'Elige un espacio de trabajo del registro actual.';
  if (snapshot && !registryTenantExists(snapshot, draft.tenantId)) {
    return 'El espacio de trabajo elegido ya no está disponible. Elige uno del inventario actual para continuar.';
  }
  if (!SLUG.test(draft.alias.trim())) return 'El alias debe empezar con una letra minúscula y usar sólo letras minúsculas, números, guiones o guiones bajos, hasta 64 caracteres.';
  const name = draft.displayName.trim();
  if (!name || name.length > 128) return 'Indica un nombre visible de hasta 128 caracteres.';
  if (draft.harnessId.trim() && !SLUG.test(draft.harnessId.trim())) {
    return 'El tipo de agente debe empezar con una letra minúscula y usar sólo letras minúsculas, números, guiones o guiones bajos, hasta 64 caracteres.';
  }
  if (!/^[0-9]+$/u.test(draft.capacity)) return 'La capacidad debe ser un entero entre 1 y 100.';
  const capacity = Number(draft.capacity);
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 100) {
    return 'La capacidad debe ser un entero entre 1 y 100.';
  }
  const placement = PLACEMENT_FIELDS.map(([draftField]) => draft[draftField].trim());
  if (placement.some(Boolean) && placement.some((value) => !value)) {
    return 'Completa los cuatro campos del entorno de ejecución o déjalos vacíos.';
  }
  return undefined;
}

export function createAgentRegistryMutation(draft: AgentRegistryCreateDraft): ConfigMutation {
  const value: Record<string, unknown> = {
    display_name: draft.displayName.trim(),
    enabled: false,
    max_concurrent_deliveries: Number(draft.capacity),
  };
  const harnessId = draft.harnessId.trim();
  if (harnessId) value.harness_id = harnessId;
  if (PLACEMENT_FIELDS.every(([field]) => draft[field].trim())) {
    for (const [draftField, field] of PLACEMENT_FIELDS) value[field] = draft[draftField].trim();
  }
  return {
    resource: 'agent', action: 'create', tenant_id: draft.tenantId,
    alias: draft.alias.trim(), value,
  };
}

export function registryTenantOptions(snapshot: ConfigurationSnapshot): { id: string; label: string }[] {
  return (snapshot.tenants ?? []).flatMap((tenant) => {
    const id = typeof tenant.id === 'string' ? tenant.id.trim() : '';
    if (!id) return [];
    const label = typeof tenant.display_name === 'string' && tenant.display_name.trim()
      ? tenant.display_name.trim() : id;
    return [{ id, label }];
  });
}

export function registryTenantExists(snapshot: ConfigurationSnapshot, tenantId: string): boolean {
  return registryTenantOptions(snapshot).some((tenant) => tenant.id === tenantId);
}

export function registryHarnessOptions(snapshot: ConfigurationSnapshot): string[] {
  return [...new Set((snapshot.harness_definitions ?? []).flatMap((harness) => {
    const id = typeof harness.id === 'string' ? harness.id : harness.harness_id;
    return typeof id === 'string' && id.trim() ? [id.trim()] : [];
  }))].sort();
}
