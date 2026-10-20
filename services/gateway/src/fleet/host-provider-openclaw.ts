import { dirname, join } from 'node:path';
import { z } from 'zod';
import { ProviderAuthError } from '../console/provider-auth.contracts.js';
import { LoginPathSchema } from './provider-login.js';

const Hash = z.string().regex(/^[0-9a-f]{64}$/u);
// Same pinned OpenClaw release and provider-agnostic auth-list source for every flow (ops/cli/fleet_provider_openclaw.py).
const Pinned = { version: z.literal('2026.7.1-2'), auth_list_source: LoginPathSchema,
  auth_list_sha256: z.literal('3ef2fa38f32ce786f0bc499bae897aba68ad9c7595ef3064994b1634d13d1373'),
  node_command: LoginPathSchema, node_command_sha256: Hash, bridge: LoginPathSchema, bridge_sha256: Hash };
/** The paying binding decides the OpenClaw provider; a binding provider without a flow here is refused. */
export const OPENCLAW_PROVIDER_BY_BINDING: Readonly<Record<string, 'openai' | 'anthropic' | 'xai'>> = Object.freeze({ codex: 'openai', claude: 'anthropic', grok: 'xai' });
export const OpenClawDriver = z.union([
  z.object({ provider_id: z.literal('openai'), method_id: z.enum(['oauth', 'device-code']), ...Pinned }).strict(),
  // Isolated Anthropic login: a pasted setup-token stored under the account's own profile id, never the external Claude CLI.
  z.object({ provider_id: z.literal('anthropic'), method_id: z.literal('setup-token'), ...Pinned }).strict(),
  // Anthropic through OpenClaw's claude-cli runtime: a Claude Code login kept in `<profile>/claude`, whose email proves the account.
  z.object({ provider_id: z.literal('anthropic'), method_id: z.literal('cli'), claude_command: LoginPathSchema, claude_command_sha256: Hash, ...Pinned }).strict(),
  z.object({ provider_id: z.literal('xai'), method_id: z.enum(['oauth', 'device-code']), ...Pinned }).strict(),
]);
type Driver = z.infer<typeof OpenClawDriver>;
type Login = { method?: string; command: string[]; sha256: string; files?: Record<string, string> | undefined };
/** The approved login recipe for a driver: OpenClaw's own `models auth login`, or `claude auth login` for the `cli` method. */
export function openClawLoginRecipe(profile: { command?: string | undefined; command_sha256?: string | undefined }, driver: Driver, login: Login): boolean {
  if (driver.method_id === 'cli') {
    return login.method === 'terminal' && login.sha256 === driver.claude_command_sha256
      && login.command.length === 3 && login.command[0] === driver.claude_command && login.command.slice(1).join(' ') === 'auth login';
  }
  return login.command.length === 5 && login.command[0] === driver.node_command && login.command[1] === profile.command
    && login.command.slice(2).join(' ') === 'models auth login' && login.sha256 === driver.node_command_sha256
    && profile.command !== undefined && login.files?.[profile.command] === profile.command_sha256;
}
export const openClawCompatible = (profile: { provider: string; openclaw?: { provider_id: string } | undefined }): boolean =>
  profile.openclaw === undefined || (Object.hasOwn(OPENCLAW_PROVIDER_BY_BINDING, profile.provider)
    && OPENCLAW_PROVIDER_BY_BINDING[profile.provider] === profile.openclaw.provider_id);
export function openClawLogin(profile: { path: string; command?: string | undefined; command_sha256?: string | undefined; command_files?: Record<string, string> | undefined;
  openclaw?: z.infer<typeof OpenClawDriver> | undefined }, agent: { runtime_key: string; state_directory: string; primary_account_id: string },
login: Login) {
  const driver = profile.openclaw; const reject = () => { throw new ProviderAuthError('AUTHORITY_REVOKED'); };
  if (!driver || !profile.command || !profile.command_sha256 || !/^[a-z][a-z0-9-]{0,63}$/u.test(agent.runtime_key)) return reject();
  if (!openClawLoginRecipe(profile, driver, login)) return reject();
  const external = join(profile.path, '.external-cli-disabled');
  const files = { ...profile.command_files, ...login.files, [profile.command]: profile.command_sha256,
    [driver.auth_list_source]: driver.auth_list_sha256, [driver.bridge]: driver.bridge_sha256 };
  if (driver.method_id === 'cli') {
    return { command: login.command, files: { ...files, [driver.claude_command]: driver.claude_command_sha256 },
      env: { CLAUDE_CONFIG_DIR: join(profile.path, 'claude'), TMPDIR: join(profile.path, 'tmp') } };
  }
  return { command: [...login.command, '--provider', driver.provider_id, '--method', driver.method_id,
    '--profile-id', `cauce:${agent.primary_account_id}`],
  files,
  env: { OPENCLAW_HOME: profile.path, OPENCLAW_STATE_DIR: profile.path, OPENCLAW_CONFIG_PATH: join(profile.path, 'openclaw.json'),
    OPENCLAW_AGENT_DIR: join(profile.path, 'agents', agent.runtime_key, 'agent'), CAUCE_OPENCLAW_AGENT_ID: agent.runtime_key,
    CAUCE_OPENCLAW_WORKSPACE: join(agent.state_directory, 'workspace'), CAUCE_OPENCLAW_LOCAL: '1', CAUCE_OPENCLAW_DIST_DIR: dirname(driver.auth_list_source),
    CODEX_HOME: external, CLAUDE_CONFIG_DIR: external,
    TMPDIR: join(profile.path, 'tmp'), NODE_COMPILE_CACHE: join(profile.path, 'tmp', 'node-compile-cache') } };
}
