import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { fleetHostUsable } from '@cauce/protocol/fleet-hosts';
import type { ConfigMutation, ConfigurationSnapshot } from '../../api/types';
import { useApi } from '../../api/context';
import { useConsoleAccess } from '../../api/console-access';
import type { Resource } from '../../api/use-resource';
import {
  agentRegistryCreateError, agentWriteBlock, createAgentRegistryMutation, createAgentRoomMembershipMutation,
  EMPTY_AGENT_REGISTRY_DRAFT, registryHarnessOptions, registryRoomOptions, registryTenantOptions,
  type AgentRegistryCreateDraft,
} from './agent-registry-create';
import { FormDialog } from '../../components/dialogs';
import { Button, Notice, PREVIEW } from '../../components/kit';
import { useConfigMutation, useRevisionEncadenada } from './use-config-mutation';
import { hostById, hostUnavailableReason, useFleetHosts } from './use-fleet-hosts';
import { useAgentLifecycle } from './use-agent-lifecycle';
import { agentLifecycleDraft } from './agent-lifecycle-model';
import { AgentLifecyclePanel } from './AgentLifecyclePanel';

interface CreatedAgent {
  tenantId: string; alias: string; displayName: string; harnessId: string; hostId: string; roomLabel?: string;
}

interface RoomStep { mutation: ConfigMutation; stage: 'queued' | 'checking' | 'ready' | 'applying' | 'done' | 'failed' }

const ROOM_STATUS: Record<RoomStep['stage'], string> = {
  queued: 'pendiente', checking: 'pendiente', ready: 'pendiente', applying: 'pendiente', done: 'creada', failed: 'no creada',
};
const FLEET_REASON: Record<string, string> = {
  executor_unconfigured: 'El ejecutor de flota no está configurado en el servidor.',
  unsupported_schema: 'El ejecutor de flota publicado usa un esquema que esta consola no admite.',
};

