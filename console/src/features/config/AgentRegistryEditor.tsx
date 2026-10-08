import { useEffect, useMemo, useRef, useState } from 'react';
import { useApi } from '../../api/context';
import { useConsoleAccess } from '../../api/console-access';
import type { ConfigMutation, ConfigurationSnapshot } from '../../api/types';
import type { Resource } from '../../api/use-resource';
import { useConfigMutation, useRevisionEncadenada, type ConfigMutationRunner } from './use-config-mutation';
import './AgentRegistryEditor.css';

type AgentRow = Record<string, unknown> & { tenant_id: string; alias: string };

interface Draft {
  displayName: string;
  enabled: string;
  capacity: string;
  noCapacityLimit: boolean;
}

function initialDraft(agent: AgentRow): Draft {
  return {
    displayName: typeof agent.display_name === 'string' ? agent.display_name : '',
    enabled: typeof agent.enabled === 'boolean' ? String(agent.enabled) : '',
    capacity: typeof agent.max_concurrent_deliveries === 'number'
      ? String(agent.max_concurrent_deliveries) : '',
    noCapacityLimit: agent.max_concurrent_deliveries === null,
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

  if (draft.enabled !== '' && draft.enabled !== String(agent.enabled)) {
    if (draft.enabled !== 'false') return { error: 'La habilitación requiere una operación verificada desde «Operar agente».' };
    value.enabled = false;
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
  return <div className="agent-registry-editor" data-open={String(open)}>
    <button type="button" className="button secondary"
      aria-label={`${open ? 'Cerrar' : 'Editar'} registro de ${tenantId}/${alias}`}
      onClick={() => { setOpen((value) => !value); runner.clear(); }}
    >{open ? 'Cerrar registro' : 'Editar registro'}</button>
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
  return <section className="settings-context" aria-label={`Registro de ${agent.tenant_id}/${agent.alias}`}>
    <div className="settings-context-heading">
      <h3>Registro · {agent.tenant_id}/{agent.alias}</h3>
      <button type="button" className="button secondary" onClick={onClose}>Cerrar editor</button>
    </div>
    <p className="settings-source">Identidad fija desde la fila seleccionada. Los permisos se vuelven a decidir en el servidor.</p>
    {!runner.canWrite ? <p className="notice" role="note">Edición de registro en solo lectura: falta permiso acreditado de configuración.</p> : null}
    {serverRefreshNotice ? <p className="notice" role="note">{serverRefreshNotice}</p> : null}
    <div className="config-form agent-registry-form">
      <label>Nombre visible
        <input maxLength={128} value={draft.displayName}
          onChange={(event) => { update({ displayName: event.target.value }); }} disabled={disabled} />
      </label>
      <label>Estado del registro
        <select value={draft.enabled} onChange={(event) => { update({ enabled: event.target.value }); }} disabled={disabled}>
          <option value="">Sin cambios</option>
          <option value="true" disabled>Habilitado (requiere operación verificada)</option>
          <option value="false">Pausar admisión de entregas</option>
        </select>
      </label>
      <label>Máximo de entregas concurrentes
        <input type="number" min={1} max={100} step={1} value={draft.capacity}
          onChange={(event) => { update({ capacity: event.target.value, noCapacityLimit: false }); }} disabled={disabled} />
      </label>
      <label className="casilla agent-registry-checkbox"><input type="checkbox" checked={draft.noCapacityLimit}
        onChange={(event) => { update({ noCapacityLimit: event.target.checked, ...(event.target.checked ? { capacity: '' } : {}) }); }} disabled={disabled} />
        Sin límite (enviar null)
      </label>
      <p className="settings-source">La ubicación, el arnés y la cuenta principal se cambian en «Operar agente».
        Habilitar la admisión requiere verificar el runtime; pausar este registro no detiene su proceso.</p>
    </div>
    {formError ? <p className="notice error" role="alert">{formError}</p> : null}
    {runner.notice ? <p className={`notice ${runner.notice.tone === 'error' ? 'error' : ''}`}
      role={runner.notice.tone === 'error' ? 'alert' : 'status'}>{runner.notice.text}</p> : null}
    <div className="settings-context-heading">
      <span>Revisión esperada: {String(runner.expectedRevision ?? 'desconocida')}</span>
      <div>
        <button type="button" className="button secondary" onClick={() => { void preview(); }} disabled={disabled}>
          Previsualizar cambio
        </button>{' '}
        <button type="button" className="button primary" onClick={() => { void apply(); }}
          disabled={disabled || !mutation || !runner.isValidated(mutation)}>
          Aplicar cambio
        </button>
      </div>
    </div>
    {runner.preview ? <pre className="config-preview" aria-label="Preview del registro de agente">{runner.preview}</pre> : null}
    {originalName && draft.displayName.trim() === '' ? <p className="settings-source">Nombre actual «{originalName}»; vacío lo quita del registro.</p> : null}
  </section>;
}
