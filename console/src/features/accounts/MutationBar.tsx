import { Save, SearchCheck } from 'lucide-react';
import type { ConfigMutation } from '../../api/types';
import { Button, Notice } from '../../components/form-kit';
import type { ConfigMutationRunner } from '../config/use-config-mutation';

export const PREVIEW_BOX = 'm-0 max-h-44 overflow-auto rounded-lg border border-line bg-subtle p-3 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap text-fg-2';

/**
 * Write bar of the pool forms: dry-run first, apply after, with apply disabled until the server
 * has validated the exact mutation currently shown.
 *
 * The buttons sit inside a `role="group"` named with `previewLabel` so that several bars on one
 * screen stay distinguishable for a screen reader and for the keyboard: previewing the wrong
 * form sends a mutation the operator never asked for.
 */
export function MutationBar({ runner, mutation, invalid, previewLabel }: {
  runner: ConfigMutationRunner;
  mutation?: ConfigMutation;
  /** Reason why the mutation cannot be submitted yet (local validation). */
  invalid?: string;
  previewLabel: string;
}) {
  const blocked = !runner.canWrite || runner.busy || mutation === undefined || Boolean(invalid);
  const applicable = mutation !== undefined && !invalid && runner.isValidated(mutation);

  return <div className="grid gap-3">
    {/* Form guidance, not a server rejection: `note` keeps the screen reader from announcing it
        as an alert the moment the form opens, and leaves `alert` for what the server denied. */}
    {invalid ? <Notice role="note">{invalid}</Notice> : null}
    <div className="flex flex-wrap justify-end gap-2" role="group" aria-label={`Acciones de ${previewLabel}`}>
      <Button disabled={blocked} onClick={() => { if (mutation) void runner.run(mutation, true); }}>
        <SearchCheck size={15} aria-hidden="true" />Previsualizar (dry-run)
      </Button>
      <Button variant="primary" disabled={blocked || !applicable} onClick={() => { if (mutation) void runner.run(mutation, false); }}>
        <Save size={15} aria-hidden="true" />Aplicar
      </Button>
    </div>
    {runner.notice ? <Notice
      tone={runner.notice.tone === 'error' ? 'danger' : runner.notice.tone === 'parcial' ? 'warn' : 'ok'}
      role={runner.notice.tone === 'success' ? 'status' : 'alert'}
      data-canal={runner.canal}
    >{runner.notice.text}</Notice> : null}
    {mutation ? <pre className={PREVIEW_BOX} aria-label={`Mutación pendiente de ${previewLabel}`}>{JSON.stringify(mutation, null, 2)}</pre> : null}
    {runner.preview ? <pre className={PREVIEW_BOX} aria-label={`Dry-run de ${previewLabel}`}>{runner.preview}</pre> : null}
  </div>;
}
