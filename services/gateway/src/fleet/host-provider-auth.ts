import { OpenClawDriver, openClawCompatible, openClawLogin } from './host-provider-openclaw.js';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { FleetOperationRequestSchema } from '@cauce/protocol';
import { assertFleetOperationAuthority, loadFleetHostScope, lockFleetRevision, preparedState, publicFleetOperation, withTransaction,
  type DatabaseClient, type DatabasePool, type FleetOperationRow } from '@cauce/store';
import { ProviderAuthError } from '../console/provider-auth.contracts.js';
import { assertProviderAuthSealedScope, createProviderAuthDependencies, resolveProviderAuthRequest,
  type ProviderAuthPhysicalScope, type ProviderAuthPolicyResolver } from '../console/provider-auth-binding.js';
import { ProviderAuthManager } from '../console/provider-auth.sessions.js';
import type { ProviderAuthActor, ProviderAuthLogin, ProviderAuthRequest, ProviderAuthService } from '../console/provider-auth.types.js';
import type { FleetExecution } from './executor.js';
import { readFleetProviderAccounts, scopedFleetProviderAgents } from './accounts.js';
import { trustedFleetBaseline } from './baseline.js';
import { fleetHostInputs } from './coordinator.js';
import { performHostCommand, performHostLoginStop, type HostCommandConfig } from './host-command.js';
import { assertLoginPins, cleanupProviderLogin, ContainerLoginBindingSchema, createProviderLogin, LoginCommandSchema,
  LoginPathSchema, LoginPinsSchema, queryProviderLoginBinding, readPrivateJson, type ProviderLoginConfig } from './provider-login.js';

const Identifier = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u);
const User = z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/u);
const Hash = z.string().regex(/^[0-9a-f]{64}$/u);
const Text = z.string().min(1).max(4096).refine(value => !/[\p{Cc}]/u.test(value));
const Provider = z.enum(['codex', 'claude', 'gemini', 'minimax', 'grok', 'feihoa']);
const Profile = z.object({ provider: Provider, path: LoginPathSchema, identity: Text, runtime_user: User,
  container_name: Text.optional(), command: LoginPathSchema.optional(), command_sha256: Hash.optional(), command_files: LoginPinsSchema.optional(), openclaw: OpenClawDriver.optional(),
}).strict().refine(openClawCompatible).refine(value => (value.command === undefined) === (value.command_sha256 === undefined));
const Profiles = z.record(Identifier, Profile).refine(value => Object.keys(value).length <= 1000);
const Login = z.object({ method: z.enum(['device', 'terminal']), command: LoginCommandSchema, sha256: Hash,
  files: LoginPinsSchema.optional(), env: z.record(z.string().regex(/^[A-Z_][A-Z0-9_]{0,63}$/u), Text).refine(value => Object.keys(value).length <= 32).optional() }).strict();
const Template = z.object({ provider: Provider, runtime_user: User, path_root: LoginPathSchema,
  command: LoginPathSchema, command_sha256: Hash, command_files: LoginPinsSchema.optional(), openclaw: OpenClawDriver.optional(),
  runtime_mode: z.enum(['native', 'container']).optional(), container_name: z.string().regex(/^[a-z][a-z0-9-]{0,127}$/u).optional(),
  container_prefix: z.string().regex(/^[a-z][a-z0-9-]{0,47}-$/u).optional(), login: Login.optional(),
}).strict().refine(openClawCompatible).refine(value => {
  const selectors = Number(value.container_name !== undefined) + Number(value.container_prefix !== undefined);
  return value.runtime_mode === 'container' ? selectors === 1 : selectors === 0;
}).refine(value => {
  const login = value.login; if (!login) return true;
  if (login.command.slice(1).some(arg => arg.startsWith('/') && login.files?.[arg] === undefined)) return false;
  const args = value.provider === 'codex' ? login.method === 'device' ? ['login', '--device-auth'] : ['login']
    : value.provider === 'claude' && login.method === 'terminal' ? ['auth', 'login'] : undefined;
  return value.openclaw === undefined ? login.command[0] === value.command && login.sha256 === value.command_sha256 && isDeepStrictEqual(login.command.slice(1), args)
    : login.command[0] === value.openclaw.node_command && login.sha256 === value.openclaw.node_command_sha256
      && login.method === 'device' && isDeepStrictEqual(login.command.slice(1), [value.command, 'models', 'auth', 'login']) && login.files?.[value.command] === value.command_sha256;
});
const Templates = z.array(Template).max(100).refine(value => new Set(value.map(row => JSON.stringify([
  row.provider, row.runtime_user, row.openclaw !== undefined, row.runtime_mode, row.container_name, row.container_prefix]))).size === value.length);
