import { useEffect, useId, useRef, useState } from 'react';
import { useApi } from '../../api/context';
import { useResource } from '../../api/use-resource';
import type { ContextRepositoryInspection, JournalVerification } from '../../api/client/context-repository-client';
import { CAMPOS_DEL_PERFIL, ETIQUETAS } from './perfil';

interface Props { tenantId: string; alias: string }
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const JOURNAL: Record<JournalVerification, string> = {
  journal_match: 'Coincide con la revisión del diario consultada',
  journal_mismatch: 'No coincide con la identidad o contenido del diario consultado',
  journal_unavailable: 'La revisión del diario no está disponible',
};

export function ContextRepositoryPanel({ tenantId, alias }: Props) {
  const [open, setOpen] = useState(false);
  return <details className="historial-contexto" onToggle={(event) => { setOpen(event.currentTarget.open); }}>
    <summary>Versiones Git del contexto</summary>
    {open ? <RepositoryContent key={`${tenantId}/${alias}`} tenantId={tenantId} alias={alias} /> : null}
  </details>;
}

function RepositoryContent({ tenantId, alias }: Props) {
  const api = useApi();
  const capability = useResource(`context-repository/${tenantId}/${alias}`, () => api.getContextRepository(tenantId, alias));
  const [commit, setCommit] = useState('');
  const [previous, setPrevious] = useState('');
  const [result, setResult] = useState<ContextRepositoryInspection>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const sequence = useRef(0);
  const id = useId();
  useEffect(() => () => { sequence.current += 1; }, []);

  function change(value: string, before = false) {
    sequence.current += 1;
    if (before) setPrevious(value); else setCommit(value);
    setResult(undefined); setError(undefined); setBusy(false);
  }

  async function inspect() {
    const instanceId = capability.data?.instance_id;
    if (busy || typeof instanceId !== 'string' || !OID.test(commit) || (previous !== '' && !OID.test(previous))) return;
    const request = ++sequence.current;
    setBusy(true); setResult(undefined); setError(undefined);
    try {
      const response = await api.inspectContextRepository(tenantId, alias, instanceId, commit, previous || undefined);
      if (request === sequence.current) setResult(response);
    } catch {
      if (request === sequence.current) setError('No se pudo inspeccionar este commit. Comprobá el identificador y la disponibilidad del repositorio autorizado.');
    } finally { if (request === sequence.current) setBusy(false); }
  }

  if (capability.loading) return <p role="status">Consultando la vinculación Git…</p>;
  if (capability.error) return <div><p role="alert">No se pudo consultar la vinculación Git de este agente.</p>
    <button className="button small secondary" type="button" onClick={() => { void capability.reload(); }}>Reintentar</button></div>;
  if (capability.data?.state === 'not_published') return <p>Este gateway todavía no publica la inspección Git.</p>;
  if (capability.data?.state !== 'configured') return <p>Esta instancia todavía no tiene un repositorio Git vinculado por el servidor.</p>;

  return <div className="perfil-vista-previa">
    <p>Repositorio vinculado a la instancia {capability.data.instance_id}. Consultá versiones de los siete campos canónicos de {alias}.</p>
    <p className="muted">Sólo lectura. No crea versiones ni cambia el perfil o los archivos del arnés. El diario de PostgreSQL conserva la autoridad.</p>
    <form className="perfil-editor" onSubmit={(event) => { event.preventDefault(); void inspect(); }}>
      <label className="perfil-campo" htmlFor={`${id}-commit`}>Commit completo
        <input id={`${id}-commit`} value={commit} maxLength={64} autoComplete="off" spellCheck={false}
          onChange={(event) => { change(event.target.value); }} aria-describedby={`${id}-help`} />
      </label>
      <label className="perfil-campo" htmlFor={`${id}-previous`}>Comparar con otro commit (opcional)
        <input id={`${id}-previous`} value={previous} maxLength={64} autoComplete="off" spellCheck={false}
          onChange={(event) => { change(event.target.value, true); }} aria-describedby={`${id}-help`} />
      </label>
      <p id={`${id}-help`} className="muted">Identificador hexadecimal completo de 40 o 64 caracteres. Se admiten objetos Git sueltos; los repositorios empaquetados y worktrees enlazados requieren soporte adicional.</p>
      <button type="submit" className="button small secondary" disabled={busy || !OID.test(commit) || (previous !== '' && !OID.test(previous))}>
        {busy ? 'Inspeccionando…' : 'Inspeccionar versión'}
      </button>
    </form>
    {error ? <p role="alert">{error}</p> : null}
    {result ? <section aria-label="Resultado de inspección Git" className="historial-diff">
      <p className="historial-diff-texto">Commit: {result.commit}</p>
      <p role="status">{JOURNAL[result.journal]}</p>
      {result.previousCommit ? <p className="historial-diff-texto">Comparación: {result.previousCommit}. {result.previousJournal ? JOURNAL[result.previousJournal] : ''}</p> : null}
      <p>Árbol de trabajo e índice no observados. Aplicación al arnés y adopción de sesión no evaluadas.</p>
      {CAMPOS_DEL_PERFIL.map((field) => {
        const current = result.profile[field];
        const old = result.previousProfile?.[field];
        const changed = result.previousProfile !== null && JSON.stringify(current) !== JSON.stringify(old);
        const text = (value: typeof current | undefined) => Array.isArray(value) ? value.join('\n') || 'Sin contenido' : value ?? 'Sin contenido';
        return <section key={field} className="historial-diff-campo">
          <h4 className="historial-diff-titulo">{ETIQUETAS[field].titulo}{changed ? ' · cambiado' : ''}</h4>
          {changed ? <p className="historial-diff-texto">Antes: {text(old)}</p> : null}
          <p className="historial-diff-texto">{text(current)}</p>
        </section>;
      })}
    </section> : null}
  </div>;
}
