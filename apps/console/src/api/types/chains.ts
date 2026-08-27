import type { DeliveryState } from './deliveries';

// ---------------------------------------------------------------------------------------------
// GET /v3/console/chains/:traceId — una cadena de delegación completa, por trace.
//
// La forma está copiada de `repository.agentChain()` (packages/store), no inventada: el endpoint
// existía en el gateway desde hace tiempo y no tenía UN SOLO consumidor en la consola. La
// visibilidad ya la resolvió el store nodo por nodo; acá no se filtra nada, sólo se dibuja.

/** Un extremo de arista: o es un agente que el actor puede ver, o es un id opaco y estable. */
export type AgentChainEndpoint =
  | {
    tenant_id?: string | null;
    alias?: string | null;
    delivery_id?: string | null;
    attempt?: number | null;
    status?: DeliveryState | null;
    terminal_at?: string | null;
    redacted?: false;
  }
  | { redacted: true; node_id: string };

export interface AgentChainNode {
  tenant_id?: string | null;
  alias?: string | null;
  hop_count?: number | null;
  delegated?: number | null;
  received?: number | null;
  open_branches?: number | null;
}

export interface AgentChainEdge {
  source: AgentChainEndpoint;
  /** `null` cuando la rama no llegó a materializarse (rechazada, o sin entrega producida). */
  target: AgentChainEndpoint | null;
  output_index?: number | null;
  state?: string | null;
  rejection_code?: string | null;
  hop_count?: number | null;
  hop_budget?: number | null;
  visited_depth?: number | null;
  /** La rama sigue viva: materializada y con el destino en un estado no terminal. */
  open?: boolean | null;
  response?: { decision?: string | null; reason?: string | null; outcome?: string | null } | null;
  root_message_id?: string | null;
  created_at?: string | null;
}

export interface AgentChainCounters {
  edges?: number | null;
  /** Aristas cuyos DOS extremos son invisibles para el actor. Se declaran, no se esconden. */
  hidden_edges?: number | null;
  redacted_endpoints?: number | null;
  open_branches?: number | null;
  rejected_branches?: number | null;
}

export interface AgentChainSnapshot {
  trace_id?: string | null;
  observed_at?: string | null;
  truncated?: boolean | null;
  nodes?: AgentChainNode[] | null;
  edges?: AgentChainEdge[] | null;
  origin_relays?: Record<string, unknown>[] | null;
  counters?: AgentChainCounters | null;
}