const Policy = z.object({ schemaVersion: z.literal(1), host_id: Identifier, state_root: LoginPathSchema,
  helper: z.object({ executable: LoginPathSchema, sha256: Hash, files: LoginPinsSchema.optional() }).strict(), profiles: Profiles,
  profile_templates: Templates.optional(),
  logins: z.partialRecord(z.enum(['codex', 'claude', 'openclaw']), Login) }).strict();
const ExecutorPolicy = z.object({ schemaVersion: z.literal(1), host_id: Identifier, profiles: Profiles, profile_templates: Templates.optional() }).loose();
const Agent = z.object({ tenant_id: Text, alias: Identifier, harness_id: Identifier, host_id: Identifier, runtime_user: User,
  primary_account_id: Identifier, runtime_key: Text, runtime_mode: z.enum(['native', 'container']), container_name: Text,
  home_directory: LoginPathSchema, state_directory: LoginPathSchema }).loose();
const Binding = z.object({ agent: Agent, profile_binding: Profile, runtime_binding: ContainerLoginBindingSchema.optional() }).strict();
const Snapshot = z.object({ agents: z.array(z.record(z.string(), z.unknown())), memberships: z.array(z.record(z.string(), z.unknown())),
  rolePolicies: z.array(z.record(z.string(), z.unknown())),
  purgedRuntimeKeys: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u)).max(1000).optional() }).strict().refine(value => {
  const keys = value.purgedRuntimeKeys ?? [];
  return new Set(keys).size === keys.length && !value.agents.some(agent => keys.includes(String(agent.runtime_key)));
});
const unavailable = () => new ProviderAuthError('HOST_UNAVAILABLE');
const denied = () => new ProviderAuthError('AUTHORITY_REVOKED');
export interface HostProviderAuthOptions {
  hostConfig: { host: string; command: HostCommandConfig }; authPolicyFile: string; projectRoot: string;
}
export type HostProviderAuthService = ProviderAuthService & { resolve(actor: ProviderAuthActor, operationId: string): Promise<ProviderAuthRequest> };

