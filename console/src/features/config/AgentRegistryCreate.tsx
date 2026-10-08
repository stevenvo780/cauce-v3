import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Dialog } from '@base-ui/react/dialog';
import type { ConfigMutation, ConfigurationSnapshot } from '../../api/types';
import { useApi } from '../../api/context';
import { useConsoleAccess } from '../../api/console-access';
import type { Resource } from '../../api/use-resource';
import {
  agentCreateStepError, agentRegistryCreateError, agentWriteBlock, CREATE_STEPS, STEP_LABEL, type CreateStep, createAgentRegistryMutation, createAgentRoomMembershipMutation,
  EMPTY_AGENT_REGISTRY_DRAFT, registryHarnessOptions, registryRoomOptions, registryTenantOptions,
  type AgentRegistryCreateDraft,
} from './agent-registry-create';
import { Button, Notice, PREVIEW } from '../../components/kit';
import { useConfigMutation, useRevisionEncadenada } from './use-config-mutation';
import { hostById, hostUnavailableReason, useFleetHosts } from './use-fleet-hosts';
import { useAgentLifecycle } from './use-agent-lifecycle';
import { agentLifecycleDraft } from './agent-lifecycle-model';
import { AgentLifecyclePanel } from './AgentLifecyclePanel';
import { DIALOG_BODY, DIALOG_FOOTER, WIZARD_POPUP, WizardHeader } from './config-dialog';
import {
  GroupsStep, IdentityStep, ModeChoice, PlacementStep, ReviewSummary, Stepper, type CreateMode,
} from './AgentCreateSteps';

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

