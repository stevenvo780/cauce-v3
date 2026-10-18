import type { ConflictFieldDiff } from './conflict';
import { Button, Notice } from './kit';

/**
 * The one conflict panel every versioned form shows after a CAS 409: the draft stays in the form,
 * the differing fields sit beside the freshly saved ones, and nothing is overwritten until the
 * person picks one of the two exits.
 */
export function ConflictNotice({ diffs, busy = false, onRetry, onDiscard, title }: {
  diffs?: readonly ConflictFieldDiff[];
  busy?: boolean;
  onRetry: () => void;
  onDiscard: () => void;
  title?: string;
}) {
  return <Notice tone="warn" role="group" aria-label="Conflicto de versión" className="grid gap-2">
    <p><strong>{title ?? 'Alguien cambió este dato mientras lo editabas.'}</strong>{' '}
      Tu borrador se conserva en el formulario y no se guardó nada todavía.</p>
    {diffs?.length ? <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-xs">
        <caption className="pb-1 text-left font-medium">Qué cambió</caption>
        <thead><tr>
          <th scope="col" className="border-b border-line px-2 py-1">Campo</th>
          <th scope="col" className="border-b border-line px-2 py-1">Tu borrador</th>
          <th scope="col" className="border-b border-line px-2 py-1">Guardado ahora</th>
        </tr></thead>
        <tbody>{diffs.map((diff) => <tr key={diff.key}>
          <th scope="row" className="border-b border-line px-2 py-1 font-medium">{diff.label}</th>
          <td className="border-b border-line px-2 py-1 break-words">{diff.mine}</td>
          <td className="border-b border-line px-2 py-1 break-words">{diff.theirs}</td>
        </tr>)}</tbody>
      </table>
    </div> : null}
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="primary" disabled={busy} onClick={onRetry}>Releer y reintentar con mis cambios</Button>
      <Button size="sm" disabled={busy} onClick={onDiscard}>Descartar mis cambios</Button>
    </div>
  </Notice>;
}
