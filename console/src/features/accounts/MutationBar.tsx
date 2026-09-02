import { Save, SearchCheck } from 'lucide-react';
import type { ConfigMutation } from '../../api/types';
import type { ConfigMutationRunner } from '../config/use-config-mutation';

/**
 * Shared write bar for both pool forms: dry-run first, apply after, with apply disabled until
 * the server has validated the exact mutation currently shown.
 *
 * Because the inventory and the matrix live in the SAME view, there are two bars on screen at
 * once, with identically worded buttons. That is why the buttons sit inside a `role="group"`
 * named with `previewLabel`: without it, "Previsualizar (dry-run)" is ambiguous to a screen
 * reader, to the keyboard, and to the tests — and previewing the wrong form sends a mutation the
 * operator never asked for.
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

  return <>
    {mutation ? <pre className="config-preview" aria-label={`Mutación pendiente de ${previewLabel}`}>{JSON.stringify(mutation, null, 2)}</pre> : null}
    <div className="config-actions" role="group" aria-label={`Acciones de ${previewLabel}`}>
      <button className="button secondary" type="button" disabled={blocked} onClick={() => { if (mutation) void runner.run(mutation, true); }}>
        <SearchCheck size={16} aria-hidden="true" />Previsualizar (dry-run)
      </button>
      <button className="button primary" type="button" disabled={blocked || !applicable} onClick={() => { if (mutation) void runner.run(mutation, false); }}>
        <Save size={16} aria-hidden="true" />Aplicar
      </button>
    </div>
    {/* Form guidance, not a server rejection: `note` keeps the screen reader from announcing it
        as an alert the moment the page loads, and leaves `alert` for what the server denied. */}
    {invalid ? <p className="notice" role="note">{invalid}</p> : null}
    {runner.preview ? <pre className="config-preview" aria-label={`Dry-run de ${previewLabel}`}>{runner.preview}</pre> : null}
    {runner.notice ? <p
      className={runner.notice.tone === 'error' ? 'notice error' : runner.notice.tone === 'parcial' ? 'notice parcial' : 'notice success'}
      role={runner.notice.tone === 'success' ? 'status' : 'alert'}
      data-canal={runner.canal}
    >{runner.notice.text}</p> : null}
  </>;
}
