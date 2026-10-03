import { useEffect, useId, useRef, useState } from 'react';
import { useApi } from '../../api/context';
import type { ContextSourcePreview } from '../../api/client/context-repository-client';
import { CAMPOS_DEL_PERFIL, ETIQUETAS, esPerfilAplicado } from './perfil';
import { DOCUMENT_REASON_MAX, problemaDeMotivo } from './ficheros-motivo';
import { pendingProfileReceipt, profileIsAdopted } from './profile-save-receipt';

interface Props {
  tenantId: string; alias: string; instanceId: string; commit: string;
  canApply: boolean; blocked: boolean; refreshRevision?: number;
  onSettled?: () => void;
  onWriteInFlightChange?: (value: boolean) => void;
}

function matchesIdentity(value: unknown, tenantId: string, alias: string): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const identity = value as Record<string, unknown>;
  return identity.tenant_id === tenantId && identity.alias === alias;
}

export function ContextRepositoryApply(props: Props) {
  const api = useApi();
  const id = useId();
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState<ContextSourcePreview>();
  const [confirmed, setConfirmed] = useState(false);
  const [phase, setPhase] = useState<'preview' | 'apply'>();
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const sequence = useRef(0);
  const mounted = useRef(true);
  const inFlight = useRef(false);
  const latest = useRef(props);
  latest.current = props;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; sequence.current += 1; }; }, []);
  useEffect(() => { setPreview(undefined); setConfirmed(false); sequence.current += 1; }, [props.tenantId, props.alias, props.instanceId, props.commit, props.refreshRevision, props.canApply]);
  const disabled = !props.canApply || props.blocked || phase !== undefined;
  const invalidReason = problemaDeMotivo(reason);

  async function run(action: 'preview' | 'apply') {
    if (disabled || inFlight.current || invalidReason !== undefined || (action === 'apply' && (!preview || !confirmed))) return;
    const captured = props;
    const request = ++sequence.current;
    const current = () => mounted.current && request === sequence.current && latest.current.canApply
      && latest.current.tenantId === captured.tenantId && latest.current.alias === captured.alias
      && latest.current.commit === captured.commit && latest.current.instanceId === captured.instanceId;
    inFlight.current = true;
    setPhase(action); setError(undefined); setMessage(undefined);
    try {
      if (action === 'preview') {
        setPreview(undefined); setConfirmed(false);
        const value = await api.previewContextSource(props.tenantId, props.alias, props.instanceId, props.commit, reason.trim());
        if (current()) setPreview(value);
      } else if (preview) {
        captured.onWriteInFlightChange?.(true);
        setPreview(undefined); setConfirmed(false);
        const result = await api.applyContextSource(preview, reason.trim());
        if (!current()) return;
        const names = preview.ficheros.map((file) => file.nombre);
        const pending = pendingProfileReceipt(result, props.tenantId, props.alias, names);
        const applied = esPerfilAplicado(result, { tenantId: props.tenantId, alias: props.alias, nombres: names });
        if ((!pending && !applied) || (pending && pending.revision !== preview.expected_revision + 1)
          || (applied && result.revision !== preview.expected_revision + 1)) {
          throw new Error('El resultado no acredita el lote completo; puede existir una revisión durable previa.');
        }
        const refreshed = await api.getAgentPerfil(props.tenantId, props.alias);
        if (!current()) return;
        if (!matchesIdentity(refreshed, captured.tenantId, captured.alias)
          || !matchesIdentity(refreshed.perfil, captured.tenantId, captured.alias)
          || (pending && (refreshed.runtime_verification?.state !== 'current'
            || refreshed.runtime_verification.generation !== pending.generation))
          || refreshed.revision !== preview.expected_revision + 1
          || CAMPOS_DEL_PERFIL.some((field) => JSON.stringify(refreshed.perfil[field]) !== JSON.stringify(preview.profile[field]))) {
          throw new Error('La lectura posterior no acredita esta revisión del perfil.');
        }
        setMessage(applied && profileIsAdopted(refreshed)
          ? 'Versión guardada y adopción de sesión acreditada.'
          : 'Versión guardada; la adopción de sesión sigue pendiente de acreditación.');
        setReason('');
      }
    } catch (failure) {
      if (current()) {
        setPreview(undefined); setConfirmed(false);
        setError(`${failure instanceof Error ? failure.message : 'No se obtuvo un resultado verificable.'} ${action === 'apply'
          ? 'Releé el estado antes de otra aplicación: puede haber efectos parciales. No se reintenta automáticamente.'
          : 'No se habilita aplicar sin una vista previa válida.'}`);
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setPhase(undefined);
      if (action === 'apply') { captured.onWriteInFlightChange?.(false); captured.onSettled?.(); }
    }
  }

  return <section className="perfil-recarga" aria-label="Aplicar versión Git">
    <p>Sólo pueden aplicarse versiones que coincidan con su diario de origen a un perfil existente.
      El contenido nuevo creado únicamente en Git permanece en modo inspección.</p>
    <label htmlFor={`${id}-reason`}>Motivo de la aplicación
      <input id={`${id}-reason`} value={reason} maxLength={DOCUMENT_REASON_MAX} disabled={disabled}
        onChange={(event) => { sequence.current += 1; setReason(event.target.value); setPreview(undefined); setConfirmed(false); setMessage(undefined); }} />
    </label>
    <button className="button small secondary" type="button" disabled={disabled || invalidReason !== undefined}
      onClick={() => { void run('preview'); }}>{phase === 'preview' ? 'Preparando…' : 'Preparar aplicación'}</button>
    {preview ? <section aria-label="Confirmación de versión Git">
      <p>Commit {preview.context_source.commit}; instancia {props.instanceId}; {props.tenantId}/{props.alias}.
        Revisión vigente {preview.expected_revision}; diario {preview.context_source.expected_journal_id}.</p>
      {CAMPOS_DEL_PERFIL.map((field) => <div key={field}>
        <h4>{ETIQUETAS[field].titulo}</h4>
        <p className="historial-diff-texto">Vigente: {JSON.stringify(preview.before[field])}</p>
        <p className="historial-diff-texto">Propuesto: {JSON.stringify(preview.profile[field])}</p>
      </div>)}
      {preview.ficheros.map((file) => <details key={file.nombre}><summary>Proyección: {file.nombre}</summary>
        {['MEMORY.md', 'HEARTBEAT.md'].includes(file.nombre)
          ? <p>Archivo propio del agente: se conserva sin cambios.</p>
          : <pre className="historial-diff-texto">{file.texto}</pre>}</details>)}
      <label><input type="checkbox" checked={confirmed} disabled={disabled}
        onChange={(event) => { setConfirmed(event.target.checked); }} />
        Confirmo estos campos y su proyección para este agente y esta revisión.
      </label>
      <button type="button" className="button small secondary" disabled={disabled || !confirmed}
        onClick={() => { void run('apply'); }}>Aplicar versión confirmada</button>
      <button type="button" className="button small secondary" disabled={phase === 'apply'}
        onClick={() => { sequence.current += 1; setPreview(undefined); setConfirmed(false); }}>Cancelar</button>
    </section> : null}
    {phase === 'apply' ? <p role="status">Aplicando la versión confirmada…</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    {message ? <p role="status">{message}</p> : null}
  </section>;
}
