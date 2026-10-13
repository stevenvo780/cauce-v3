import { createContext, useContext, useMemo, useSyncExternalStore } from 'react';
import type { QuotaAccountsSnapshot } from '../api/client/my-quotas-client';
import { useApi } from '../api/context';
import { SharedResource } from '../api/shared-resource';
import type { FleetActivitySnapshot, MessagePage, QueueSnapshot, SystemStatus, TopologySnapshot } from '../api/types';
import type { Resource } from '../api/use-resource';
import type { LiveAgentView } from '../features/live/agent-state';
import type { SaludDeCola } from '../features/messages/queue-health';
import type { AgenteDeMensajeria } from '../features/messages/roster';

export interface FleetData {
  agents: AgenteDeMensajeria[];
  salud: Record<string, SaludDeCola>;
  /** Live view per roster id (`tenant:alias`); absent when activity does not report the agent. */
  live: Map<string, LiveAgentView>;
  status: Resource<SystemStatus>;
  topology: Resource<TopologySnapshot>;
  messages: Resource<MessagePage>;
  activity: Resource<FleetActivitySnapshot>;
  queues: Resource<QueueSnapshot>;
  /** Provider quota accounts: one read and one poller shared by the office plan, the campus and the agent sheet. */
  quotaAccounts?: SharedResource<QuotaAccountsSnapshot>;
  /** Activity refresh period; 0 pauses it. */
  activityIntervalMs: number;
  setActivityIntervalMs: (ms: number) => void;
  loading: boolean;
  error?: Error;
  reload: () => void;
}

export const FleetContext = createContext<FleetData | null>(null);

export function useFleet(): FleetData {
  const fleet = useContext(FleetContext);
  if (!fleet) throw new Error('useFleet needs <FleetProvider>');
  return fleet;
}

export const QUOTA_ACCOUNTS_POLL_MS = 30_000;

/**
 * The quota accounts every fleet view reads. Under `<FleetProvider>` all views share its single read;
 * a view rendered on its own keeps a private one, which only fetches while it is mounted.
 */
export function useQuotaAccounts(): Resource<QuotaAccountsSnapshot> {
  const shared = useContext(FleetContext)?.quotaAccounts;
  const api = useApi();
  const own = useMemo(() => new SharedResource(() => api.getQuotaAccounts(), QUOTA_ACCOUNTS_POLL_MS), [api]);
  const store = shared ?? own;
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
