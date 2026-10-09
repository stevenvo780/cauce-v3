import { useEffect } from 'react';
import { subscribePixelIcons } from '../../components/pixel-icons/pixel-icon-cache';
import { fleetLook } from './looks';
import type { OfficeAgent } from './office-agent';
import type { Scenes } from './scene';

/** Pushes every agent's chosen look into the scene as it changes, and redraws when a pixel icon arrives. */
export function useOfficeLooks(scene: Scenes | null, agents: readonly OfficeAgent[], kick: () => void): void {
  useEffect(() => {
    if (!scene) return;
    scene.sprites.setLooks(new Map(agents.map((agent) => [agent.id, fleetLook(agent)])));
    kick();
  }, [scene, agents, kick]);
  useEffect(() => subscribePixelIcons(kick), [kick]);
}
