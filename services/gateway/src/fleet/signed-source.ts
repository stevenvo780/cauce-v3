import { createHash, createPrivateKey, createPublicKey, randomBytes, sign, type KeyObject } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { FleetEvidenceSchema, FleetOperationRequestSchema, FleetOperationSchema, type FleetError, type FleetEvidence, type FleetStepName } from '@cauce/protocol';
import { HostId, stableHostJson, type FleetOperationClaim } from '@cauce/store';
import { FleetProviderAccountsSchema } from './accounts.js';
import type { FleetExecution, FleetExecutionRepository } from './executor.js';
import { QuotaHostTransportError } from './quota-executor.js';

const IdentitySchema = z.object({ enrollment_id: z.uuid(), company_id: HostId, host_id: HostId,
  gateway: z.string(), state: z.literal('enrolled'), key_fingerprint: z.string().regex(/^[a-f0-9]{64}$/u), executor_ready: z.boolean() }).strict();
const ClaimSchema = z.object({ operation: FleetOperationSchema, request: FleetOperationRequestSchema,
  worker_id: z.string().min(1).max(128), claim_token: z.uuid(), epoch: z.number().int().positive() }).strict();
const Target = z.object({ resource: z.literal('agent'), tenant_id: z.string(), alias: z.string() }).strict();
const Membership = z.object({ tenant_id: z.string(), alias: z.string(), room_id: z.string(), role: z.string(), enabled: z.boolean() }).strict();
const Records = z.array(z.record(z.string(), z.unknown()));
const ExecutionSchema = z.object({ operation: FleetOperationSchema, request: FleetOperationRequestSchema,
  fenced_targets: z.array(Target), previous_agents: Records.optional(), desired_memberships: z.array(Membership).optional(),
  global_desired_memberships: z.array(Membership).optional(), trusted_accounts: FleetProviderAccountsSchema.optional(),
  snapshot: z.record(z.string(), z.unknown()).optional(), snapshot_revision: z.number().int().nonnegative().optional(),
  fleet_scope: z.object({ operation_id: z.uuid(), host_id: HostId, scope_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    prepared_revision: z.number().int().nonnegative(), worker_id: z.string(), claim_token: z.uuid(), claim_epoch: z.number().int().positive() }).strict().optional(),
}).strict();

