import { useEffect, useMemo, useRef, useState } from 'react';
import { useApi } from '../../api/context';
import { useConsoleAccess } from '../../api/console-access';
import type { ConfigMutation, ConfigurationSnapshot } from '../../api/types';
import type { Resource } from '../../api/use-resource';
import { useConfigMutation, useRevisionEncadenada, type ConfigMutationNotice, type ConfigMutationRunner } from './use-config-mutation';
import { Button, Notice, PREVIEW } from '../../components/kit';
import { CHECK_LABEL, HINT } from './config-ui';
import type { FleetHost } from '@cauce/protocol/fleet-hosts';
import { fleetHostUsable } from '@cauce/protocol/fleet-hosts';
import { agentHostIdOf, agentWriteBlock } from './agent-registry-create';
import { hostUnavailableReason } from './use-fleet-hosts';

type AgentRow = Record<string, unknown> & { tenant_id: string; alias: string };

interface Draft {
  displayName: string;
  enabled: string;
  capacity: string;
  noCapacityLimit: boolean;
  hostId: string;
}

function initialDraft(agent: AgentRow): Draft {
  return {
    hostId: agentHostIdOf(agent) ?? '',
    displayName: typeof agent.display_name === 'string' ? agent.display_name : '',
    enabled: typeof agent.enabled === 'boolean' ? String(agent.enabled) : '',
    capacity: typeof agent.max_concurrent_deliveries === 'number'
      ? String(agent.max_concurrent_deliveries) : '',
    noCapacityLimit: agent.max_concurrent_deliveries === null,
  };
}

function hasRuntime(agent: AgentRow): boolean {
  return agent.runtime_key !== undefined && agent.runtime_key !== null;
}

function hostEditable(agent: AgentRow): boolean {
  return !hasRuntime(agent) || agentHostIdOf(agent) === undefined;
}

