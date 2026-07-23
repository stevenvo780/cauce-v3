import { ultimateTerminalGate, ULTIMATE_TERMINAL_CAPABILITY, ULTIMATE_TERMINAL_PLUGIN_ID } from './plugin';

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
