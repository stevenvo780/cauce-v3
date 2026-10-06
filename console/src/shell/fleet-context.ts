import { createContext, useContext } from 'react';
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
