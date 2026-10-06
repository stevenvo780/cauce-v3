import { Save, SearchCheck } from 'lucide-react';
import type { ConfigMutation } from '../../api/types';
import { cn } from '../../cn';
import { Button, Notice, Outcome, PREVIEW } from '../../components/kit';
import type { ConfigMutationRunner } from '../config/use-config-mutation';

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
    {runner.notice ? <Outcome tone={runner.notice.tone} canal={runner.canal}>{runner.notice.text}</Outcome> : null}
    {mutation ? <pre className={cn(PREVIEW, 'max-h-44')} aria-label={`Mutación pendiente de ${previewLabel}`}>{JSON.stringify(mutation, null, 2)}</pre> : null}
    {runner.preview ? <pre className={cn(PREVIEW, 'max-h-44')} aria-label={`Dry-run de ${previewLabel}`}>{runner.preview}</pre> : null}
  </div>;
}
