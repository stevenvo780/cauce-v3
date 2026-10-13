import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useApi } from '../api/context';
import { usePolling } from '../api/use-polling';
import { useResource } from '../api/use-resource';
import { buildLiveViews, type LiveAgentView } from '../features/live/agent-state';
import { SharedResource } from '../api/shared-resource';
import { FleetContext, QUOTA_ACCOUNTS_POLL_MS, type FleetData } from './fleet-context';
import { saludDeColaPorAgente } from '../features/messages/queue-health';
import { construirRosterDeMensajeria } from '../features/messages/roster';
import { fleetAgentId } from '../features/terminal/fleet';

/**
 * One poller for the agent roster that the sidebar, the chat, the terminal and the office share.
 * Before it, each view fetched status, topology and activity on its own clock.
 */
export function FleetProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const status = useResource('fleet-status', () => api.getStatus());
  const topology = useResource('fleet-topology', () => api.getTopology());
  const messages = useResource('fleet-messages', () => api.listMessages());
  const activity = useResource('fleet-activity', () => api.getFleetActivity());
  const queues = useResource('fleet-queues', () => api.getQueues());
  // Quotas are only read while a view that shows them is mounted: most pages never subscribe.
  const quotaAccounts = useMemo(() => new SharedResource(() => api.getQuotaAccounts(), QUOTA_ACCOUNTS_POLL_MS), [api]);

  usePolling(messages.reload, 2_500, { pausedWhile: messages.loading });
  usePolling(status.reload, 5_000, { pausedWhile: status.loading });
  const [activityIntervalMs, setActivityIntervalMs] = useState(5_000);
  usePolling(activity.reload, activityIntervalMs, { pausedWhile: activity.loading || activityIntervalMs === 0 });
  usePolling(queues.reload, 15_000, { pausedWhile: queues.loading });
  usePolling(topology.reload, 30_000, { pausedWhile: topology.loading });

  const [lastActivityReadFailed, setLastActivityReadFailed] = useState(false);
  useEffect(() => {
    if (activity.error) setLastActivityReadFailed(true);
    else if (!activity.loading) setLastActivityReadFailed(false);
  }, [activity.error, activity.loading]);
  const activityUnavailable = Boolean(activity.error) || (lastActivityReadFailed && activity.loading);
  const activityData = activityUnavailable ? undefined : activity.data;
  const agents = useMemo(() => {
    const rosterActivity = activityUnavailable && activity.data ? {
      ...activity.data,
      agents: activity.data.agents?.map((agent) => ({ ...agent, presence: undefined })),
    } : activity.data;
    return construirRosterDeMensajeria({
      status: status.data,
      topology: topology.data,
      activity: rosterActivity,
      messages: messages.data,
    });
  }, [status.data, topology.data, activity.data, activityUnavailable, messages.data]);

  const salud = useMemo(
    () => saludDeColaPorAgente(activityData, queues.error ? undefined : queues.data),
    [activityData, queues.data, queues.error],
  );

  const live = useMemo(() => {
    const map = new Map<string, LiveAgentView>();
    if (!activityData) return map;
    for (const view of buildLiveViews(activityData, {}, Date.now()).views) {
      map.set(fleetAgentId(view.tenantId, view.alias), view);
    }
    return map;
  }, [activityData]);

  const value = useMemo<FleetData>(() => ({
    agents,
    salud,
    live,
    status,
    topology,
    messages,
    activity,
    queues,
    quotaAccounts,
    activityIntervalMs,
    setActivityIntervalMs,
    loading: (status.loading && !status.data) || (topology.loading && !topology.data)
      || (activity.loading && !activity.data) || (messages.loading && !messages.data),
    error: status.error ?? topology.error ?? activity.error ?? messages.error,
    reload: () => {
      void status.reload();
      void topology.reload();
      void messages.reload();
      void activity.reload();
      void queues.reload();
    },
  }), [agents, salud, live, status, topology, messages, activity, queues, quotaAccounts, activityIntervalMs]);

  return <FleetContext.Provider value={value}>{children}</FleetContext.Provider>;
}
