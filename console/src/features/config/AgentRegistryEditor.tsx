import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useApi } from '../../api/context';
import { useConsoleAccess } from '../../api/console-access';
import type { ConfigMutation, ConfigurationSnapshot } from '../../api/types';
import type { Resource } from '../../api/use-resource';
import { useConfigMutation, useRevisionEncadenada, type ConfigMutationNotice, type ConfigMutationRunner } from './use-config-mutation';
import { Button, Notice, PREVIEW } from '../../components/kit';
import { BLOCK_TITLE, CHECK_LABEL, HINT } from './config-ui';
import type { FleetHost } from '@cauce/protocol/fleet-hosts';
import { fleetHostUsable } from '@cauce/protocol/fleet-hosts';
import { agentHostIdOf, agentWriteBlock } from './agent-registry-create';
import { hostUnavailableReason } from './use-fleet-hosts';
import { AgentQuotaBinding } from './AgentQuotaBinding';
import { diffConflictFields, type ConflictFieldDiff } from '../../components/conflict';
import { ConflictNotice } from '../../components/ConflictNotice';

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

function buildMutation(agent: AgentRow, draft: Draft, baseline: Draft): { mutation?: ConfigMutation; error?: string } {
  const value: Record<string, unknown> = {};
  const originalName = typeof agent.display_name === 'string' ? agent.display_name : '';
  // Only what the draft changed against its own base is sent: a concurrent save of another field
  // is never reverted by resending the stale value this form happened to be showing.
  if (draft.displayName !== baseline.displayName && draft.displayName !== originalName) {
    const normalized = draft.displayName.trim();
    if (normalized.length > 128) return { error: 'El nombre visible admite hasta 128 caracteres.' };
    value.display_name = normalized || null;
  }

  if (hostEditable(agent) && draft.hostId !== baseline.hostId && draft.hostId !== (agentHostIdOf(agent) ?? '')) {
    value.host_id = draft.hostId || null;
  }

  if (draft.enabled !== baseline.enabled && draft.enabled !== '' && draft.enabled !== String(agent.enabled)) {
    if (draft.enabled !== 'false') return { error: 'Reanudar la recepción requiere una operación verificada desde «Ejecución».' };
    value.enabled = false;
  }

  const originalCapacity = agent.max_concurrent_deliveries;
  const capacityTouched = draft.noCapacityLimit !== baseline.noCapacityLimit || draft.capacity !== baseline.capacity;
  if (capacityTouched && draft.noCapacityLimit) {
    if (originalCapacity !== null) value.max_concurrent_deliveries = null;
  } else if (capacityTouched && draft.capacity !== '') {
    if (!/^[0-9]+$/u.test(draft.capacity)) return { error: 'La capacidad debe ser un entero entre 1 y 100.' };
    const capacity = Number(draft.capacity);
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 100) {
      return { error: 'La capacidad debe ser un entero entre 1 y 100.' };
    }
    if (capacity !== originalCapacity) value.max_concurrent_deliveries = capacity;
  } else if (capacityTouched && typeof originalCapacity === 'number') {
    return { error: 'Indica una capacidad o marca «Sin límite» para enviar null.' };
  }

  if (Object.keys(value).length === 0) return { error: 'Cambia al menos un campo antes de previsualizar.' };
  return {
    mutation: {
      resource: 'agent', action: 'update', tenant_id: agent.tenant_id, alias: agent.alias, value,
    },
  };
}

/** The agent's «Ajustes» tab: name, computer, message intake and capacity, plus the accounts its quota reads from. */
export function AgentRegistryEditor({ tenantId, alias, snapshot, hosts, onReloaded, onDeleted, onDirtyChange }: {
  tenantId: string; alias: string; snapshot: ConfigurationSnapshot; hosts?: FleetHost[] | undefined;
  onReloaded: (snapshot: ConfigurationSnapshot) => void;
  onDeleted?: (notice: ConfigMutationNotice) => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const api = useApi();
  const access = useConsoleAccess();
  const [registryDirty, setRegistryDirty] = useState(false);
  const [quotaDirty, setQuotaDirty] = useState(false);
  useEffect(() => { onDirtyChange?.(registryDirty || quotaDirty); }, [onDirtyChange, registryDirty, quotaDirty]);
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
    config: resource, access, encadenado: chained, canal: `agent-registry:${tenantId}/${alias}`, redoDryRunOnConflict: false,
    ...(writeBlock === undefined ? {} : { bloqueo: writeBlock }),
  });
  const agent = current.agents?.find((row) => row.tenant_id === tenantId && row.alias === alias);
  if (!agent) return null;
  return <AgentRegistryForm agent={agent as AgentRow} runner={runner} onDeleted={onDeleted} hosts={hosts} onDirtyChange={setRegistryDirty}
    deleteBlock={deleteBlock} quota={<AgentQuotaBinding key={`${tenantId}/${alias}`} tenantId={tenantId} alias={alias} snapshot={current}
      onReloaded={onReloaded} onDirtyChange={setQuotaDirty} />} />;
}

