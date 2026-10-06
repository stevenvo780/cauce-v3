import { useEffect, useId, useRef, useState } from 'react';
import { useApi } from '../../api/context';
import { Button } from '../../components/kit';

export function HumanProfileEditor({ name, disabled }: { name: string; disabled: boolean }) {
  const api = useApi();
  const id = useId();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const sending = useRef(false);
  const generation = useRef(0);
  const restoreFocus = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => () => { generation.current += 1; }, []);
  useEffect(() => {
    if (editing) input.current?.focus();
    else if (restoreFocus.current) { restoreFocus.current = false; trigger.current?.focus(); }
  }, [editing]);

  function cancel() {
    generation.current += 1;
    restoreFocus.current = true;
    setEditing(false);
    setError('');
  }

  async function save() {
    if (sending.current || disabled) return;
    const clean = draft.trim();
    if (!clean || Array.from(clean).length > 120) {
      setError('El nombre debe tener entre 1 y 120 caracteres.');
      return;
    }
    const current = generation.current;
    sending.current = true;
    setBusy(true);
    setError('');
    try {
      await api.updateHumanProfile(clean);
      if (current !== generation.current) return;
      restoreFocus.current = true;
      setEditing(false);
      setSaved(true);
    } catch (cause) {
      if (current === generation.current) setError(cause instanceof Error ? cause.message : 'No se pudo guardar el nombre.');
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="grid min-w-0 gap-2 [&_p]:m-0 [&_p]:break-words [&_p]:text-xs">
      <Button
        ref={trigger} size="sm" hidden={editing} className="justify-self-start [&[hidden]]:hidden"
        disabled={disabled} aria-disabled={disabled || busy}
        onClick={() => { if (busy || disabled) return; setDraft(name); setError(''); setSaved(false); setEditing(true); }}
      >Editar nombre</Button>
      {editing ? (
        <form
          className="grid gap-2"
          onSubmit={(event) => { event.preventDefault(); void save(); }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel(); }
          }}
        >
          <label htmlFor={id}>Tu nombre</label>
          <input
            id={id} ref={input} value={draft} disabled={busy || disabled} autoComplete="name"
            aria-describedby={`${id}-help${error ? ` ${id}-error` : ''}`} aria-invalid={Boolean(error)}
            onChange={(event) => { setDraft(event.target.value); }}
          />
          <p id={`${id}-help`} className="text-muted">Entre 1 y 120 caracteres. Los mensajes anteriores conservan su autoría.</p>
          {error ? <p id={`${id}-error`} role="alert" className="text-danger-ink">{error}</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="primary" disabled={busy || disabled}>{busy ? 'Guardando…' : 'Guardar nombre'}</Button>
            <Button onClick={cancel}>Cancelar edición</Button>
          </div>
        </form>
      ) : null}
      {saved ? <p role="status" className="text-ok-ink">Nombre guardado</p> : null}
    </div>
  );
}
