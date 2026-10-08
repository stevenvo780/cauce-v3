import { AGENT_APPEARANCE_STYLES, pixelIconName, type AgentAppearanceStyle } from '@cauce/protocol/agent-preferences';
import type { Accessory } from './accessories';

/** What the office draws of an agent's chosen appearance; `icon` is a pixelarticons name, when the glyph is one. */
export interface FleetLook {
  hue: number | null;
  style: AgentAppearanceStyle;
  icon: string | null;
}

export interface LookInput {
  glyph?: string | null;
  hue?: number | null;
  style?: string | null;
}

const ACCESSORY_OF: Readonly<Record<AgentAppearanceStyle, Accessory | null>> = {
  orb: null,
  aurora: 'scarf',
  pulse: 'headphones',
  pixel: 'cap',
};

/** An unknown or missing style reads as the plain orb, so a bad value never hides the agent. */
export function fleetLook(input: LookInput): FleetLook {
  const style = AGENT_APPEARANCE_STYLES.find((candidate) => candidate === input.style) ?? 'orb';
  return {
    hue: typeof input.hue === 'number' ? input.hue : null,
    style,
    icon: pixelIconName(input.glyph) ?? null,
  };
}

export function accessoryOf(style: AgentAppearanceStyle): Accessory | null {
  return ACCESSORY_OF[style];
}
