import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeCanonicalBase64,
  MAX_SEALED_BYTES,
  openSealedSecret,
  SEALING_NONCE_BYTES,
  SEALING_PUBLIC_KEY_BYTES,
  SecretHandoffPayloadSchema,
  SecretHandoffRefSchema,
  generateSealingKeyPair,
  type SecretHandoffRef,
} from "@cauce/protocol";
import { readOwnerOnlyFile, writeOwnerOnlyFile } from "./secure-files.js";

/**
 * Recipient half of the sealed credential hand-off.
 * Everything here obeys one rule: the value exists in this process only as long as it takes to
 * write it to an owner-only file inside the per-delivery directory. It never reaches the returned
 * descriptor, the prompt, a log line or an error, and its buffer is zeroed on every path out.
 * The one exception is the scrub material below, NOT zeroable: a JS string is immutable, so that
 * copy of the value lives until GC. It is kept out of `MaterializedSecret` and out of the prompt.
 */

/** Transport that resolves a hand-off id into its sealed payload. Owned by the gateway client. */
export type FetchSealedSecret = (id: string) => Promise<unknown>;

/** What the turn is told exists: enough to open the file, never enough to learn the value. */
export interface MaterializedSecret {
  readonly id: string;
  readonly label: string;
  readonly path: string;
}

/**
 * What the release point needs once the plaintext buffer is gone, captured HERE with the value in
 * hand: re-reading the file at ACK time would hand the agent a one-command disarm — `rm` it, or
 * chmod it away from 0600, and every scrub becomes a no-op on a file the agent owns.
 */
export interface SecretScrubMaterial {
  readonly values: readonly string[];
  readonly digests: readonly string[];
}

interface OpenedSecret {
  readonly secret: MaterializedSecret;
  readonly digest: string;
  readonly value: string | undefined;
}

export interface SecretMaterialization {
  readonly secrets: readonly MaterializedSecret[];
  readonly scrub: SecretScrubMaterial;
}

export interface SecretMaterializationDeps {
  readonly directory: string;
  readonly keyPath: string;
  readonly toTenant: string;
  readonly toAlias: string;
  readonly fetchSealedSecret: FetchSealedSecret | undefined;
  readonly notice: (secretId: string, reason: string) => void;
}

export interface SealingIdentity {
  readonly publicKey: Buffer;
  readonly keyId: string;
}

const KEY_PURPOSE = "Sealing private key";
const SECRET_PURPOSE = "Handed-off secret";
const MAX_SECRETS_PER_DELIVERY = 8;
/** Floor of the scrub guarantee: a shorter value is never struck from prose, only its digest holds. */
const MIN_SCRUBBED_LENGTH = 4;
const NOTHING_MATERIALIZED: SecretMaterialization = { secrets: [], scrub: { values: [], digests: [] } };

function scrubbableValue(plaintext: Buffer): string | undefined {
  if (plaintext.byteLength < MIN_SCRUBBED_LENGTH) return undefined;
  const value = plaintext.toString("utf8");
  return value.includes("\uFFFD") ? undefined : value;
}

function rawPublicKey(privateKey: Buffer): Buffer {
  const key = createPrivateKey({ key: privateKey, format: "der", type: "pkcs8" });
  const spki = createPublicKey(key).export({ type: "spki", format: "der" });
  return Buffer.from(spki.subarray(spki.byteLength - SEALING_PUBLIC_KEY_BYTES));
}

function sealingKeyId(publicKey: Buffer): string {
  return createHash("sha256").update(publicKey).digest("hex").slice(0, 16);
}

/**
 * Secrets get their OWN 0700 directory, never the attachments one: a whole-prefix deny at the
 * release point is only possible when no honest attachment can ever live under it. It is rooted
 * at the system temp dir on purpose — the agent workspace is its `cwd`, where its own `git add`,
 * indexer or grep would find a plaintext credential left behind by a SIGKILL.
 */
export async function createSecretsDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "cauce-secrets-"));
  await chmod(directory, 0o700);
  return directory;
}

/**
 * First boot writes the private half 0600 and never rewrites it. A concurrent boot loses the
 * O_EXCL race on purpose and re-reads what the winner wrote: two halves of one identity would
 * make every secret sealed against the published key undecryptable.
 */
async function loadOrCreatePrivateKey(path: string): Promise<Buffer> {
  const existing = await readOwnerOnlyFile(path, KEY_PURPOSE).catch(() => undefined);
  if (existing !== undefined) return existing;
  const pair = generateSealingKeyPair();
  try {
    await writeOwnerOnlyFile(path, pair.privateKey, KEY_PURPOSE);
    return pair.privateKey;
  } catch {
    pair.privateKey.fill(0);
    return await readOwnerOnlyFile(path, KEY_PURPOSE);
  }
}

/** Only the public half leaves: the key id is what a sender quotes to seal against this agent. */
export async function loadOrCreateSealingKeyPair(path: string): Promise<SealingIdentity> {
  const privateKey = await loadOrCreatePrivateKey(path);
  try {
    const publicKey = rawPublicKey(privateKey);
    return { publicKey, keyId: sealingKeyId(publicKey) };
  } finally {
    privateKey.fill(0);
  }
}

