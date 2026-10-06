import { useEffect, useMemo, useRef, useState } from 'react';
import { useApi } from '../../api/context';
import { useConsoleAccess } from '../../api/console-access';
import type { ConfigMutation, ConfigurationSnapshot } from '../../api/types';
import type { Resource } from '../../api/use-resource';
import { useConfigMutation, useRevisionEncadenada, type ConfigMutationRunner } from './use-config-mutation';
import { Button, Notice } from '../../components/form-kit';
import { CHECK_LABEL, HINT, PREVIEW } from './config-ui';

type AgentRow = Record<string, unknown> & { tenant_id: string; alias: string };

interface Draft {
  displayName: string;
  harnessId: string;
  clearHarness: boolean;
  enabled: string;
  capacity: string;
  noCapacityLimit: boolean;
  containerName: string;
  runtimeUser: string;
  homeDirectory: string;
  stateDirectory: string;
  clearPlacement: boolean;
}

function initialDraft(agent: AgentRow): Draft {
  return {
    displayName: typeof agent.display_name === 'string' ? agent.display_name : '',
    harnessId: typeof agent.harness_id === 'string' ? agent.harness_id : '',
    clearHarness: false,
    enabled: typeof agent.enabled === 'boolean' ? String(agent.enabled) : '',
    capacity: typeof agent.max_concurrent_deliveries === 'number'
      ? String(agent.max_concurrent_deliveries) : '',
    noCapacityLimit: agent.max_concurrent_deliveries === null,
    containerName: typeof agent.container_name === 'string' ? agent.container_name : '',
    runtimeUser: typeof agent.runtime_user === 'string' ? agent.runtime_user : '',
    homeDirectory: typeof agent.home_directory === 'string' ? agent.home_directory : '',
    stateDirectory: typeof agent.state_directory === 'string' ? agent.state_directory : '',
    clearPlacement: false,
  };
}

function buildMutation(agent: AgentRow, draft: Draft): { mutation?: ConfigMutation; error?: string } {
  const value: Record<string, unknown> = {};
  const originalName = typeof agent.display_name === 'string' ? agent.display_name : '';
  if (draft.displayName !== originalName) {
    const normalized = draft.displayName.trim();
    if (normalized.length > 128) return { error: 'El nombre visible admite hasta 128 caracteres.' };
    value.display_name = normalized || null;
  }

  const originalHarness = typeof agent.harness_id === 'string' ? agent.harness_id : '';
  if (draft.clearHarness) {
    if (agent.harness_id !== null && agent.harness_id !== undefined) value.harness_id = null;
  } else if (draft.harnessId !== originalHarness) {
    const harness = draft.harnessId.trim();
    if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(harness)) {
      return { error: 'El ID del arnés debe ser un slug en minúsculas, o usa «Quitar arnés». ' };
    }
    value.harness_id = harness;
  }

  if (draft.enabled !== '' && draft.enabled !== String(agent.enabled)) {
    value.enabled = draft.enabled === 'true';
  }

  const originalCapacity = agent.max_concurrent_deliveries;
  if (draft.noCapacityLimit) {
    if (originalCapacity !== null) value.max_concurrent_deliveries = null;
  } else if (draft.capacity !== '') {
    if (!/^[0-9]+$/u.test(draft.capacity)) return { error: 'La capacidad debe ser un entero entre 1 y 100.' };
    const capacity = Number(draft.capacity);
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 100) {
      return { error: 'La capacidad debe ser un entero entre 1 y 100.' };
    }
    if (capacity !== originalCapacity) value.max_concurrent_deliveries = capacity;
  } else if (typeof originalCapacity === 'number') {
    return { error: 'Indica una capacidad o marca «Sin límite» para enviar null.' };
  }

  const placementKeys = [
    ['containerName', 'container_name', 'Nombre del contenedor'],
    ['runtimeUser', 'runtime_user', 'Usuario de runtime'],
    ['homeDirectory', 'home_directory', 'Directorio home'],
    ['stateDirectory', 'state_directory', 'Directorio de estado'],
  ] as const;
  const placementChanged = placementKeys.some(([draftKey, agentKey]) => {
    const current = typeof agent[agentKey] === 'string' ? agent[agentKey] : '';
    return draft[draftKey] !== current;
  });
  if (draft.clearPlacement) {
    if (placementKeys.some(([, key]) => agent[key] !== null && agent[key] !== undefined)) {
      for (const [, key] of placementKeys) value[key] = null;
    }
  } else if (placementChanged) {
    const missing = placementKeys.find(([draftKey]) => !draft[draftKey].trim());
    if (missing) return { error: `Placement es atómico: completa «${missing[2]}» o quita el placement completo.` };
    for (const [draftKey, key] of placementKeys) value[key] = draft[draftKey].trim();
  }

  if (Object.keys(value).length === 0) return { error: 'Cambia al menos un campo antes de previsualizar.' };
  return {
    mutation: {
      resource: 'agent', action: 'update', tenant_id: agent.tenant_id, alias: agent.alias, value,
    },
  };
}

