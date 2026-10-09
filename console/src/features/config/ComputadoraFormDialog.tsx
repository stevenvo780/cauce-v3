import type { SyntheticEvent } from 'react';
import { Button, Notice } from '../../components/kit';
import { FormDialog } from '../../components/dialogs';
import { FORM_GRID } from './config-ui';

export interface Editor {
  modo: 'alta' | 'editar';
  hostId: string;
  displayName: string;
  notes: string;
  version: number;
}

/** Create and edit share one modal; the error stays inside it because the page behind is inert while it is open. */
export function ComputadoraFormDialog({ editor, busy, error, onChange, onSubmit, onClose }: {
  editor: Editor | undefined;
  busy: boolean;
  error: string | undefined;
  onChange: (editor: Editor) => void;
  onSubmit: (event: SyntheticEvent<HTMLFormElement>) => void;
  onClose: () => void;
}) {
  const alta = editor?.modo !== 'editar';
  return <FormDialog open={!!editor} busy={busy} onClose={onClose}
    title={alta ? 'Registrar computadora' : `Editar ${editor.hostId}`}
    description={alta ? 'Registrarla no instala el ejecutor: eso sigue siendo un paso del operador.' : 'Cambia su nombre visible y sus notas.'}>
    {editor ? <form aria-label={alta ? 'Registrar computadora' : `Editar ${editor.hostId}`} onSubmit={onSubmit} className="grid gap-3">
      {error ? <Notice tone="danger" role="alert">{error}</Notice> : null}
      <div className={FORM_GRID}>
        <label className="grid gap-1">Identificador (host_id)
          {alta
            ? <input required value={editor.hostId} disabled={busy} onChange={(event) => { onChange({ ...editor, hostId: event.target.value }); }} />
            : <code className="text-sm">{editor.hostId}</code>}
        </label>
        <label className="grid gap-1">Nombre visible
          <input required maxLength={80} value={editor.displayName} disabled={busy}
            onChange={(event) => { onChange({ ...editor, displayName: event.target.value }); }} />
        </label>
      </div>
      <label className="grid gap-1">Notas
        <textarea maxLength={500} rows={3} value={editor.notes} disabled={busy}
          onChange={(event) => { onChange({ ...editor, notes: event.target.value }); }} />
      </label>
      <div className="flex flex-wrap justify-end gap-2">
        <Button size="sm" disabled={busy} onClick={onClose}>Cancelar</Button>
        <Button size="sm" variant="primary" type="submit" disabled={busy}>Guardar</Button>
      </div>
    </form> : null}
  </FormDialog>;
}
