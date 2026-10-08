import { createHash, X509Certificate } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { z } from 'zod';
import { logEvent } from '@cauce/protocol';
import { AuthError, validatePrincipal, type AuthProvider, type MtlsIdentityAuthority, type MtlsIdentityProvider, type Principal } from '../auth.js';

export class FleetCredentialRejectedError extends AuthError {
  constructor() { super('Fleet credential is no longer provisioned'); }
}

const IdentityDocument = z.object({ version: z.literal(1), identities: z.array(z.object({
  certificate_sha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  token_sha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  expires_at: z.unknown().optional(), principal: z.unknown(),
}).loose()).max(20_000) }).strict();
const reportedInvalidExpiries = new Set<string>();
async function readIdentities(filename: string, ownerUid: number) {
  try {
    const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.uid !== ownerUid || stat.nlink !== 1 || (stat.mode & 0o022) !== 0 || stat.size > 8_388_608) throw new Error();
      const body = await file.readFile('utf8');
      if (Buffer.byteLength(body) > 8_388_608) throw new Error();
      const identities = IdentityDocument.parse(JSON.parse(body)).identities;
      const invalid = identities.filter(identity => typeof identity.expires_at !== 'string' || !Number.isFinite(Date.parse(identity.expires_at))).length;
      const warningKey = `${filename}\u0000${String(invalid)}`;
      if (invalid > 0 && !reportedInvalidExpiries.has(warningKey)) {
        if (reportedInvalidExpiries.size < 64) reportedInvalidExpiries.add(warningKey);
        logEvent('identity_records_without_valid_expiry', { path: filename, invalid }, { level: 'warn' });
      }
      return identities;
    } finally { await file.close(); }
  } catch { throw new AuthError('fleet mTLS identity registry is unavailable'); }
}
export class FleetMtlsIdentityProvider implements MtlsIdentityProvider {
  constructor(private readonly basePath: string, private readonly fleetPath: string,
    private readonly namespace: 'normal' | 'bootstrap', private readonly ownerUid = 0) {
    if (basePath === fleetPath || ![basePath, fleetPath].every(path => path.startsWith('/') && !path.split('/').includes('..'))) {
      throw new Error('Fleet mTLS identity registries must be distinct absolute paths');
    }
  }
  async resolve(certificate: X509Certificate): Promise<Principal> { return (await this.resolveAuthority(certificate)).principal; }
  async resolveAuthority(certificate: X509Certificate): Promise<MtlsIdentityAuthority> {
    return this.resolveFingerprintAuthority(certificate.fingerprint256.replaceAll(':', '').toLowerCase());
  }
  async resolveFingerprintAuthority(fingerprint: string): Promise<MtlsIdentityAuthority> {
    if (!/^[a-f0-9]{64}$/u.test(fingerprint)) throw new AuthError('fleet certificate fingerprint is invalid');
    const [base, fleet] = await Promise.all([readIdentities(this.basePath, this.ownerUid), readIdentities(this.fleetPath, this.ownerUid)]);
    const matches = [...base, ...fleet].filter(identity => identity.certificate_sha256 === fingerprint);
    if (matches.length === 0) throw new FleetCredentialRejectedError();
    if (matches.length !== 1) throw new AuthError('fleet certificate mapping is ambiguous');
    const record = matches[0];
    if (record === undefined) throw new FleetCredentialRejectedError();
    const expiresAtMs = typeof record.expires_at === 'string' ? Date.parse(record.expires_at) : NaN;
    if (!Number.isSafeInteger(expiresAtMs)) throw new AuthError('fleet certificate expiry is invalid');
    if (expiresAtMs <= Date.now()) throw new FleetCredentialRejectedError();
    const principal = validatePrincipal(record.principal as Principal);
    if ((principal.channel === 'bootstrap') !== (this.namespace === 'bootstrap')
        || (this.namespace === 'bootstrap' && (principal.roles.length !== 0 || principal.permissions.length !== 0))) {
      throw new AuthError('fleet certificate has a different credential namespace');
    }
    return { principal, expiresAtMs };
  }
}

export class FleetTokenProbeAuthProvider implements AuthProvider {
  readonly name = 'fleet-token-probe';
  readonly mode = 'production' as const;
  constructor(private readonly path: string, private readonly ownerUid = 0, private readonly basePath?: string) {
    if (basePath !== undefined && (basePath === path || ![basePath, path].every(value => value.startsWith('/') && !value.split('/').includes('..')))) {
      throw new Error('Fleet token identity registries must be distinct absolute paths');
    }
  }
  async authenticateHttp(request: FastifyRequest): Promise<Principal> {
    const header = request.headers.authorization;
    if (typeof header !== 'string' || !/^Bearer [a-f0-9]{64}$/u.test(header)) throw new AuthError('invalid credential probe transport');
    const hash = createHash('sha256').update(header.slice(7)).digest('hex');
    const authorities = await Promise.all([readIdentities(this.path, this.ownerUid),
      ...(this.basePath === undefined ? [] : [readIdentities(this.basePath, this.ownerUid)])]);
    const matches = authorities.flat().filter(identity => identity.token_sha256 === hash);
    if (matches.length === 0) throw new FleetCredentialRejectedError();
    if (matches.length !== 1) throw new AuthError('fleet bearer mapping is ambiguous');
    const record = matches[0];
    if (record === undefined) throw new FleetCredentialRejectedError();
    const expiry = typeof record.expires_at === 'string' ? Date.parse(record.expires_at) : NaN;
    if (!Number.isSafeInteger(expiry)) throw new AuthError('fleet bearer expiry is invalid');
    if (expiry <= Date.now()) throw new FleetCredentialRejectedError();
    return validatePrincipal(record.principal as Principal);
  }
  async authenticateHello(request: FastifyRequest): Promise<Principal> { return this.authenticateHttp(request); }
}
