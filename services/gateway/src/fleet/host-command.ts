import { spawn } from 'node:child_process';
import { z } from 'zod';
import { FleetEvidenceSchema, FleetOperationRequestSchema, FleetStepNameSchema, FleetReplacementCommitSchema, type FleetStepName, type FleetEvidence } from '@cauce/protocol';
import { canRestoreFleetUpdate } from '@cauce/store';
import { ProviderAuthError } from '../console/provider-auth.contracts.js';
import type { FleetExecution, FleetEffectResult } from './executor.js';
import { fleetHostSpawn, type FleetSshTransport } from './host-transport.js';
import { BoundedTail, logHostCommandFailure } from './host-stderr.js';
import { providerProbeFailure, providerRuntimeFailureReason } from './provider-login.js';
import { fleetExecutionFailure } from './recovery-host-command.js';
import { replacementCompensationSnapshot, verifyReplacementCompensation } from './replacement-compensation.js';

export interface HostCommandConfig { python: string; executable: string; policyFile: string; timeoutMs?: number; transport?: FleetSshTransport }
export async function performHostRetirement(config: HostCommandConfig, execution: FleetExecution, signal: AbortSignal): Promise<FleetEvidence> {
  const commit = FleetReplacementCommitSchema.parse(execution.snapshot?.replacement_commit);
  if (execution.operation.status !== 'running' || commit.operation_id !== execution.operation.id) throw unverified();
  const result = await runHostCommand(config, 'retire-replacement', execution, signal);
  const proof = result.evidence.replacement_retired;
  if (result.awaiting_auth || proof?.commit_sha256 !== commit.commit_sha256
      || proof.original_container_id !== commit.original_container_id || proof.replacement_container_id !== commit.replacement_container_id
      || proof.runtime_digest !== commit.runtime_digest || result.evidence.stopped_verified !== true) throw unverified();
  return result.evidence;
}
const ReceiptSchema = z.object({ evidence: FleetEvidenceSchema, awaiting_auth: z.boolean().optional(),
  account_identity: z.string().min(1).max(256).regex(/^[^\p{Cc}]+$/u).refine(value => !value.startsWith('unverified:')).optional() }).strict();
const CheckpointDigest = z.string().regex(/^[a-f0-9]{64}$/u);
const MaintenanceCheckpoint = z.object({ snapshot_sha256: CheckpointDigest, original_container_id: CheckpointDigest,
  checkpoint_sha256: CheckpointDigest, generation: CheckpointDigest }).strict();
export async function performHostMaintenanceCheckpoint(config: HostCommandConfig, execution: FleetExecution, signal: AbortSignal, requireExisting = false) {
  return runHostReceipt(config, 'maintenance-checkpoint', execution, signal, output => MaintenanceCheckpoint.parse(output), requireExisting);
}
const MAX_RECEIPT_BYTES = 8192;
function unverified(): Error { return new Error('Host effect could not be verified'); }
function absolute(value: string): boolean { return value.startsWith('/') && !/[\p{Cc}]/u.test(value) && !value.split('/').includes('..'); }

export async function performHostCommand(
  config: HostCommandConfig, step: FleetStepName, execution: FleetExecution, signal: AbortSignal,
): Promise<FleetEffectResult> {
  return runHostCommand(config, FleetStepNameSchema.parse(step), execution, signal);
}

export async function performHostCompensation(config: HostCommandConfig, execution: FleetExecution, signal: AbortSignal) {
  const replacement = replacementCompensationSnapshot(execution);
  const result = await runHostCommand(config, 'compensate', execution, signal);
  if (execution.request.kind === 'recover') {
    if (result.awaiting_auth || result.evidence.recovery_compensated !== true) throw unverified();
    return { recovery_compensated: true };
  }
  verifyReplacementCompensation(execution, result.evidence);
  const restored = canRestoreFleetUpdate(execution.operation, execution.request, replacement?.previous_agents ?? execution.previous_agents ?? [], replacement)
    && result.evidence.runtime_digest !== undefined;
  if (result.awaiting_auth || (!restored && result.evidence.stopped_verified !== true)
      || result.evidence.revocation_verified !== true) throw unverified();
  return result.evidence;
}

export async function performHostLoginStop(config: HostCommandConfig, execution: FleetExecution, signal: AbortSignal) {
  try {
    const result = await runHostCommand(config, 'login-stop', execution, signal);
    if (result.awaiting_auth || result.evidence.stopped_verified !== true) throw unverified();
    return { stopped: true };
  } catch (error) {
    if (error instanceof ProviderAuthError && error.reason) throw new ProviderAuthError('STOP_UNCONFIRMED', error.reason);
    throw error;
  }
}

