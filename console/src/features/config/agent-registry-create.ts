import type { ConfigAction, ConfigMutation, ConfigurationSnapshot } from '../../api/types';
import { BORRADOR_VACIO, mutacionDeAlta } from './alta-rapida';
import { canUseConfigForm } from './config-form-access';
import type { ConfigFormDefinition } from './config-form-model';

export interface AgentRegistryCreateDraft {
  tenantId: string;
  alias: string;
  displayName: string;
  harnessId: string;
  capacity: string;
  hostId: string;
  roomId: string;
  roomRole: string;
  containerName: string;
  runtimeUser: string;
  homeDirectory: string;
  stateDirectory: string;
}

export const EMPTY_AGENT_REGISTRY_DRAFT: AgentRegistryCreateDraft = {
  tenantId: '', alias: '', displayName: '', harnessId: '', capacity: '2', hostId: '', roomId: '', roomRole: 'agent',
  containerName: '', runtimeUser: '', homeDirectory: '', stateDirectory: '',
};

const SLUG = /^[a-z][a-z0-9_-]{0,63}$/u;
const PLACEMENT_FIELDS = [
  ['containerName', 'container_name', 'nombre del contenedor'],
  ['runtimeUser', 'runtime_user', 'usuario de ejecución'],
  ['homeDirectory', 'home_directory', 'directorio personal'],
  ['stateDirectory', 'state_directory', 'directorio de estado'],
] as const;

export const CREATE_STEPS = ['identidad', 'computadora', 'grupos', 'revision'] as const;
export type CreateStep = typeof CREATE_STEPS[number];

export const STEP_LABEL: Record<CreateStep, string> = {
  identidad: 'Identidad', computadora: 'Arnés y computadora', grupos: 'Grupos', revision: 'Revisar y crear',
};

function identityError(draft: AgentRegistryCreateDraft, snapshot?: ConfigurationSnapshot): string | undefined {
  if (!draft.tenantId) return 'Elige un espacio de trabajo del registro actual.';
  if (snapshot && !registryTenantExists(snapshot, draft.tenantId)) {
    return 'El espacio de trabajo elegido ya no está disponible. Elige uno del inventario actual para continuar.';
  }
  if (!SLUG.test(draft.alias.trim())) return 'El alias debe empezar con una letra minúscula y usar sólo letras minúsculas, números, guiones o guiones bajos, hasta 64 caracteres.';
  const name = draft.displayName.trim();
  if (!name || name.length > 128) return 'Indica un nombre visible de hasta 128 caracteres.';
  return undefined;
}

function placementError(draft: AgentRegistryCreateDraft): string | undefined {
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

function groupError(draft: AgentRegistryCreateDraft, snapshot?: ConfigurationSnapshot): string | undefined {
  if (draft.roomId && !draft.roomRole.trim()) return 'Indica el rol del agente en el grupo inicial.';
  if (draft.roomId && snapshot && !registryRoomOptions(snapshot, draft.tenantId).some((room) => room.id === draft.roomId)) {
    return 'El grupo elegido ya no está disponible en este espacio. Elige uno del inventario actual.';
  }
  return undefined;
}

/** The first problem that blocks leaving `step`; the later steps are not looked at yet. */
export function agentCreateStepError(
  step: CreateStep, draft: AgentRegistryCreateDraft, snapshot?: ConfigurationSnapshot,
): string | undefined {
  if (step === 'identidad') return identityError(draft, snapshot);
  if (step === 'computadora') return placementError(draft);
  if (step === 'grupos') return groupError(draft, snapshot);
  return undefined;
}

export function agentRegistryCreateError(
  draft: AgentRegistryCreateDraft, snapshot?: ConfigurationSnapshot,
): string | undefined {
  return identityError(draft, snapshot) ?? placementError(draft) ?? groupError(draft, snapshot);
}

export function createAgentRegistryMutation(draft: AgentRegistryCreateDraft): ConfigMutation {
  const value: Record<string, unknown> = {
    display_name: draft.displayName.trim(),
    enabled: false,
    max_concurrent_deliveries: Number(draft.capacity),
  };
  const harnessId = draft.harnessId.trim();
  if (harnessId) value.harness_id = harnessId;
  if (draft.hostId) value.host_id = draft.hostId;
  if (PLACEMENT_FIELDS.every(([field]) => draft[field].trim())) {
    for (const [draftField, field] of PLACEMENT_FIELDS) value[field] = draft[draftField].trim();
  }
  return {
    resource: 'agent', action: 'create', tenant_id: draft.tenantId,
    alias: draft.alias.trim(), value,
  };
}

/** The initial-room membership, sent after the registry row exists, through the same onboarding mutation. */
export function createAgentRoomMembershipMutation(draft: AgentRegistryCreateDraft): ConfigMutation {
  return mutacionDeAlta('membership', {
    ...BORRADOR_VACIO, tenantId: draft.tenantId.trim(), roomId: draft.roomId.trim(),
    alias: draft.alias.trim(), role: draft.roomRole.trim(), habilitado: true,
  });
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

export function registryRoomOptions(snapshot: ConfigurationSnapshot, tenantId: string): { id: string; label: string }[] {
  return (snapshot.rooms ?? []).flatMap((room) => {
    const id = typeof room.id === 'string' ? room.id.trim() : '';
    if (!id || room.tenant_id !== tenantId || room.enabled === false) return [];
    const label = typeof room.display_name === 'string' && room.display_name.trim() ? room.display_name.trim() : id;
    return [{ id, label }];
  });
}

function registryTenantExists(snapshot: ConfigurationSnapshot, tenantId: string): boolean {
  return registryTenantOptions(snapshot).some((tenant) => tenant.id === tenantId);
}

export function registryHarnessOptions(snapshot: ConfigurationSnapshot): string[] {
  return [...new Set((snapshot.harness_definitions ?? []).flatMap((harness) => {
    const id = typeof harness.id === 'string' ? harness.id : harness.harness_id;
    return typeof id === 'string' && id.trim() ? [id.trim()] : [];
  }))].sort();
}

// The registry resources are outside ConfigResource; canUseConfigForm only reads `resource`.
const AGENT_DEFINITION = { resource: 'agent', label: 'Agente', fields: [] } as unknown as ConfigFormDefinition;

/** The reason the fleet capability denies this agent action, or `undefined` when it is allowed. */
export function agentWriteBlock(snapshot: ConfigurationSnapshot, action: ConfigAction): string | undefined {
  return canUseConfigForm(snapshot, AGENT_DEFINITION, action) ? undefined : 'Solo el hub administra agentes';
}

/** The computer an agent row is placed on, whether the registry row or its runtime placement carries it. */
export function agentHostIdOf(row: Record<string, unknown> | undefined): string | undefined {
  const placement = row?.placement && typeof row.placement === 'object' ? row.placement as Record<string, unknown> : undefined;
  const hostId = placement?.host_id ?? row?.host_id;
  return typeof hostId === 'string' && hostId.trim() ? hostId.trim() : undefined;
}

export function agentHostRow(snapshot: ConfigurationSnapshot, tenantId: string, alias: string): Record<string, unknown> | undefined {
  return snapshot.agents?.find((row) => row.tenant_id === tenantId && row.alias === alias);
}
