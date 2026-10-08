import { spawn } from 'node:child_process';
import { z } from 'zod';
import { FleetEvidenceSchema, FleetOperationRequestSchema, FleetStepNameSchema, type FleetStepName } from '@cauce/protocol';
import type { FleetExecution, FleetEffectResult } from './executor.js';

export interface HostCommandConfig { python: string; executable: string; policyFile: string; timeoutMs?: number }
const ReceiptSchema = z.object({ evidence: FleetEvidenceSchema, awaiting_auth: z.boolean().optional() }).strict();
const MAX_RECEIPT_BYTES = 8192;
function unverified(): Error { return new Error('Host effect could not be verified'); }
function absolute(value: string): boolean { return value.startsWith('/') && !/[\p{Cc}]/u.test(value) && !value.split('/').includes('..'); }

export async function performHostCommand(
  config: HostCommandConfig, step: FleetStepName, execution: FleetExecution, signal: AbortSignal,
): Promise<FleetEffectResult> {
  return runHostCommand(config, FleetStepNameSchema.parse(step), execution, signal);
}

export async function performHostCompensation(config: HostCommandConfig, execution: FleetExecution, signal: AbortSignal) {
  const result = await runHostCommand(config, 'compensate', execution, signal);
  if (result.awaiting_auth || result.evidence.stopped_verified !== true || result.evidence.revocation_verified !== true) throw unverified();
  return result.evidence;
}

export async function performHostLoginStop(config: HostCommandConfig, execution: FleetExecution, signal: AbortSignal) {
  const result = await runHostCommand(config, 'login-stop', execution, signal);
  if (result.awaiting_auth || result.evidence.stopped_verified !== true) throw unverified();
  return { stopped: true };
}

async function runHostCommand(
  config: HostCommandConfig, step: FleetStepName | 'compensate' | 'login-stop', execution: FleetExecution, signal: AbortSignal,
): Promise<FleetEffectResult> {
  const timeoutMs = config.timeoutMs ?? 60_000;
  if (![config.python, config.executable, config.policyFile].every(absolute)
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000 || signal.aborted) throw unverified();
  const request = FleetOperationRequestSchema.parse(execution.request);
  const encoded = JSON.stringify({ operation_id: execution.operation.id, request, fenced_targets: execution.fenced_targets,
    previous_agents: execution.previous_agents ?? [], desired_memberships: execution.desired_memberships ?? [],
    ...(execution.trusted_accounts === undefined ? {} : { trusted_accounts: execution.trusted_accounts }),
    ...(execution.snapshot === undefined ? {} : { snapshot: execution.snapshot }) });
  return new Promise((resolve, reject) => {
    const child = spawn(config.python, [config.executable, '--policy', config.policyFile, '--step', step], {
      detached: true, stdio: ['pipe', 'pipe', 'ignore'],
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '', TMPDIR: '/var/tmp' },
    });
    let failed = false; let done = false; let bytes = 0;
    let force: NodeJS.Timeout | undefined;
    const chunks: Buffer[] = [];
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
    child.once('error', () => { cleanup(); reject(unverified()); });
    child.stdin.on('error', stop);
    child.once('close', (code) => {
      cleanup();
      if (code !== 0 || failed) { reject(unverified()); return; }
      try {
        const receipt = ReceiptSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        resolve({ evidence: receipt.evidence, ...(receipt.awaiting_auth === undefined ? {} : { awaiting_auth: receipt.awaiting_auth }) });
      }
      catch { reject(unverified()); }
    });
    child.stdin.end(encoded);
  });
}
