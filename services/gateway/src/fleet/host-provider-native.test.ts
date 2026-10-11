import { describe, expect, it } from 'vitest';
import { nativeProviderLogin } from './host-provider-native.js';

const command = '/approved/cli'; const sha256 = 'a'.repeat(64);
const profile = { provider: 'grok', path: '/profiles/account', command, command_sha256: sha256 };
const login = { method: 'device', command: [command, 'login', '--device-auth'], sha256 };
describe('native login projection', () => {
  it('keeps canonical HOME outside Grok profile redirection', () => {
    expect(nativeProviderLogin(profile, login)).toEqual({ command: login.command, files: undefined, env: { GROK_HOME: profile.path } });
  });
  it('uses dedicated Muse config and data without launcher overrides', () => {
    const muse = { ...profile, provider: 'muse', muse: { bridge: '/approved/bridge', bridge_sha256: 'b'.repeat(64) } };
    expect(nativeProviderLogin(muse, { ...login, command: [command, 'login'] }).env).toEqual({
      XDG_CONFIG_HOME: '/profiles/account/config', XDG_DATA_HOME: '/profiles/account/data', MUSE_NO_AUTO_UPDATE: '1' });
  });
  it.each([{ ...login, method: 'terminal' }, { ...login, command: [command, 'login', '--oauth'] },
    { ...login, sha256: 'c'.repeat(64) }, { ...login, command: ['/redirect/cli', 'login', '--device-auth'] }])('rejects a mismatched sealed Grok login', candidate => {
    expect(() => nativeProviderLogin(profile, candidate)).toThrow('provider authentication could not be verified');
  });
  it('pins the Muse bridge and complete CLI file closure even though login executes only the CLI', () => {
    const muse = { ...profile, provider: 'muse', command_files: { '/approved/module': 'c'.repeat(64) },
      muse: { bridge: '/approved/bridge', bridge_sha256: 'b'.repeat(64) } };
    expect(nativeProviderLogin(muse, { ...login, command: [command, 'login'] }).files).toEqual({
      '/approved/module': 'c'.repeat(64), '/approved/bridge': 'b'.repeat(64), [command]: sha256 });
  });
});
