import { request } from 'node:http';
import { lstat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { HostId, SignedHostRequestSchema } from '@cauce/store';
import { assertAuthBridgeParent } from '../auth-bridge-socket.js';
import { AuthorityInventorySchema, AuthorityIssuedSchema, RuntimeAuthorityRequestSchema, RuntimeAuthoritySchema,
  TerminalGrantSchema, TerminalReceiptSchema, TerminalRevokedSchema } from './schemas.js';

export interface SignedFleetAuthoritySocketPolicy { ownerUid: number; peerUid: number; groupGid?: number }
const ErrorCode = z.enum(['INVALID_REQUEST', 'AUTHORITY_REVOKED', 'AUTHORITY_UNAVAILABLE', 'forbidden', 'conflict', 'invalid_input']);
const ErrorBody = z.object({ error: ErrorCode }).strict();
export const SignedAuthorityEnvelopeSchema = z.object({ host_id: HostId, packet: SignedHostRequestSchema }).strict()
  .refine(value => value.host_id === value.packet.host_id);
export class SignedFleetAuthorityError extends Error {
  constructor(readonly code: z.infer<typeof ErrorCode>, readonly statusCode: number) {
    super('Signed fleet authority could not be verified');
  }
}
const unavailable = () => new SignedFleetAuthorityError('AUTHORITY_UNAVAILABLE', 503);
export async function assertSignedAuthoritySocket(filename: string, policy: SignedFleetAuthoritySocketPolicy): Promise<void> {
  if (![policy.ownerUid, policy.peerUid, policy.groupGid ?? 0].every(value => Number.isSafeInteger(value) && value >= 0)
      || policy.ownerUid !== policy.peerUid && policy.groupGid === undefined) throw unavailable();
  await assertAuthBridgeParent(filename, policy);
  const parent = await lstat(dirname(filename)); const shared = policy.ownerUid !== policy.peerUid;
  if ((parent.mode & 0o7777) !== (shared ? 0o750 : 0o700)
      || shared && parent.gid !== policy.groupGid) throw unavailable();
  const info = await lstat(filename);
  if (!info.isSocket() || info.uid !== policy.ownerUid || (info.mode & 0o7777) !== (shared ? 0o660 : 0o600)
      || shared && info.gid !== policy.groupGid) throw unavailable();
}
export class SignedFleetAuthorityClient {
  private readonly runtimeAuthorities = new Map<string, NonNullable<z.infer<typeof RuntimeAuthoritySchema>['identity']>>();
  constructor(private readonly filename: string, private readonly policy: SignedFleetAuthoritySocketPolicy) {}
  async resolveRuntimeAuthority(fingerprint: string): Promise<z.infer<typeof RuntimeAuthoritySchema>['identity']> {
    const body = RuntimeAuthorityRequestSchema.parse({ action: 'resolve_runtime_authority', certificate_sha256: fingerprint });
    const cached = this.runtimeAuthorities.get(fingerprint);
    if (cached && Date.parse(cached.expires_at) > Date.now()) return cached;
    this.runtimeAuthorities.delete(fingerprint);
    const result = RuntimeAuthoritySchema.parse(await this.post('/runtime-authority', body,
      output => RuntimeAuthoritySchema.parse(output), AbortSignal.timeout(1_000)));
    if (result.identity !== null && Date.parse(result.identity.expires_at) > Date.now()) {
      if (this.runtimeAuthorities.size >= 2_000) this.runtimeAuthorities.clear();
      this.runtimeAuthorities.set(fingerprint, result.identity);
    }
    return result.identity;
  }
  async invoke(host: string, packet: unknown, signal?: AbortSignal): Promise<unknown> {
    const envelope = SignedAuthorityEnvelopeSchema.parse({ host_id: host, packet });
    return this.post('/signed-authority', envelope, output => {
      const action = envelope.packet.payload.action;
      return action === 'ready' ? z.object({ ready: z.literal(true), host_id: HostId }).strict()
        .refine(value => value.host_id === host).parse(output)
        : action === 'issue' ? AuthorityIssuedSchema.parse(output)
        : action === 'issue_terminal' ? TerminalGrantSchema.parse(output)
        : action === 'terminal_receipt' ? TerminalReceiptSchema.parse(output)
        : action === 'revoke_terminal' ? TerminalRevokedSchema.parse(output) : AuthorityInventorySchema.parse(output);
    }, signal);
  }
  private async post(path: string, input: unknown, parse: (output: unknown) => unknown, signal?: AbortSignal): Promise<unknown> {
    if (process.geteuid?.() !== this.policy.peerUid || signal?.aborted) throw unavailable();
    await assertSignedAuthoritySocket(this.filename, this.policy);
    const before = await lstat(this.filename); const body = JSON.stringify(input);
    if (Buffer.byteLength(body) > 262_144) throw new SignedFleetAuthorityError('INVALID_REQUEST', 400);
    return new Promise((resolve, reject) => {
      const outgoing = request({ socketPath: this.filename, path, method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }, signal }, response => {
        let bytes = 0; const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 65_536) response.destroy(unavailable()); else chunks.push(chunk);
        });
        response.once('error', () => { reject(unavailable()); });
        response.once('end', () => {
          void (async () => {
            try {
              await assertSignedAuthoritySocket(this.filename, this.policy);
              const after = await lstat(this.filename);
              if (before.dev !== after.dev || before.ino !== after.ino) throw unavailable();
              const output: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              if (response.statusCode !== 200) throw new SignedFleetAuthorityError(ErrorBody.parse(output).error,
                [400,403,409,422,503].includes(response.statusCode ?? 0) ? response.statusCode ?? 503 : 503);
              resolve(parse(output));
            } catch (error) { reject(error instanceof SignedFleetAuthorityError ? error : unavailable()); }
          })();
        });
      });
      outgoing.setTimeout(90_000, () => { outgoing.destroy(unavailable()); });
      outgoing.once('error', () => { reject(unavailable()); }); outgoing.end(body);
    });
  }
}
