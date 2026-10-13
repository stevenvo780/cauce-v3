import { useEffect, useState } from 'react';
import type { ContextVersionDiff, ContextVersions, VersionedContextFile } from '../../api/client/context-versions-client';
import { useApi } from '../../api/context';
import { useResource } from '../../api/use-resource';
import { Button, Notice } from '../../components/kit';
import { Time } from '../../components/ui';

const ORIGEN: Record<string, string> = { ui: 'Consola', cli: 'CLI', native: 'Nativo (en el espacio)', restore: 'Restauración', profile: 'Perfil', directive: 'Directiva' };
const NATIVE_APPLY_ERRORS: Record<string, string> = {
  native_context_governed_path: 'El agente intentó cambiar archivos gobernados desde su espacio; solo puede editar context/notes/. Nada de esa edición se guardó.',
  native_context_secret_detected: 'La edición del agente en su espacio se rechazó porque el contenido parece un secreto.',
  native_context_too_large: 'La edición del agente en su espacio se rechazó porque supera el tamaño máximo del contexto.',
  native_context_harness_limit: 'La edición del agente en su espacio se rechazó porque supera el límite de documento de su harness.',
  native_context_unsafe_text: 'La edición del agente en su espacio se rechazó porque el texto no es válido.',
  native_context_invalid_files: 'La edición del agente en su espacio se rechazó porque los archivos no son válidos.',
};

