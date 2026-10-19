import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute, normalize } from 'node:path';
import { z } from 'zod';
import { FleetOperationRequestSchema, isSignalAborted, readMutableBoolean } from '@cauce/protocol';
import { ProviderAuthError, ProviderAuthReasonSchema } from '../console/provider-auth.contracts.js';
import type { ProviderAuthLogin, ProviderAuthReason } from '../console/provider-auth.types.js';
import type { FleetExecution } from './executor.js';
import type { HostCommandConfig } from './host-command.js';

export const LoginPathSchema = z.string().max(4096).refine(value => isAbsolute(value) && normalize(value) === value && !/[\p{Cc}]/u.test(value));
const Hash = z.string().regex(/^[0-9a-f]{64}$/u);
const Literal = z.string().max(4096).refine(value => !/[\p{Cc}]/u.test(value));
export const LoginCommandSchema = z.array(Literal).min(1).max(32).refine(value => LoginPathSchema.safeParse(value[0]).success);
export const LoginPinsSchema = z.record(LoginPathSchema, Hash).refine(value => Object.keys(value).length <= 32);
export const HelperLoginPinsSchema = z.record(LoginPathSchema, Hash).refine(value => Object.keys(value).length <= 64);
export const ContainerLoginBindingSchema = z.object({ container_id: Hash, generation: Hash, image_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  python: LoginPathSchema, helper: z.literal('/cauce/executor/provider-login.py') }).strict();
const PacketSchema = z.object({ operation_id: z.uuid(), command: LoginCommandSchema,
  runtime_user: z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/u), home: LoginPathSchema, cwd: LoginPathSchema,
  env: z.record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/u), Literal).refine(value => Object.keys(value).length <= 32),
  backend: z.enum(['native', 'container']), state_root: LoginPathSchema, account_scope: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u),
  command_sha256: Hash.optional(), command_files: LoginPinsSchema.optional(), container_binding: ContainerLoginBindingSchema.optional(),
  ttl_seconds: z.number().int().min(1).max(900).optional(),
}).strict().refine(value => (value.backend === 'container') === (value.container_binding !== undefined));
export type ProviderLoginPacket = z.infer<typeof PacketSchema>;
export interface ProviderLoginTransport {
  python: string; helper: { executable: string; sha256: string; files?: Record<string, string> | undefined }; stateRoot: string;
  startTimeoutMs?: number; stopTimeoutMs?: number;
}
export interface ProviderLoginConfig extends ProviderLoginTransport {
  packet: ProviderLoginPacket; method: 'device' | 'terminal';
}
const StartedSchema = z.object({ type: z.literal('started'), operation_id: z.uuid(), pid: z.number().int().positive(),
  start_ticks: z.union([z.string().regex(/^[0-9]+$/u), z.number().int().positive()]), runtime_uid: z.number().int().positive(),
  backend: z.enum(['native', 'container']), container_id: Hash.optional() }).strict();
const ExitSchema = z.object({ type: z.literal('exited'), operation_id: z.uuid(), exit_code: z.number().int(), stopped_verified: z.boolean() }).strict();
const CleanupSchema = z.object({ stopped_verified: z.literal(true) }).strict();
const OutputSchema = z.object({ type: z.literal('output'), data: z.string().max(87_384).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u) }).strict();
const EventSchema = z.union([StartedSchema, ExitSchema, OutputSchema]);
const unavailable = () => new ProviderAuthError('HOST_UNAVAILABLE');
export const QUOTA_STEP_REASONS = ['runtime_release_stale', 'runtime_image_stale', 'reader_unreadable', 'environment_not_running', 'isolation_rejected', 'cli_update_failed', 'cli_update_timed_out'] as const;
export type QuotaStepReason = typeof QUOTA_STEP_REASONS[number];
const QUOTA_STEP_REASON = new Map<string, QuotaStepReason>([
  ['runtime_release_stale', 'runtime_release_stale'],
  ['runtime_image_stale', 'runtime_image_stale'],
  ['reader_unreadable', 'reader_unreadable'],
  ['environment_not_running', 'environment_not_running'],
  ['isolation_rejected', 'isolation_rejected'],
  ['quota container isolation or ownership differs', 'isolation_rejected'],
  ['quota profile volume ownership differs', 'isolation_rejected'],
  ['quota CLI image is unavailable', 'runtime_image_stale'],
  ['quota reader did not return a JSON observation', 'reader_unreadable'],
  ['quota reader did not return an observation', 'reader_unreadable'],
  ['quota reader exceeds its output limit', 'reader_unreadable'],
  ['quota environment is not running', 'environment_not_running'],
  ['quota CLI executable cannot be inspected', 'reader_unreadable'],
  ['quota CLI version receipt is invalid', 'reader_unreadable'],
  ['cli_update_failed', 'cli_update_failed'],
  ['cli_update_timed_out', 'cli_update_timed_out'],
]);
export function readQuotaStepReason(error: unknown): QuotaStepReason | undefined {
  if (!error || typeof error !== 'object' || !('quotaStepReason' in error)) return undefined;
  const reason = error.quotaStepReason;
  return QUOTA_STEP_REASONS.find(item => item === reason);
}
function quotaStepReason(stderr: string): QuotaStepReason | undefined {
  const line = stderr.split('\n').find(item => item.startsWith('fleet effect failed: '));
  if (!line) return undefined;
  const text = line.slice('fleet effect failed: '.length).trim();
  return QUOTA_STEP_REASON.get(text) ?? QUOTA_STEP_REASONS.find(item => text.startsWith(`${item}: `));
}
const PROVIDER_AUTH_FAILURE_REASONS = ['AUTHORITY_REVOKED', 'SESSION_CONFLICT', 'INVALID_REQUEST', 'HOST_UNAVAILABLE',
  'RUNTIME_DRIFT', 'STOP_UNCONFIRMED', 'IDENTITY_MISMATCH', 'FUNCTIONAL_CHECK_FAILED', 'LOGIN_FAILED', 'SESSION_EXPIRED'] as const;
