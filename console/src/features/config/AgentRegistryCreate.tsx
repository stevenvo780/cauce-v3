import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { ConfigurationSnapshot } from '../../api/types';
import { useApi } from '../../api/context';
import { useConsoleAccess } from '../../api/console-access';
import type { Resource } from '../../api/use-resource';
import {
  agentRegistryCreateError, createAgentRegistryMutation, EMPTY_AGENT_REGISTRY_DRAFT,
  registryHarnessOptions, registryTenantOptions, type AgentRegistryCreateDraft,
} from './agent-registry-create';
import { FormDialog } from '../../components/dialogs';
import { Button, Notice, PREVIEW } from '../../components/kit';
import { useConfigMutation, useRevisionEncadenada } from './use-config-mutation';

export function AgentRegistryCreate({ snapshot, open, onOpenChange, onReloaded, focusReturnRef }: {
  snapshot: ConfigurationSnapshot;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onReloaded: (snapshot: ConfigurationSnapshot) => void;
  focusReturnRef: RefObject<HTMLButtonElement | null>;
}) {
  const api = useApi();
  const access = useConsoleAccess();
  const [freshSnapshot, setFreshSnapshot] = useState<ConfigurationSnapshot>();
  const [draft, setDraft] = useState<AgentRegistryCreateDraft>(EMPTY_AGENT_REGISTRY_DRAFT);
  const [formError, setFormError] = useState<string>();
  const [created, setCreated] = useState(false);
  const [resultNotice, setResultNotice] = useState<string>();
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
  const runner = useConfigMutation({ config, access, encadenado: chained, canal: 'agent-registry:create' });
  const clearRunner = useRef(runner.clear);
  clearRunner.current = runner.clear;
  const tenants = useMemo(() => registryTenantOptions(activeSnapshot), [activeSnapshot]);
  const harnesses = useMemo(() => registryHarnessOptions(activeSnapshot), [activeSnapshot]);
  const error = agentRegistryCreateError(draft, activeSnapshot);
  const mutation = error ? undefined : createAgentRegistryMutation(draft);
  const busy = runner.busy;
  const disabled = busy || !runner.canWrite;
  const clearNoticeOnNextOpen = useRef(false);

  useEffect(() => {
    if (open && clearNoticeOnNextOpen.current) {
      clearRunner.current();
      clearNoticeOnNextOpen.current = false;
    }
  }, [open]);

  useEffect(() => {
    if (!created || !runner.notice) return;
    setResultNotice(`Registro creado. ${runner.notice.text}`);
    setCreated(false);
  }, [created, runner.notice]);

  function edit(patch: Partial<AgentRegistryCreateDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
    setFormError(undefined);
    setResultNotice(undefined);
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
    if (!runner.isValidated(mutation)) return;
    setFormError(undefined);
    if (await runner.run(mutation, false)) {
      setCreated(true);
      setDraft(EMPTY_AGENT_REGISTRY_DRAFT);
      setFormError(undefined);
      clearNoticeOnNextOpen.current = true;
      onOpenChange(false);
    }
  }

  return <>
    {resultNotice ? <Notice tone="ok" role="status">{resultNotice}</Notice> : null}
    <FormDialog open={open} wide busy={busy} title="Añadir agente" initialFocus={aliasInput} finalFocus={focusReturnRef}
      description="Este cambio requiere permiso para administrar el registro. El servidor lo verifica al previsualizar."
      onClose={() => { onOpenChange(false); }}>
      {!runner.canWrite ? <Notice role="note">
        Tu cuenta no tiene permiso para modificar este registro, o no pudimos verificarlo.
      </Notice> : null}
      {!tenants.length ? <Notice role="note">No hay espacios de trabajo publicados en esta lectura; no se puede elegir destino.</Notice> : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <label>Espacio de trabajo
          <select value={draft.tenantId} onChange={(event) => { edit({ tenantId: event.target.value }); }} disabled={disabled}>
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
      {formError ? <Notice tone="danger" role="alert">{formError}</Notice> : null}
      {runner.notice ? <Notice tone={runner.notice.tone === 'error' ? 'danger' : 'info'}
        role={runner.notice.tone === 'error' ? 'alert' : 'status'}>{runner.notice.text}</Notice> : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-xs text-muted">Revisión esperada: {String(runner.expectedRevision ?? 'desconocida')}</span>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => { void preview(); }} disabled={disabled || !tenants.length}>Previsualizar alta</Button>
          <Button variant="primary" onClick={() => { void apply(); }}
            disabled={disabled || !mutation || !runner.isValidated(mutation)}>Crear registro</Button>
        </div>
      </div>
      {runner.preview ? <pre className={PREVIEW} aria-label="Preview del alta de agente">{runner.preview}</pre> : null}
    </FormDialog>
  </>;
}