export function ContextVersionsPanel({ tenantId, alias, canWrite }: { tenantId: string; alias: string; canWrite: boolean }) {
  const api = useApi();
  const identity = `${tenantId}/${alias}`;
  const context = useResource(`versioned-context:${identity}`, () => api.getVersionedContext(tenantId, alias));
  const history = useResource(`context-versions:${identity}`, () => api.getContextVersions(tenantId, alias));
  const [draft, setDraft] = useState<{ version: number; files: VersionedContextFile[] }>();
  const [selected, setSelected] = useState('');
  const [newPath, setNewPath] = useState('');
  const [diff, setDiff] = useState<ContextVersionDiff>();
  const [restoring, setRestoring] = useState<number>();
  const [older, setOlder] = useState<ContextVersions>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => {
    if (!draft) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => { window.removeEventListener('beforeunload', warn); };
  }, [draft]);
  const snapshot = context.data;
  const files = draft?.files ?? snapshot?.files ?? [];
  const current = files.find(file => file.path === selected) ?? files.at(0);
  const writable = canWrite && !!snapshot && !context.error && !context.loading && !busy;
  async function operation(action: () => Promise<unknown>, message: string, discard = false) {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await action();
      if (discard) { setDraft(undefined); setRestoring(undefined); setOlder(undefined); setDiff(undefined); }
      const reread = await context.reload();
      const versions = await history.reload();
      if (reread.error || versions.error) throw new Error('La operación respondió, pero su estado no se pudo releer. Reintenta la consulta.');
      setNotice(message);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'No se confirmó la operación del contexto.'); }
    finally { setBusy(false); }
  }
  function updateFiles(next: VersionedContextFile[]) { if (snapshot) setDraft({ version: draft?.version ?? snapshot.version, files: next }); }
  async function compare(version: number) {
    if (!snapshot || busy) return;
    setBusy(true); setError('');
    try { setDiff(await api.getContextVersionDiff(tenantId, alias, version, snapshot.version)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'No se pudieron leer las diferencias.'); }
    finally { setBusy(false); }
  }
  async function loadOlder() {
    const cursor = older?.next_cursor ?? history.data?.next_cursor;
    if (cursor == null || busy) return;
    setBusy(true); setError('');
    try { const next = await api.getContextVersions(tenantId, alias, cursor); setOlder(previous => ({ ...next, entries: [...previous?.entries ?? [], ...next.entries] })); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'No se pudieron leer más versiones.'); }
    finally { setBusy(false); }
  }
  return <section aria-label="Versiones de contexto" className="grid gap-4">
    <div className="flex flex-wrap justify-between gap-2"><h3 className="m-0">Contexto versionado</h3>
      <Button disabled={busy || context.loading || !!draft} onClick={() => { void operation(async () => undefined, 'Estado releído.'); }}>Releer versiones</Button></div>
    {context.loading && !snapshot ? <p role="status">Leyendo el contexto…</p> : null}
    {context.error || history.error || error ? <Notice tone="danger" role="alert">{error || (context.error?.message ?? history.error?.message)}</Notice> : null}
    {notice ? <Notice tone="info" role="status">{notice}</Notice> : null}
    {snapshot ? <>
      <dl className="m-0 grid grid-cols-2 gap-2 text-sm"><div><dt>Guardado</dt><dd>{snapshot.version}</dd></div>
        <div><dt>Usado por el agente</dt><dd>{snapshot.applied_version ?? 'Sin aplicación verificada'}</dd></div>
        <div><dt>Aplicación</dt><dd>{snapshot.application.state === 'applied' ? 'Aplicada' : snapshot.application.state === 'error' ? 'Error de aplicación' : 'Aplicación pendiente'}</dd></div>
        <div><dt>Versión deseada</dt><dd>{snapshot.desired_version}</dd></div><div><dt>GitHub</dt><dd>{snapshot.sync.state === 'synced' ? 'Sincronizado' : snapshot.sync.state === 'error' ? 'Error de sincronización' : 'Pendiente'}</dd></div></dl>
      {snapshot.desired_version !== snapshot.applied_version ? <Notice tone="warn">El agente aún no acredita la versión {snapshot.desired_version}. Guardar una versión no demuestra que ya la esté usando.</Notice> : null}
      {snapshot.sync.last_error ? <Notice tone="warn">{snapshot.sync.last_error}</Notice> : null}
      {snapshot.application.last_error === 'native_context_conflict' ? <Notice tone="danger" role="alert">
        Conflicto de ingesta nativa: el agente editó su contexto dentro del espacio sobre una versión anterior y esta ya había avanzado. No se perdió nada: su edición quedó apartada en el espacio como copia en conflicto y sigue trabajando con la versión del servidor.
        <div className="mt-2"><Button size="sm" disabled={!writable || !!draft} onClick={() => { setDraft({ version: snapshot.version, files: snapshot.files }); setNotice('Borrador creado desde la versión actual. Incorpora el contenido acordado con el agente y guarda una nueva versión; la adoptará en su próximo turno.'); }}>Resolver desde esta ficha</Button></div>
      </Notice> : snapshot.application.last_error ? <Notice tone="danger">{NATIVE_APPLY_ERRORS[snapshot.application.last_error] ?? snapshot.application.last_error}</Notice> : null}
      {snapshot.sync.git_commit ? <p className="m-0 text-xs break-all">Commit: <code>{snapshot.sync.git_commit}</code>{snapshot.sync.pushed_at ? <> · publicado <Time value={snapshot.sync.pushed_at} /></> : null}</p> : null}
      <div className="flex flex-wrap gap-2"><Button disabled={!writable || !!draft} onClick={() => { void operation(() => api.applyVersionedContext(tenantId, alias), 'Aplicación solicitada. El estado usado por el agente se muestra arriba.'); }}>Aplicar al agente</Button>
        <Button disabled={!writable || !!draft} onClick={() => { void operation(() => api.retryContextSync(tenantId, alias), 'Sincronización solicitada.'); }}>Reintentar sincronización</Button></div>
      <label>Archivo<select value={current?.path ?? ''} disabled={busy} onChange={event => { setSelected(event.target.value); }}>
        {!files.length ? <option value="">Sin archivos</option> : null}{files.map(file => <option key={file.path}>{file.path}</option>)}</select></label>
      {current ? <><label>Contenido de {current.path}<textarea className="min-h-64 font-mono text-xs" value={current.content} disabled={!writable}
        onChange={event => { updateFiles(files.map(file => file.path === current.path ? { ...file, content: event.target.value } : file)); }} /></label>
        <Button disabled={!writable} onClick={() => { updateFiles(files.filter(file => file.path !== current.path)); }}>Quitar este archivo del borrador</Button></> : <p>No hay contextos guardados. Añade un archivo para comenzar.</p>}
      <form className="flex flex-wrap items-end gap-2" onSubmit={event => { event.preventDefault(); if (!writable) return;
        const path = newPath.trim(); if (!path || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..') || files.some(file => file.path === path)) { setError('Usa una ruta relativa nueva dentro del contexto.'); return; }
        updateFiles([...files, { path, content: '' }]); setSelected(path); setNewPath(''); }}>
        <label className="flex-1">Nuevo archivo<input value={newPath} placeholder="context/directivas.md" disabled={!writable} onChange={event => { setNewPath(event.target.value); }} /></label>
        <Button type="submit" disabled={!writable || !newPath.trim()}>Añadir archivo</Button></form>
      {draft ? <Notice tone="warn">Borrador sin guardar, basado en la versión {draft.version}.</Notice> : null}
      <div className="flex flex-wrap gap-2"><Button variant="primary" disabled={!writable || !draft} onClick={() => { if (draft) void operation(() => api.saveVersionedContext(tenantId, alias, { expected_version: draft.version, files: draft.files, source: 'ui' }), 'Versión guardada. La aplicación y sincronización se acreditan por separado.', true); }}>Guardar nueva versión</Button>
        <Button disabled={busy || !draft} onClick={() => { setDraft(undefined); setError(''); }}>Descartar borrador</Button></div>
    </> : null}
    <section aria-label="Historial de versiones"><h3>Historial</h3>
      {history.loading ? <p role="status">Leyendo historial…</p> : null}
      <ul className="m-0 grid list-none gap-2 p-0">{[...history.data?.entries ?? [], ...older?.entries ?? []].map(entry => <li key={entry.version} className="grid gap-2 border-b border-line py-2">
        <span>Versión {entry.version} · {ORIGEN[entry.source] ?? entry.source} · {entry.actor_alias || 'sin autor registrado'} · <Time value={entry.created_at} />{entry.restored_from == null ? '' : ` · restaurada de ${String(entry.restored_from)}`}</span>
        <div className="flex gap-2"><Button size="sm" disabled={busy || !snapshot} onClick={() => { void compare(entry.version); }}>Ver diferencias de versión {entry.version}</Button>
          <Button size="sm" disabled={!writable || !!draft} onClick={() => { setRestoring(entry.version); }}>Restaurar versión {entry.version}</Button></div></li>)}</ul>
      {history.data && !history.data.entries.length ? <p>Aún no hay cambios registrados.</p> : null}
      {(older?.next_cursor ?? history.data?.next_cursor) != null ? <Button disabled={busy} onClick={() => { void loadOlder(); }}>Leer versiones anteriores</Button> : null}
    </section>
    {diff ? <section aria-label="Diferencias de contexto"><h3>Versión {diff.from} a {diff.to}</h3>{!diff.files.length ? <p>Sin diferencias.</p> : null}
      {diff.files.map(file => <details key={file.path} open><summary>{file.path} · {file.change === 'added' ? 'Añadido' : file.change === 'deleted' ? 'Eliminado' : 'Modificado'}</summary>
        <div className="grid gap-2 md:grid-cols-2"><div><h4>Antes</h4><pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-subtle p-3 text-xs">{file.before ?? 'No existía'}</pre></div>
          <div><h4>Después</h4><pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-subtle p-3 text-xs">{file.after ?? 'Eliminado'}</pre></div></div></details>)}</section> : null}
    {restoring !== undefined && snapshot ? <section aria-label="Confirmar restauración" className="grid gap-2 rounded-lg border border-line p-3"><p>Restaurar la versión {restoring} crea una nueva versión y conserva todo el historial.</p>
      <div className="flex gap-2"><Button disabled={!writable || !!draft} onClick={() => { void operation(() => api.restoreContextVersion(tenantId, alias, { expected_version: snapshot.version, version: restoring }), 'Restauración guardada como una versión nueva.', true); }}>Confirmar restauración</Button>
        <Button disabled={busy} onClick={() => { setRestoring(undefined); }}>Cancelar</Button></div></section> : null}
  </section>;
}
