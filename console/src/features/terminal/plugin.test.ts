import type { TerminalTarget } from './api';
import { buildFleetAgents } from './fleet';
import {
  liveTuiGate, terminalChannelGate, ultimateTerminalGate,
  ULTIMATE_TERMINAL_CAPABILITY, ULTIMATE_TERMINAL_PLUGIN_ID,
} from './plugin';

const CAPABILITY = {
  available: true,
  plugin_id: ULTIMATE_TERMINAL_PLUGIN_ID,
  capabilities: [ULTIMATE_TERMINAL_CAPABILITY],
  websocket_path: '/v3/console/terminal/ws',
};
const ACCESS = { permissions: ['ultimate-terminal.connect'] };
const [JARVIS] = buildFleetAgents({ presence: [{ tenant_id: 'Steven', alias: 'jarvis' }] });

function target(overrides: Partial<TerminalTarget> = {}): TerminalTarget {
  return {
    tenant_id: 'Steven', alias: 'jarvis', container: 'claw', runtime_user: 'claw', harness: 'claude-code',
    shares_container_with: [], modes: ['shell'], pty_state: 'online', last_seen: null,
    authorized: true, reason: 'Autorizado por el servidor.',
    ...overrides,
  };
}

it('enables Ultimate Terminal only with exact client capability and RBAC', () => {
  const capability = {
    available: true,
    plugin_id: ULTIMATE_TERMINAL_PLUGIN_ID,
    capabilities: [ULTIMATE_TERMINAL_CAPABILITY],
    websocket_path: '/v3/ws/terminal',
  };
  expect(ultimateTerminalGate(capability, { permissions: [] }).enabled).toBe(false);
  expect(ultimateTerminalGate({ ...capability, plugin_id: 'broker' }, { permissions: ['ultimate-terminal.connect'] }).enabled).toBe(false);
  expect(ultimateTerminalGate(capability, { permissions: ['ultimate-terminal.connect'] }).enabled).toBe(true);
});

it.each([
  ['capabilities string', { capabilities: ULTIMATE_TERMINAL_CAPABILITY }],
  ['capabilities mixed array', { capabilities: [ULTIMATE_TERMINAL_CAPABILITY, 7] }],
  ['numeric endpoint', { websocket_path: 7 }],
  ['cross-origin endpoint', { websocket_path: 'wss://elsewhere.example/v3/ws/terminal' }],
  ['endpoint query', { websocket_path: '/v3/ws/terminal?token=forbidden' }],
  ['endpoint fragment', { websocket_path: '/v3/ws/terminal#fragment' }],
  ['endpoint credentials', { websocket_path: 'ws://user:pass@localhost/v3/ws/terminal' }],
])('fails closed for malformed capability payload: %s', (_label, override) => {
  const malformed = {
    available: true,
    plugin_id: ULTIMATE_TERMINAL_PLUGIN_ID,
    capabilities: [ULTIMATE_TERMINAL_CAPABILITY],
    websocket_path: '/v3/ws/terminal',
    ...override,
  };
  expect(ultimateTerminalGate(malformed as never, { permissions: ['ultimate-terminal.connect'] }).enabled).toBe(false);
});

it('opens the channel only when the plugin gate AND the destination are both explicit allows', () => {
  const targets = { websocket_path: '/v3/console/terminal/ws', items: [target()] };

  expect(terminalChannelGate(CAPABILITY, ACCESS, targets, JARVIS)).toMatchObject({ enabled: true, status: 'allowed', websocketPath: '/v3/console/terminal/ws' });
  // RBAC missing: blocked before any destination is even considered.
  expect(terminalChannelGate(CAPABILITY, { permissions: [] }, targets, JARVIS)).toMatchObject({ enabled: false, status: 'blocked' });
  // Plugin gate fine, destination refused by the server.
  expect(terminalChannelGate(CAPABILITY, ACCESS, { items: [target({ authorized: false, reason: 'attribution_required' })] }, JARVIS))
    .toMatchObject({ enabled: false, status: 'denied', reason: 'attribution_required' });
});

it('never presents a harness-only viewer as an interactive PTY shell', () => {
  const targets = {
    websocket_path: '/v3/console/terminal/ws',
    items: [target({ modes: ['harness'] })],
  };

  expect(terminalChannelGate(CAPABILITY, ACCESS, targets, JARVIS)).toMatchObject({
    enabled: false,
    status: 'unknown',
    reason: expect.stringMatching(/no publica el modo shell.*solo lectura/iu) as unknown,
  });
  expect(liveTuiGate(CAPABILITY, ACCESS, targets, JARVIS)).toMatchObject({
    enabled: true,
    status: 'available',
  });
});

it('stays closed when the destination inventory is UNKNOWN', () => {
  expect(terminalChannelGate(CAPABILITY, ACCESS, undefined, JARVIS)).toMatchObject({ enabled: false, status: 'unknown' });
  expect(terminalChannelGate(CAPABILITY, ACCESS, { items: null }, JARVIS)).toMatchObject({ enabled: false, status: 'unknown' });
});

it('holds the inventory endpoint to the same same-origin rule as the capability', () => {
  const hostile = { websocket_path: 'wss://elsewhere.example/v3/console/terminal/ws', items: [target()] };
  expect(terminalChannelGate(CAPABILITY, ACCESS, hostile, JARVIS)).toMatchObject({ enabled: false, status: 'blocked' });

  const leaky = { websocket_path: '/v3/console/terminal/ws?ticket=leaked', items: [target()] };
  expect(terminalChannelGate(CAPABILITY, ACCESS, leaky, JARVIS).enabled).toBe(false);
});

it.each([
  ['agent_offline', 'offline'],
  ['not_installed', 'not_installed'],
  ['unknown', 'unknown'],
] as const)('reports %s as the explicit status %s instead of enabling the channel', (ptyState, status) => {
  const gate = terminalChannelGate(CAPABILITY, ACCESS, { items: [target({ pty_state: ptyState })] }, JARVIS);
  expect(gate).toMatchObject({ enabled: false, status });
  expect(gate.reason.length).toBeGreaterThan(0);
});
