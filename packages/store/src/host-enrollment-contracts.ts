import { createHash, createPublicKey, verify } from 'node:crypto';
import { z } from 'zod';
import { COMPANY_ID_PATTERN } from './company-authority.js';
import { StoreError } from './repository/errors.js';

export const HostId = z.string().regex(COMPANY_ID_PATTERN);
const Hex = z.string().regex(/^[a-f0-9]{64}$/u);
const Base64 = z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/u).max(512);
export const HostInvitationSchema = z.object({ host_id: HostId, display_name: z.string().trim().min(1).max(120),
  notes: z.string().trim().max(2000).default('') }).strict();
export const HostClaimSchema = z.object({ invitation_token: Hex, public_key: Base64, proof: Base64 }).strict();
export const HostReportSchema = z.object({ cli_version: z.string().min(1).max(128), platform: z.string().min(1).max(128),
  docker_version: z.string().min(1).max(128).nullable(), status: z.literal('reachable') }).strict();
export const SignedHostRequestSchema = z.object({ company_id: HostId, host_id: HostId,
  issued_at: z.number().int().positive(), nonce: Hex, payload: z.record(z.string(),z.unknown()), proof: Base64 }).strict();
export const HostHeartbeatSchema = SignedHostRequestSchema.extend({payload:HostReportSchema});
export const HostSetupRequestSchema = SignedHostRequestSchema.extend({payload:z.object({action:z.literal('package')}).strict()});
export type SignedHostRequest = z.infer<typeof SignedHostRequestSchema>;
/** What a verified computer may receive at setup: its own company and host, and the harnesses the platform keeps enabled. */
export interface HostSetupScope { host_id: string; company_id: string; harnesses: string[] }
export interface HostInvitation { enrollment_id: string; company_id: string; host_id: string; nonce: string;
  invitation_token: string; expires_at: string; state: 'pending' }
export interface HostEnrollmentReceipt { enrollment_id: string; company_id: string; host_id: string;
  state: 'enrolled'; key_fingerprint: string; executor_ready: boolean }
export function stableHostJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableHostJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stableHostJson(object[key])}`).join(',')}}`;
}
export function hostEnrollmentMessage(invitation: Pick<HostInvitation, 'enrollment_id' | 'company_id' | 'host_id' | 'nonce'>): string {
  return stableHostJson({ version: 1, enrollment_id: invitation.enrollment_id, company_id: invitation.company_id,
    host_id: invitation.host_id, nonce: invitation.nonce });
}
export function hostRequestMessage(method: string, path: string, packet: SignedHostRequest): string {
  const { proof: _proof, ...signed } = packet; return stableHostJson({ version: 1, method, path, ...signed });
}
export function hostKeyFingerprint(encoded: string): string {
  try {
    const der = Buffer.from(encoded, 'base64');
    const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
    if (der.toString('base64') !== encoded || key.asymmetricKeyType !== 'ed25519'
      || !key.export({format:'der',type:'spki'}).equals(der)) throw new Error('invalid key');
    return createHash('sha256').update(der).digest('hex');
  } catch { throw new StoreError('invalid_input', 'an Ed25519 host identity is required'); }
}
export function verifyHostProof(publicKey: string, proof: string, message: string): boolean {
  try {
    const signature = Buffer.from(proof, 'base64');
    if (signature.length !== 64 || signature.toString('base64') !== proof) return false;
    return verify(null, Buffer.from(message), createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' }), signature);
  } catch { return false; }
}