async function policies(options: HostProviderAuthOptions): Promise<z.infer<typeof Policy>> {
  try {
    const auth = Policy.parse(await readPrivateJson(options.authPolicyFile));
    const executor = ExecutorPolicy.parse(await readPrivateJson(options.hostConfig.command.policyFile));
    if (auth.host_id !== options.hostConfig.host || executor.host_id !== auth.host_id || !isDeepStrictEqual(auth.profiles, executor.profiles)
        || !isDeepStrictEqual(auth.profile_templates, executor.profile_templates)) throw unavailable();
    await assertLoginPins({ ...auth.helper.files, [auth.helper.executable]: auth.helper.sha256 });
    return auth;
  } catch { throw unavailable(); }
}
function selected(policy: z.infer<typeof Policy>, accountId: string, provider: string, identity: string, runtimeUser: string,
  placement: { runtime_key: unknown; runtime_mode: unknown; container_name: unknown }, harness: string) {
  let profile = policy.profiles[accountId];
  let templateLogin: z.infer<typeof Login> | undefined;
  if (!profile) {
    const templates = policy.profile_templates?.filter(value => value.provider === provider && value.runtime_user === runtimeUser
      && (harness === 'openclaw') === (value.openclaw !== undefined) && (value.runtime_mode === undefined || value.runtime_mode === placement.runtime_mode)
      && (value.container_name === undefined || value.container_name === placement.container_name)
      && (value.container_prefix === undefined || typeof placement.container_name === 'string' && placement.container_name.startsWith(value.container_prefix))) ?? [];
    const template = templates.length === 1 ? templates[0] : undefined;
    const runtime = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u).safeParse(placement.runtime_key);
    if (!template || !runtime.success || !z.enum(['native', 'container']).safeParse(placement.runtime_mode).success) throw denied();
    templateLogin = template.login;
    profile = Profile.parse({ provider, runtime_user: runtimeUser, identity,
      path: join(template.path_root, runtime.data, createHash('sha256').update(accountId).digest('hex')),
      command: template.command, command_sha256: template.command_sha256,
      ...(template.command_files === undefined ? {} : { command_files: template.command_files }),
      ...(template.openclaw === undefined ? {} : { openclaw: template.openclaw }),
      ...(placement.runtime_mode === 'container' ? { container_name: Text.parse(placement.container_name) } : {}) });
  }
  if (profile.provider !== provider || profile.identity !== identity || profile.runtime_user !== runtimeUser
      || (provider !== 'codex' && provider !== 'claude') || (harness === 'openclaw') !== (profile.openclaw !== undefined)
      || (placement.runtime_mode === 'container' ? profile.container_name !== placement.container_name : profile.container_name !== undefined)) throw denied();
  const loginKey = harness === 'openclaw' ? 'openclaw' : provider;
  const login = Login.safeParse(templateLogin ?? policy.logins[loginKey]); if (!login.success) throw denied();
  return { profile, login: login.data };
}
function resolver(options: HostProviderAuthOptions): ProviderAuthPolicyResolver {
  return async (client, context) => {
    const policy = await policies(options);
    const { account, agent, operation } = context;
    const placement = (await client.query<{ runtime_key: string | null; runtime_mode: string | null; container_name: string }>(
      'SELECT runtime_key,runtime_mode,container_name FROM agents WHERE tenant_id=$1 AND alias=$2 FOR SHARE', [agent.tenant_id, agent.alias])).rows[0];
    if (!placement) throw denied();
    const { profile } = selected(policy, account.id, account.provider, account.external_account_id, agent.runtime_user, placement, agent.harness_id);
    if (agent.host_id !== policy.host_id || account.id !== agent.primary_account_id) throw denied();
    await assertProviderAuthSealedScope(client, operation, agent);
    return { provider_id: profile.provider, account_id: account.id, harness_id: agent.harness_id, host_id: policy.host_id,
      runtime_user: profile.runtime_user, profile_id: account.id };
  };
}
async function operation(client: DatabaseClient, scope: ProviderAuthPhysicalScope, active: boolean): Promise<FleetOperationRow> {
  const row = (await client.query<FleetOperationRow>(`SELECT * FROM fleet_operations WHERE id=$1 ${active ? 'FOR SHARE' : ''}`, [scope.operation_id])).rows[0];
  if (row?.target.resource !== 'agent' || !['create', 'update', 'start', 'restore'].includes(row.kind)) throw denied();
  if (active && (row.status !== 'awaiting_auth' || row.cancel_requested || row.target.tenant_id !== scope.tenant_id || row.target.alias !== scope.alias)) throw denied();
  return row;
}
async function activeExecution(client: DatabaseClient, scope: ProviderAuthPhysicalScope, snapshotQuery: string): Promise<FleetExecution> {
  await lockFleetRevision(client);
  const row = await operation(client, scope, true);
  await lockFleetRevision(client, Number(row.desired_revision ?? row.expected_revision));
  await assertFleetOperationAuthority(client, row);
  const reservation = (await client.query<{ state: string; expires: string }>(`SELECT metadata->'provider_auth'->>'state' AS state,
    metadata->'provider_auth'->>'expires_at' AS expires FROM fleet_operation_events
    WHERE operation_id=$1 AND metadata ? 'provider_auth' ORDER BY id DESC LIMIT 1`, [row.id])).rows[0];
  if (reservation?.state !== 'reserved' || !Number.isFinite(Date.parse(reservation.expires))
      || Date.parse(reservation.expires) <= Date.now()) throw new ProviderAuthError('SESSION_EXPIRED');
  const prepared = await preparedState(client, row.id);
  const raw = (await client.query<{ jsonb_build_object: unknown }>(snapshotQuery)).rows;
  if (raw.length !== 1) throw unavailable();
  const snapshot = Snapshot.parse(raw[0]?.jsonb_build_object);
  snapshot.agents = await trustedFleetBaseline(client, snapshot.agents);
  prepared.previous_agents = await trustedFleetBaseline(client, prepared.previous_agents);
  const matches = snapshot.agents.filter(value => value.tenant_id === scope.tenant_id && value.alias === scope.alias);
  const agent = Agent.parse(matches.length === 1 ? matches[0] : undefined);
  if (agent.harness_id !== scope.harness_id || agent.host_id !== scope.host_id || agent.runtime_user !== scope.runtime_user
      || agent.primary_account_id !== scope.account_id || scope.profile_id !== scope.account_id || agent.runtime_key !== scope.runtime_key) throw denied();
  const sealed = await assertProviderAuthSealedScope(client, row, agent);
  if (sealed.target_sha256 !== scope.host_scope_sha256) throw denied();
  const account = (await client.query<{ provider: string; external_account_id: string; enabled: boolean; consent: boolean }>(`SELECT provider,external_account_id,enabled,
    (payer_tenant_id=$2 OR shared_with_pool) AS consent FROM provider_accounts WHERE id=$1 FOR SHARE`, [scope.account_id, scope.tenant_id])).rows[0];
  if (!account?.enabled || !account.consent || account.provider !== scope.provider_id || account.external_account_id !== scope.expected_external_account_id) throw denied();
  const trusted_accounts = await readFleetProviderAccounts(client, scopedFleetProviderAgents(
    row.request, prepared.fenced_targets, prepared.previous_agents, snapshot.agents));
  const hostScope = await loadFleetHostScope(client, row, scope.host_id);
  return { operation: publicFleetOperation(row), request: FleetOperationRequestSchema.parse(row.request), ...prepared,
    ...fleetHostInputs(hostScope.targets, prepared), snapshot, trusted_accounts };
}
async function loginConfiguration(options: HostProviderAuthOptions, execution: FleetExecution, scope: ProviderAuthPhysicalScope,
  signal: AbortSignal): Promise<ProviderLoginConfig> {
  const policy = await policies(options);
  const target = Snapshot.parse(execution.snapshot).agents;
  const expected = target.find(value => value.tenant_id === scope.tenant_id && value.alias === scope.alias);
  const agent = Agent.parse(expected);
  const { profile, login } = selected(policy, scope.account_id, scope.provider_id, scope.expected_external_account_id, scope.runtime_user, agent, agent.harness_id);
  const binding = Binding.parse(await queryProviderLoginBinding(options.hostConfig.command, execution, signal));
  for (const key of ['tenant_id', 'alias', 'runtime_key', 'harness_id', 'host_id', 'runtime_mode', 'container_name', 'runtime_user',
    'home_directory', 'state_directory', 'primary_account_id'] as const) if (binding.agent[key] !== agent[key]) throw denied();
  if (!isDeepStrictEqual(binding.profile_binding, profile) || (agent.runtime_mode === 'container') !== (binding.runtime_binding !== undefined)
      || (profile.container_name !== undefined && profile.container_name !== agent.container_name)) throw denied();
  const projected = agent.harness_id === 'openclaw' ? openClawLogin(profile, agent, login) : { command: login.command, files: login.files,
    env: { [profile.provider === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR']: profile.path } };
  const env = { ...login.env };
  for (const [key, value] of Object.entries({ HOME: agent.home_directory, PATH: '/usr/bin:/bin', ...projected.env })) {
    if (env[key] !== undefined && env[key] !== value) throw denied(); env[key] = value;
  }
  for (const value of projected.command.slice(1)) if (value.startsWith('/') && projected.files?.[value] === undefined) throw unavailable();
  return { python: options.hostConfig.command.python, helper: policy.helper, stateRoot: policy.state_root, method: login.method,
    packet: { operation_id: scope.operation_id, command: projected.command, command_sha256: login.sha256,
      ...(projected.files === undefined ? {} : { command_files: projected.files }), runtime_user: agent.runtime_user,
      home: agent.home_directory, cwd: agent.home_directory, env, backend: agent.runtime_mode, state_root: policy.state_root,
      account_scope: scope.account_id, ttl_seconds: 600,
      ...(binding.runtime_binding === undefined ? {} : { container_binding: binding.runtime_binding }) } };
}
function guardedLogin(login: ProviderAuthLogin, start: () => Promise<void>): ProviderAuthLogin {
  return { method: login.method, subscribeOutput: listener => login.subscribeOutput(listener), start,
    write: bytes => login.write(bytes), resize: (cols, rows) => login.resize(cols, rows), close: () => login.close() };
}

export async function createHostProviderAuthService(pool: DatabasePool, options: HostProviderAuthOptions): Promise<HostProviderAuthService> {
  LoginPathSchema.parse(options.projectRoot); Identifier.parse(options.hostConfig.host);
  await policies(options);
  const snapshotQuery = await readFile(join(options.projectRoot, 'ops/scripts/fleet-query.sql'), 'utf8');
  const resolve = resolver(options);
  const logins = new Map<string, ProviderAuthLogin>();
  const run = async <T>(scope: ProviderAuthPhysicalScope, signal: AbortSignal, effect: (execution: FleetExecution) => Promise<T>): Promise<T> => {
    signal.throwIfAborted();
    return withTransaction(pool, async client => {
      const execution = await activeExecution(client, scope, snapshotQuery); signal.throwIfAborted();
      const result = await effect(execution); signal.throwIfAborted();
      await activeExecution(client, scope, snapshotQuery); return result;
    });
  };
  const dependencies = createProviderAuthDependencies(pool, resolve, {
    stopAdapter: (scope, signal) => run(scope, signal, execution => performHostLoginStop(options.hostConfig.command, execution, signal)),
    openLogin: (scope, signal) => run(scope, signal, async execution => {
      const config = await loginConfiguration(options, execution, scope, signal);
      const login = await createProviderLogin(config, signal);
      const guarded = guardedLogin(login, () => run(scope, signal, async fresh => {
        const current = await loginConfiguration(options, fresh, scope, signal);
        if (!isDeepStrictEqual(current.packet, config.packet) || !isDeepStrictEqual(current.helper, config.helper)) throw denied();
        await login.start();
      }));
      logins.set(scope.operation_id, guarded); return guarded;
    }),
    verify: async (scope, signal) => {
      const login = logins.get(scope.operation_id);
      if (!login || !(await login.close()).stopped) throw new ProviderAuthError('STOP_UNCONFIRMED');
      return run(scope, signal, async execution => {
        await loginConfiguration(options, execution, scope, signal);
        const result = await performHostCommand(options.hostConfig.command, 'authenticate', execution, signal);
        return { identity_matches: !result.awaiting_auth && result.evidence.provider_verified === true,
          functional_call_verified: !result.awaiting_auth && result.evidence.provider_verified === true };
      });
    },
    cleanup: async (scope, _sessionId, signal, borrowedClient) => {
      try {
        const policy = await policies(options);
        const client = borrowedClient ?? await pool.connect(); let execution: FleetExecution;
        try {
          const row = await operation(client, scope, false); const prepared = await preparedState(client, row.id);
          const sealed = await loadFleetHostScope(client, row, options.hostConfig.host);
          const selected = sealed.agents.find(agent => agent.tenant_id === row.target.tenant_id
            && row.target.resource === 'agent' && agent.alias === row.target.alias);
          if (!selected || scope.host_id !== options.hostConfig.host || selected.runtime_user !== scope.runtime_user
              || selected.primary_account_id !== scope.account_id || scope.profile_id !== scope.account_id) throw denied();
          await assertProviderAuthSealedScope(client, row, selected);
          const agents = await trustedFleetBaseline(client, sealed.agents);
          execution = { operation: publicFleetOperation(row), request: FleetOperationRequestSchema.parse(row.request),
            ...fleetHostInputs(sealed.targets, prepared),
            snapshot: { agents, memberships: [], rolePolicies: [] }, trusted_accounts: await readFleetProviderAccounts(client, agents) };
        } finally { if (!borrowedClient) client.release(); }
        const stopped = await cleanupProviderLogin({ python: options.hostConfig.command.python, helper: policy.helper,
          stateRoot: policy.state_root }, scope.operation_id, signal);
        if (!stopped.stopped) return stopped;
        await performHostLoginStop(options.hostConfig.command, execution, signal);
        logins.delete(scope.operation_id); return { stopped: true };
      } catch { return { stopped: false }; }
    },
  });
  const manager = new ProviderAuthManager(dependencies);
  return Object.assign(manager, { resolve: (actor: ProviderAuthActor, operationId: string) => resolveProviderAuthRequest(pool, actor, operationId, resolve) });
}