function buildMutation(agent: AgentRow, draft: Draft): { mutation?: ConfigMutation; error?: string } {
  const value: Record<string, unknown> = {};
  const originalName = typeof agent.display_name === 'string' ? agent.display_name : '';
  if (draft.displayName !== originalName) {
    const normalized = draft.displayName.trim();
    if (normalized.length > 128) return { error: 'El nombre visible admite hasta 128 caracteres.' };
    value.display_name = normalized || null;
  }

  if (hostEditable(agent) && draft.hostId !== (agentHostIdOf(agent) ?? '')) {
    value.host_id = draft.hostId || null;
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

export function AgentRegistryEditor({ tenantId, alias, snapshot, hosts, onReloaded, onDeleted, initialOpen = false, hideTrigger = false, embedded = false, onDirtyChange, onClose }: {
  tenantId: string; alias: string; snapshot: ConfigurationSnapshot; hosts?: FleetHost[] | undefined;
  onReloaded: (snapshot: ConfigurationSnapshot) => void;
  onDeleted?: (notice: ConfigMutationNotice) => void;
  initialOpen?: boolean; hideTrigger?: boolean; embedded?: boolean; onDirtyChange?: (dirty: boolean) => void; onClose?: () => void;
}) {
  const api = useApi();
  const access = useConsoleAccess();
  const [open, setOpen] = useState(initialOpen);
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
  const current = freshSnapshot ?? snapshot;
  const writeBlock = agentWriteBlock(current, 'update');
  const deleteBlock = agentWriteBlock(current, 'delete');
  const runner = useConfigMutation({
    config: resource, access, encadenado: chained, canal: `agent-registry:${tenantId}/${alias}`,
    ...(writeBlock === undefined ? {} : { bloqueo: writeBlock }),
  });
  const agent = current.agents?.find((row) => row.tenant_id === tenantId && row.alias === alias);
  if (!agent) return null;
  return <div className="min-w-0" data-open={String(open)}>
    {hideTrigger ? null : <Button
      aria-label={`${open ? 'Cerrar' : 'Editar'} registro de ${tenantId}/${alias}`}
      onClick={() => { setOpen((value) => !value); runner.clear(); }}
    >{open ? 'Cerrar registro' : 'Editar registro'}</Button>}
    {open ? <AgentRegistryForm agent={agent as AgentRow} runner={runner} onDeleted={onDeleted} hosts={hosts} embedded={embedded} onDirtyChange={onDirtyChange}
      deleteBlock={deleteBlock} onClose={() => { setOpen(false); runner.clear(); onClose?.(); }} /> : null}
  </div>;
}

function AgentRegistryForm({
  agent, runner, onClose, onDeleted, hosts, deleteBlock, embedded, onDirtyChange,
}: {
  embedded: boolean;
  onDirtyChange: ((dirty: boolean) => void) | undefined;
  agent: AgentRow;
  runner: ConfigMutationRunner;
  onClose: () => void;
  onDeleted?: ((notice: ConfigMutationNotice) => void) | undefined;
  hosts?: FleetHost[] | undefined;
  deleteBlock?: string | undefined;
}) {
  const [draft, setDraft] = useState(() => initialDraft(agent));
  const [formError, setFormError] = useState<string>();
  const [serverRefreshNotice, setServerRefreshNotice] = useState<string>();
  const [deleting, setDeleting] = useState(false);
  const agentVersion = JSON.stringify([
    agent.harness_id, agent.display_name, agent.enabled, agent.max_concurrent_deliveries,
    agent.container_name, agent.runtime_user, agent.home_directory, agent.state_directory, agent.runtime_key,
    agentHostIdOf(agent),
  ]);
  const previousAgentVersion = useRef(agentVersion);
  const baseline = useRef(initialDraft(agent));
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline.current);
  const reportDirty = useRef(onDirtyChange);
  reportDirty.current = onDirtyChange;
  useEffect(() => { reportDirty.current?.(dirty); }, [dirty]);
  useEffect(() => () => { reportDirty.current?.(false); }, []);
  const built = useMemo(() => buildMutation(agent, draft), [agent, draft]);
  const mutation = built.mutation;
  const disabled = !runner.canWrite || runner.busy;
  const editDisabled = disabled || deleting;
  const canDelete = !hasRuntime(agent);
  const currentHost = agentHostIdOf(agent);
  const hostOptions = [...(hosts ?? []), ...(currentHost && !hosts?.some((host) => host.host_id === currentHost)
    ? [{ host_id: currentHost, display_name: currentHost, enabled: true, status: 'unknown' } as FleetHost] : [])];
  const deletion: ConfigMutation = { resource: 'agent', action: 'delete', tenant_id: agent.tenant_id, alias: agent.alias };

  useEffect(() => {
    if (previousAgentVersion.current === agentVersion) return;
    previousAgentVersion.current = agentVersion;
    const edited = JSON.stringify(draftRef.current) !== JSON.stringify(baseline.current);
    baseline.current = initialDraft(agent);
    setDraft(baseline.current);
    setFormError(undefined);
    setDeleting(false);
    setServerRefreshNotice(edited
      ? 'El registro cambió en el servidor. Se descartó el borrador y se cargaron los valores actuales; revísalos antes de previsualizar.'
      : undefined);
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

  async function remove(dryRun: boolean) {
    if (!canDelete || disabled || deleteBlock || (!dryRun && !runner.isValidated(deletion))) return;
    setFormError(undefined);
    if (dryRun) { await runner.run(deletion, true); return; }
    const outcome = await runner.change(deletion, false);
    runner.clear();
    if (!outcome.ok) { runner.informar({ text: outcome.message, tone: 'error' }); return; }
    const reread = outcome.recarga?.releido === true ? outcome.recarga : undefined;
    const notice: ConfigMutationNotice = {
      text: `Registro de ${agent.tenant_id}/${agent.alias} eliminado en revisión ${String(outcome.result.revision)}.`
        + (reread ? ` Inventario releído en revisión ${String(reread.revision)}.` : ' La relectura no quedó acreditada; actualiza el inventario antes de seguir.'),
      tone: reread ? 'success' : 'parcial',
    };
    runner.informar(notice); onDeleted?.(notice);
  }

  const originalName = typeof agent.display_name === 'string' ? agent.display_name : '';
  return <section className={embedded ? 'grid min-w-0 grid-cols-1 gap-4' : 'mt-3 grid grid-cols-1 gap-3 rounded-lg border border-line bg-subtle p-4'}
    aria-label={`Registro de ${agent.tenant_id}/${agent.alias}`}>
    {embedded ? null : <div className="flex flex-wrap items-center justify-between gap-3">
      <h3>Registro · {agent.tenant_id}/{agent.alias}</h3>
      <Button onClick={onClose}>Cerrar editor</Button>
    </div>}
    <p className={HINT}>Identidad fija desde la fila seleccionada. Los permisos se vuelven a decidir en el servidor.</p>
    {runner.canWrite ? null : <Notice role="note">Edición de registro en solo lectura: falta permiso acreditado de configuración.</Notice>}
    {serverRefreshNotice ? <Notice role="note">{serverRefreshNotice}</Notice> : null}
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <label>Nombre visible
        <input maxLength={128} value={draft.displayName}
          onChange={(event) => { update({ displayName: event.target.value }); }} disabled={editDisabled} />
      </label>
      {hostEditable(agent)
        ? <label>Computadora
          <select value={draft.hostId} onChange={(event) => { update({ hostId: event.target.value }); }} disabled={editDisabled}>
            {hasRuntime(agent) ? <option value="" disabled>Elige una computadora</option> : <option value="">Sin computadora</option>}
            {hostOptions.map((host) => <option key={host.host_id} value={host.host_id} disabled={!fleetHostUsable(host)}>
              {host.display_name}{fleetHostUsable(host) ? '' : host.enabled ? ' · sin conexión' : ' · deshabilitada'}
            </option>)}
          </select>
          {hasRuntime(agent) ? <span className={HINT}>
            Asigna la computadora donde ya corre este agente; después solo se cambia con una operación de flota.</span> : null}
          {hostUnavailableReason(hostOptions.find((host) => host.host_id === draft.hostId)) ? <span className={HINT}>
            {hostUnavailableReason(hostOptions.find((host) => host.host_id === draft.hostId))}</span> : null}
        </label>
        : <p className={HINT}>Computadora: {hostOptions.find((host) => host.host_id === currentHost)?.display_name ?? currentHost}.
          {hasRuntime(agent) ? ' La computadora se elige al crear; trasladar un agente no está soportado.' : ''}</p>}
      <label>Estado del registro
        <select value={draft.enabled} onChange={(event) => { update({ enabled: event.target.value }); }} disabled={editDisabled}>
          <option value="">Sin cambios</option>
          <option value="true" disabled>Habilitado (requiere operación verificada)</option>
          <option value="false">Pausar admisión de entregas</option>
        </select>
      </label>
      <label>Máximo de entregas concurrentes
        <input type="number" min={1} max={100} step={1} value={draft.capacity}
          onChange={(event) => { update({ capacity: event.target.value, noCapacityLimit: false }); }} disabled={editDisabled} />
      </label>
      <label className={CHECK_LABEL}><input type="checkbox" checked={draft.noCapacityLimit}
        onChange={(event) => { update({ noCapacityLimit: event.target.checked, ...(event.target.checked ? { capacity: '' } : {}) }); }} disabled={editDisabled} />
        Sin límite (enviar null)
      </label>
      <p className={HINT}>La ubicación, el arnés y la cuenta principal se cambian en «Operar agente».
        Habilitar la admisión requiere verificar el runtime; pausar este registro no detiene su proceso.</p>
    </div>
    {formError ? <Notice tone="danger" role="alert">{formError}</Notice> : null}
    {runner.notice ? <Notice tone={runner.notice.tone === 'error' ? 'danger' : 'info'}
      role={runner.notice.tone === 'error' ? 'alert' : 'status'}>{runner.notice.text}</Notice> : null}
    <div className="flex flex-wrap items-center justify-between gap-3">
      <span>Revisión esperada: {String(runner.expectedRevision ?? 'desconocida')}</span>
      <div>
        <Button onClick={() => { void preview(); }} disabled={disabled || deleting}>
          Previsualizar cambio
        </Button>{' '}
        <Button variant="primary" onClick={() => { void apply(); }}
          disabled={disabled || deleting || !mutation || !runner.isValidated(mutation)}>
          Aplicar cambio
        </Button>
      </div>
    </div>
    {canDelete ? <Button className="justify-self-start" disabled={disabled || deleting || Boolean(deleteBlock)} title={deleteBlock}
      onClick={() => { setDeleting(true); runner.clear(); setFormError(undefined); }}>Eliminar registro</Button>
      : <p className={HINT}>Un agente con ejecución se retira con «Retirar agente» en la fila del agente.</p>}
    {deleting && canDelete ? <form className="grid gap-3" aria-label={`Eliminar registro de ${agent.tenant_id}/${agent.alias}`}
      onSubmit={(event) => { event.preventDefault(); void remove(true); }}>
      <p>Eliminar este registro requiere comprobar sus dependencias. Previsualiza antes de confirmar.</p>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={disabled}>Previsualizar eliminación</Button>
        <Button variant="primary" disabled={disabled || !runner.isValidated(deletion)}
          onClick={() => { void remove(false); }}>Confirmar eliminación del registro</Button>
        <Button disabled={runner.busy}
          onClick={() => { setDeleting(false); runner.clear(); }}>Cancelar eliminación</Button>
      </div>
    </form> : null}
    {runner.preview ? <pre className={PREVIEW} aria-label="Preview del registro de agente">{runner.preview}</pre> : null}
    {originalName && draft.displayName.trim() === '' ? <p className={HINT}>Nombre actual «{originalName}»; vacío lo quita del registro.</p> : null}
  </section>;
}
