import type { ConsoleAccess, TerminalCapability } from '../../api/types';
import { permissionState } from '../../lib';
import type { TerminalTarget, TerminalTargetsSnapshot } from './api';
import {
  resolveLiveTui, resolveTerminalTarget, SHELL_MODE,
  type FleetAgent, type LiveTuiStatus, type TerminalAccessStatus,
} from './fleet';

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
    const currentHref = typeof globalThis.location !== 'undefined' ? globalThis.location.href : 'http://localhost/';
    const base = new URL(currentHref);
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
    return { enabled: false, reason: 'Tu cuenta no tiene concedido el permiso de conectar a la terminal, o no se pudo leer el permiso. Ante la duda, cerrado.' };
  }
  if (capability?.available !== true) return { enabled: false, reason: capability?.reason ?? 'El servidor no dijo si el canal PTY está disponible en este stack.' };
  if (capability.plugin_id !== ULTIMATE_TERMINAL_PLUGIN_ID) return { enabled: false, reason: 'El servidor anunció otro cliente de terminal, no éste: la consola no se conecta a un canal que no reconoce.' };
  if (!Array.isArray(capability.capabilities) || !capability.capabilities.every((item) => typeof item === 'string')) {
    return { enabled: false, reason: 'Payload de capabilities inválido.' };
  }
  if (!capability.capabilities.includes(ULTIMATE_TERMINAL_CAPABILITY)) return { enabled: false, reason: 'Capability terminal.pty.client ausente.' };
  if (!sameOriginWebsocketPath(capability.websocket_path)) return { enabled: false, reason: 'Endpoint WebSocket inválido o no same-origin.' };
  return { enabled: true, reason: 'Capability y permiso verificados por servidor.', websocketPath: capability.websocket_path };
}

/** `blocked` means the plugin gate itself is closed, before any destination is even considered. */
interface CanalGate<S> {
  enabled: boolean;
  status: S | 'blocked';
  reason: string;
  websocketPath?: string;
}

interface CanalResolution<S> {
  status: S;
  reason: string;
  target?: TerminalTarget;
}

/**
 * The single body behind both public gates: the plugin gate (RBAC + capability + same-origin
 * endpoint), then the endpoint the inventory may publish held to that SAME rule, and only then
 * the server's per-target authority. Sharing it is what stops the two channels from ever
 * disagreeing about same-origin. The client only paints grey buttons; the real authority is
 * always the server's, re-checked on every session request.
 */
function canalGate<S>(
  capability: TerminalCapability | undefined,
  access: ConsoleAccess | undefined,
  targets: TerminalTargetsSnapshot | undefined,
  agent: FleetAgent,
  resolve: (items: TerminalTarget[] | null | undefined, agent: FleetAgent) => CanalResolution<S>,
  openStatus: S,
): { gate: CanalGate<S>; target?: TerminalTarget } {
  const plugin = ultimateTerminalGate(capability, access);
  if (!plugin.enabled) return { gate: { enabled: false, status: 'blocked', reason: plugin.reason } };
  const declared = targets?.websocket_path ?? plugin.websocketPath;
  if (!sameOriginWebsocketPath(declared)) {
    return { gate: { enabled: false, status: 'blocked', reason: 'Endpoint WebSocket inválido o no same-origin.' } };
  }
  const resolution = resolve(targets?.items, agent);
  return {
    gate: {
      enabled: resolution.status === openStatus,
      status: resolution.status,
      reason: resolution.reason,
      websocketPath: declared,
    },
    ...(resolution.target ? { target: resolution.target } : {}),
  };
}

/** Full gate for one destination, plus the refusal to present a read-only TUI as a shell. */
export function terminalChannelGate(
  capability: TerminalCapability | undefined,
  access: ConsoleAccess | undefined,
  targets: TerminalTargetsSnapshot | undefined,
  agent: FleetAgent,
): CanalGate<TerminalAccessStatus> {
  const { gate, target } = canalGate(capability, access, targets, agent, resolveTerminalTarget, 'allowed');
  if (gate.status === 'allowed' && !target?.modes.includes(SHELL_MODE)) {
    return {
      enabled: false,
      status: 'unknown',
      reason: `El agente PTY de ${agent.alias} está conectado, pero no publica el modo shell. `
        + 'La consola no convierte una TUI de solo lectura en una terminal interactiva.',
      websocketPath: gate.websocketPath,
    };
  }
  return gate;
}

/** Same as `terminalChannelGate`, but for the agent's live TUI (`harness` mode). */
export function liveTuiGate(
  capability: TerminalCapability | undefined,
  access: ConsoleAccess | undefined,
  targets: TerminalTargetsSnapshot | undefined,
  agent: FleetAgent,
): CanalGate<LiveTuiStatus> {
  return canalGate(capability, access, targets, agent, resolveLiveTui, 'available').gate;
}
