import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { ProviderAuthError } from '../console/provider-auth.contracts.js';
import { LoginPathSchema } from './provider-login.js';

const Hash = z.string().regex(/^[0-9a-f]{64}$/u);
export const MuseDriver = z.object({ bridge: LoginPathSchema, bridge_sha256: Hash }).strict();
interface NativeProfile {
  provider: string; path: string; command_files?: Record<string, string> | undefined; command?: string | undefined; command_sha256?: string | undefined;
  muse?: z.infer<typeof MuseDriver> | undefined;
}
interface NativeLogin { method: string; command: string[]; sha256: string; files?: Record<string, string> | undefined }
export function nativeProviderCompatible(profile: { provider: string; command?: string | undefined; command_sha256?: string | undefined; muse?: unknown }): boolean {
  return (profile.provider === 'muse' ? profile.muse !== undefined : profile.muse === undefined)
    && (!['grok', 'muse'].includes(profile.provider) || profile.command !== undefined && profile.command_sha256 !== undefined);
}
export function nativeLoginRecipe(profile: { provider: string; command?: string | undefined; command_sha256?: string | undefined }, login: NativeLogin): boolean {
  const args = profile.provider === 'codex' ? login.method === 'device' ? ['login', '--device-auth'] : ['login']
    : profile.provider === 'claude' && login.method === 'terminal' ? ['auth', 'login']
      : profile.provider === 'grok' && login.method === 'device' ? ['login', '--device-auth']
        : profile.provider === 'muse' && login.method === 'device' ? ['login'] : undefined;
  return args !== undefined && login.command[0] === profile.command && login.sha256 === profile.command_sha256
    && isDeepStrictEqual(login.command.slice(1), args);
}
export function nativeProviderLogin(profile: NativeProfile, login: NativeLogin) {
  if (['grok', 'muse'].includes(profile.provider) && (!nativeProviderCompatible(profile) || !nativeLoginRecipe(profile, login))) {
    throw new ProviderAuthError('AUTHORITY_REVOKED');
  }
  const env: Record<string, string> = profile.provider === 'grok' ? { GROK_HOME: profile.path }
    : profile.provider === 'muse' ? { XDG_CONFIG_HOME: join(profile.path, 'config'), XDG_DATA_HOME: join(profile.path, 'data'), MUSE_NO_AUTO_UPDATE: '1' }
      : { [profile.provider === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR']: profile.path };
  const files = profile.provider === 'muse' && profile.muse && profile.command && profile.command_sha256
    ? { ...profile.command_files, ...login.files, [profile.command]: profile.command_sha256, [profile.muse.bridge]: profile.muse.bridge_sha256 }
    : profile.command_files ? { ...profile.command_files, ...login.files } : login.files;
  return { command: login.command, files, env };
}
