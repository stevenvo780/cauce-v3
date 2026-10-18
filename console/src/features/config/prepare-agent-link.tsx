import type { MouseEvent } from 'react';
import { onNavClick } from '../../router';
import { prepareAgentHref } from './use-agent-route';

export function PrepareAgentLink({ tenantId, alias, className }: { tenantId: string; alias: string; className?: string }) {
  const href = prepareAgentHref(tenantId, alias);
  const label = `Preparar ${alias}`;
  return (
    <a href={href} aria-label={label} title={label} className={className}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => { onNavClick(event, href); }}>
      Preparar
    </a>
  );
}