export function AgentRegistryEditor({ tenantId, alias, snapshot, onReloaded }: {
  tenantId: string; alias: string; snapshot: ConfigurationSnapshot;
  onReloaded: (snapshot: ConfigurationSnapshot) => void;
}) {
  const api = useApi();
  const access = useConsoleAccess();
  const [open, setOpen] = useState(false);
  const [freshSnapshot, setFreshSnapshot] = useState<ConfigurationSnapshot>();
  const chained = useRevisionEncadenada();
  useEffect(() => { setFreshSnapshot(undefined); }, [snapshot]);
  const resource: Resource<ConfigurationSnapshot> = {
    data: freshSnapshot ?? snapshot,
    loading: false,
    reload: async () => {
      try {
        const data = await api.getConfiguration();
        setFreshSnapshot(data);
        onReloaded(data);
        return { data };
      } catch (cause) {
        return { error: cause instanceof Error ? cause : new Error('No se pudo releer la configuración.') };
      }
    },
  };
  const runner = useConfigMutation({ config: resource, access, encadenado: chained, canal: `agent-registry:${tenantId}/${alias}` });
  const agent = freshSnapshot
    ? freshSnapshot.agents?.find((row) => row.tenant_id === tenantId && row.alias === alias)
    : snapshot.agents?.find((row) => row.tenant_id === tenantId && row.alias === alias);
  if (!agent) return null;
  return <div className="min-w-0" data-open={String(open)}>
    <Button size="sm"
      aria-label={`${open ? 'Cerrar' : 'Editar'} registro de ${tenantId}/${alias}`}
      onClick={() => { setOpen((value) => !value); runner.clear(); }}
    >{open ? 'Cerrar registro' : 'Editar registro'}</Button>
    {open ? <AgentRegistryForm agent={agent as AgentRow} runner={runner} onClose={() => { setOpen(false); runner.clear(); }} /> : null}
  </div>;
}

