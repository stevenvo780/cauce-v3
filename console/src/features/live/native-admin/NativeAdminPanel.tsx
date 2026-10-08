import { useEffect, useRef, useState } from 'react';
import { NativePieceMutationSchema, type NativePieceKind } from '@cauce/protocol/native-admin';
import { useApi } from '../../../api/context';
import type { PermissionState } from '../../../lib';
import { ApiError } from '../../../api/client/core';
import type { NativeRead, NativeSaved } from './client';
import { clearNativeDrafts, readNativeDraft, storeNativeDraft, type NativeDraft } from './drafts';
import '../native-context-repository.css';

interface Props { tenantId: string; alias: string; permission: PermissionState; blocked?: boolean; onReload?: () => Promise<void> }
const labels: Record<NativePieceKind, string> = { skill: 'Skills', mcp: 'Servidores MCP', subagent: 'Subagentes', prompt: 'Prompts' };
const blank = (kind: NativePieceKind): NativeDraft => ({ kind, id: '', content: '', url: '', env: '', reason: '' });
export function NativeAdminPanel(props: Props) {
  const [open, setOpen] = useState(false);
  return <details className="native-context-repository" onToggle={event => { if (event.target === event.currentTarget) setOpen(event.currentTarget.open); }}>
    <summary>Piezas nativas · MCP, skills y subagentes</summary>
    {open ? <NativeEditor key={`${props.tenantId}/${props.alias}`} {...props} /> : null}
  </details>;
}
function NativeEditor({ tenantId, alias, permission, blocked = false, onReload }: Props) {
  const api = useApi(); const sequence = useRef(0);
  const [draft, setDraft] = useState<NativeDraft>(() => readNativeDraft(api, tenantId, alias) ?? blank('skill'));
  const [inventory, setInventory] = useState<NativeRead>(); const [busy, setBusy] = useState(false);
  const [error, setError] = useState(''); const [saved, setSaved] = useState<NativeSaved>(); const [status, setStatus] = useState('');
  const [unconfirmed, setUnconfirmed] = useState<NativeDraft['pending']>(() => readNativeDraft(api, tenantId, alias)?.pending);
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => {
    const unsubscribe = api.onAuthGenerationChange(() => {
      sequence.current += 1; clearNativeDrafts(api); setDraft(blank('skill')); setInventory(undefined); setSaved(undefined); setUnconfirmed(undefined); setError('La sesión cambió. Relee las piezas.'); setBusy(false);
    });
    return () => { sequence.current += 1; unsubscribe(); };
  }, [api]);
  function change(patch: Partial<NativeDraft>) {
    const next = { ...draft, ...patch }; setDraft(next); storeNativeDraft(api, tenantId, alias, next); setSaved(undefined); setStatus(''); setConfirmDelete(false);
  }
  async function load(kind = draft.kind, id?: string) {
    if (busy || (unconfirmed && (id !== undefined || kind !== draft.kind))) return; const token = ++sequence.current; setBusy(true); setError('');
    try {
      const result = await api.readNativePieces(tenantId, alias, kind, id);
      if (token !== sequence.current) return;
      if (id === undefined) { setInventory(result); if (kind !== draft.kind) change(blank(kind)); }
      else if (result.outcome.type === 'piece') {
        const value = result.outcome.piece.value;
        const next: NativeDraft = { ...blank(kind), id, base: result,
          content: value && 'content' in value ? value.content : '', url: value && 'mcp' in value ? value.mcp.url : '',
          env: value && 'mcp' in value ? value.mcp.bearer_token_env_var ?? '' : '' };
        setDraft(next); storeNativeDraft(api, tenantId, alias, next); setSaved(undefined); setStatus('');
      }
    } catch (failure) { if (token === sequence.current) setError(failure instanceof Error ? failure.message : 'No se pudo leer.'); }
    finally { if (token === sequence.current) setBusy(false); }
  }
  const piece = draft.base?.outcome.type === 'piece' ? draft.base.outcome.piece : undefined;
  const writable = permission === 'allowed' && inventory?.can_write === true && draft.base?.can_write === true
    && piece?.editable === true && !busy && !blocked && !unconfirmed;
  async function save(action: 'put' | 'delete') {
    const baseIdentity = draft.base?.identity;
    if (baseIdentity === undefined || !writable || draft.reason.trim().length < 12 || draft.reason.length > 500) return;
    const mutation = NativePieceMutationSchema.safeParse({ kind: draft.kind, id: draft.id, action, expected_sha: piece.sha,
      ...(action === 'delete' ? {} : { value: draft.kind === 'mcp' ? { mcp: { url: draft.url,
        ...(draft.env.trim() ? { bearer_token_env_var: draft.env.trim() } : {}) } } : { content: draft.content } }) });
    if (!mutation.success) { setError('Revisa nombre, formato Markdown o URL HTTPS sin credenciales ni parámetros.'); return; }
    const pending = { operationId: crypto.randomUUID(), mutation: mutation.data, identity: baseIdentity };
    setUnconfirmed(pending); const intended = { ...draft, pending }; setDraft(intended); storeNativeDraft(api, tenantId, alias, intended);
    const token = ++sequence.current; setBusy(true); setError(''); setStatus('');
    let received: NativeSaved | undefined;
    try {
      const result = await api.mutateNativePiece(tenantId, alias, mutation.data, draft.reason.trim(), pending.identity, pending.operationId);
      received = result;
      const read = await api.readNativePieces(tenantId, alias, draft.kind, draft.id);
      if (token !== sequence.current) return;
      const value = read.outcome.type === 'piece' ? read.outcome.piece : undefined;
      if (value?.sha !== result.receipt.sha || JSON.stringify(read.identity) !== JSON.stringify(result.receipt.identity)
        || (action === 'put' && JSON.stringify(value.value) !== JSON.stringify(mutation.data.value))
        || (action === 'delete' && value.value !== undefined)) throw new Error('El disco cambió o no acreditó la misma pieza. Se conserva el borrador.');
      setSaved(result); setConfirmDelete(false); setUnconfirmed(undefined);
      const next = { ...draft, base: read, reason: '' }; setDraft(next); storeNativeDraft(api, tenantId, alias, next);
      setStatus(action === 'delete' ? 'Pieza borrada y ausencia verificada. Pendiente de recarga.' : 'Guardado con respaldo privado y SHA verificado. Pendiente de recarga.');
      const list = await api.readNativePieces(tenantId, alias, draft.kind);
      if (token === sequence.current) setInventory(list);
    } catch (failure) { if (token === sequence.current) { setError(failure instanceof Error ? failure.message : 'No se confirmó el guardado.');
      if (received === undefined && failure instanceof ApiError && [400, 401, 403, 409, 501].includes(failure.status)) {
        setUnconfirmed(undefined); setDraft(draft); storeNativeDraft(api, tenantId, alias, draft);
      } else { setUnconfirmed(pending); setDraft(intended); storeNativeDraft(api, tenantId, alias, intended); }
    } }
    finally { if (token === sequence.current) setBusy(false); }
  }
  async function recover() {
    if (!unconfirmed || busy || blocked || permission !== 'allowed') return; const token = ++sequence.current; setBusy(true); setError('');
    try {
      const discovered = await api.discoverNativePiece(tenantId, alias, unconfirmed.mutation, unconfirmed.identity, unconfirmed.operationId);
      if (token !== sequence.current) return;
      if (discovered.state !== 'pending') throw new Error('No se encontró una reserva verificable. El borrador y su bloqueo se conservan.');
      const result = await api.recoverNativePiece(tenantId, alias, unconfirmed.operationId, unconfirmed.mutation);
      if (token !== sequence.current) return;
      if (result.state === 'not_applied') {
        setUnconfirmed(undefined);
        const restored = { ...draft }; delete restored.pending; setDraft(restored); storeNativeDraft(api, tenantId, alias, restored);
        setStatus('La operación quedó cercada sin aplicar cambios. El borrador se conserva y ya puede reintentarse.'); return;
      }
      const read = await api.readNativePieces(tenantId, alias, draft.kind, draft.id);
      if (token !== sequence.current) return;
      const mutation = unconfirmed.mutation;
      if (read.outcome.type !== 'piece' || read.outcome.piece.sha !== result.receipt.sha
        || JSON.stringify(read.identity) !== JSON.stringify(result.receipt.identity)
        || (mutation.action === 'put' && JSON.stringify(read.outcome.piece.value) !== JSON.stringify(mutation.value))
        || (mutation.action === 'delete' && read.outcome.piece.value !== undefined)) throw new Error('La relectura no acreditó la recuperación.');
      setUnconfirmed(undefined);
      const next = { ...draft, base: read }; delete next.pending; setDraft(next); storeNativeDraft(api, tenantId, alias, next); setSaved(result);
      setStatus('Guardado recuperado con recibo durable y archivo verificado. Pendiente de recarga.');
    } catch (failure) { if (token === sequence.current) setError(failure instanceof Error ? failure.message : 'Recuperación no acreditada.'); }
    finally { if (token === sequence.current) setBusy(false); }
  }
  async function recognize() {
    if (!saved || !writable) return; const token = ++sequence.current; setBusy(true); setError('');
    try {
      const result = await api.recognizeNativePiece(tenantId, alias, draft.kind, draft.id, saved.receipt.sha, saved.receipt.identity);
      if (token === sequence.current) setStatus(result.state === 'available_for_new_session'
        ? 'El proveedor reconoció la pieza desde el perfil privado. Disponible para nuevas invocaciones; la sesión abierta requiere recarga.'
        : result.reason === 'provider_format_verified'
          ? 'El proveedor reconoció el formato MCP en una proyección pública aislada. La adopción del perfil y de la sesión sigue pendiente.'
          : 'Archivo verificado. Este tipo no tiene un catálogo nativo seguro para confirmar la adopción; pendiente de próxima sesión.');
    } catch (failure) { if (token === sequence.current) setError(failure instanceof Error ? failure.message : 'Reconocimiento no acreditado.'); }
    finally { if (token === sequence.current) setBusy(false); }
  }
  async function reload() {
    if (!saved || !onReload || !writable) return; const token = ++sequence.current; setBusy(true); setError('');
    try {
      await onReload(); const read = await api.readNativePieces(tenantId, alias, draft.kind, draft.id);
      if (token !== sequence.current) return;
      if (read.identity.writer_instance_id === saved.receipt.identity.writer_instance_id || read.outcome.type !== 'piece'
        || read.outcome.piece.sha !== saved.receipt.sha) throw new Error('No se acreditó un nuevo escritor con la misma pieza.');
      const recognition = await api.recognizeNativePiece(tenantId, alias, draft.kind, draft.id, saved.receipt.sha, read.identity);
      if (token !== sequence.current) return;
      setStatus(recognition.state === 'available_for_new_session'
        ? 'Runtime reiniciado con nuevo escritor y archivo exacto reconocido para nuevas invocaciones. La adopción por una sesión sigue pendiente.'
        : 'Runtime reiniciado con nuevo escritor y archivo exacto verificado. El reconocimiento y la adopción por una sesión siguen pendientes.');
    } catch (failure) { if (token === sequence.current) setError(failure instanceof Error ? failure.message : 'Recarga no acreditada.'); }
    finally { if (token === sequence.current) setBusy(false); }
  }
  const items = inventory?.outcome.type === 'inventory' ? inventory.outcome.items : [];
  return <section className="perfil-editor" aria-label="Editor de piezas nativas">
    <p className="muted">Piezas de la cuenta medida. MCP admite HTTPS y referencias a variables de entorno; los valores secretos no se muestran. Guardar acredita el archivo; la adopción de sesión se verifica aparte.</p>
    <div className="drawer-delivery-actions">
      <label>Tipo de pieza<select value={draft.kind} disabled={busy || !!unconfirmed} onChange={event => { void load(event.target.value as NativePieceKind); }}>
        {(inventory?.kinds ?? ['skill', 'mcp', 'subagent']).map(kind => <option key={kind} value={kind}>{labels[kind]}</option>)}
      </select></label>
      <button type="button" disabled={busy} onClick={() => { void load(); }}>Leer inventario nativo</button>
    </div>
    {inventory ? <p className="muted">Arnés: {inventory.harness}. Prompts y formatos adicionales sin contrato nativo demostrado quedan sin edición.</p> : null}
    <ul>{items.map(item => <li key={item.id}><button type="button" disabled={busy || !!unconfirmed} onClick={() => { void load(draft.kind, item.id); }}>{item.id}</button>{item.editable ? '' : ' · formato privado o no compatible'}</li>)}</ul>
    {inventory?.outcome.type === 'inventory' && inventory.outcome.truncated ? <p role="status">Inventario limitado a 100 piezas; no acredita la totalidad.</p> : null}
    <label>Nombre de pieza<input value={draft.id} disabled={busy || !!unconfirmed || permission !== 'allowed'} onChange={event => { change({ id: event.target.value, base: undefined }); }} /></label>
    <button type="button" disabled={busy || !!unconfirmed || !/^[a-z][a-z0-9_-]{0,63}$/u.test(draft.id)} onClick={() => { void load(draft.kind, draft.id); }}>Leer o preparar pieza</button>
    {draft.kind === 'mcp' ? <>
      <label>URL MCP HTTPS<input value={draft.url} disabled={!writable} onChange={event => { change({ url: event.target.value }); }} /></label>
      <label>Variable de entorno del token (opcional)<input value={draft.env} disabled={!writable} onChange={event => { change({ env: event.target.value }); }} /></label>
    </> : <label>Contenido Markdown<textarea rows={12} value={draft.content} disabled={!writable} onChange={event => { change({ content: event.target.value }); }} /></label>}
    {draft.kind !== 'mcp' ? <p className="muted">Usa frontmatter con name igual al nombre de pieza y description, seguido del cuerpo Markdown.</p> : null}
    <label>Motivo del cambio nativo<textarea rows={2} value={draft.reason} disabled={!writable} onChange={event => { change({ reason: event.target.value }); }} /></label>
    <div className="drawer-delivery-actions">
      <button type="button" disabled={!writable || draft.reason.trim().length < 12} onClick={() => { void save('put'); }}>Guardar pieza nativa</button>
      <button type="button" disabled={!writable || piece.value === undefined || draft.reason.trim().length < 12} onClick={() => { setConfirmDelete(true); }}>Borrar pieza nativa</button>
    </div>
    {confirmDelete ? <div role="alert"><p>Se borrará {draft.kind}/{draft.id}; el respaldo privado se conserva. La sesión necesita recarga.</p><button type="button" disabled={!writable} onClick={() => { void save('delete'); }}>Confirmar borrado de pieza</button><button type="button" onClick={() => { setConfirmDelete(false); }}>Cancelar borrado</button></div> : null}
    {unconfirmed ? <button type="button" disabled={busy || blocked || permission !== 'allowed'} onClick={() => { void recover(); }}>Verificar operación nativa pendiente</button> : null}
    {saved ? <button type="button" disabled={!writable} onClick={() => { void recognize(); }}>Verificar reconocimiento del proveedor</button> : null}
    {saved && onReload ? <button type="button" disabled={!writable} onClick={() => { void reload(); }}>Reiniciar este agente y verificar archivos</button> : null}
    {busy ? <p role="status">Verificando piezas nativas…</p> : null}
    {error ? <p role="alert">{error}</p> : null}{status ? <p role="status">{status}</p> : null}
  </section>;
}