export function pendingSecretRefs(body: Record<string, unknown>): readonly SecretHandoffRef[] {
  const declared = body.secrets_v1;
  if (!Array.isArray(declared)) return [];
  const refs: SecretHandoffRef[] = [];
  for (const value of declared.slice(0, MAX_SECRETS_PER_DELIVERY)) {
    const parsed = SecretHandoffRefSchema.safeParse(value);
    if (parsed.success) refs.push(parsed.data);
  }
  return refs;
}

/** Reason codes, so `secret_handoff_skipped` tells the operator WHICH check closed the door. */
function skip(reason: string): Error {
  const error = new Error("sealed hand-off skipped");
  error.name = reason;
  return error;
}

function canonicalBytes(value: string, cap: number): Buffer {
  const decoded = decodeCanonicalBase64(value, cap);
  if (decoded === undefined) throw skip("sealed_field_not_canonical");
  return decoded;
}

/**
 * The binding is rebuilt from the REF the delivery carried and from this adapter's own identity,
 * never from the fetched payload: an attacker who could answer the transport would otherwise pick
 * the AAD that opens their own blob. The payload's routing fields are only compared against it.
 */
async function materializeOne(
  ref: SecretHandoffRef,
  index: number,
  identity: SealingIdentity & { readonly privateKey: Buffer },
  deps: SecretMaterializationDeps,
): Promise<OpenedSecret | undefined> {
  const path = join(deps.directory, `secret-${String(index + 1)}-${ref.id}`);
  let plaintext: Buffer | undefined;
  try {
    if (deps.fetchSealedSecret === undefined) throw skip("handoff_not_configured");
    if (Date.parse(ref.expires_at) <= Date.now()) throw skip("handoff_expired");
    const payload = SecretHandoffPayloadSchema.parse(await deps.fetchSealedSecret(ref.id));
    if (payload.sealing_key_id !== identity.keyId) throw skip("sealing_key_mismatch");
    if (payload.id !== ref.id
      || payload.from_tenant !== ref.from_tenant
      || payload.from_alias !== ref.from_alias
      || payload.to_tenant !== deps.toTenant
      || payload.to_alias !== deps.toAlias) {
      throw skip("payload_does_not_match_ref");
    }
    plaintext = openSealedSecret({
      privateKey: identity.privateKey,
      ephemeralPublic: canonicalBytes(payload.ephemeral_public, SEALING_PUBLIC_KEY_BYTES),
      nonce: canonicalBytes(payload.nonce, SEALING_NONCE_BYTES),
      sealed: canonicalBytes(payload.sealed, MAX_SEALED_BYTES),
      keyId: identity.keyId,
      binding: {
        id: ref.id,
        fromTenant: ref.from_tenant,
        fromAlias: ref.from_alias,
        toTenant: deps.toTenant,
        toAlias: deps.toAlias,
      },
    });
    await writeOwnerOnlyFile(path, plaintext, SECRET_PURPOSE);
    return {
      secret: { id: ref.id, label: ref.label, path },
      digest: createHash("sha256").update(plaintext).digest("hex"),
      value: scrubbableValue(plaintext),
    };
  } catch (error) {
    await rm(path, { force: true }).catch(() => undefined);
    deps.notice(ref.id, error instanceof Error ? error.name : "unknown");
    return undefined;
  } finally {
    plaintext?.fill(0);
  }
}

/**
 * A hand-off that cannot be opened is skipped, never fatal: the sender's mistake, an expired
 * window or a transport that is not wired must not cost the human their turn.
 */
export async function materializeSecrets(
  refs: readonly SecretHandoffRef[],
  deps: SecretMaterializationDeps,
): Promise<SecretMaterialization> {
  if (refs.length === 0) return NOTHING_MATERIALIZED;
  if (deps.fetchSealedSecret === undefined || deps.keyPath.length === 0) {
    for (const ref of refs) deps.notice(ref.id, "handoff_not_configured");
    return NOTHING_MATERIALIZED;
  }
  let identity: SealingIdentity & { readonly privateKey: Buffer };
  try {
    const privateKey = await loadOrCreatePrivateKey(deps.keyPath);
    const publicKey = rawPublicKey(privateKey);
    identity = { privateKey, publicKey, keyId: sealingKeyId(publicKey) };
  } catch {
    for (const ref of refs) deps.notice(ref.id, "sealing_key_unavailable");
    return NOTHING_MATERIALIZED;
  }
  const secrets: MaterializedSecret[] = [];
  const values: string[] = [];
  const digests: string[] = [];
  try {
    for (const [index, ref] of refs.entries()) {
      const opened = await materializeOne(ref, index, identity, deps);
      if (opened === undefined) continue;
      secrets.push(opened.secret);
      digests.push(opened.digest);
      if (opened.value !== undefined) values.push(opened.value);
    }
  } finally {
    identity.privateKey.fill(0);
  }
  return { secrets, scrub: { values, digests } };
}
