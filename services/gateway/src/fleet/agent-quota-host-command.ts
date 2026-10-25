import { z } from 'zod';
import { AgentQuotaExecutionSchema, AgentQuotaReceiptSchema, type AgentQuotaExecution } from '@cauce/protocol';
import type { HostCommandConfig } from './host-command.js';
import { fleetSshArguments } from './host-transport.js';
import { boundedProviderReceipt, LoginPathSchema } from './provider-login.js';

function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
export async function performAgentQuotaHostCommand(config: HostCommandConfig, value: AgentQuotaExecution,
  signal: AbortSignal): Promise<z.infer<typeof AgentQuotaReceiptSchema>> {
  const execution = AgentQuotaExecutionSchema.parse(value);
  [config.python, config.executable, config.policyFile].forEach(path => LoginPathSchema.parse(path));
  const { tenant_id, alias, runtime_key, harness_id, host_id, runtime_mode, container_name, runtime_user,
    home_directory, state_directory, systemd_user, primary_account_id } = execution.agent;
  const packet: Record<string, unknown> = { operation_id: execution.operation_id, action: 'query_agent', agent: {
    tenant_id, alias, runtime_key, harness_id, host_id, runtime_mode, container_name, runtime_user,
    home_directory, state_directory, systemd_user, primary_account_id,
  } };
  if (execution.trusted_accounts !== undefined) {
    packet.trusted_accounts = execution.trusted_accounts;
  }
  const args = ['-B', config.executable, '--policy', config.policyFile, '--quota'];
  const command = config.transport === undefined ? { executable: config.python, args }
    : { executable: config.transport.executable, args: [...await fleetSshArguments(config.transport), config.transport.destination,
      [config.python, ...args].map(quote).join(' ')] };
  const receipt = AgentQuotaReceiptSchema.parse(await boundedProviderReceipt(command.executable, command.args,
    JSON.stringify(packet), signal, config.timeoutMs ?? 180_000));
  if (receipt.operation_id !== execution.operation_id || receipt.tenant !== tenant_id || receipt.alias !== alias
    || receipt.host_id !== host_id || receipt.container_name !== container_name || receipt.harness !== harness_id) {
    throw new Error('Agent quota receipt is outside its execution scope');
  }
  return receipt;
}
