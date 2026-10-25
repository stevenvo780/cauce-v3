import { expect, it } from 'vitest';
import { h8eReceipt, redactH8ePane, startH8eClaudeRuntime } from './v4-h8e-claude-runtime.js';

it('reproduce el login caducado con Claude real y un proveedor local 401', async () => {
  const runtime = await startH8eClaudeRuntime();
  let safePane = '';
  try {
    expect(runtime.version).toMatch(/^2\.1\.310\b/u);
    await runtime.tmux(['new-session', '-d', '-s', 'h8e-native', '-n', 'agente', '-x', '140', '-y', '42', '-c', '/home/node/projects',
      '/home/node/.local/bin/claude --dangerously-skip-permissions --model claude-sonnet-4-6']);
    await runtime.tmux(['set-option', '-t', 'h8e-native', 'remain-on-exit', 'on']);
    await expect.poll(async () => {
      safePane = redactH8ePane((await runtime.tmux(['capture-pane', '-p', '-t', 'h8e-native:agente', '-S', '-100'])).stdout);
      return safePane;
    }, { timeout: 30_000, interval: 300 }).toMatch(/[❯›]/u);
    await runtime.tmux(['send-keys', '-t', 'h8e-native:agente', '-l', 'H8E_LOCAL_AUTHENTICATION_PROBE']);
    await runtime.tmux(['send-keys', '-t', 'h8e-native:agente', 'Enter']);
    await expect.poll(async () => {
      safePane = redactH8ePane((await runtime.tmux(['capture-pane', '-p', '-t', 'h8e-native:agente', '-S', '-100'])).stdout);
      return safePane;
    }, { timeout: 45_000, interval: 300 }).toMatch(/[●⏺]\s+Login expired\s*·\s*Please run \/login/u);
    await runtime.tmux(['send-keys', '-t', 'h8e-native:agente', '-l', '/login']);
    await runtime.tmux(['send-keys', '-t', 'h8e-native:agente', 'Enter']);
    await expect.poll(async () => redactH8ePane((await runtime.tmux(['capture-pane', '-p', '-t', 'h8e-native:agente', '-S', '-100'])).stdout),
      { timeout: 15_000, interval: 300 }).toContain('Select login method:');
    await runtime.tmux(['send-keys', '-t', 'h8e-native:agente', 'Enter']);
    await expect.poll(async () => {
      safePane = redactH8ePane((await runtime.tmux(['capture-pane', '-p', '-t', 'h8e-native:agente', '-S', '-100'])).stdout);
      return safePane;
    }, { timeout: 30_000, interval: 300 }).toContain('Paste code here if prompted >');
    await h8eReceipt('native-reproduction.json', { real_claude_cli: true, local_server_configured_status: 401,
      observed_http_request_count: runtime.requests.length, observed_http_requests: runtime.requests, login_trigger: 'synthetic persisted expired OAuth state',
      bullet_login_expired: /[●⏺]\s+Login expired/u.test(safePane), login_dialog: safePane.includes('Paste code here if prompted >') });
  } finally {
    try { await h8eReceipt('native-tui.redacted.txt', safePane); } finally { await runtime.close(); }
  }
}, 420_000);