const PROVIDER_RUNTIME_FAILURES = new Map<string, ProviderAuthReason>([
  ['fleet effect failed: container image or ownership labels differ', 'CONTAINER_IMAGE_OR_OWNERSHIP_DRIFT'],
  ['fleet effect failed: container resource limits differ from the approved shape', 'CONTAINER_RESOURCE_LIMITS_DRIFT'],
  ...['container isolation differs from the approved shape', 'container GPU or device access differs from the approved shape',
    'container networks differ from the approved shape', 'container sidecar environment differs from the approved shape',
    'container declared extensions differ', 'container runtime mounts differ', 'container execution user or home differs',
    'container process identity differs', 'container runtime executable hash differs']
    .map(message => [`fleet effect failed: ${message}`, 'CONTAINER_ISOLATION_DRIFT'] as const),
]);
export function providerRuntimeFailureReason(stderr: string): ProviderAuthReason | undefined {
  const lines = stderr.slice(0, 4096).split('\n'); if (stderr.length > 4096) lines.pop();
  for (const line of lines) { const reason = PROVIDER_RUNTIME_FAILURES.get(line); if (reason) return reason; }
  return undefined;
}
export function providerAuthFailureReason(error: unknown): string {
  if (error instanceof ProviderAuthError) {
    const runtimeReason = ProviderAuthReasonSchema.safeParse(error.reason);
    if (runtimeReason.success) return runtimeReason.data;
  }
  const reason = readQuotaStepReason(error);
  if (reason) return reason;
  return error instanceof ProviderAuthError ? PROVIDER_AUTH_FAILURE_REASONS.find(code => code === error.code) ?? 'helper_failed' : 'helper_failed';
}
const maximumPinBytes = 536_870_912;