function AgentRegistryForm({
  agent, runner, onDeleted, hosts, deleteBlock, onDirtyChange, quota,
}: {
  onDirtyChange: ((dirty: boolean) => void) | undefined;
  agent: AgentRow;
  runner: ConfigMutationRunner;
  /** The quota accounts block, placed between the settings and the deletion zone. */
  quota: ReactNode;
  onDeleted?: ((notice: ConfigMutationNotice) => void) | undefined;
  hosts?: FleetHost[] | undefined;
  deleteBlock?: string | undefined;
}) {
  const [draft, setDraft] = useState(() => initialDraft(agent));
  const [formError, setFormError] = useState<string>();
  const [conflictDiffs, setConflictDiffs] = useState<ConflictFieldDiff[]>();
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
  const built = useMemo(() => buildMutation(agent, draft, baseline.current), [agent, draft]);
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
    const fresh = initialDraft(agent);
    const mine = draftRef.current;
    const edited = JSON.stringify(mine) !== JSON.stringify(baseline.current);
    setFormError(undefined);
    setDeleting(false);
    const changedKeys = (Object.keys(fresh) as (keyof Draft)[]).filter((key) => mine[key] !== baseline.current[key]);
    const landed = changedKeys.every((key) => mine[key] === fresh[key]);
    if (!edited || landed || JSON.stringify(mine) === JSON.stringify(fresh)) {
      baseline.current = fresh;
      setDraft(fresh);
      setConflictDiffs(undefined);
      return;
    }
    // The draft survives a concurrent save: only the panel below may settle it.
    setConflictDiffs(diffConflictFields(
      { display_name: mine.displayName, host_id: mine.hostId, enabled: mine.enabled, capacity: mine.noCapacityLimit ? null : mine.capacity },
      {
        display_name: fresh.displayName, host_id: fresh.hostId, enabled: fresh.enabled,
        capacity: fresh.noCapacityLimit ? null : fresh.capacity,
      },
      {
        display_name: 'Nombre visible', host_id: 'Computadora', enabled: 'Recepción de mensajes',
        capacity: 'Mensajes a la vez',
      },
    ));
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
  return <section className="grid min-w-0 grid-cols-1 gap-6" aria-label={`Registro de ${agent.tenant_id}/${agent.alias}`}>
    <div className="grid min-w-0 grid-cols-1 gap-4">
      <div className="grid gap-1">
        <h3 className={BLOCK_TITLE}>Ajustes del agente</h3>
        <p className={HINT}>Revisa el cambio con «Previsualizar cambio» y después pulsa «Aplicar cambio». La ubicación, el arnés y la cuenta principal se cambian en «Ejecución».</p>
      </div>
      {runner.canWrite ? null : <Notice role="note">Solo lectura: tu cuenta no tiene permiso para cambiar los ajustes.</Notice>}
      {conflictDiffs ? <ConflictNotice diffs={conflictDiffs} busy={runner.busy}
        onRetry={() => { setConflictDiffs(undefined); void preview(); }}
        onDiscard={() => {
          const fresh = initialDraft(agent);
          baseline.current = fresh;
          setDraft(fresh);
          setConflictDiffs(undefined);
          runner.clear();
        }} /> : null}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="grid content-start gap-1">
          <label>Nombre visible
            <input maxLength={128} value={draft.displayName}
              onChange={(event) => { update({ displayName: event.target.value }); }} disabled={editDisabled} />
          </label>
          {originalName && draft.displayName.trim() === '' ? <span className={HINT}>Nombre actual «{originalName}»; vacío lo quita.</span> : null}
        </div>
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
          : <div className="grid content-start gap-1 text-[13px]"><span className="font-medium">Computadora</span>
            <span>{hostOptions.find((host) => host.host_id === currentHost)?.display_name ?? currentHost}</span>
            {hasRuntime(agent) ? <span className={HINT}>Se elige al crear el agente; trasladarlo a otra computadora no está soportado.</span> : null}</div>}
        <div className="grid content-start gap-1">
          <label>Recepción de mensajes
            <select value={draft.enabled} onChange={(event) => { update({ enabled: event.target.value }); }} disabled={editDisabled}>
              <option value="">Sin cambios</option>
              <option value="true" disabled>Activo: recibe mensajes</option>
              <option value="false">Pausar: deja de recibir mensajes nuevos</option>
            </select>
          </label>
          <span className={HINT}>Pausar no detiene el programa que ya está corriendo; reanudar se hace en «Ejecución».</span>
        </div>
        <div className="grid content-start gap-2">
          <label>Mensajes a la vez
            <input type="number" min={1} max={100} step={1} value={draft.capacity}
              onChange={(event) => { update({ capacity: event.target.value, noCapacityLimit: false }); }} disabled={editDisabled} />
          </label>
          <label className={CHECK_LABEL}><input type="checkbox" checked={draft.noCapacityLimit}
            onChange={(event) => { update({ noCapacityLimit: event.target.checked, ...(event.target.checked ? { capacity: '' } : {}) }); }} disabled={editDisabled} />
            Sin límite
          </label>
        </div>
      </div>
      {formError ? <Notice tone="danger" role="alert">{formError}</Notice> : null}
      {runner.notice ? <Notice tone={runner.notice.tone === 'error' ? 'danger' : 'info'}
        role={runner.notice.tone === 'error' ? 'alert' : 'status'}>{runner.notice.text}</Notice> : null}
      <div className="flex flex-wrap items-center justify-end gap-2" title={`Revisión esperada: ${String(runner.expectedRevision ?? 'desconocida')}`}>
        <Button onClick={() => { void preview(); }} disabled={disabled || deleting}>
          Previsualizar cambio
        </Button>
        <Button variant="primary" onClick={() => { void apply(); }}
          disabled={disabled || deleting || !mutation || !runner.isValidated(mutation)}>
          Aplicar cambio
        </Button>
      </div>
      {runner.preview && !deleting ? <pre className={PREVIEW} aria-label="Preview del registro de agente">{runner.preview}</pre> : null}
    </div>
    {quota}
    {canDelete ? <div className="grid gap-3 rounded-lg border border-danger/30 p-4">
      <h3 className="m-0 text-sm font-semibold text-danger-ink">Eliminar este agente</h3>
      <p className={HINT}>Como nunca se puso en marcha, se borran con él su perfil, sus cuentas vinculadas, su apariencia y sus membresías
        sin historial. Si no queda historial, el alias queda libre para otro agente; si queda, el alias sigue reservado para no mezclar
        historiales. No se puede deshacer.</p>
      {deleting ? <form className="grid gap-3" aria-label={`Eliminar registro de ${agent.tenant_id}/${agent.alias}`} onSubmit={(event) => { event.preventDefault(); void remove(true); }}>
        <p className="m-0 text-[13px]">Previsualiza la eliminación para comprobar sus dependencias y después confírmala.</p>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={disabled}>Previsualizar eliminación</Button>
          <Button variant="danger" disabled={disabled || !runner.isValidated(deletion)}
            onClick={() => { void remove(false); }}>Confirmar eliminación del registro</Button>
          <Button disabled={runner.busy}
            onClick={() => { setDeleting(false); runner.clear(); }}>Cancelar eliminación</Button>
        </div>
        {runner.preview ? <pre className={PREVIEW} aria-label="Preview del registro de agente">{runner.preview}</pre> : null}
      </form> : <div><Button variant="danger" disabled={disabled || Boolean(deleteBlock)} title={deleteBlock}
        onClick={() => { setDeleting(true); runner.clear(); setFormError(undefined); }}>Eliminar registro</Button></div>}
    </div> : <p className={HINT}>Este agente ya se puso en marcha: para quitarlo, usa «Retirar o eliminar» en la pestaña «Estado».</p>}
  </section>;
}
