import type { Failure } from '../api/error-message';
import { Notice } from './kit';

/** The action and server reason stay in their own text node; the code beside them is what support asks for. */
export function ErrorNotice({ failure }: { failure: Failure }) {
  return <Notice tone="danger" role="alert" className="wrap-anywhere">
    <span>{failure.message}</span>
    {failure.code ? <> <span className="text-xs whitespace-nowrap">Código: <code>{failure.code}</code></span></> : null}
  </Notice>;
}
