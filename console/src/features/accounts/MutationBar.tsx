import { Save, SearchCheck } from 'lucide-react';
import type { ConfigMutation, ConfigurationSnapshot } from '../../api/types';
import { cn } from '../../cn';
import { Button, Notice, Outcome, PREVIEW } from '../../components/kit';
import type { ConfigMutationRunner } from '../config/use-config-mutation';
import { configMutationSummary } from '../config/config-change-summary';

/**
 * Write bar of the pool forms: dry-run first, apply after, with apply disabled until the server
 * has validated the exact mutation currently shown.
 *
 * The buttons sit inside a `role="group"` named with `previewLabel` so that several bars on one
 * screen stay distinguishable for a screen reader and for the keyboard: previewing the wrong
 * form sends a mutation the operator never asked for.
 */
export function MutationBar({ runner, mutation, invalid, previewLabel, part = 'all', snapshot }: {
  runner: ConfigMutationRunner;
  mutation?: ConfigMutation;
  snapshot?: ConfigurationSnapshot | undefined;
  /** Reason why the mutation cannot be submitted yet (local validation). */
  invalid?: string;
  previewLabel: string;
  /** `actions` stays in a dialog footer; `details` scrolls with the fields. */
  part?: 'all' | 'actions' | 'details';
}) {
  const blocked = !runner.canWrite || runner.busy || mutation === undefined || Boolean(invalid);
  const applicable = mutation !== undefined && !invalid && runner.isValidated(mutation);
  // `note`, not `alert`: the form's own guidance must not be announced as a server rejection.
  const notice = invalid ? <Notice role="note">{invalid}</Notice> : null;
  const actions = (
    <div className="flex flex-wrap justify-end gap-2" role="group" aria-label={`Acciones de ${previewLabel}`}>
      <Button disabled={blocked} onClick={() => { if (mutation) void runner.run(mutation, true); }}>
        <SearchCheck size={15} aria-hidden="true" />Previsualizar cambio
      </Button>
      <Button variant="primary" disabled={blocked || !applicable} onClick={() => { if (mutation) void runner.run(mutation, false); }}>
        <Save size={15} aria-hidden="true" />Aplicar
      </Button>
    </div>
  );
  const outcome = runner.notice ? <Outcome tone={runner.notice.tone} canal={runner.canal}>{runner.notice.text}</Outcome> : null;
  const pending = mutation ? <div className="grid gap-2"><p className="m-0 text-sm wrap-anywhere">Al confirmar: {configMutationSummary(mutation, snapshot)}.</p><details><summary>Detalles técnicos del cambio</summary><pre className={cn(PREVIEW, 'max-h-44')} aria-label={`Mutación pendiente de ${previewLabel}`}>{JSON.stringify(mutation, null, 2)}</pre></details></div> : null;
  const preview = runner.preview ? <details><summary>Detalles técnicos de la vista previa</summary><pre className={cn(PREVIEW, 'max-h-44')} aria-label={`Vista previa de ${previewLabel}`}>{runner.preview}</pre></details> : null;
  if (part === 'actions') return <div className="grid gap-3">{notice}{actions}{outcome}</div>;
  if (part === 'details') return pending || preview ? <div className="grid gap-3">{pending}{preview}</div> : null;
  return <div className="grid gap-3">{notice}{actions}{outcome}{pending}{preview}</div>;
}
