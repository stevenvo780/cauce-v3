import { Dialog } from '@base-ui/react/dialog';
import { useState } from 'react';
import { Button, Notice } from '../../components/kit';
import { ConfigCollectionForm } from './ConfigCollectionForm';
import { DIALOG_BODY, WIZARD_POPUP, WizardHeader } from './config-dialog';
import { configFormDefinition } from './config-form-model';
import { GroupEditor } from './GroupEditor';
import type { ConfigWrites } from './use-config-writes';

const TITLE: Record<string, string> = { create: 'Nuevo equipo', update: 'Editar equipo', delete: 'Eliminar equipo' };

/**
 * The typed form of a team (room) or of one of its memberships, in a modal. It is the same form, runner and
 * revision chain as «Espacios y salas»; only the surface changes.
 */
export function TeamFormDialog({ ctx }: { ctx: ConfigWrites }) {
  const [dirty, setDirty] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const target = ctx.formTarget;
  const definition = target ? configFormDefinition(target.collection) : undefined;
  if (!ctx.formModal || !target || !definition || !ctx.config.data) return null;
  const Form = target.collection === 'rooms' ? GroupEditor : ConfigCollectionForm;
  const close = () => { setConfirming(false); setDirty(false); ctx.setFormTarget(undefined); ctx.canalFormulario.clear(); };
  const requestClose = () => { if (dirty) setConfirming(true); else close(); };
  const title = target.collection === 'rooms' ? TITLE[target.action] ?? 'Equipo' : `Miembro del equipo · ${definition.label}`;
  return <Dialog.Root open onOpenChange={(open) => { if (!open && !ctx.busy) requestClose(); }}>
    <Dialog.Portal>
      <Dialog.Backdrop className="fixed inset-0 z-50 bg-scrim" />
      <Dialog.Popup className={WIZARD_POPUP}>
        <WizardHeader title={title} busy={ctx.busy}
          description="Se manda por el mismo endpoint versionado que «Espacios y salas», con vista previa antes de confirmar." />
        {confirming ? <div className="shrink-0 border-b border-line px-5 py-3">
          <Notice tone="warn" role="alert" className="grid gap-2">
            <p><strong>Tenés cambios sin guardar.</strong> Si cerrás ahora, se descartan los borradores sin confirmar.</p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button size="sm" onClick={() => { setConfirming(false); }}>Seguir editando</Button>
              <Button size="sm" variant="danger" onClick={close}>Descartar y cerrar</Button>
            </div>
          </Notice>
        </div> : null}
        <div className={DIALOG_BODY}>
          <Form key={`${target.collection}:${target.action}:${JSON.stringify(target.row ?? {})}`} definition={definition} target={target}
            snapshot={ctx.config.data} runner={ctx.canalFormulario} busy={ctx.busy} onCancel={requestClose} onDirtyChange={setDirty}
            onRelated={(related) => { ctx.openForm(related, true); }} />
        </div>
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}
