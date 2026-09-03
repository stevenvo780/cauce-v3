import {
  createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman,
  generateKeyPairSync, hkdfSync, randomBytes, type KeyObject,
} from 'node:crypto';
import { z } from 'zod';
import { decodeCanonicalBase64 } from './attachment-limits.js';
import { hasUnsafeTextCodePoint, isStrictUtcIso8601 } from './content-safety.js';
import { AliasSchema, CanonicalUuidV4Schema, TenantSchema } from './schemas/core.js';

/**
 * Sealed credential hand-off between agents.
 *
 *   k = HKDF-SHA256(ikm=X25519(ephemeral, recipient), salt=SEALING_HKDF_SALT, info=sealingAad, L=32)
 *   sealed = AES-256-GCM(k, nonce, plaintext, aad=sealingAad) || tag
 *
 * The binding is both HKDF `info` and GCM AAD, so a sealed blob is useless against another
 * recipient, another hand-off id or another published key: nothing else has to be checked
 * for a replay to fail closed.
 */

export const SEALING_ALGORITHM = 'x25519' as const;
export const SEALING_HKDF_SALT = 'cauce-v3/secret-handoff/v1';
export const SECRET_HANDOFF_MAX_TTL_MS = 24 * 60 * 60_000;
export const MAX_SECRET_PLAINTEXT_BYTES = 64 * 1024;
export const MAX_SECRET_LABEL_LENGTH = 120;
export const SEALING_PUBLIC_KEY_BYTES = 32;
export const SEALING_NONCE_BYTES = 12;
export const SEALING_TAG_BYTES = 16;

/** Ciphertext plus tag and framing slack. Exported because a consumer that recomputes this
    formula becomes a second cap that drifts and admits what `openSealedSecret` refuses. */
export const MAX_SEALED_BYTES = MAX_SECRET_PLAINTEXT_BYTES + 64;

const SEALING_DERIVED_KEY_BYTES = 32;
const MAX_HANDOFF_INSTANT_BYTES = 64;
/** SPKI header of an X25519 key: the raw 32 bytes on the wire are wrapped with it to build a KeyObject. */
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const OPAQUE_FAILURE = 'sealed secret could not be opened';
const OPAQUE_SEAL_FAILURE = 'secret could not be sealed';

export class SealingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SealingError';
  }
}

/** Routing facts of one hand-off. They are derived from the authenticated principal, never sent. */
export interface SecretHandoffBinding {
  readonly id: string;
  readonly fromTenant: string;
  readonly fromAlias: string;
  readonly toTenant: string;
  readonly toAlias: string;
}

export interface SealingBinding extends SecretHandoffBinding {
  readonly keyId: string;
}

export interface SealingKeyPair {
  readonly publicKey: Buffer;
  readonly privateKey: Buffer;
}

export interface SealedSecret {
  readonly sealed: Buffer;
  readonly ephemeralPublic: Buffer;
  readonly nonce: Buffer;
  readonly sealingKeyId: string;
}

export interface SealSecretInput {
  readonly recipientPublicKey: Buffer;
  readonly keyId: string;
  readonly binding: SecretHandoffBinding;
  readonly plaintext: Buffer;
}

export interface OpenSealedSecretInput {
  readonly privateKey: Buffer;
  readonly ephemeralPublic: Buffer;
  readonly nonce: Buffer;
  readonly sealed: Buffer;
  readonly keyId: string;
  readonly binding: SecretHandoffBinding;
}

/**
 * Canonical binding. The key order below IS the contract: rebuilding the literal here means a
 * caller cannot break interoperability by assembling the object in another order.
 */
export function sealingAad(binding: SealingBinding): string {
  return JSON.stringify({
    v: 1,
    id: binding.id,
    from_tenant: binding.fromTenant,
    from_alias: binding.fromAlias,
    to_tenant: binding.toTenant,
    to_alias: binding.toAlias,
    key_id: binding.keyId
  });
}

function rawPublicKey(key: KeyObject): Buffer {
  const spki = key.export({ type: 'spki', format: 'der' });
  return Buffer.from(spki.subarray(spki.byteLength - SEALING_PUBLIC_KEY_BYTES));
}

function publicKeyObject(raw: Buffer): KeyObject {
  if (raw.byteLength !== SEALING_PUBLIC_KEY_BYTES) {
    throw new SealingError('sealing public key must be 32 raw bytes');
  }
  return createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki'
  });
}

function deriveSealingKey(shared: Buffer, aad: Buffer): Buffer {
  return Buffer.from(hkdfSync(
    'sha256', shared, Buffer.from(SEALING_HKDF_SALT, 'utf8'), aad, SEALING_DERIVED_KEY_BYTES
  ));
}

export function generateSealingKeyPair(): SealingKeyPair {
  const pair = generateKeyPairSync('x25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' }
  });
  return {
    publicKey: Buffer.from(pair.publicKey.subarray(pair.publicKey.length - SEALING_PUBLIC_KEY_BYTES)),
    privateKey: pair.privateKey
  };
}

/** A degenerate recipient key -- all zero, low order -- fails inside the provider: it surfaces as
    the same opaque SealingError, never as an OpenSSL string a caller would forward as a 500. */
