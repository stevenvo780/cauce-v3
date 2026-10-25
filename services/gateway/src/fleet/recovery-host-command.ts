import { FleetExecutionReasonSchema, FleetRecoveryPreflightSchema, FleetRecoveryReasonSchema, type FleetExecutionReason } from '@cauce/protocol/fleet-recovery';
import { boundedProviderReceipt } from './provider-login.js';
import type { HostCommandConfig } from './host-command.js';
import { RecoveryPreflightPayloadSchema, type RecoveryPreflightPayload } from './agent-recovery-preflight.js';

export class FleetExecutionFailure extends Error {
  constructor(readonly reason: FleetExecutionReason) { super('No se pudo completar este paso de la ejecución.'); }
}
export function fleetExecutionFailure(stderr: string): FleetExecutionFailure | undefined {
  if (stderr.length > 4096) return undefined;
  const lines = stderr.split('\n').slice(0, -1);
  const generic = lines.filter(line => line.startsWith('CAUCE_FLEET_FAILURE='));
  const legacy = lines.filter(line => line.startsWith('CAUCE_RECOVERY_FAILURE='));
  if (generic.length > 1 || legacy.length > 1) return undefined;
  const recovery = legacy.length ? FleetRecoveryReasonSchema.safeParse(legacy[0]?.slice('CAUCE_RECOVERY_FAILURE='.length)) : undefined;
  if (recovery && !recovery.success) return undefined;
  if (generic.length) {
    const reason = FleetExecutionReasonSchema.safeParse(generic[0]?.slice('CAUCE_FLEET_FAILURE='.length));
    return reason.success && (!recovery || recovery.data === reason.data)
      ? new FleetExecutionFailure(reason.data) : undefined;
  }
  return recovery?.success ? new FleetExecutionFailure(recovery.data) : undefined;
}
export async function recoveryHostPreflight(config: HostCommandConfig, payload: RecoveryPreflightPayload, signal: AbortSignal) {
  if (config.transport !== undefined || ![config.python, config.executable, config.policyFile].every(value =>
    value.startsWith('/') && !value.split('/').includes('..') && !/[\p{Cc}]/u.test(value))) throw new Error('Recovery host configuration is unavailable');
  const result = await boundedProviderReceipt(config.python,
    ['-B', config.executable, '--policy', config.policyFile, '--recovery-preflight'],
    JSON.stringify(RecoveryPreflightPayloadSchema.parse(payload)), signal, 15_000);
  return FleetRecoveryPreflightSchema.parse(result);
}
