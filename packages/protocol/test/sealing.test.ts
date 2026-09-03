import { describe, expect, it } from 'vitest';
import {
  MAX_SEALED_BYTES,
  MAX_SECRET_LABEL_LENGTH,
  MAX_SECRET_PLAINTEXT_BYTES,
  SEALING_ALGORITHM,
  SEALING_NONCE_BYTES,
  SEALING_PUBLIC_KEY_BYTES,
  SealingError,
  SealingKeyPublicationSchema,
  SecretHandoffPayloadSchema,
  SecretHandoffRefSchema,
  SecretHandoffRequestSchema,
  generateSealingKeyPair,
  openSealedSecret,
  sealSecret,
  sealingAad,
  type OpenSealedSecretInput,
  type SealedSecret,
  type SecretHandoffBinding,
} from '../src/index.js';

const HANDOFF_ID = '5f8e1c1a-2b3c-4d5e-8f90-123456789abc';
const KEY_ID = 'handoff-a1';

const binding: SecretHandoffBinding = {
  id: HANDOFF_ID,
  fromTenant: 'steven',
  fromAlias: 'zeus',
  toTenant: 'miguel',
  toAlias: 'kratos',
};

function flipByte(buffer: Buffer, index = 0): Buffer {
  const copy = Buffer.from(buffer);
  copy.writeUInt8(copy.readUInt8(index) ^ 0x01, index);
  return copy;
}

function seal(plaintext: Buffer, recipientPublicKey: Buffer): SealedSecret {
  return sealSecret({ recipientPublicKey, keyId: KEY_ID, binding, plaintext });
}