function AgentRegistryForm({
  agent, runner, onClose,
}: {
  agent: AgentRow;
  runner: ConfigMutationRunner;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(() => initialDraft(agent));
  const [formError, setFormError] = useState<string>();
  const [serverRefreshNotice, setServerRefreshNotice] = useState<string>();
  const agentVersion = JSON.stringify([
    agent.harness_id, agent.display_name, agent.enabled, agent.max_concurrent_deliveries,
    agent.container_name, agent.runtime_user, agent.home_directory, agent.state_directory,
  ]);
  const previousAgentVersion = useRef(agentVersion);
  const built = useMemo(() => buildMutation(agent, draft), [agent, draft]);
  const mutation = built.mutation;
  const disabled = !runner.canWrite || runner.busy;

  useEffect(() => {
    if (previousAgentVersion.current === agentVersion) return;
    previousAgentVersion.current = agentVersion;
    setDraft(initialDraft(agent));
    setFormError(undefined);
    setServerRefreshNotice('El registro cambió en el servidor. Se descartó el borrador y se cargaron los valores actuales; revísalos antes de previsualizar.');
  }, [agent, agentVersion]);

  function update(patch: Partial<Draft>) {
    setDraft((current) => ({ ...current, ...patch }));
    setFormError(undefined);
    runner.clear();
  }

  async function preview() {
    if (!mutation) {
      setFormError(built.error ?? 'La mutación no es válida.');
      runner.clear();
      return;
    }
    setFormError(undefined);
    await runner.run(mutation, true);
  }

  async function apply() {
    if (!mutation) {
      setFormError(built.error ?? 'La mutación no es válida.');
      runner.clear();
      return;
    }
    setFormError(undefined);
    await runner.run(mutation, false);
  }

  const originalName = typeof agent.display_name === 'string' ? agent.display_name : '';
  const originalHarness = typeof agent.harness_id === 'string' ? agent.harness_id : '';
  return <section aria-label={`Registro de ${agent.tenant_id}/${agent.alias}`} className="mt-3 grid gap-3 rounded-lg border border-line bg-subtle p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h4 className="m-0 text-sm font-semibold">Registro · {agent.tenant_id}/{agent.alias}</h4>
      <Button size="sm" onClick={onClose}>Cerrar editor</Button>
    </div>
    <p className={HINT}>Identidad fija desde la fila seleccionada. Los permisos se vuelven a decidir en el servidor.</p>
    {!runner.canWrite ? <Notice role="note">Edición de registro en solo lectura: falta permiso acreditado de configuración.</Notice> : null}
    {serverRefreshNotice ? <Notice role="note">{serverRefreshNotice}</Notice> : null}
    <div className="grid gap-3 sm:grid-cols-2">
      <label>Nombre visible
        <input maxLength={128} value={draft.displayName}
          onChange={(event) => { update({ displayName: event.target.value }); }} disabled={disabled} />
      </label>
      <label>ID del arnés
        <input value={draft.harnessId} placeholder="Sin cambio" pattern="[a-z][a-z0-9_-]{0,63}"
          onChange={(event) => { update({ harnessId: event.target.value, clearHarness: false }); }} disabled={disabled} />
      </label>
      <label className={CHECK_LABEL}><input type="checkbox" checked={draft.clearHarness} className="mt-0.5"
        onChange={(event) => { update({ clearHarness: event.target.checked }); }} disabled={disabled} />
        Quitar arnés {originalHarness ? <span className={HINT}>{originalHarness}</span> : null}
      </label>
      <label>Estado del registro
        <select value={draft.enabled} onChange={(event) => { update({ enabled: event.target.value }); }} disabled={disabled}>
          <option value="">Sin cambios</option>
          <option value="true">Habilitado</option>
          <option value="false">Deshabilitado</option>
        </select>
      </label>
      <label>Máximo de entregas concurrentes
        <input type="number" min={1} max={100} step={1} value={draft.capacity}
          onChange={(event) => { update({ capacity: event.target.value, noCapacityLimit: false }); }} disabled={disabled} />
      </label>
      <label className={CHECK_LABEL}><input type="checkbox" checked={draft.noCapacityLimit} className="mt-0.5"
        onChange={(event) => { update({ noCapacityLimit: event.target.checked, ...(event.target.checked ? { capacity: '' } : {}) }); }} disabled={disabled} />
        Sin límite (enviar null)
      </label>
      <label>Nombre del contenedor
        <input value={draft.containerName} onChange={(event) => { update({ containerName: event.target.value, clearPlacement: false }); }} disabled={disabled} />
      </label>
      <label>Usuario de runtime
        <input value={draft.runtimeUser} onChange={(event) => { update({ runtimeUser: event.target.value, clearPlacement: false }); }} disabled={disabled} />
      </label>
      <label>Directorio home
        <input value={draft.homeDirectory} onChange={(event) => { update({ homeDirectory: event.target.value, clearPlacement: false }); }} disabled={disabled} />
      </label>
      <label>Directorio de estado
        <input value={draft.stateDirectory} onChange={(event) => { update({ stateDirectory: event.target.value, clearPlacement: false }); }} disabled={disabled} />
      </label>
      <label className={`${CHECK_LABEL} sm:col-span-2`}><input type="checkbox" checked={draft.clearPlacement} className="mt-0.5"
        onChange={(event) => { update({ clearPlacement: event.target.checked }); }} disabled={disabled} />
        Quitar placement completo (enviar null en los cuatro campos)
      </label>
    </div>
    {formError ? <Notice tone="danger" role="alert">{formError}</Notice> : null}
    {runner.notice ? <Notice tone={runner.notice.tone === 'error' ? 'danger' : 'info'}
      role={runner.notice.tone === 'error' ? 'alert' : 'status'}>{runner.notice.text}</Notice> : null}
    <div className="flex flex-wrap items-center justify-between gap-3">
      <span className="text-xs text-muted">Revisión esperada: {String(runner.expectedRevision ?? 'desconocida')}</span>
      <div className="flex gap-2">
        <Button onClick={() => { void preview(); }} disabled={disabled}>Previsualizar cambio</Button>
        <Button variant="primary" onClick={() => { void apply(); }}
          disabled={disabled || !mutation || !runner.isValidated(mutation)}>Aplicar cambio</Button>
      </div>
    </div>
    {runner.preview ? <pre className={PREVIEW} aria-label="Preview del registro de agente">{runner.preview}</pre> : null}
    {originalName && draft.displayName.trim() === '' ? <p className={HINT}>Nombre actual «{originalName}»; vacío lo quita del registro.</p> : null}
  </section>;
}