async function runHostCommand(
  config: HostCommandConfig, step: FleetStepName | 'compensate' | 'login-stop' | 'retire-replacement', execution: FleetExecution, signal: AbortSignal,
): Promise<FleetEffectResult> {
  return runHostReceipt(config, step, execution, signal, (output, runtimeStderr) => {
    const receipt = ReceiptSchema.parse(output);
    const probe = step === 'authenticate' ? providerProbeFailure(runtimeStderr) : undefined;
    return { evidence: receipt.evidence,
      ...(probe === undefined || !receipt.awaiting_auth ? {} : { probe_failure: probe.reason }),
      ...(receipt.awaiting_auth === undefined ? {} : { awaiting_auth: receipt.awaiting_auth }),
      ...(receipt.account_identity === undefined ? {} : { account_identity: receipt.account_identity }) };
  });
}
async function runHostReceipt<T>(
  config: HostCommandConfig, step: FleetStepName | 'compensate' | 'login-stop' | 'retire-replacement' | 'maintenance-checkpoint',
  execution: FleetExecution, signal: AbortSignal, parse: (output: unknown, runtimeStderr: string) => T, requireExistingCheckpoint = false,
): Promise<T> {
  const timeoutMs = config.timeoutMs ?? 150_000;
  const isAborted = () => signal.aborted;
  if (![config.python, config.executable, config.policyFile].every(absolute)
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000 || signal.aborted) throw unverified();
  const request = FleetOperationRequestSchema.parse(execution.request);
  const replacement = replacementCompensationSnapshot(execution);
  const encoded = JSON.stringify({ operation_id: execution.operation.id, request, fenced_targets: execution.fenced_targets,
    previous_agents: execution.previous_agents ?? [], desired_memberships: execution.desired_memberships ?? [],
    ...(step === 'compensate' && canRestoreFleetUpdate(execution.operation, request, replacement?.previous_agents ?? execution.previous_agents ?? [], replacement)
      ? { restore_previous_runtime: true } : {}),
    ...(execution.global_desired_memberships === undefined ? {} : { global_desired_memberships: execution.global_desired_memberships }),
    ...(execution.trusted_accounts === undefined ? {} : { trusted_accounts: execution.trusted_accounts }),
    ...(execution.fleet_scope === undefined ? {} : { fleet_scope: execution.fleet_scope }),
    ...(execution.snapshot === undefined ? {} : { snapshot: execution.snapshot }) });
  if (Buffer.byteLength(encoded) > 1_048_576) throw unverified();
  const specification = await fleetHostSpawn(config, step, { requireExistingCheckpoint });
  if (isAborted()) throw unverified();
  return new Promise((resolve, reject) => {
    const child = spawn(specification.executable, specification.arguments, {
      detached: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '', TMPDIR: '/var/tmp', PYTHONDONTWRITEBYTECODE: '1' },
    });
    let failed = false; let done = false; let bytes = 0; let runtimeStderr = '';
    let force: NodeJS.Timeout | undefined;
    const chunks: Buffer[] = [];
    const stderr = new BoundedTail();
    const failure = () => { const executionFailure = fleetExecutionFailure(runtimeStderr);
      if (executionFailure) return executionFailure;
      const reason = providerRuntimeFailureReason(runtimeStderr);
      return reason ? new ProviderAuthError('HOST_UNAVAILABLE', reason) : unverified(); };
    const kill = (termination: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try { process.kill(-child.pid, termination); } catch { /* The process group may already be gone. */ }
    };
    const stop = () => {
      if (done) return;
      failed = true; kill('SIGTERM');
      force ??= setTimeout(() => { kill('SIGKILL'); }, 500);
    };
    const timeout = setTimeout(stop, timeoutMs);
    const cleanup = () => { done = true; clearTimeout(timeout); if (force) clearTimeout(force); signal.removeEventListener('abort', stop); };
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > MAX_RECEIPT_BYTES) stop(); else chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => { stderr.push(chunk); runtimeStderr += chunk.toString('utf8').slice(0, 4097 - runtimeStderr.length); });
    child.stderr.on('error', () => undefined);
    child.once('error', () => { cleanup(); reject(failure()); });
    child.stdin.on('error', stop);
    child.once('close', (code) => {
      cleanup();
      const hosts = new Set(execution.previous_agents?.map(agent => agent.host_id).filter((host): host is string => typeof host === 'string'));
      const diagnostic = step === 'login-stop' ? providerRuntimeFailureReason(runtimeStderr) ?? 'helper_failed' : stderr.text();
      if (code !== 0) logHostCommandFailure(step, code, diagnostic, execution.operation.id,
        execution.fleet_scope?.host_id ?? (hosts.size === 1 ? [...hosts][0] ?? null : null));
      // The identity probe names why it failed in one allowlisted, secret-free line; journal it and carry its reason.
      const probe = step === 'authenticate' ? providerProbeFailure(runtimeStderr) : undefined;
      if (probe) process.stderr.write(`provider auth helper failed: ${probe.detail} operation_id=${execution.operation.id}\n`);
      if (code !== 0 || failed) { reject(failure()); return; }
      try {
        resolve(parse(JSON.parse(Buffer.concat(chunks).toString('utf8')), runtimeStderr));
      }
      catch { reject(failure()); }
    });
    child.stdin.end(encoded);
  });
}
