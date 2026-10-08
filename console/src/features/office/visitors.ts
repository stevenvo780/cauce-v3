import { useCallback, useEffect, useState } from 'react';
import { useApi } from '../../api/context';
import { usePolling } from '../../api/use-polling';
import type { ClientConnection } from '../../api/types/client-delegations';
import type { FleetAgent } from '../terminal/fleet';
import { fleetAgentId } from '../terminal/fleet';

/** An MCP client the owner declared (Dots, GPT…). Cauce cannot see whether it is connected right now. */
export interface McpVisitor {
  /** Office key, same shape as fleet agents: `tenant/alias`. */
  id: string;
  tenantId: string;
  alias: string;
  label: string;
  lastPublicationAt: string | null;
}

const MAILBOX = /^mbx-[a-f0-9]{48}$/u;
export const isMailboxAlias = (alias: string) => MAILBOX.test(alias);

/** Published within this window: drawn awake, never as working. */
export const RECENT_VISITOR_MS = 15 * 60_000;

export function visitorsOf(items: readonly ClientConnection[]): McpVisitor[] {
  return items.flatMap((item) => (item.mailbox && item.label && !item.revoked ? [{
    id: `${item.mailbox.tenant_id}/${item.mailbox.alias}`,
    tenantId: item.mailbox.tenant_id,
    alias: item.mailbox.alias,
    label: item.label,
    lastPublicationAt: item.last_publication_at,
  }] : []));
}

/** The transcript helpers only read tenant and alias; a mailbox has no rooms or lease. */
export function mailboxAgent(tenantId: string, alias: string): FleetAgent {
  return { id: fleetAgentId(tenantId, alias), tenantId, alias, roomIds: [], roomMembership: {}, leaseState: 'unknown' };
}

/** The owner's declared MCP clients with a mailbox. Without access (no operator session) it stays empty. */
export function useMcpVisitors(): McpVisitor[] {
  const api = useApi();
  const [visitors, setVisitors] = useState<McpVisitor[]>([]);
  const load = useCallback(() => {
    api.listClientConnections().then((page) => { setVisitors(visitorsOf(page.items)); }, () => { setVisitors([]); });
  }, [api]);
  useEffect(() => { load(); }, [load]);
  usePolling(load, 60_000);
  return visitors;
}
