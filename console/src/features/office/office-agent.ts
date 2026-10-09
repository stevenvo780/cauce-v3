import type { AgentAppearanceStyle } from '@cauce/protocol/agent-preferences';
import type { LiveState } from '../live/agent-state';
import type { Send } from './simulation';
import type { OfficeTeam } from './teams';

export interface OfficeAgent {
  id: string;
  name: string;
  state: LiveState;
  reason: string;
  delegatesTo: readonly string[];
  /** Deliveries handed to other agents and still in flight there, each with its own id. */
  sends?: readonly Send[];
  /** The fleet's chosen look: the hue dresses the character and the glyph rides on its name tag. */
  glyph?: string | null;
  hue?: number | null;
  /** The chosen style decides the accessory: scarf, headphones or cap; the orb wears none. */
  style?: AgentAppearanceStyle | null;
  awake?: boolean;
  /** A declared MCP client: no desk work, no agent actions, talking leaves a mailbox note. */
  visitor?: boolean;
  team?: OfficeTeam;
  groups?: readonly string[];
}
