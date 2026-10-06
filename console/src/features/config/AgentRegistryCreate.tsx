import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';
import type { ConfigurationSnapshot } from '../../api/types';
import { useApi } from '../../api/context';
import { useConsoleAccess } from '../../api/console-access';
import type { Resource } from '../../api/use-resource';
import {
  agentRegistryCreateError, createAgentRegistryMutation, EMPTY_AGENT_REGISTRY_DRAFT,
  registryHarnessOptions, registryTenantOptions, type AgentRegistryCreateDraft,
} from './agent-registry-create';
import { useConfigMutation, useRevisionEncadenada } from './use-config-mutation';
import './AgentRegistryCreate.css';

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
  const dialogRef = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
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
  const wasOpen = useRef(false);
  const clearNoticeOnNextOpen = useRef(false);

  useEffect(() => {
    if (open && !wasOpen.current) {
      if (aliasInput.current && !aliasInput.current.disabled) aliasInput.current.focus({ preventScroll: true });
      else titleRef.current?.focus({ preventScroll: true });
      if (clearNoticeOnNextOpen.current) {
        clearRunner.current();
        clearNoticeOnNextOpen.current = false;
      }
    }
    else if (!open && wasOpen.current) focusReturnRef.current?.focus({ preventScroll: true });
    wasOpen.current = open;
  }, [focusReturnRef, open]);

  useEffect(() => {
    if (!open) return undefined;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && !busy) {
        event.preventDefault();
        onOpenChange(false);
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => { document.removeEventListener('keydown', onKeyDown); };
  }, [busy, onOpenChange, open]);

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

  function trapFocus(event: ReactKeyboardEvent<HTMLElement>) {
    if (event.key !== 'Tab') return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const candidates = [...dialog.querySelectorAll<HTMLElement>(
      'button, input, select, textarea, a[href], summary, [tabindex]',
    )].filter((element) => {
      const style = window.getComputedStyle(element);
      if (element.tabIndex < 0 || element.matches(':disabled') || element.hidden
        || element.getAttribute('aria-hidden') === 'true'
        || style.display === 'none' || style.visibility === 'hidden') return false;
      const closedDetails = element.closest('details:not([open])');
      return !closedDetails || element === closedDetails.querySelector('summary');
    });
    if (!candidates.length) {
      event.preventDefault();
      titleRef.current?.focus({ preventScroll: true });
      return;
    }
    const focused = document.activeElement;
    const currentIndex = candidates.indexOf(focused as HTMLElement);
    event.preventDefault();
    const nextIndex = currentIndex < 0
      ? event.shiftKey ? candidates.length - 1 : 0
      : (currentIndex + (event.shiftKey ? -1 : 1) + candidates.length) % candidates.length;
    candidates[nextIndex]?.focus();
  }

  return <>
    {resultNotice ? <p className="notice" role="status">{resultNotice}</p> : null}
    {open ? <div className="agent-registry-create-backdrop">
      <section ref={dialogRef} className="agent-registry-create settings-context" role="dialog" aria-modal="true"
        onKeyDown={trapFocus}
        aria-labelledby="agent-registry-create-title" aria-describedby="agent-registry-create-hub-note">
        <div className="settings-context-heading">
          <h2 ref={titleRef} id="agent-registry-create-title" tabIndex={-1}>Añadir agente</h2>
          <button type="button" className="button secondary" onClick={() => { onOpenChange(false); }} disabled={busy}>
            Cerrar
          </button>
        </div>
        <p id="agent-registry-create-hub-note" className="notice" role="note">
          Este cambio requiere permiso para administrar el registro. El servidor lo verifica al previsualizar.
        </p>
        {!runner.canWrite ? <p className="notice" role="note">
          Tu cuenta no tiene permiso para modificar este registro, o no pudimos verificarlo.
        </p> : null}
        {!tenants.length ? <p className="notice" role="note">No hay espacios de trabajo publicados en esta lectura; no se puede elegir destino.</p> : null}
        <div className="config-form agent-registry-create-form">
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
          <details className="agent-registry-create-advanced">
            <summary>Entorno de ejecución (opcional)</summary>
            <p>Indica el contenedor, el usuario y sus dos directorios. Completa los cuatro campos o déjalos vacíos; no se generan valores.</p>
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
          </details>
        </div>
        {formError ? <p className="notice error" role="alert">{formError}</p> : null}
        {runner.notice ? <p className={`notice ${runner.notice.tone === 'error' ? 'error' : ''}`}
          role={runner.notice.tone === 'error' ? 'alert' : 'status'}>{runner.notice.text}</p> : null}
        <div className="settings-context-heading agent-registry-create-actions">
          <span>Revisión esperada: {String(runner.expectedRevision ?? 'desconocida')}</span>
          <div>
            <button type="button" className="button secondary" onClick={() => { void preview(); }} disabled={disabled || !tenants.length}>
              Previsualizar alta
            </button>{' '}
            <button type="button" className="button primary" onClick={() => { void apply(); }}
              disabled={disabled || !mutation || !runner.isValidated(mutation)}>
              Crear registro
            </button>
          </div>
        </div>
        {runner.preview ? <pre className="config-preview" aria-label="Preview del alta de agente">{runner.preview}</pre> : null}
      </section>
    </div> : null}
  </>;
}