export async function readPrivateJson(filename: string): Promise<unknown> {
  try {
    const file = await open(LoginPathSchema.parse(filename), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.uid !== process.geteuid?.() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.size > 1_048_576) throw unavailable();
      const body = await file.readFile(); if (body.length > 1_048_576) throw unavailable(); return JSON.parse(body.toString('utf8')) as unknown;
    } finally { await file.close(); }
  } catch { throw unavailable(); }
}
export async function assertLoginPins(pins: Record<string, string>): Promise<void> {
  try {
    HelperLoginPinsSchema.parse(pins);
    for (const [filename, expected] of Object.entries(pins)) {
      const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || ![0, process.geteuid?.()].includes(stat.uid) || stat.nlink !== 1 || (stat.mode & 0o022) !== 0 || stat.size > maximumPinBytes) throw unavailable();
        const hash = createHash('sha256'); const bytes = Buffer.alloc(65_536); let length = 0;
        for (;;) { const read = await file.read(bytes, 0, bytes.length, null); if (read.bytesRead === 0) break;
          length += read.bytesRead; if (length > maximumPinBytes) throw unavailable(); hash.update(bytes.subarray(0, read.bytesRead)); }
        if (hash.digest('hex') !== expected) throw unavailable();
      } finally { await file.close(); }
    }
  } catch { throw unavailable(); }
}
async function validateTransport(config: ProviderLoginTransport): Promise<void> {
  LoginPathSchema.parse(config.python); LoginPathSchema.parse(config.stateRoot);
  await assertLoginPins({ ...config.helper.files, [config.helper.executable]: config.helper.sha256 });
}
async function validatePacketPins(packet: ProviderLoginPacket): Promise<void> {
  if (packet.backend === 'native') {
    await assertLoginPins({ ...packet.command_files,
      ...(packet.command_sha256 === undefined ? {} : { [packet.command[0] ?? '']: packet.command_sha256 }) });
  }
}
function spawnPrivate(python: string, argv: string[]): ChildProcessWithoutNullStreams {
  const child = spawn(python, argv, { detached: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME ?? '', TMPDIR: '/var/tmp', PYTHONDONTWRITEBYTECODE: '1' } });
  child.stderr.resume(); return child;
}
function kill(child: ChildProcessWithoutNullStreams): void {
  if (child.pid === undefined) return;
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* The helper process group may already be gone. */ }
}
export async function boundedProviderReceipt(python: string, argv: string[], body: string, signal: AbortSignal, timeoutMs = 60_000): Promise<unknown> {
  if (signal.aborted || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw unavailable();
  return new Promise((resolve, reject) => {
    const child = spawnPrivate(python, argv); const chunks: Buffer[] = []; let length = 0; let invalid = false;
    let stderrText = ''; let rejected = false;
    const stop = () => { invalid = true; kill(child); };
    const timer = setTimeout(stop, timeoutMs); signal.addEventListener('abort', stop, { once: true });
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', stop); };
    const rejectStep = () => {
      if (rejected) return; rejected = true;
      const runtimeReason = providerRuntimeFailureReason(stderrText);
      const error = new ProviderAuthError(runtimeReason === 'CONTAINER_IMAGE_OR_OWNERSHIP_DRIFT' ? 'RUNTIME_DRIFT' : 'HOST_UNAVAILABLE', runtimeReason);
      const reason = quotaStepReason(stderrText);
      if (reason) Object.assign(error, { quotaStepReason: reason });
      process.stderr.write(`provider auth helper failed: ${runtimeReason ?? reason ?? 'helper_failed'}\n`);
      reject(error);
    };
    child.stdout.on('data', (bytes: Buffer) => { length += bytes.length; if (length > 32_768) stop(); else chunks.push(bytes); });
    child.stderr.on('data', (bytes: Buffer) => { stderrText += bytes.toString('utf8').slice(0, 4097 - stderrText.length); });
    child.once('error', () => { finish(); rejectStep(); }); child.stdin.once('error', stop);
    child.once('close', code => { finish(); if (invalid || code !== 0) { rejectStep(); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown); } catch { rejectStep(); } });
    if (signal.aborted) stop(); child.stdin.end(body);
  });
}
export async function cleanupProviderLogin(config: ProviderLoginTransport, operationId: string, signal: AbortSignal): Promise<{ stopped: boolean }> {
  try {
    await validateTransport(config); z.uuid().parse(operationId);
    CleanupSchema.parse(await boundedProviderReceipt(config.python, ['-B', config.helper.executable, '--cleanup', operationId, config.stateRoot], '', signal, config.stopTimeoutMs ?? 5000));
    return { stopped: true };
  } catch { return { stopped: false }; }
}
export function queryProviderLoginBinding(config: HostCommandConfig, execution: FleetExecution, signal: AbortSignal, prepareLogin = false): Promise<unknown> {
  const body = JSON.stringify({ operation_id: execution.operation.id, request: FleetOperationRequestSchema.parse(execution.request),
    fenced_targets: execution.fenced_targets, previous_agents: execution.previous_agents ?? [], desired_memberships: execution.desired_memberships ?? [],
    ...(execution.trusted_accounts === undefined ? {} : { trusted_accounts: execution.trusted_accounts }),
    ...(execution.snapshot === undefined ? {} : { snapshot: execution.snapshot }) });
  return boundedProviderReceipt(config.python, ['-B', config.executable, '--policy', config.policyFile, '--binding',
    ...(prepareLogin ? ['--prepare-login'] : [])], body, signal, config.timeoutMs);
}