export function AgentRegistryCreate({ snapshot, open, onOpenChange, onReloaded, focusReturnRef, onOpenAgent }: {
  snapshot: ConfigurationSnapshot;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onReloaded: (snapshot: ConfigurationSnapshot) => void;
  focusReturnRef: RefObject<HTMLButtonElement | null>;
  onOpenAgent?: (ref: string) => void;
}) {
  const api = useApi();
  const access = useConsoleAccess();
  const fleet = useFleetHosts(open, snapshot.revision);
  const lifecycle = useAgentLifecycle(open);
  const [freshSnapshot, setFreshSnapshot] = useState<ConfigurationSnapshot>();
  const [draft, setDraft] = useState<AgentRegistryCreateDraft>(EMPTY_AGENT_REGISTRY_DRAFT);
  const [formError, setFormError] = useState<string>();
  const [step, setStep] = useState<CreateStep>('identidad');
  const [mode, setMode] = useState<CreateMode>('register');
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
    setStep('identidad');
    if (draft.roomId) setRoomStep({ mutation: createAgentRoomMembershipMutation(draft), stage: 'queued' });
  }

  const stepIndex = CREATE_STEPS.indexOf(step);
  const stepFields = { draft, edit, disabled };

  function next() {
    const problem = agentCreateStepError(step, draft, activeSnapshot) ?? (step === 'computadora' ? hostReason : undefined);
    if (problem) { setFormError(problem); return; }
    setFormError(undefined);
    runner.clear();
    setStep(CREATE_STEPS[Math.min(stepIndex + 1, CREATE_STEPS.length - 1)] ?? 'revision');
  }

  function back() {
    setFormError(undefined);
    runner.clear();
    setStep(CREATE_STEPS[Math.max(stepIndex - 1, 0)] ?? 'identidad');
  }

  const preparedDraft = created ? {
    ...agentLifecycleDraft(activeSnapshot), tenantId: created.tenantId, alias: created.alias,
    displayName: created.displayName, harnessId: created.harnessId, hostId: created.hostId,
  } : undefined;
  const tenantLabel = tenants.find((tenant) => tenant.id === draft.tenantId)?.label ?? draft.tenantId;
  const hostLabel = hostById(fleet.hosts, draft.hostId)?.display_name ?? (draft.hostId || 'Sin computadora por ahora');
  const roomLabel = rooms.find((room) => room.id === draft.roomId)?.label;
  const preparing = !created && mode === 'prepare';

  const permissionNotice = writeBlock ? <Notice role="note">{writeBlock}</Notice>
    : !runner.canWrite ? <Notice role="note">
      Tu cuenta no tiene permiso para modificar este registro, o no pudimos verificarlo.
    </Notice> : null;
  const notices = <>
    {formError ? <Notice tone="danger" role="alert">{formError}</Notice> : null}
    {runner.notice ? <Notice tone={runner.notice.tone === 'error' ? 'danger' : 'info'}
      role={runner.notice.tone === 'error' ? 'alert' : 'status'}>{runner.notice.text}</Notice> : null}
  </>;

  return <Dialog.Root open={open} onOpenChange={(next) => { if (!next && !busy) onOpenChange(false); }}>
    <Dialog.Portal>
      <Dialog.Backdrop className="fixed inset-0 z-50 bg-scrim" />
      <Dialog.Popup initialFocus={aliasInput} finalFocus={focusReturnRef} className={WIZARD_POPUP}>
        <WizardHeader busy={busy} title="Añadir agente"
          description="Este cambio requiere permiso para administrar el registro. El servidor lo verifica al previsualizar." />
        {created ? <>
          <div className={`${DIALOG_BODY} grid content-start gap-3`} aria-label="Resultado del alta de agente">
            <Notice tone="ok" role="status">Registro creado: {created.tenantId}/{created.alias}.</Notice>
            <ul className="m-0 grid list-none gap-1 p-0 text-sm">
              <li>Computadora: {hostById(fleet.hosts, created.hostId)?.display_name ?? (created.hostId || 'sin asignar')}</li>
              {created.roomLabel ? <li>Grupo inicial: {created.roomLabel}, {ROOM_STATUS[roomStep?.stage ?? 'done']}.</li> : null}
            </ul>
            {runner.notice ? <Notice tone={runner.notice.tone === 'error' ? 'danger' : 'info'}
              role={runner.notice.tone === 'error' ? 'alert' : 'status'}>{runner.notice.text}</Notice> : null}
            {created.hostId ? <div className="grid gap-2">
              <p className="m-0 text-xs text-muted">Siguiente paso: preparar el agente en su computadora. Así queda su entorno de ejecución listo para admitir entregas.</p>
              {fleetReason ? <Notice role="note">{fleetReason}</Notice> : null}
              {preparedDraft && !fleetReason ? <AgentLifecyclePanel snapshot={activeSnapshot} onReloaded={onReloaded}
                initialDraft={preparedDraft} triggerLabel="Preparar en la computadora" /> : null}
            </div> : <Notice role="note">Asigna una computadora en Editar registro para prepararlo.</Notice>}
          </div>
          <div className={DIALOG_FOOTER}>
            {onOpenAgent ? <Button onClick={() => { onOpenAgent(`${created.tenantId}/${created.alias}`); onOpenChange(false); }}>Abrir ficha</Button> : null}
            <Button variant="primary" onClick={() => { onOpenChange(false); }}>Terminar</Button>
          </div>
        </> : <>
          <div className={`${DIALOG_BODY} grid content-start gap-4`}>
            {permissionNotice}
            {step === 'identidad' ? <ModeChoice mode={mode} onChange={(value) => { setMode(value); setFormError(undefined); }} disabled={disabled} /> : null}
            {preparing ? <AgentLifecyclePanel snapshot={activeSnapshot} onReloaded={onReloaded} initialOpen hideTrigger embedded
              onClose={() => { onOpenChange(false); }} /> : <>
              <Stepper step={step} />
              <h3 className="m-0 text-sm font-semibold">{STEP_LABEL[step]}</h3>
              {step === 'identidad' ? <IdentityStep {...stepFields} tenants={tenants} aliasInput={aliasInput} /> : null}
              {step === 'computadora' ? <PlacementStep {...stepFields} harnesses={harnesses} hosts={hosts} hostReason={hostReason} /> : null}
              {step === 'grupos' ? <GroupsStep {...stepFields} rooms={rooms} /> : null}
              {step === 'revision' ? <>
                <ReviewSummary draft={draft} tenantLabel={tenantLabel} hostLabel={hostLabel} roomLabel={roomLabel} />
                <p className="m-0 text-xs text-muted">Revisión esperada: {String(runner.expectedRevision ?? 'desconocida')}. Previsualiza el alta para que el servidor la valide antes de crearla.</p>
                {runner.preview ? <pre className={PREVIEW} aria-label="Preview del alta de agente">{runner.preview}</pre> : null}
              </> : null}
              {notices}
            </>}
          </div>
          <div className={DIALOG_FOOTER}>
            {preparing ? <Button onClick={() => { onOpenChange(false); }}>Cerrar</Button> : <>
              {stepIndex > 0 ? <Button className="mr-auto" onClick={back} disabled={busy}>Atrás</Button> : null}
              {step === 'revision' ? <>
                <Button onClick={() => { void preview(); }} disabled={disabled || !tenants.length}>Previsualizar alta</Button>
                <Button variant="primary" onClick={() => { void apply(); }}
                  disabled={disabled || !mutation || !runner.isValidated(mutation) || Boolean(hostReason)}>Crear registro</Button>
              </> : <Button variant="primary" onClick={next} disabled={busy}>Siguiente</Button>}
            </>}
          </div>
        </>}
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}