export function AgentRegistryCreate({ snapshot, open, onOpenChange, onReloaded, focusReturnRef }: {
  snapshot: ConfigurationSnapshot;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onReloaded: (snapshot: ConfigurationSnapshot) => void;
  focusReturnRef: RefObject<HTMLButtonElement | null>;
}) {
  const api = useApi();
  const access = useConsoleAccess();
  const fleet = useFleetHosts(open, snapshot.revision);
  const lifecycle = useAgentLifecycle(open);
  const [freshSnapshot, setFreshSnapshot] = useState<ConfigurationSnapshot>();
  const [draft, setDraft] = useState<AgentRegistryCreateDraft>(EMPTY_AGENT_REGISTRY_DRAFT);
  const [formError, setFormError] = useState<string>();
  const [created, setCreated] = useState<CreatedAgent>();
  const [roomStep, setRoomStep] = useState<RoomStep>();
  const aliasInput = useRef<HTMLInputElement>(null);
  const chained = useRevisionEncadenada();
  const activeSnapshot = typeof freshSnapshot?.revision === 'number'
    && (typeof snapshot.revision !== 'number' || freshSnapshot.revision > snapshot.revision) ? freshSnapshot : snapshot;
  const config: Resource<ConfigurationSnapshot> = {
    data: activeSnapshot,
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
  const writeBlock = agentWriteBlock(activeSnapshot, 'create');
  const runner = useConfigMutation({
    config, access, encadenado: chained, canal: 'agent-registry:create',
    ...(writeBlock === undefined ? {} : { bloqueo: writeBlock }),
  });
  const clearRunner = useRef(runner.clear);
  clearRunner.current = runner.clear;
  const tenants = useMemo(() => registryTenantOptions(activeSnapshot), [activeSnapshot]);
  const harnesses = useMemo(() => registryHarnessOptions(activeSnapshot), [activeSnapshot]);
  const rooms = useMemo(() => registryRoomOptions(activeSnapshot, draft.tenantId), [activeSnapshot, draft.tenantId]);
  const hosts = fleet.hosts ?? [];
  const hostReason = hostUnavailableReason(hostById(fleet.hosts, draft.hostId));
  const error = agentRegistryCreateError(draft, activeSnapshot);
  const mutation = error ? undefined : createAgentRegistryMutation(draft);
  const busy = runner.busy || (roomStep !== undefined && roomStep.stage !== 'done' && roomStep.stage !== 'failed');
  const disabled = busy || !runner.canWrite;
  const clearNoticeOnNextOpen = useRef(false);
  const fleetReason = lifecycle.capabilityError
    ?? (lifecycle.capability === undefined ? 'Leyendo capacidades de flota…'
      : lifecycle.capability.available ? undefined
        : FLEET_REASON[lifecycle.capability.reason ?? ''] ?? 'La preparación en computadora no está disponible en este servidor.');

  useEffect(() => {
    if (open && clearNoticeOnNextOpen.current) {
      clearRunner.current();
      clearNoticeOnNextOpen.current = false;
      setCreated(undefined);
      setRoomStep(undefined);
    }
  }, [open]);

  useEffect(() => {
    if (!roomStep) return;
    if (roomStep.stage === 'queued') {
      setRoomStep({ ...roomStep, stage: 'checking' });
      void runner.run(roomStep.mutation, true).then((ok) => { setRoomStep({ ...roomStep, stage: ok ? 'ready' : 'failed' }); });
    } else if (roomStep.stage === 'ready') {
      setRoomStep({ ...roomStep, stage: 'applying' });
      void runner.run(roomStep.mutation, false).then((ok) => { setRoomStep({ ...roomStep, stage: ok ? 'done' : 'failed' }); });
    }
  }, [roomStep, runner]);

  function edit(patch: Partial<AgentRegistryCreateDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
    setFormError(undefined);
    runner.clear();
  }

  async function preview() {
    if (error || !mutation) {
      setFormError(error ?? 'Completa los datos requeridos.');
      runner.clear();
      return;
    }
    setFormError(undefined);
    await runner.run(mutation, true);
  }

  async function apply() {
    if (error || !mutation) {
      setFormError(error ?? 'Completa los datos requeridos.');
      runner.clear();
      return;
    }
    if (hostReason) {
      setFormError(hostReason);
      return;
    }
    if (!runner.isValidated(mutation)) return;
    setFormError(undefined);
    if (!(await runner.run(mutation, false))) return;
    const roomLabel = rooms.find((room) => room.id === draft.roomId)?.label;
    clearNoticeOnNextOpen.current = true;
    setCreated({
      tenantId: draft.tenantId, alias: draft.alias.trim(), displayName: draft.displayName.trim(),
      harnessId: draft.harnessId.trim(), hostId: draft.hostId, ...(roomLabel === undefined ? {} : { roomLabel }),
    });
    setDraft(EMPTY_AGENT_REGISTRY_DRAFT);
    if (draft.roomId) setRoomStep({ mutation: createAgentRoomMembershipMutation(draft), stage: 'queued' });
  }

  const preparedDraft = created ? {
    ...agentLifecycleDraft(activeSnapshot), tenantId: created.tenantId, alias: created.alias,
    displayName: created.displayName, harnessId: created.harnessId, hostId: created.hostId,
  } : undefined;

  return <FormDialog open={open} wide busy={busy} title="Añadir agente" initialFocus={aliasInput} finalFocus={focusReturnRef}
    description="Este cambio requiere permiso para administrar el registro. El servidor lo verifica al previsualizar."
    onClose={() => { onOpenChange(false); }}>
    {created ? <div className="grid gap-3" aria-label="Resultado del alta de agente">
      <Notice tone="ok" role="status">Registro creado: {created.tenantId}/{created.alias}.</Notice>
      <ul className="m-0 grid list-none gap-1 p-0 text-sm">
        <li>Computadora: {hostById(fleet.hosts, created.hostId)?.display_name ?? (created.hostId || 'sin asignar')}</li>
        {created.roomLabel ? <li>Sala inicial: {created.roomLabel}, {ROOM_STATUS[roomStep?.stage ?? 'done']}.</li> : null}
      </ul>
      {runner.notice ? <Notice tone={runner.notice.tone === 'error' ? 'danger' : 'info'}
        role={runner.notice.tone === 'error' ? 'alert' : 'status'}>{runner.notice.text}</Notice> : null}
      {created.hostId ? <div className="grid gap-2">
        <p className="m-0 text-xs text-muted">Siguiente paso: preparar el agente en su computadora. Así queda su entorno de ejecución listo para admitir entregas.</p>
        {fleetReason ? <Notice role="note">{fleetReason}</Notice> : null}
        {preparedDraft && !fleetReason ? <AgentLifecyclePanel snapshot={activeSnapshot} onReloaded={onReloaded}
          initialDraft={preparedDraft} triggerLabel="Preparar en la computadora" /> : null}
      </div> : <Notice role="note">Asigna una computadora en Editar registro para prepararlo.</Notice>}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="primary" onClick={() => { onOpenChange(false); }}>Terminar</Button>
      </div>
    </div> : <>
      {writeBlock ? <Notice role="note">{writeBlock}</Notice>
        : !runner.canWrite ? <Notice role="note">
          Tu cuenta no tiene permiso para modificar este registro, o no pudimos verificarlo.
        </Notice> : null}
      {!tenants.length ? <Notice role="note">No hay espacios de trabajo publicados en esta lectura; no se puede elegir destino.</Notice> : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <label>Espacio de trabajo
          <select value={draft.tenantId} onChange={(event) => { edit({ tenantId: event.target.value, roomId: '' }); }} disabled={disabled}>
            <option value="">Elige un espacio de trabajo</option>
            {tenants.map((tenant) => <option key={tenant.id} value={tenant.id}>{tenant.label}</option>)}
          </select>
        </label>
        <label>Alias
          <input ref={aliasInput} value={draft.alias} maxLength={64} pattern="[a-z][a-z0-9_-]{0,63}"
            onChange={(event) => { edit({ alias: event.target.value }); }} disabled={disabled} />
        </label>
        <label>Nombre visible
          <input value={draft.displayName} maxLength={128}
            onChange={(event) => { edit({ displayName: event.target.value }); }} disabled={disabled} />
        </label>
        <label>Tipo de agente (opcional)
          {harnesses.length ? <select value={draft.harnessId} onChange={(event) => { edit({ harnessId: event.target.value }); }} disabled={disabled}>
            <option value="">Sin declarar</option>
            {harnesses.map((harness) => <option key={harness} value={harness}>{harness}</option>)}
          </select> : <input value={draft.harnessId} maxLength={64} placeholder="p. ej. codex"
            onChange={(event) => { edit({ harnessId: event.target.value }); }} disabled={disabled} />}
        </label>
        <label>Máximo de entregas concurrentes
          <input type="number" min={1} max={100} step={1} value={draft.capacity}
            onChange={(event) => { edit({ capacity: event.target.value }); }} disabled={disabled} />
        </label>
        <label>Computadora (opcional)
          <select value={draft.hostId} onChange={(event) => { edit({ hostId: event.target.value }); }} disabled={disabled}>
            <option value="">Sin computadora por ahora</option>
            {hosts.map((host) => <option key={host.host_id} value={host.host_id} disabled={!fleetHostUsable(host)}>
              {host.display_name}{fleetHostUsable(host) ? '' : host.enabled ? ' · sin conexión' : ' · deshabilitada'}
            </option>)}
          </select>
        </label>
        {hostReason ? <Notice role="alert" className="sm:col-span-2">{hostReason}</Notice> : null}
        <label>Sala inicial (opcional)
          <select value={draft.roomId} onChange={(event) => { edit({ roomId: event.target.value }); }} disabled={disabled || !rooms.length}>
            <option value="">Sin sala inicial</option>
            {rooms.map((room) => <option key={room.id} value={room.id}>{room.label}</option>)}
          </select>
        </label>
        {draft.roomId ? <label>Rol en la sala
          <input value={draft.roomRole} maxLength={64} onChange={(event) => { edit({ roomRole: event.target.value }); }} disabled={disabled} />
        </label> : null}
        <details className="grid gap-2 sm:col-span-2">
          <summary className="cursor-pointer text-[13px] font-medium">Entorno de ejecución (opcional)</summary>
          <p className="m-0 my-2 text-xs text-muted">Indica el contenedor, el usuario y sus dos directorios. Completa los cuatro campos o déjalos vacíos; no se generan valores.</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <label>Nombre del contenedor
              <input value={draft.containerName} onChange={(event) => { edit({ containerName: event.target.value }); }} disabled={disabled} />
            </label>
            <label>Usuario de ejecución
              <input value={draft.runtimeUser} onChange={(event) => { edit({ runtimeUser: event.target.value }); }} disabled={disabled} />
            </label>
            <label>Directorio personal
              <input value={draft.homeDirectory} onChange={(event) => { edit({ homeDirectory: event.target.value }); }} disabled={disabled} />
            </label>
            <label>Directorio de estado
              <input value={draft.stateDirectory} onChange={(event) => { edit({ stateDirectory: event.target.value }); }} disabled={disabled} />
            </label>
          </div>
        </details>
      </div>
      <p className="m-0 text-xs text-muted">La sala inicial se añade después de crear el registro, con su propia validación del servidor.</p>
      {formError ? <Notice tone="danger" role="alert">{formError}</Notice> : null}
      {runner.notice ? <Notice tone={runner.notice.tone === 'error' ? 'danger' : 'info'}
        role={runner.notice.tone === 'error' ? 'alert' : 'status'}>{runner.notice.text}</Notice> : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-xs text-muted">Revisión esperada: {String(runner.expectedRevision ?? 'desconocida')}</span>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => { void preview(); }} disabled={disabled || !tenants.length}>Previsualizar alta</Button>
          <Button variant="primary" onClick={() => { void apply(); }}
            disabled={disabled || !mutation || !runner.isValidated(mutation) || Boolean(hostReason)}>Crear registro</Button>
        </div>
      </div>
      {runner.preview ? <pre className={PREVIEW} aria-label="Preview del alta de agente">{runner.preview}</pre> : null}
    </>}
  </FormDialog>;
}