class HostProviderLogin implements ProviderAuthLogin {
  readonly method: 'device' | 'terminal';
  private readonly listeners = new Set<(bytes: Uint8Array) => void>();
  private child: ChildProcessWithoutNullStreams | undefined;
  private closing: Promise<{ stopped: boolean }> | undefined;
  private closed = false;
  private started = false;
  private verifiedStop = false;
  private completed: Promise<void> = Promise.resolve();
  constructor(private readonly config: ProviderLoginConfig, private readonly signal: AbortSignal) { this.method = config.method; }
  subscribeOutput(listener: (bytes: Uint8Array) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  async start(): Promise<void> {
    if (this.closed || this.signal.aborted || this.child) throw unavailable();
    await validateTransport(this.config);
    await validatePacketPins(this.config.packet);
    if (readMutableBoolean(this.closed) || isSignalAborted(this.signal)) throw unavailable();
    const child = spawnPrivate(this.config.python, ['-B', this.config.helper.executable]); this.child = child;
    let buffer = ''; let rejectStart!: (error: Error) => void; let resolveStart!: () => void;
    const starting = new Promise<void>((resolve, reject) => { resolveStart = resolve; rejectStart = reject; });
    const invalid = () => { this.verifiedStop = false; rejectStart(unavailable()); kill(child); };
    const abort = () => { void this.close(); };
    const timer = setTimeout(invalid, this.config.startTimeoutMs ?? 60_000);
    this.completed = new Promise<void>(resolve => {
      child.once('close', () => { clearTimeout(timer); this.signal.removeEventListener('abort', abort);
        if (!this.started) rejectStart(unavailable()); resolve(); });
    });
    child.once('error', invalid); child.stdin.on('error', invalid);
    child.stdout.on('data', (bytes: Buffer) => {
      buffer += bytes.toString('utf8'); if (buffer.length > 131_072) { invalid(); return; }
      for (;;) { const index = buffer.indexOf('\n'); if (index < 0) break;
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        try {
          const event = EventSchema.parse(JSON.parse(line));
          if (event.type === 'output') {
            if (!this.started || this.closed) continue;
            const decoded = Buffer.from(event.data, 'base64'); if (decoded.length > 65_536) throw unavailable();
            for (const listener of this.listeners) listener(decoded);
          } else if (event.type === 'started') {
            if (this.started || event.operation_id !== this.config.packet.operation_id || event.backend !== this.config.packet.backend
                || (event.backend === 'container' && event.container_id !== this.config.packet.container_binding?.container_id)) throw unavailable();
            this.started = true; clearTimeout(timer); resolveStart();
          } else {
            if (event.operation_id !== this.config.packet.operation_id) throw unavailable();
            this.verifiedStop = event.stopped_verified;
          }
        } catch { invalid(); return; }
      }
    });
    this.signal.addEventListener('abort', abort, { once: true });
    child.stdin.write(JSON.stringify(this.config.packet) + '\n');
    if (isSignalAborted(this.signal)) abort();
    await starting;
  }
  private send(value: unknown): Promise<void> {
    const child = this.child;
    if (!child || child.stdin.destroyed || child.stdin.writableEnded) return Promise.reject(unavailable());
    return new Promise((resolve, reject) => { child.stdin.write(JSON.stringify(value) + '\n', error => { if (error) reject(unavailable()); else resolve(); }); });
  }
  async write(bytes: Uint8Array): Promise<void> {
    if (bytes.byteLength > 4096) throw new ProviderAuthError('INVALID_REQUEST');
    if (this.closed || !this.started) throw unavailable(); await this.send({ type: 'input', data: Buffer.from(bytes).toString('base64') });
  }
  async resize(cols: number, rows: number): Promise<void> {
    if (!Number.isSafeInteger(cols) || !Number.isSafeInteger(rows) || cols < 20 || cols > 400 || rows < 5 || rows > 200) throw new ProviderAuthError('INVALID_REQUEST');
    if (this.closed || !this.started) throw unavailable(); await this.send({ type: 'resize', cols, rows });
  }
  close(): Promise<{ stopped: boolean }> { this.closing ??= this.closeNow(); return this.closing; }
  private async closeNow(): Promise<{ stopped: boolean }> {
    this.closed = true; this.listeners.clear();
    const child = this.child; if (!child) return { stopped: true };
    try { await this.send({ type: 'close' }); } catch { /* A closed helper still requires a cleanup proof. */ }
    const timer = setTimeout(() => { kill(child); }, this.config.stopTimeoutMs ?? 5000);
    try { await this.completed; } finally { clearTimeout(timer); }
    if (this.verifiedStop) return { stopped: true };
    return cleanupProviderLogin(this.config, this.config.packet.operation_id, new AbortController().signal);
  }
}
export async function createProviderLogin(config: ProviderLoginConfig, signal: AbortSignal): Promise<ProviderAuthLogin> {
  try {
    if (signal.aborted || config.stateRoot !== config.packet.state_root) throw unavailable();
    PacketSchema.parse(config.packet); await validateTransport(config);
    await validatePacketPins(config.packet);
    return new HostProviderLogin(config, signal);
  } catch (error) { throw error instanceof ProviderAuthError ? error : unavailable(); }
}