function unavailable(): Error { return new Error('Signed host channel could not be verified'); }
export async function privateBytes(filename: string): Promise<Buffer> {
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.uid !== process.geteuid?.() || info.nlink !== 1 || (info.mode & 0o077) !== 0 || info.size > 16_384) throw unavailable();
    return await file.readFile();
  } finally { await file.close(); }
}
export class SignedHostChannel {
  private constructor(readonly identity: z.infer<typeof IdentitySchema>, private readonly key: KeyObject, readonly gateway: string) {}
  static async load(directory: string): Promise<SignedHostChannel> {
    try {
      if (!isAbsolute(directory) || resolve(directory) !== directory) throw unavailable();
      const info = await lstat(directory);
      if (!info.isDirectory() || info.uid !== process.geteuid?.() || (info.mode & 0o077) !== 0 || await realpath(directory) !== directory) throw unavailable();
      const identity = IdentitySchema.parse(JSON.parse((await privateBytes(join(directory, 'identity.json'))).toString('utf8')));
      const key = createPrivateKey(await privateBytes(join(directory, 'private.pem')));
      if (key.asymmetricKeyType !== 'ed25519') throw unavailable();
      const fingerprint = createHash('sha256').update(createPublicKey(key).export({ type: 'spki', format: 'der' })).digest('hex');
      if (fingerprint !== identity.key_fingerprint) throw unavailable();
      const gateway = new URL(identity.gateway);
      if (gateway.username || gateway.password || gateway.search || gateway.hash || gateway.pathname !== '/'
        || gateway.protocol !== 'https:' && !(gateway.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(gateway.hostname))) throw unavailable();
      return new SignedHostChannel(identity, key, gateway.origin);
    } catch { throw unavailable(); }
  }
  async request(method: 'POST', path: string, payload: Record<string, unknown>): Promise<unknown> {
    if (!path.startsWith(`/v3/fleet/hosts/${this.identity.host_id}/`) || /[?#\\\p{Cc}]/u.test(path)) throw unavailable();
    const packet = { company_id: this.identity.company_id, host_id: this.identity.host_id,
      issued_at: Date.now(), nonce: randomBytes(32).toString('hex'), payload };
    const proof = sign(null, Buffer.from(stableHostJson({ version: 1, method, path, ...packet })), this.key).toString('base64');
    const body = stableHostJson({ ...packet, proof });
    if (Buffer.byteLength(body) > 262_144) throw unavailable();
    try {
      const response = await fetch(this.gateway + path, { method, body, redirect: 'error',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) })
        .catch(() => { throw new QuotaHostTransportError(); });
      if (!response.ok || !response.body) { await response.body?.cancel(); throw unavailable(); }
      const reader = response.body.getReader(); let total = 0; const chunks: Uint8Array[] = [];
      try {
        for (;;) {
          const part = await reader.read().catch(() => { throw new QuotaHostTransportError(); }); if (part.done) break;
          total += part.value.byteLength;
          if (total > 2_097_152) { await reader.cancel(); throw unavailable(); }
          chunks.push(part.value);
        }
      } finally { reader.releaseLock(); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch (error) {
      if (error instanceof QuotaHostTransportError) throw error;
      throw unavailable();
    }
  }
}
function fence(claim: FleetOperationClaim) { return { operation_id: claim.operation.id, claim_token: claim.claim_token, epoch: claim.epoch }; }
export class HostChannelFleetSource implements FleetExecutionRepository {
  constructor(private readonly channel: SignedHostChannel) {}
  private invoke(action: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    return this.channel.request('POST', `/v3/fleet/hosts/${this.channel.identity.host_id}/channel`, { resource: 'fleet_operation', action, ...payload });
  }
  async claim(_worker: string, host: string, leaseMs = 30_000) {
    if (host !== this.channel.identity.host_id) throw unavailable();
    return z.object({ claim: ClaimSchema.nullable() }).strict().parse(await this.invoke('claim', { lease_ms: leaseMs })).claim;
  }
  async renew(claim: FleetOperationClaim, leaseMs = 30_000) {
    return z.object({ renewed: z.boolean() }).strict().parse(await this.invoke('renew', { claim: fence(claim), lease_ms: leaseMs })).renewed;
  }
  async prepare(claim: FleetOperationClaim) {
    const prepared = ExecutionSchema.parse(await this.invoke('prepare', { claim: fence(claim) }));
    if (prepared.operation.id !== claim.operation.id) throw unavailable();
    return { operation: prepared.operation, fenced_targets: prepared.fenced_targets };
  }
  async execution(claim: FleetOperationClaim): Promise<FleetExecution> {
    const result = ExecutionSchema.parse(await this.invoke('execution', { claim: fence(claim) }));
    if (result.operation.id !== claim.operation.id) throw unavailable();
    return { operation: result.operation, request: result.request, fenced_targets: result.fenced_targets,
      previous_agents: result.previous_agents ?? [], desired_memberships: result.desired_memberships ?? [],
      ...(result.global_desired_memberships === undefined ? {} : { global_desired_memberships: result.global_desired_memberships }),
      ...(result.trusted_accounts === undefined ? {} : { trusted_accounts: result.trusted_accounts }),
      ...(result.snapshot === undefined ? {} : { snapshot: result.snapshot }),
      ...(result.fleet_scope === undefined ? {} : { fleet_scope: result.fleet_scope }),
    };
  }
  async startStep(claim: FleetOperationClaim, name: FleetStepName) {
    return FleetOperationSchema.parse(await this.invoke('start_step', { claim: fence(claim), step: name }));
  }
  async completeStep(claim: FleetOperationClaim, name: FleetStepName, evidence: FleetEvidence) {
    return FleetOperationSchema.parse(await this.invoke('complete_step', { claim: fence(claim), step: name, evidence: FleetEvidenceSchema.parse(evidence) }));
  }
  async awaitAuth(claim: FleetOperationClaim) { return FleetOperationSchema.parse(await this.invoke('await_auth', { claim: fence(claim) })); }
  async fail(claim: FleetOperationClaim, error: FleetError) { return FleetOperationSchema.parse(await this.invoke('fail', { claim: fence(claim), error })); }
  async compensate(claim: FleetOperationClaim, evidence: FleetEvidence = {}) {
    return FleetOperationSchema.parse(await this.invoke('compensate', { claim: fence(claim), evidence }));
  }
  async settle(claim: FleetOperationClaim) { return FleetOperationSchema.parse(await this.invoke('settle', { claim: fence(claim) })); }
}
