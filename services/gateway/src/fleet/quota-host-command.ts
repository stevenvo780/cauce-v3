import { z } from 'zod';
import { QuotaProviderReportSchema } from '@cauce/protocol';
import type { QuotaOperationExecution } from '@cauce/store';
import type { HostCommandConfig } from './host-command.js';
import { fleetSshArguments } from './host-transport.js';
import { boundedProviderReceipt, ContainerLoginBindingSchema, LoginCommandSchema, LoginPathSchema } from './provider-login.js';

const Identifier = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u);
export const QuotaExecutionSchema = z.object({ operation_id: z.uuid(),
  action: z.enum(['create','authenticate','query','update_cli','delete']), consent: z.boolean(),
  environment: z.object({ id: z.uuid(), company_id: Identifier, account_id: Identifier, host_id: Identifier,
    provider: z.enum(['claude','codex','grok','muse','agy']), container_name: z.string().regex(/^cauce-quota-[a-f0-9]{32}$/u) }).strict(),
}).strict().refine(value => value.action !== 'authenticate' || value.consent);
const LoginPlan = z.object({ operation_id: z.uuid(), command: LoginCommandSchema, runtime_user: z.literal('node'),
  home: z.literal('/home/node'), cwd: z.literal('/home/node'), env: z.object({ PATH: z.string().max(256) }).strict(),
  backend: z.literal('container'), state_root: LoginPathSchema, account_scope: Identifier, ttl_seconds: z.number().int().min(1).max(900),
  container_binding: ContainerLoginBindingSchema,
}).strict();
export const QuotaEffectSchema = z.object({ runtime_verified: z.literal(true).optional(),
  container_name: z.string().regex(/^cauce-quota-[a-f0-9]{32}$/u).optional(), stopped_verified: z.literal(true).optional(),
  profile_removed_verified: z.literal(true).optional(), cli_updated_verified: z.literal(true).optional(), cli_version: z.string().min(1).max(256).optional(),
  provider_report: QuotaProviderReportSchema.optional(), captured_at: z.iso.datetime({ offset: true }).optional(),
  observation_status: z.enum(['unknown','error','stale','ok']).optional(), awaiting_auth: z.literal(true).optional(), login_plan: LoginPlan.optional(),
}).strict();
export type QuotaEffect = z.infer<typeof QuotaEffectSchema>;
function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
export function assertQuotaEffect(execution: QuotaOperationExecution, result: QuotaEffect): void {
  const report = result.provider_report;
  if (execution.action === 'create' && (result.runtime_verified !== true || result.container_name !== execution.environment.container_name || !result.cli_version)
      || execution.action === 'delete' && (result.stopped_verified !== true || result.profile_removed_verified !== true)
      || execution.action === 'update_cli' && (result.cli_updated_verified !== true || !result.cli_version)
      || execution.action === 'query' && (report === undefined || result.captured_at === undefined
        || report.account_id !== execution.environment.account_id || report.provider !== execution.environment.provider
        || report.windows.some(window => window.account_id !== execution.environment.account_id))
      || execution.action === 'authenticate' && (result.awaiting_auth !== true
        || result.login_plan?.operation_id !== execution.operation_id || result.login_plan.account_scope !== execution.environment.account_id)
      || execution.action !== 'authenticate' && (result.awaiting_auth !== undefined || result.login_plan !== undefined)) {
    throw new Error('Quota effect receipt is incomplete or outside its scope');
  }
}

async function invokeQuotaHostCommand(config: HostCommandConfig, execution: QuotaOperationExecution,
  signal: AbortSignal, action: '--quota' | '--quota-auth-verify'): Promise<unknown> {
  const input = QuotaExecutionSchema.parse(execution);
  [config.python, config.executable, config.policyFile].forEach(value => LoginPathSchema.parse(value));
  const args = [config.executable, '--policy', config.policyFile, action];
  const command = config.transport === undefined ? { executable: config.python, args }
    : { executable: config.transport.executable, args: [...await fleetSshArguments(config.transport), config.transport.destination,
      [config.python, ...args].map(quote).join(' ')] };
  const budget = config.timeoutMs ?? 180_000;
  // update_cli lets the executor time out at 200s and print the reason; a shorter receipt kills it with no stderr.
  const timeoutMs = execution.action === 'update_cli' ? Math.min(300_000, Math.max(budget, 240_000)) : budget;
  return boundedProviderReceipt(command.executable, command.args, JSON.stringify(input), signal, timeoutMs);
}

export async function performQuotaHostCommand(config: HostCommandConfig, execution: QuotaOperationExecution,
  signal: AbortSignal): Promise<QuotaEffect> {
  const result = QuotaEffectSchema.parse(await invokeQuotaHostCommand(config, execution, signal, '--quota'));
  assertQuotaEffect(execution, result);
  return result;
}

const AuthenticationReceipt = z.object({ authenticated_verified: z.literal(true),
  account_identity: z.string().min(1).max(256).regex(/^[^\p{Cc}]+$/u),
}).strict();
export async function verifyQuotaAuthenticationHostCommand(config: HostCommandConfig, execution: QuotaOperationExecution,
  signal: AbortSignal): Promise<z.infer<typeof AuthenticationReceipt>> {
  if (execution.action !== 'authenticate' || !execution.consent) throw new Error('Quota authentication verification requires consent');
  return AuthenticationReceipt.parse(await invokeQuotaHostCommand(config, execution, signal, '--quota-auth-verify'));
}
