import type { ConsoleAccess, TerminalCapability } from '../../api/types';
import { permissionState } from '../../lib';
import type { TerminalTargetsSnapshot } from './api';
import { resolveLiveTui, resolveTerminalTarget, type FleetAgent, type LiveTuiStatus, type TerminalAccessStatus } from './fleet';

export const ULTIMATE_TERMINAL_PLUGIN_ID = 'ultimate-terminal.client';
export const ULTIMATE_TERMINAL_CAPABILITY = 'terminal.pty.client';

export interface PluginGate {
  enabled: boolean;
  reason: string;
  websocketPath?: string;
}

function sameOriginWebsocketPath(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const base = new URL(globalThis.location?.href ?? 'http://localhost/');
    const endpoint = new URL(value, base);
    const compatibleProtocol = base.protocol === 'https:'
      ? endpoint.protocol === 'https:' || endpoint.protocol === 'wss:'
      : endpoint.protocol === 'http:' || endpoint.protocol === 'ws:';
    return compatibleProtocol
      && endpoint.host === base.host
      && !endpoint.username
      && !endpoint.password
      && !endpoint.search
      && !endpoint.hash;
  } catch {
    return false;
  }
}

/** Client plugin gate: it grants no broker/runtime capability and defaults closed on ambiguity. */
export function ultimateTerminalGate(capability: TerminalCapability | undefined, access: ConsoleAccess | undefined): PluginGate {
  if (permissionState(access, 'ultimate-terminal.connect') !== 'allowed') {
    return { enabled: false, reason: 'Permiso RBAC DENY o UNKNOWN.' };
  }
  if (capability?.available !== true) return { enabled: false, reason: capability?.reason ?? 'Capability server-side UNKNOWN.' };
  if (capability.plugin_id !== ULTIMATE_TERMINAL_PLUGIN_ID) return { enabled: false, reason: 'Plugin identity UNKNOWN.' };
  if (!Array.isArray(capability.capabilities) || !capability.capabilities.every((item) => typeof item === 'string')) {
    return { enabled: false, reason: 'Payload de capabilities inválido.' };
  }
  if (!capability.capabilities.includes(ULTIMATE_TERMINAL_CAPABILITY)) return { enabled: false, reason: 'Capability terminal.pty.client ausente.' };
  if (!sameOriginWebsocketPath(capability.websocket_path)) return { enabled: false, reason: 'Endpoint WebSocket inválido o no same-origin.' };
  return { enabled: true, reason: 'Capability y permiso verificados por servidor.', websocketPath: capability.websocket_path };
}

/** `blocked` means the plugin gate itself is closed, before any destination is even considered. */
export interface TerminalChannelGate {
  enabled: boolean;
  status: TerminalAccessStatus | 'blocked';
  reason: string;
  websocketPath?: string;
}

/**
 * Full gate for one destination: the plugin gate (RBAC + capability + same-origin endpoint)
 * AND the server's per-target authority. Both must be explicit allows; the client only paints
 * grey buttons, the real authority is always the server's, re-checked on every session request.
 */
export function terminalChannelGate(
  capability: TerminalCapability | undefined,
  access: ConsoleAccess | undefined,
  targets: TerminalTargetsSnapshot | undefined,
  agent: FleetAgent,
): TerminalChannelGate {
  const gate = ultimateTerminalGate(capability, access);
  if (!gate.enabled) return { enabled: false, status: 'blocked', reason: gate.reason };

  // The inventory may publish its own endpoint; it is held to the same same-origin rule.
  const declared = targets?.websocket_path ?? gate.websocketPath;
  if (!sameOriginWebsocketPath(declared)) {
    return { enabled: false, status: 'blocked', reason: 'Endpoint WebSocket inválido o no same-origin.' };
  }

  const resolution = resolveTerminalTarget(targets?.items, agent);
  return {
    enabled: resolution.status === 'allowed',
    status: resolution.status,
    reason: resolution.reason,
    websocketPath: declared,
  };
}

/** Igual que `terminalChannelGate`, pero para la TUI viva del agente (modo `harness`). */
export interface LiveTuiGate {
  enabled: boolean;
  status: LiveTuiStatus | 'blocked';
  reason: string;
  websocketPath?: string;
}

/**
 * Puerta completa de la TUI en vivo: la puerta del plugin (RBAC + capability + endpoint
 * same-origin), la autoridad por destino Y que el servidor publique el modo `harness`.
 * Cualquier eslabón que no sea un permiso explícito deja la TUI cerrada, con su motivo.
 */
export function liveTuiGate(
  capability: TerminalCapability | undefined,
  access: ConsoleAccess | undefined,
  targets: TerminalTargetsSnapshot | undefined,
  agent: FleetAgent,
): LiveTuiGate {
  const channel = terminalChannelGate(capability, access, targets, agent);
  if (channel.status === 'blocked') return { enabled: false, status: 'blocked', reason: channel.reason };
  const live = resolveLiveTui(targets?.items, agent);
  return {
    enabled: live.status === 'available',
    status: live.status,
    reason: live.reason,
    ...(channel.websocketPath ? { websocketPath: channel.websocketPath } : {}),
  };
}