function failure(input: OpenSealedSecretInput): string {
  try {
    openSealedSecret(input);
  } catch (error) {
    return error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ''}` : '';
  }
  return '';
}

describe('sealing binding', () => {
  it('serializes the binding with the contracted key order', () => {
    expect(sealingAad({ ...binding, keyId: KEY_ID })).toBe(
      '{"v":1,"id":"5f8e1c1a-2b3c-4d5e-8f90-123456789abc","from_tenant":"steven",'
      + '"from_alias":"zeus","to_tenant":"miguel","to_alias":"kratos","key_id":"handoff-a1"}'
    );
  });

  it('publishes a raw x25519 public key of the contracted length', () => {
    const pair = generateSealingKeyPair();
    expect(pair.publicKey.byteLength).toBe(SEALING_PUBLIC_KEY_BYTES);
    expect(pair.privateKey.byteLength).toBeGreaterThan(SEALING_PUBLIC_KEY_BYTES);
  });
});

describe('sealed secret round trip', () => {
  it('returns the exact plaintext bytes', () => {
    const pair = generateSealingKeyPair();
    const plaintext = Buffer.from('npg_FICTICIA0AbCdEf ÿ binario', 'utf8');
    const sealed = seal(plaintext, pair.publicKey);

    expect(sealed.sealingKeyId).toBe(KEY_ID);
    expect(sealed.nonce.byteLength).toBe(SEALING_NONCE_BYTES);
    expect(sealed.ephemeralPublic.byteLength).toBe(SEALING_PUBLIC_KEY_BYTES);
    expect(sealed.sealed.includes(plaintext)).toBe(false);

    const opened = openSealedSecret({
      privateKey: pair.privateKey,
      ephemeralPublic: sealed.ephemeralPublic,
      nonce: sealed.nonce,
      sealed: sealed.sealed,
      keyId: KEY_ID,
      binding,
    });
    expect(opened.equals(plaintext)).toBe(true);
  });

  it('produces a different sealed blob for the same plaintext', () => {
    const pair = generateSealingKeyPair();
    const plaintext = Buffer.from('same secret', 'utf8');
    const first = seal(plaintext, pair.publicKey);
    const second = seal(plaintext, pair.publicKey);
    expect(first.sealed.equals(second.sealed)).toBe(false);
    expect(first.ephemeralPublic.equals(second.ephemeralPublic)).toBe(false);
  });
});

describe('sealing rejects malformed input', () => {
  it('rejects a public key of the wrong length', () => {
    const pair = generateSealingKeyPair();
    for (const key of [pair.publicKey.subarray(0, 31), Buffer.concat([pair.publicKey, Buffer.of(0)])]) {
      expect(() => seal(Buffer.from('x'), key)).toThrow(SealingError);
    }
  });

  it('rejects a plaintext over the protocol cap', () => {
    const pair = generateSealingKeyPair();
    expect(() => seal(Buffer.alloc(MAX_SECRET_PLAINTEXT_BYTES + 1, 0x41), pair.publicKey))
      .toThrow(SealingError);
    expect(() => seal(Buffer.alloc(MAX_SECRET_PLAINTEXT_BYTES, 0x41), pair.publicKey)).not.toThrow();
  });

  const degenerateKeys: readonly [string, Buffer][] = [
    ['all zero', Buffer.alloc(SEALING_PUBLIC_KEY_BYTES, 0)],
    ['order one', Buffer.concat([Buffer.of(1), Buffer.alloc(SEALING_PUBLIC_KEY_BYTES - 1, 0)])],
    ['order eight', Buffer.from(
      'e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800', 'hex'
    )],
  ];

  it.each(degenerateKeys)('turns a %s recipient key into a SealingError', (_name, key) => {
    let thrown: unknown;
    try {
      seal(Buffer.from('npg_FICTICIA', 'utf8'), key);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SealingError);
    const detail = thrown instanceof Error ? `${thrown.message}\n${thrown.stack ?? ''}` : '';
    expect(detail).not.toMatch(/error:[0-9A-F]{8}/u);
    expect(detail).not.toContain('derivation');
    expect(detail).not.toContain('npg_FICTICIA');
  });

  it('keeps the sealed blob under the cap the consumers import', () => {
    const pair = generateSealingKeyPair();
    const sealed = seal(Buffer.alloc(MAX_SECRET_PLAINTEXT_BYTES, 0x41), pair.publicKey);
    expect(MAX_SEALED_BYTES).toBeGreaterThan(MAX_SECRET_PLAINTEXT_BYTES);
    expect(sealed.sealed.byteLength).toBeLessThanOrEqual(MAX_SEALED_BYTES);
    expect(() => openSealedSecret({
      privateKey: pair.privateKey,
      ephemeralPublic: sealed.ephemeralPublic,
      nonce: sealed.nonce,
      sealed: Buffer.alloc(MAX_SEALED_BYTES + 1, 0x41),
      keyId: KEY_ID,
      binding,
    })).toThrow(SealingError);
  });
});

describe('sealed secret tamper resistance', () => {
  const pair = generateSealingKeyPair();
  const plaintext = Buffer.from('ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789', 'utf8');
  const sealed = seal(plaintext, pair.publicKey);
  const base = {
    privateKey: pair.privateKey,
    ephemeralPublic: sealed.ephemeralPublic,
    nonce: sealed.nonce,
    sealed: sealed.sealed,
    keyId: KEY_ID,
    binding,
  };

  const tampered: readonly [string, OpenSealedSecretInput][] = [
    ['sealed', { ...base, sealed: flipByte(sealed.sealed) }],
    ['tag', { ...base, sealed: flipByte(sealed.sealed, sealed.sealed.byteLength - 1) }],
    ['nonce', { ...base, nonce: flipByte(sealed.nonce) }],
    ['ephemeral public key', { ...base, ephemeralPublic: flipByte(sealed.ephemeralPublic) }],
    ['recipient alias', { ...base, binding: { ...binding, toAlias: 'iza' } }],
    ['recipient tenant', { ...base, binding: { ...binding, toTenant: 'jhon' } }],
    ['handoff id', { ...base, binding: { ...binding, id: '00000000-0000-4000-8000-000000000000' } }],
    ['sealing key id', { ...base, keyId: 'handoff-a2' }],
    ['truncated blob', { ...base, sealed: sealed.sealed.subarray(0, 8) }],
  ];

  it.each(tampered)('refuses to open a handoff with a tampered %s', (_name, input) => {
    expect(() => openSealedSecret(input)).toThrow(SealingError);
    // Every cause reports the SAME message: a caller must not get a decryption oracle.
    expect(failure(input)).toContain('SealingError: sealed secret could not be opened\n');
  });

  it('refuses to open with another recipient private key', () => {
    const other = generateSealingKeyPair();
    expect(() => openSealedSecret({ ...base, privateKey: other.privateKey })).toThrow(SealingError);
  });

  it('never leaks plaintext or ciphertext material in the failure', () => {
    const message = failure({ ...base, nonce: flipByte(sealed.nonce) });
    expect(message).toContain('sealed secret could not be opened');
    for (const fragment of [
      plaintext.toString('utf8'),
      plaintext.toString('base64'),
      sealed.sealed.toString('base64'),
      pair.privateKey.toString('base64'),
    ]) {
      expect(message).not.toContain(fragment);
    }
  });
});

describe('secret handoff wire schemas', () => {
  const pair = generateSealingKeyPair();
  const sealedSecret = seal(Buffer.from('secreto', 'utf8'), pair.publicKey);

  const publication = {
    key_id: KEY_ID,
    algorithm: SEALING_ALGORITHM,
    public_key: pair.publicKey.toString('base64'),
    not_after: '2026-09-03T10:00:00Z',
  };

  const request = {
    to_tenant: 'miguel',
    to_alias: 'kratos',
    label: 'neon dev',
    sealing_key_id: KEY_ID,
    ephemeral_public: sealedSecret.ephemeralPublic.toString('base64'),
    nonce: sealedSecret.nonce.toString('base64'),
    sealed: sealedSecret.sealed.toString('base64'),
    expires_at: '2026-09-03T10:00:00Z',
  };

  it('accepts a published sealing key, with and without expiry', () => {
    expect(SealingKeyPublicationSchema.safeParse(publication).success).toBe(true);
    const { not_after: _ignored, ...rest } = publication;
    expect(SealingKeyPublicationSchema.safeParse(rest).success).toBe(true);
  });

  const badPublications: readonly [string, Record<string, unknown>][] = [
    ['a public key that is not 32 bytes', { ...publication, public_key: Buffer.alloc(31).toString('base64') }],
    ['a non canonical base64 key', {
      ...publication,
      public_key: `${pair.publicKey.toString('base64').slice(0, 42)}B=`,
    }],
    ['another algorithm', { ...publication, algorithm: 'rsa' }],
    ['an unknown field', { ...publication, comment: 'hola' }],
    ['a local expiry', { ...publication, not_after: '2026-09-03T10:00:00+02:00' }],
  ];

  it.each(badPublications)('rejects a publication with %s', (_name, candidate) => {
    expect(SealingKeyPublicationSchema.safeParse(candidate).success).toBe(false);
  });

  it('accepts a well formed handoff request', () => {
    expect(SecretHandoffRequestSchema.safeParse(request).success).toBe(true);
  });

  const badRequests: readonly [string, Record<string, unknown>][] = [
    ['an empty label', { ...request, label: '' }],
    ['an oversized label', { ...request, label: 'a'.repeat(MAX_SECRET_LABEL_LENGTH + 1) }],
    ['a bidi control in the label', { ...request, label: 'neon\u202edev' }],
    ['a newline in the label', { ...request, label: 'neon\ndev' }],
    ['a nonce that is not 12 bytes', { ...request, nonce: Buffer.alloc(11).toString('base64') }],
    ['an ephemeral key that is not 32 bytes', { ...request, ephemeral_public: Buffer.alloc(16).toString('base64') }],
    ['a sealed blob over the cap', {
      ...request,
      sealed: Buffer.alloc(MAX_SECRET_PLAINTEXT_BYTES + 65).toString('base64'),
    }],
    ['a sealed blob shorter than the tag', { ...request, sealed: Buffer.alloc(8).toString('base64') }],
    ['an alias that is not an alias', { ...request, to_alias: 'Kratos' }],
    ['a loose expiry', { ...request, expires_at: '2026-09-03 10:00:00Z' }],
    ['an unknown field', { ...request, secret: 'npg_FICTICIA' }],
  ];

  it.each(badRequests)('rejects a handoff request with %s', (_name, candidate) => {
    expect(SecretHandoffRequestSchema.safeParse(candidate).success).toBe(false);
  });

  it('describes a pending handoff without carrying any sealed material', () => {
    const ref = {
      id: HANDOFF_ID,
      from_tenant: 'steven',
      from_alias: 'zeus',
      label: 'neon dev',
      expires_at: '2026-09-03T10:00:00Z',
    };
    expect(SecretHandoffRefSchema.safeParse(ref).success).toBe(true);
    expect(SecretHandoffRefSchema.safeParse({ ...ref, sealed: request.sealed }).success).toBe(false);
  });

  it('returns the sealed payload the recipient needs to rebuild the binding', () => {
    const payload = {
      id: HANDOFF_ID,
      from_tenant: 'steven',
      from_alias: 'zeus',
      to_tenant: 'miguel',
      to_alias: 'kratos',
      label: 'neon dev',
      sealing_key_id: KEY_ID,
      ephemeral_public: request.ephemeral_public,
      nonce: request.nonce,
      sealed: request.sealed,
      expires_at: '2026-09-03T10:00:00Z',
      created_at: '2026-09-02T10:00:00Z',
    };
    expect(SecretHandoffPayloadSchema.safeParse(payload).success).toBe(true);
    expect(SecretHandoffPayloadSchema.safeParse({ ...payload, plaintext: 'x' }).success).toBe(false);
  });
});
