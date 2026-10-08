import { dirname, join } from 'node:path';
import { z } from 'zod';
import { ProviderAuthError } from '../console/provider-auth.contracts.js';
import { LoginPathSchema } from './provider-login.js';

const Hash = z.string().regex(/^[0-9a-f]{64}$/u);
export const OpenClawDriver = z.object({ provider_id: z.literal('openai'), method_id: z.enum(['oauth', 'device-code']),
  version: z.literal('2026.6.6'), auth_list_source: LoginPathSchema,
  auth_list_sha256: z.literal('31f4f35423fa6d909eaa448612f06a2030d43f91872f90c07d11e4638bff2c90'),
  node_command: LoginPathSchema, node_command_sha256: Hash, bridge: LoginPathSchema, bridge_sha256: Hash }).strict();
export const openClawCompatible = (profile: { provider: string; openclaw?: unknown }): boolean => profile.openclaw === undefined || profile.provider === 'codex';
export function openClawLogin(profile: { path: string; command?: string | undefined; command_sha256?: string | undefined; command_files?: Record<string, string> | undefined;
  openclaw?: z.infer<typeof OpenClawDriver> | undefined }, agent: { runtime_key: string; state_directory: string; primary_account_id: string },
login: { command: string[]; sha256: string; files?: Record<string, string> | undefined }) {
  const driver = profile.openclaw; const reject = () => { throw new ProviderAuthError('AUTHORITY_REVOKED'); };
  if (!driver || !profile.command || !profile.command_sha256 || !/^[a-z][a-z0-9-]{0,63}$/u.test(agent.runtime_key)) return reject();
  if (login.command.length !== 5 || login.command[0] !== driver.node_command || login.command[1] !== profile.command
      || login.command.slice(2).join(' ') !== 'models auth login' || login.sha256 !== driver.node_command_sha256
      || login.files?.[profile.command] !== profile.command_sha256) return reject();
  const external = join(profile.path, '.external-cli-disabled');
  return { command: [...login.command, '--provider', driver.provider_id, '--method', driver.method_id,
    '--profile-id', `cauce:${agent.primary_account_id}`],
  files: { ...profile.command_files, ...login.files, [profile.command]: profile.command_sha256,
    [driver.auth_list_source]: driver.auth_list_sha256, [driver.bridge]: driver.bridge_sha256 },
  env: { OPENCLAW_HOME: profile.path, OPENCLAW_STATE_DIR: profile.path, OPENCLAW_CONFIG_PATH: join(profile.path, 'openclaw.json'),
    OPENCLAW_AGENT_DIR: join(profile.path, 'agents', agent.runtime_key, 'agent'), CAUCE_OPENCLAW_AGENT_ID: agent.runtime_key,
    CAUCE_OPENCLAW_WORKSPACE: join(agent.state_directory, 'workspace'), CAUCE_OPENCLAW_LOCAL: '1', CAUCE_OPENCLAW_DIST_DIR: dirname(driver.auth_list_source),
    CODEX_HOME: external, CLAUDE_CONFIG_DIR: external } };
}
