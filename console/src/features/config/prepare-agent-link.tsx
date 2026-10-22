import type { MouseEvent } from 'react';
import { onNavClick } from '../../router';
import { prepareAgentHref } from './use-agent-route';

export function PrepareAgentLink({ tenantId, alias, className, onPrepare }: {
  tenantId: string; alias: string; className?: string; onPrepare?: () => void;
}) {
  const href = prepareAgentHref(tenantId, alias);
  const label = `Preparar ${alias}`;
  return (
    <a href={href} aria-label={label} title={label} className={className}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        onNavClick(event, href);
        if (event.defaultPrevented) onPrepare?.();
      }}>
      Preparar
    </a>
  );
}
