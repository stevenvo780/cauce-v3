import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { TLSSocket } from 'node:tls';
import { AliasSchema, TenantSchema } from '@cauce/protocol';
import { DecisionError } from './errors.js';
import { isPlainObject } from './questions.js';

/** Who is asking, taken from the verified client certificate and never from the request body. */
export interface Caller {
  readonly tenant: string;
  readonly alias: string;
}

export type IdentifyCaller = (socket: unknown) => Promise<Caller>;

export interface MtlsIdentityOptions {
  /** The gateway's `mtls_identities.json`: the same file, read-only, so revocation is shared. */
  readonly identitiesFile: string;
  /** Only these aliases may ask (`*` = any alias of an allowed tenant); empty = nobody. */
  readonly allowedAliases: ReadonlySet<string>;
  /** Only agents of these tenants may ask; empty = nobody. */
  readonly allowedTenants: ReadonlySet<string>;
  readonly now?: () => number;
}

const ACCEPTED_ROLES = new Set(['agent', 'adapter']);
const HEX64 = /^[a-f0-9]{64}$/iu;

function unauthenticated(message: string): DecisionError {
  return new DecisionError('no_autenticado', message);
}

interface IdentityRecord {
  readonly certificate: Buffer;
  readonly expiresAt: number;
  readonly principal: Record<string, unknown>;
}

async function readRecords(path: string): Promise<IdentityRecord[]> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw unauthenticated('el registro de identidades mTLS no está disponible');
  }
  if (!isPlainObject(decoded) || decoded.version !== 1 || !Array.isArray(decoded.identities)) {
    throw unauthenticated('el registro de identidades mTLS no es válido');
  }
  const records: IdentityRecord[] = [];
  for (const entry of decoded.identities) {
    if (!isPlainObject(entry) || typeof entry.certificate_sha256 !== 'string' || !HEX64.test(entry.certificate_sha256)) continue;
    if (!isPlainObject(entry.principal)) continue;
    const expiresAt = typeof entry.expires_at === 'string' ? Date.parse(entry.expires_at) : Number.NaN;
    records.push({ certificate: Buffer.from(entry.certificate_sha256, 'hex'), expiresAt, principal: entry.principal });
  }
  return records;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/**
 * Same mapping as the gateway: Node verified the chain against the Cauce CA, and the SHA-256 of
 * the leaf selects exactly one principal. The file is re-read per request so a removal revokes at once.
 * The database is not consulted: a tenant, agent or membership disabled there keeps its certificate,
 * which is why access also needs both explicit allowlists, and both fail closed.
 */
export function mtlsIdentity(options: MtlsIdentityOptions): IdentifyCaller {
  const now = options.now ?? Date.now;
  return async (socket) => {
    if (!(socket instanceof TLSSocket) || !socket.authorized) throw unauthenticated('hace falta un certificado de cliente verificado');
    const certificate = socket.getPeerX509Certificate();
    if (certificate === undefined) throw unauthenticated('falta el certificado de cliente');
    const presented = Buffer.from(certificate.fingerprint256.replaceAll(':', '').toLowerCase(), 'hex');
    let match: IdentityRecord | undefined;
    for (const record of await readRecords(options.identitiesFile)) {
      if (record.certificate.length !== presented.length || !timingSafeEqual(record.certificate, presented)) continue;
      if (match !== undefined) throw unauthenticated('el certificado está mapeado a más de una identidad');
      match = record;
    }
    if (match === undefined) throw unauthenticated('el certificado no está aprovisionado');
    if (!Number.isFinite(match.expiresAt) || match.expiresAt <= now()) throw unauthenticated('la identidad mTLS venció');
    const tenant = TenantSchema.safeParse(match.principal.tenant_id);
    const alias = AliasSchema.safeParse(match.principal.alias);
    if (!tenant.success || !alias.success) throw unauthenticated('la identidad mTLS no es válida');
    if (!stringList(match.principal.roles).some((role) => ACCEPTED_ROLES.has(role))) {
      throw new DecisionError('no_autorizado', 'sólo agentes y adaptadores consultan decisiones');
    }
    if (!stringList(match.principal.permissions).includes('route')) throw new DecisionError('no_autorizado', 'hace falta el permiso route');
    if (!options.allowedTenants.has(tenant.data)) {
      throw new DecisionError('no_autorizado', `el tenant ${tenant.data} no está habilitado para decisiones`);
    }
    if (!options.allowedAliases.has('*') && !options.allowedAliases.has(alias.data)) {
      throw new DecisionError('no_autorizado', `${alias.data} todavía no está habilitado para decisiones`);
    }
    return { tenant: tenant.data, alias: alias.data };
  };
}
