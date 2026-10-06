import { useEffect, useId, useRef, useState } from 'react';
import { useApi } from '../../api/context';
import type { ClientConnectionsPage } from '../../api/types/client-delegations';
import { ClientDeclarationResponseError, clientConnectionsResponse } from '../../api/client/client-delegations-client';
import { confirmDeclarationResult, verifiedConnection, declarationError, grantActive, prepareDeclaration, selectedConnection, sendDeclaration,
  uncertainDeclaration, type ClientDeclarationCommand } from './client-declaration-state';
import { Button } from '../../components/form-kit';

/** The panel scrolls inside the account popover instead of growing it past the viewport. */
const BODY = 'grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 overflow-y-auto overscroll-contain pt-2 max-h-[min(55dvh,480px)] max-[760px]:max-h-[45dvh] [overflow-wrap:anywhere] [&_p]:m-0 [&_p]:text-xs';

export function ClientConnectionsPanel({ active, disabled }: { active: boolean; disabled: boolean }) {
  const api = useApi();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<ClientConnectionsPage>();
  const [reference, setReference] = useState('');
  const [referenceInput, setReferenceInput] = useState('');
  const [label, setLabel] = useState('Dots');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState<ClientDeclarationCommand>();
  const [needsReload, setNeedsReload] = useState(false);
  const sending = useRef(false);
  const generation = useRef(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => () => { generation.current += 1; }, []);
  useEffect(() => { if (!active) setOpen(false); }, [active]);
  useEffect(() => { if (open) heading.current?.focus({ preventScroll: true }); }, [open, pending]);

  async function load() {
    const current = ++generation.current;
    setBusy(true);
    setError('');
    setPage(undefined);
    try {
      const fresh = clientConnectionsResponse(await api.listClientConnections());
      if (current !== generation.current) return;
      setPage(fresh);
      setNeedsReload(false);
      setReference(previous => selectedConnection(fresh, previous) ? previous : '');
      if (referenceInput) {
        try { verifiedConnection(fresh, referenceInput); }
        catch (cause) { setError(declarationError(cause)); }
      }
    } catch (cause) {
      if (current === generation.current) setError(declarationError(cause));
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }

  async function mutate(operation: ClientDeclarationCommand['operation'], retry = false) {
    if (sending.current || busy || disabled || needsReload) return;
    let command: ClientDeclarationCommand;
    try {
      if (retry && pending) command = pending;
      else {
        if (pending) return;
        command = prepareDeclaration(operation, selectedConnection(page, reference), label, crypto.randomUUID());
      }
    } catch {
      setError('Elegí una conexión vigente y una etiqueta ASCII de 1 a 128 caracteres, con extremos alfanuméricos.');
      return;
    }
    const current = ++generation.current;
    sending.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    setPending(command);
    try {
      const result = await sendDeclaration(api, command);
      if (current !== generation.current) return;
      confirmDeclarationResult(command, result);
      setPending(undefined);
      setPage(undefined);
      setNeedsReload(true);
      setNotice('Declaración guardada. No verifica un cliente vivo y no modifica el acceso OAuth.');
      await load();
    } catch (cause) {
      if (current !== generation.current) return;
      if (uncertainDeclaration(cause)) {
        if (cause instanceof ClientDeclarationResponseError) {
          setPage(undefined);
          setNeedsReload(true);
          const reloadGeneration = generation.current + 1;
          await load();
          if (reloadGeneration !== generation.current) return;
        }
        setError('No se pudo confirmar el resultado. Reintentá el mismo intento; se conservarán su referencia, etiqueta e identificador.');
      } else {
        setPending(undefined);
        setPage(undefined);
        setNeedsReload(true);
        setError(declarationError(cause));
      }
    } finally {
      sending.current = false;
      if (current === generation.current) setBusy(false);
    }
  }

  const selected = selectedConnection(page, reference);
  return <section className="grid min-w-0 gap-2 border-t border-line pt-3" data-client-connections onKeyDown={event => {
    if (event.key === 'Escape' && open) {
      event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus({ preventScroll: true });
    }
  }}>
    <Button ref={trigger} className="justify-self-start" aria-expanded={open} aria-controls={id}
      disabled={disabled} onClick={() => { setOpen(!open); if (!open && !busy) void load(); }}>Conexiones MCP</Button>
    {open && active ? <div id={id} role="region" aria-labelledby={`${id}-title`} className={BODY} aria-busy={busy}>
      <h3 id={`${id}-title`} tabIndex={-1} ref={heading} className="text-[13px] font-semibold">Declaraciones de cliente</h3>
      <p>Una etiqueta es tu declaración sobre un grant exacto. No prueba que Dots u otro cliente esté conectado ahora. Instancia desconocida; último uso no observado.</p>
      <Button size="sm" className="justify-self-start" disabled={busy || disabled}
        onClick={() => { void load(); }}>Recargar conexiones</Button>
      {notice ? <p role="status">{notice}</p> : null}
      {error ? <p role="alert" className="rounded-md bg-danger-soft px-2 py-1.5 text-danger-ink">{error}</p> : null}
      {busy ? <p role="status">Consultando al servidor…</p> : null}
      {pending ? <div className="grid gap-2 rounded-md bg-warn-soft p-2 text-warn-ink"><p>Hay una acción pendiente sobre la declaración. No inicies otra hasta confirmar el resultado.</p>
        <Button variant="primary" className="whitespace-normal" disabled={busy || disabled || needsReload}
          onClick={() => { void mutate(pending.operation, true); }}>Reintentar mismo intento</Button></div> : null}
      {page?.truncated ? <p role="status">Lista limitada a 100 conexiones, sin paginación. Si tu referencia no aparece, no se puede seleccionar desde este panel.</p> : null}
      {page ? <fieldset className="m-0 grid min-w-0 gap-2 rounded-lg border border-line p-2" disabled={busy || disabled || Boolean(pending)}><legend className="max-w-full px-1 text-xs">Elegí la referencia exacta; no seleccionamos una automáticamente</legend>
        <label className="min-w-0" htmlFor={`${id}-reference`}>connection_ref verificada
          <input id={`${id}-reference`} className="font-mono" value={referenceInput} autoComplete="off" spellCheck={false}
            aria-describedby={`${id}-reference-help`} onChange={event => {
              const value = event.target.value;
              setReferenceInput(value); setReference(''); setError(''); setNotice('');
              if (!value) return;
              try {
                const match = verifiedConnection(page, value);
                setReference(match.connection_ref); setLabel(match.label ?? 'Dots');
              } catch (cause) { setError(declarationError(cause)); }
            }} />
        </label>
        <p id={`${id}-reference-help`}>Pegá la connection_ref verificada por cauce_connection_identity. Debe coincidir exactamente con una sola conexión de la lista actual.</p>
        {page.items.length === 0 ? <p>No hay conexiones visibles para esta cuenta.</p> : null}
        <div className="grid max-h-[min(25dvh,240px)] gap-2 overflow-y-auto overscroll-contain">{page.items.map((item, position) => <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-line p-2 has-[:checked]:border-brand has-[:checked]:bg-brand-soft" key={`${item.connection_ref}:${String(position)}`}>
          <input type="radio" name={id} value={item.connection_ref} checked={reference === item.connection_ref}
            onChange={() => { setReferenceInput(item.connection_ref); setReference(''); setError(''); setNotice('');
              try { const match = verifiedConnection(page, item.connection_ref); setReference(match.connection_ref); setLabel(match.label ?? 'Dots'); }
              catch (cause) { setError(declarationError(cause)); }
            }} />
          <span className="grid min-w-0 gap-0.5 text-xs [overflow-wrap:anywhere]"><code className="font-mono">{item.connection_ref}</code><span>Cliente: <code>{item.client_id}</code></span>
            <span>Creado: <time dateTime={item.created_at}>{item.created_at}</time></span>
            <span>Vence: <time dateTime={item.expires_at}>{item.expires_at}</time></span>
            <span>{item.revoked ? 'Grant OAuth revocado' : grantActive(item) ? 'Grant vigente según expiración' : 'Grant vencido'}</span>
            <span>{item.display_label ?? 'Sin declaración'}</span>
            <span>Última publicación: {item.last_publication_at ?? 'No informada'}</span>
          </span>
        </label>)}</div>
      </fieldset> : null}
      {selected && !pending && !needsReload ? <form className="grid min-w-0 gap-2" onSubmit={event => { event.preventDefault(); void mutate(selected.binding_id ? 'rename' : 'create'); }}>
        <label htmlFor={`${id}-label`}>Etiqueta declarada</label>
        <input id={`${id}-label`} value={label} maxLength={128} disabled={busy || disabled} autoComplete="off"
          onChange={event => { setLabel(event.target.value); }} aria-describedby={`${id}-label-help`} />
        <p id={`${id}-label-help`}>ASCII, 1–128 caracteres; letras, números, espacios, punto, guion y guion bajo. Extremos alfanuméricos.</p>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" className="whitespace-normal" disabled={busy || disabled || !grantActive(selected)}>{selected.binding_id ? 'Renombrar declaración' : 'Guardar declaración'}</Button>
          {selected.binding_id ? <Button variant="danger" disabled={busy || disabled}
            onClick={() => { void mutate('revoke'); }}>Quitar declaración</Button> : null}
        </div>
        <p>Quitar la declaración no revoca el grant OAuth. Los mensajes anteriores conservan su evidencia.</p>
      </form> : null}
    </div> : null}
  </section>;
}
