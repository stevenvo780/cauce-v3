import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { FleetExecution } from './executor.js';
import type { HostCommandConfig } from './host-command.js';
import type { FleetOperationClaim } from '@cauce/store';
import { boundedProviderReceipt } from './provider-login.js';

export const MaintenanceDeferReasonSchema = z.enum(['pending_deliveries', 'provider_login', 'composer_busy',
  'turn_active', 'tui_unreadable', 'preflight_unavailable']);
const Hash = z.string().regex(/^[a-f0-9]{64}$/u);
const Ready = z.object({ state: z.literal('ready'), operation_id: z.uuid(), container_id: Hash,
  generation: Hash, guard_id: z.string().regex(/^[a-f0-9]{32,64}$/u) }).strict();
const Event = z.union([Ready, z.object({ state: z.literal('deferred'), reason: MaintenanceDeferReasonSchema }).strict(),
  z.object({ state: z.enum(['runtime_current', 'stopped', 'aborted']) }).strict()]);
export type MaintenanceGuardEvent = z.infer<typeof Event>;
export interface MaintenanceGuard {
  first: MaintenanceGuardEvent;
  finish(commit: boolean): Promise<void>;
}
const unavailable = () => new Error('Host maintenance guard could not be verified');

function maintenancePacket(execution: FleetExecution, claim: FleetOperationClaim): Record<string, unknown> {
  const target = execution.request.target;
  const agents = z.array(z.record(z.string(), z.unknown())).parse(execution.snapshot?.agents);
  const selected = agents.filter(agent => target.resource === 'agent'
    && agent.tenant_id === target.tenant_id && agent.alias === target.alias);
  if (selected.length !== 1) throw unavailable();
  return { operation_id: execution.operation.id, agent: selected[0], trusted_accounts: execution.trusted_accounts ?? [],
    claim: { claim_token: claim.claim_token, consumer_epoch: claim.epoch } };
}

export async function proveMaintenanceResume(config: HostCommandConfig, execution: FleetExecution,
  claim: FleetOperationClaim, ready: MaintenanceGuardEvent, signal: AbortSignal): Promise<string> {
  if (ready.state !== 'ready' || ready.operation_id !== execution.operation.id || config.transport !== undefined
      || ![config.python, config.executable, config.policyFile].every(path => path.startsWith('/')
        && !path.split('/').includes('..') && !/[\p{Cc}]/u.test(path))) throw unavailable();
  const packet = JSON.stringify({ ...maintenancePacket(execution, claim),
    expected_runtime: { container_id: ready.container_id, generation: ready.generation } });
  if (Buffer.byteLength(packet) > 1_048_576) throw unavailable();
  const proof = z.object({ resumable: z.literal(true), fingerprint: Hash }).strict().parse(await boundedProviderReceipt(
    config.python, ['-B', config.executable, '--policy', config.policyFile, '--maintenance-resume-proof'],
    packet, signal, 20_000, 5_000));
  return proof.fingerprint;
}

export async function beginMaintenanceGuard(config: HostCommandConfig, execution: FleetExecution,
  claim: FleetOperationClaim, signal: AbortSignal): Promise<MaintenanceGuard> {
  if (config.transport !== undefined || signal.aborted
      || ![config.python, config.executable, config.policyFile].every(path => path.startsWith('/')
        && !path.split('/').includes('..') && !/[\p{Cc}]/u.test(path))) throw unavailable();
  const packet = JSON.stringify(maintenancePacket(execution, claim));
  if (Buffer.byteLength(packet) > 1_048_576) throw unavailable();
  const child = spawn(config.python, ['-B', config.executable, '--policy', config.policyFile, '--maintenance-guard'], {
    detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: process.env.HOME ?? '', TMPDIR: '/var/tmp', PYTHONDONTWRITEBYTECODE: '1' },
  });
  let output = '', stderrBytes = 0, total = 0, ended = false, rejected = false;
  let first: MaintenanceGuardEvent | undefined;
  let terminal: 'stopped' | 'aborted' | undefined;
  let finishStarted = false;
  let force: NodeJS.Timeout | undefined;
  let resolveFirst: (event: MaintenanceGuardEvent) => void = () => undefined;
  let rejectFirst: (error: Error) => void = () => undefined;
  let resolveExit: () => void = () => undefined;
  let rejectExit: (error: Error) => void = () => undefined;
  const firstEvent = new Promise<MaintenanceGuardEvent>((resolve, reject) => { resolveFirst = resolve; rejectFirst = reject; });
  const exited = new Promise<void>((resolve, reject) => { resolveExit = resolve; rejectExit = reject; });
  void exited.catch(() => undefined);
  const terminate = () => {
    rejected = true;
    if (ended || child.pid === undefined) return;
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* The bounded helper may already have exited. */ }
    force ??= setTimeout(() => { if (child.pid !== undefined) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* The process group has been reaped. */ }
    } }, 45_000);
  };
  const timeout = setTimeout(terminate, config.timeoutMs ?? 150_000);
  signal.addEventListener('abort', terminate, { once: true });
  child.stdin.on('error', terminate);
  child.stderr.on('data', (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > 8192) terminate(); });
  child.stdout.on('data', (chunk: Buffer) => {
    total += chunk.length;
    if (total > 8192) { terminate(); return; }
    output += chunk.toString('utf8');
    for (;;) {
      const newline = output.indexOf('\n');
      if (newline < 0) break;
      const line = output.slice(0, newline); output = output.slice(newline + 1);
      try {
        const event = Event.parse(JSON.parse(line));
        if (!first) {
          if (event.state === 'ready' && event.operation_id !== execution.operation.id) throw unavailable();
          first = event; resolveFirst(event);
        } else {
          if (terminal !== undefined || event.state !== 'stopped' && event.state !== 'aborted') throw unavailable();
          terminal = event.state;
        }
      } catch { terminate(); }
    }
  });
  child.once('error', () => { rejected = true; rejectFirst(unavailable()); });
  child.once('close', code => {
    ended = true; clearTimeout(timeout); if (force) clearTimeout(force);
    signal.removeEventListener('abort', terminate);
    if (!first || rejected || code !== 0 || output.trim()) { rejectFirst(unavailable()); rejectExit(unavailable()); }
    else resolveExit();
  });
  child.stdin.write(packet + '\n');
  let event: MaintenanceGuardEvent;
  try { event = await firstEvent; }
  catch (error) { terminate(); await exited.catch(() => undefined); throw error; }
  return { first: event, async finish(commit) {
    if (finishStarted) throw unavailable();
    finishStarted = true;
    if (event.state === 'ready') {
      child.stdin.end(JSON.stringify({ operation_id: execution.operation.id,
        action: commit ? 'commit' : 'abort', guard_id: event.guard_id }) + '\n');
    } else child.stdin.end();
    await exited;
    if (event.state === 'ready' && terminal !== (commit ? 'stopped' : 'aborted')) throw unavailable();
  } };
}
