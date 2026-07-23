import type { ConsoleAccess, TerminalCapability } from '../../api/types';
import { permissionState } from '../../lib';

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
