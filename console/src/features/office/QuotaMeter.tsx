import { cn } from '../../cn';
import type { AgentQuotaBar } from './agent-quota-bar';

/** Grey hatching: an empty bar would read as «spent» and a full one as «all left». */
const NO_NUMBER = 'bg-[repeating-linear-gradient(90deg,#566c86_0_3px,#333c57_3px_6px)]';

/** The quota window that runs out first, as a pixel health bar; grey while there is no number to show. */
export function QuotaMeter({ quota, reading = false, className }: { quota: AgentQuotaBar | undefined; reading?: boolean; className?: string }) {
  const remaining = reading ? null : quota?.remaining ?? null;
  return (
    <span aria-hidden="true" className={cn('relative block h-2 border-2 border-[#0e0f17] bg-[#333c57]', remaining === null ? NO_NUMBER : null, className)}>
      {remaining !== null && quota ? <span className="absolute inset-y-0 left-0" style={{ width: `${String(remaining)}%`, backgroundColor: quota.color }} /> : null}
    </span>
  );
}
