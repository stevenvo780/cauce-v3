import { describe, expect, it } from 'vitest';
import { OpenClawDriver, openClawCompatible, openClawLogin } from './host-provider-openclaw.js';

const source = '31f4f35423fa6d909eaa448612f06a2030d43f91872f90c07d11e4638bff2c90';
const driver = { provider_id: 'openai', method_id: 'device-code', version: '2026.6.6', auth_list_source: '/usr/lib/openclaw/dist/auth-list.js',
  auth_list_sha256: source, node_command: '/usr/bin/node', node_command_sha256: 'a'.repeat(64), bridge: '/bundle/bridge.mjs', bridge_sha256: 'b'.repeat(64) } as const;
const profile = { provider: 'codex', path: '/home/dev/profiles/runtime-one/account', command: '/usr/lib/openclaw/openclaw.mjs',
  command_sha256: 'c'.repeat(64), openclaw: driver };
const agent = { runtime_key: 'runtime-one', state_directory: '/home/dev/states/runtime-one', primary_account_id: 'account-one' };
const login = { command: ['/usr/bin/node', profile.command, 'models', 'auth', 'login'], sha256: driver.node_command_sha256,
  files: { [profile.command]: profile.command_sha256 } };
describe('measured OpenClaw provider login', () => {
  it('projects a separate persistent account profile and an exact login without importing or overwriting defaults', () => {
    const projection = openClawLogin(profile, agent, login);
    expect(projection.command).toEqual([...login.command, '--provider', 'openai', '--method', 'device-code', '--profile-id', 'cauce:account-one']);
    expect(projection.env.OPENCLAW_HOME).toBe(profile.path); expect(projection.env.CODEX_HOME).toBe(`${profile.path}/.external-cli-disabled`);
    expect(projection.env.OPENCLAW_AGENT_DIR).toBe(`${profile.path}/agents/runtime-one/agent`);
    expect(projection.env.CAUCE_OPENCLAW_LOCAL).toBe('1'); expect(projection.env.CAUCE_OPENCLAW_DIST_DIR).toBe('/usr/lib/openclaw/dist');
    expect(projection.files[profile.command]).toBe(profile.command_sha256); expect(projection.files[driver.auth_list_source]).toBe(source);
  });
  it.each(['--force', '--set-default', '--provider', 'claude'])('rejects an unscoped login argument %s', value => {
    expect(() => openClawLogin(profile, agent, { ...login, command: [...login.command, value] })).toThrow();
  });
  it('rejects divergent Node, CLI and pins before opening the terminal', () => {
    expect(() => openClawLogin(profile, agent, { ...login, sha256: 'd'.repeat(64) })).toThrow();
    expect(() => openClawLogin(profile, agent, { ...login, files: {} })).toThrow();
    expect(() => openClawLogin(profile, agent, { ...login, command: ['/usr/bin/other', ...login.command.slice(1)] })).toThrow();
    expect(() => openClawLogin(profile, { ...agent, runtime_key: '../../foreign' }, login)).toThrow();
  });
  it('accepts compatible v1 native policies and refuses unmeasured provider methods and versions', () => {
    expect(openClawCompatible({ provider: 'claude' })).toBe(true);
    expect(openClawCompatible({ provider: 'claude', openclaw: driver })).toBe(false);
    expect(OpenClawDriver.safeParse(driver).success).toBe(true);
    for (const extra of [{ provider_id: 'anthropic' }, { method_id: 'cli' }, { version: '2026.1.1' }, { auth_list_sha256: '0'.repeat(64) }]) {
      expect(OpenClawDriver.safeParse({ ...driver, ...extra }).success).toBe(false);
    }
  });
});