export function sealSecret(input: SealSecretInput): SealedSecret {
  if (input.plaintext.byteLength === 0 || input.plaintext.byteLength > MAX_SECRET_PLAINTEXT_BYTES) {
    throw new SealingError('secret plaintext is outside the protocol cap');
  }
  const recipient = publicKeyObject(input.recipientPublicKey);
  let shared: Buffer | undefined;
  let key: Buffer | undefined;
  try {
    const aad = Buffer.from(sealingAad({ ...input.binding, keyId: input.keyId }), 'utf8');
    const ephemeral = generateKeyPairSync('x25519');
    shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient });
    key = deriveSealingKey(shared, aad);
    const nonce = randomBytes(SEALING_NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(aad);
    const sealed = Buffer.concat([cipher.update(input.plaintext), cipher.final(), cipher.getAuthTag()]);
    return {
      sealed, nonce, ephemeralPublic: rawPublicKey(ephemeral.publicKey), sealingKeyId: input.keyId
    };
  } catch {
    throw new SealingError(OPAQUE_SEAL_FAILURE);
  } finally {
    key?.fill(0);
    shared?.fill(0);
  }
}

/**
 * Every failure — bad lengths, wrong key, tampered ciphertext, nonce, ephemeral key or binding —
 * raises the same error with the same message: the caller must not gain a decryption oracle, and
 * no fragment of plaintext or key material may reach a message, a log or a stack.
 */
export function openSealedSecret(input: OpenSealedSecretInput): Buffer {
  let shared: Buffer | undefined;
  let key: Buffer | undefined;
  try {
    if (input.nonce.byteLength !== SEALING_NONCE_BYTES ||
        input.sealed.byteLength <= SEALING_TAG_BYTES ||
        input.sealed.byteLength > MAX_SEALED_BYTES) {
      throw new SealingError(OPAQUE_FAILURE);
    }
    const aad = Buffer.from(sealingAad({ ...input.binding, keyId: input.keyId }), 'utf8');
    shared = diffieHellman({
      privateKey: createPrivateKey({ key: input.privateKey, format: 'der', type: 'pkcs8' }),
      publicKey: publicKeyObject(input.ephemeralPublic)
    });
    key = deriveSealingKey(shared, aad);
    const boundary = input.sealed.byteLength - SEALING_TAG_BYTES;
    const decipher = createDecipheriv('aes-256-gcm', key, input.nonce);
    decipher.setAAD(aad);
    decipher.setAuthTag(input.sealed.subarray(boundary));
    return Buffer.concat([decipher.update(input.sealed.subarray(0, boundary)), decipher.final()]);
  } catch {
    throw new SealingError(OPAQUE_FAILURE);
  } finally {
    key?.fill(0);
    shared?.fill(0);
  }
}

/**
 * Wire contracts of the hand-off. NO field of any schema below carries a plaintext value: the
 * secret only ever exists sealed, and neither the request, the reference nor the payload has a
 * field where a clear value could travel.
 */

const SEALING_KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const SealingKeyIdSchema = z.string().regex(SEALING_KEY_ID_PATTERN);

const base64OfExactly = (bytes: number) => (value: string): boolean =>
  decodeCanonicalBase64(value, bytes)?.byteLength === bytes;

const RawPublicKeySchema = z.string()
  .refine(base64OfExactly(SEALING_PUBLIC_KEY_BYTES), 'sealing public key must be 32 canonical base64 bytes');
const NonceSchema = z.string()
  .refine(base64OfExactly(SEALING_NONCE_BYTES), 'nonce must be 12 canonical base64 bytes');
const SealedSchema = z.string().refine((value) => {
  const decoded = decodeCanonicalBase64(value, MAX_SEALED_BYTES);
  return decoded !== undefined && decoded.byteLength > SEALING_TAG_BYTES;
}, 'sealed secret is not canonical base64 within the protocol cap');
const HandoffInstantSchema = z.string()
  .refine((value) => isStrictUtcIso8601(value, MAX_HANDOFF_INSTANT_BYTES), 'instant is not strict UTC ISO-8601');
const SecretLabelSchema = z.string().min(1).max(MAX_SECRET_LABEL_LENGTH)
  .refine((value) => !hasUnsafeTextCodePoint(value), 'secret label carries unsafe code points');

export const SealingKeyPublicationSchema = z.object({
  key_id: SealingKeyIdSchema,
  algorithm: z.literal(SEALING_ALGORITHM),
  public_key: RawPublicKeySchema,
  not_after: HandoffInstantSchema.optional()
}).strict();

export const SecretHandoffRequestSchema = z.object({
  to_tenant: TenantSchema,
  to_alias: AliasSchema,
  label: SecretLabelSchema,
  sealing_key_id: SealingKeyIdSchema,
  ephemeral_public: RawPublicKeySchema,
  nonce: NonceSchema,
  sealed: SealedSchema,
  expires_at: HandoffInstantSchema
}).strict();

/** What the recipient is told exists. It names the secret; it does not carry it. */
export const SecretHandoffRefSchema = z.object({
  id: CanonicalUuidV4Schema,
  from_tenant: TenantSchema,
  from_alias: AliasSchema,
  label: SecretLabelSchema,
  expires_at: HandoffInstantSchema
}).strict();

export const SecretHandoffPayloadSchema = z.object({
  id: CanonicalUuidV4Schema,
  from_tenant: TenantSchema,
  from_alias: AliasSchema,
  to_tenant: TenantSchema,
  to_alias: AliasSchema,
  label: SecretLabelSchema,
  sealing_key_id: SealingKeyIdSchema,
  ephemeral_public: RawPublicKeySchema,
  nonce: NonceSchema,
  sealed: SealedSchema,
  expires_at: HandoffInstantSchema,
  created_at: HandoffInstantSchema
}).strict();

export type SealingKeyPublication = z.infer<typeof SealingKeyPublicationSchema>;
export type SecretHandoffRequest = z.infer<typeof SecretHandoffRequestSchema>;
export type SecretHandoffRef = z.infer<typeof SecretHandoffRefSchema>;
export type SecretHandoffPayload = z.infer<typeof SecretHandoffPayloadSchema>;
