import { useEffect, useId, useRef, useState } from 'react';
import { useApi } from '../../api/context';
import { useResource } from '../../api/use-resource';
import type { ContextRepositoryInspection, JournalVerification } from '../../api/client/context-repository-client';
import { Button, Notice, SectionCard } from '../../components/kit';
import { ContextRepositoryApply } from './ContextRepositoryApply';
import { NativeContextRepositoryPanel } from './NativeContextRepositoryPanel';
import { CAMPOS_DEL_PERFIL, ETIQUETAS } from './perfil';

interface Props { tenantId: string; alias: string; canApply?: boolean; blocked?: boolean; refreshRevision?: number;
  onSettled?: () => void; onWriteInFlightChange?: (value: boolean) => void }
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const JOURNAL: Record<JournalVerification, string> = {
  journal_match: 'Coincide con la revisión del diario consultada',
  journal_mismatch: 'No coincide con la identidad o contenido del diario consultado',
  journal_unavailable: 'La revisión del diario no está disponible',
  git_authored: 'Contenido nuevo de Git; no declara una revisión de origen en el diario',
};
const MONO = 'm-0 break-words whitespace-pre-wrap font-mono text-xs text-fg-2';

/** Inspects a commit of the bound repository and, with write permission, applies it behind a preview. */
export function ContextRepositoryPanel(props: Props) {
  // Typed commits and results belong to one agent: another agent starts from scratch.
  return <RepositoryContent key={`${props.tenantId}/${props.alias}`} {...props} />;
}

function RepositoryContent({ tenantId, alias, ...permissions }: Props) {
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

  if (capability.loading) return <p role="status" className="m-0 text-muted">Consultando la vinculación Git…</p>;
  if (capability.error) return <Notice tone="danger" role="alert" className="flex flex-wrap items-center justify-between gap-2">
    <p>No se pudo consultar la vinculación Git de este agente.</p>
    <Button size="sm" onClick={() => { void capability.reload(); }}>Reintentar</Button>
  </Notice>;
  if (capability.data?.state === 'not_published') return <p className="m-0 text-muted">Este gateway todavía no publica la inspección Git.</p>;
  if (capability.data?.state !== 'configured') return <p className="m-0 text-muted">Esta instancia todavía no tiene un repositorio Git vinculado por el servidor.</p>;

  const validOids = OID.test(commit) && (previous === '' || OID.test(previous));
  return <div className="grid gap-4">
    <SectionCard title="Versiones Git del contexto"
      description={`Repositorio vinculado a la instancia ${capability.data.instance_id ?? ''}. Consultá versiones de los siete campos canónicos de ${alias}. Inspeccionar no cambia el perfil ni los archivos; aplicar exige vista previa y confirmación. El diario de PostgreSQL conserva la autoridad.`}>
      <form className="grid gap-3 md:grid-cols-2" onSubmit={(event) => { event.preventDefault(); void inspect(); }}>
        <label htmlFor={`${id}-commit`}>Commit completo
          <input id={`${id}-commit`} value={commit} maxLength={64} autoComplete="off" spellCheck={false} className="font-mono"
            onChange={(event) => { change(event.target.value); }} aria-describedby={`${id}-help`} />
        </label>
        <label htmlFor={`${id}-previous`}>Comparar con otro commit (opcional)
          <input id={`${id}-previous`} value={previous} maxLength={64} autoComplete="off" spellCheck={false} className="font-mono"
            onChange={(event) => { change(event.target.value, true); }} aria-describedby={`${id}-help`} />
        </label>
        <p id={`${id}-help`} className="m-0 text-xs text-muted md:col-span-2">
          Identificador hexadecimal completo de 40 o 64 caracteres. Se admiten objetos Git sueltos; los repositorios empaquetados y worktrees enlazados requieren soporte adicional.
        </p>
        <div className="md:col-span-2">
          <Button type="submit" disabled={busy || !validOids}>{busy ? 'Inspeccionando…' : 'Inspeccionar versión'}</Button>
        </div>
      </form>
      <NativeContextRepositoryPanel tenantId={tenantId} alias={alias} instanceId={capability.data.instance_id ?? ''} commit={commit} previous={previous} />
    </SectionCard>
    {error ? <Notice tone="danger" role="alert">{error}</Notice> : null}
    {result ? <SectionCard title="Resultado de inspección Git" className="min-w-0">
      <div className="grid gap-1 text-[13px]">
        <p className={MONO}>Commit: {result.commit}</p>
        <p role="status" className="m-0">{JOURNAL[result.journal]}</p>
        {result.previousCommit ? <p className={MONO}>Comparación: {result.previousCommit}. {result.previousJournal ? JOURNAL[result.previousJournal] : ''}</p> : null}
        <p className="m-0 text-xs text-muted">Árbol de trabajo e índice no observados. Aplicación al arnés y adopción de sesión no evaluadas.</p>
      </div>
      {permissions.canApply && ['journal_match', 'git_authored'].includes(result.journal) && capability.data.instance_id ? <ContextRepositoryApply
        key={`${result.commit}/${String(result.previousCommit)}`} tenantId={tenantId} alias={alias}
        instanceId={capability.data.instance_id} commit={result.commit} canApply={permissions.canApply}
        blocked={permissions.blocked ?? false} refreshRevision={permissions.refreshRevision}
        onSettled={permissions.onSettled} onWriteInFlightChange={permissions.onWriteInFlightChange} />
        : permissions.canApply ? <Notice tone="warn">Esta versión permanece en modo inspección: su origen declarado no coincide con el diario o no está disponible.</Notice> : null}
      <div className="grid gap-3">
        {CAMPOS_DEL_PERFIL.map((field) => {
          const current = result.profile[field];
          const old = result.previousProfile?.[field];
          const changed = result.previousProfile !== null && JSON.stringify(current) !== JSON.stringify(old);
          const text = (value: typeof current | undefined) => Array.isArray(value) ? value.join('\n') || 'Sin contenido' : value ?? 'Sin contenido';
          return <section key={field} className="grid gap-1 border-t border-line pt-3">
            <h4 className="m-0 text-[13px] font-semibold">{ETIQUETAS[field].titulo}{changed ? ' · cambiado' : ''}</h4>
            {changed ? <p className={`${MONO} text-danger-ink`}>Antes: {text(old)}</p> : null}
            <p className={MONO}>{text(current)}</p>
          </section>;
        })}
      </div>
    </SectionCard> : null}
  </div>;
}
