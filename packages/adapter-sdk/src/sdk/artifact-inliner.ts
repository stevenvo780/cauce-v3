import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import { basename, extname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import {
  base64CharacterBudget,
  isValidMediaType,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_ATTACHMENTS_TOTAL_BYTES,
  mediaTypeForExtension,
} from "@cauce/protocol";
import type { OutputArtifact, StructuredOutput } from "./types.js";

/**
 * Converts local attachments declared in `output.artifacts` to `data:` base64 URIs before
 * publishing the response to the bus, enabling safe delivery to the end user.
 */

export const MAX_INLINED_ARTIFACT_BYTES = MAX_ATTACHMENT_BYTES;

export const MAX_INLINED_ARTIFACTS_PER_RESPONSE = MAX_ATTACHMENTS_PER_MESSAGE;

const MAX_INLINED_TOTAL_BYTES = MAX_ATTACHMENTS_TOTAL_BYTES;

/**
 * Maximum paths attempted to open. The parser doesn't cap the length of `artifacts`, and a turn
 * can't become hundreds of syscalls for an invented list.
 */
const MAX_LOOKUPS = 16;

/** Cap on the resulting base64: the same calculation the bridge does before decoding. */
const MAX_BASE64_CHARACTERS = base64CharacterBudget(MAX_INLINED_ARTIFACT_BYTES, 64);

/**
 * No `/proc`, `/sys`, or `/dev`. These are "regular" files that aren't files: `/proc/self/…`
 * reports size 0 and returns the adapter's own state, and a device may never finish reading.
 * The agent never wants to attach those.
 */
const FORBIDDEN_ROOTS: readonly string[] = ["/proc/", "/sys/", "/dev/"];

const HEX_SHA256 = /^[0-9a-f]{64}$/u;

/** Any scheme: `data:`, `https:`, `git:`, `s3:`… Only `file:` is dereferenced. */
const HAS_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/u;

/**
 * Acceptable local path, already decoded.
 *
 * Only absolute paths and no `..` segment: a relative path depends on the adapter's cwd (which
 * isn't the agent's), and a `..` turns a path that looks bounded into any other.
 */
function acceptablePath(path: string): string | undefined {
  if (path.length === 0 || path.length > 4096) return undefined;
  if (!isAbsolute(path) || path.includes("\0")) return undefined;
  if (path.split("/").includes("..")) return undefined;
  if (FORBIDDEN_ROOTS.some((root) => path.startsWith(root))) return undefined;
  return path;
}

/** Is any segment of the raw URI `..`, with or without percent-encoding (`%2e%2e`, `.%2E`)? */
function traverses(uri: string): boolean {
  return uri.split(/[/?#]/u).some((segment) => segment.replace(/%2e/giu, ".") === "..");
}

/**
 * Translates an artifact's `uri` to a local path, or `undefined` if it shouldn't be touched.
 *
 * `file://host/...` with a foreign host is rejected: a resource from another machine, not the agent's.
 */
export function localArtifactPath(uri: string): string | undefined {
  const trimmed = uri.trim();
  if (trimmed.length === 0) return undefined;
  if (/^file:/iu.test(trimmed)) {
    // `..` is searched in the RAW URI in addition to the final path. `new URL()` normalizes
    // segments and makes the traversal disappear —`file:///w/%2e%2e/%2e%2e/etc/passwd` becomes
    // `/etc/passwd`—, so checking only the result would accept a path that tried to escape. A
    // URI that attempts traversal is not read, period.
    if (traverses(trimmed)) return undefined;
    try {
      const url = new URL(trimmed);
      const host = url.hostname.toLowerCase();
      if (host !== "" && host !== "localhost") return undefined;
// `fileURLToPath` decodes percent-encoding; that's why the `..` check on the final path is
    // still done afterward (a `%2e%2e` is a `..` in another suit).
      return acceptablePath(fileURLToPath(url));
    } catch {
      return undefined;
    }
  }
  if (HAS_SCHEME.test(trimmed)) return undefined;
  return acceptablePath(trimmed);
}

/**
 * Reads a REGULAR file without following the final symlink and without hanging.
 *
 * - `O_NOFOLLOW`: an `artifacts[].uri` pointing to a symlink to `/etc/passwd` fails here.
 *   Validation is against the already-opened descriptor (`fstat`), not a pre-checked path, so
 *   there's no window between check and use.
 * - `O_NONBLOCK`: opening a FIFO in read mode blocks until a writer appears. Without this, an
 *   attachment could hang the entire turn, which is worse than not sending it.
 * - Size is checked twice: in `fstat` to avoid materializing an absurd buffer, and on the bytes
 *   ACTUALLY read, which are the ones to be encoded.
 */
async function readRegularFile(path: string): Promise<Buffer | undefined> {
  const noFollow = "O_NOFOLLOW" in fsConstants ? fsConstants.O_NOFOLLOW : 0;
  const nonBlock = "O_NONBLOCK" in fsConstants ? fsConstants.O_NONBLOCK : 0;
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | noFollow | nonBlock);
    const metadata = await handle.stat();
    if (!metadata.isFile()) return undefined;
    if (metadata.size <= 0 || metadata.size > MAX_INLINED_ARTIFACT_BYTES) return undefined;
    const bytes = await handle.readFile();
    if (bytes.length === 0 || bytes.length > MAX_INLINED_ARTIFACT_BYTES) return undefined;
    return bytes;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** The type declared by the agent wins; if not declared (or declared garbage), inferred from the extension. */
function mediaTypeFor(artifact: OutputArtifact, path: string): string {
  const declared = artifact.media_type?.trim() ?? "";
  if (isValidMediaType(declared)) return declared;
  return mediaTypeForExtension(extname(path).toLowerCase()) ?? "application/octet-stream";
}

/**
 * Converts ONE artifact. Returns `undefined` when it should be left as is, which is always the
 * safe answer.
 */
async function inlineArtifact(
  artifact: OutputArtifact,
  path: string,
): Promise<{ readonly artifact: OutputArtifact; readonly bytes: number } | undefined> {
  const bytes = await readRegularFile(path);
  if (bytes === undefined) return undefined;

  const digest = createHash("sha256").update(bytes).digest("hex");
  const declared = artifact.sha256?.trim().toLowerCase() ?? "";
  // A declared sha that doesn't match what was read means the file changed, or the agent pointed
  // to the wrong file. Sending it anyway would be saying we sent one thing and sending another.
  if (declared !== "" && (!HEX_SHA256.test(declared) || declared !== digest)) return undefined;

  const base64 = bytes.toString("base64");
  // The limit is checked on the RESULT, not on the original: base64 grows ~33%, and it's the
  // result the bridge measures again before uploading.
  if (base64.length > MAX_BASE64_CHARACTERS) return undefined;

  const mediaType = mediaTypeFor(artifact, path);
  // Use the declared name or derive the filename from its path.
  const name = artifact.name.trim().length > 0 ? artifact.name : basename(path);
  return {
    artifact: {
      name,
      uri: `data:${mediaType};base64,${base64}`,
      media_type: mediaType,
      sha256: digest,
    },
    bytes: bytes.length,
  };
}

/**
 * Replaces local artifacts that can be read safely with `data:`, and leaves everything else
 * untouched: `data:` URIs that already came done, `http(s)://` (which the bridge lists as a link
 * on purpose, so it doesn't become an SSRF against production), what exceeds the caps, and what
 * can't be read.
 *
 * Never throws. Returns the same object when there was nothing to change.
 */
export async function inlineLocalArtifacts(output: StructuredOutput): Promise<StructuredOutput> {
  try {
    if (output.artifacts.length === 0) return output;

    const artifacts: OutputArtifact[] = [];
    let remaining = MAX_INLINED_ARTIFACTS_PER_RESPONSE;
    let remainingBytes = MAX_INLINED_TOTAL_BYTES;
    let lookups = 0;
    let changed = false;

    for (const artifact of output.artifacts) {
      // A `data:` that already came done is not touched, but DOES count against it: the bridge
      // counts uploads, not conversions, so converting a fifth attachment it will discard is wasted.
      if (/^data:/iu.test(artifact.uri.trim())) {
        remaining -= 1;
        artifacts.push(artifact);
        continue;
      }
      const path = remaining > 0 && lookups < MAX_LOOKUPS ? localArtifactPath(artifact.uri) : undefined;
      if (path === undefined) {
        artifacts.push(artifact);
        continue;
      }
      lookups += 1;
      const inlined = await inlineArtifact(artifact, path);
      // Couldn't (doesn't exist, is a symlink, is a FIFO, sha doesn't match, too big): stays as is
      // and the human reads the bridge's line. The turn still ships.
      if (inlined === undefined) {
        artifacts.push(artifact);
        continue;
      }
      // The aggregate cap is measured in file bytes, same as `MAX_ATTACHMENTS_TOTAL_BYTES`.
      if (inlined.bytes > remainingBytes) {
        artifacts.push(artifact);
        continue;
      }
      remainingBytes -= inlined.bytes;
      remaining -= 1;
      changed = true;
      artifacts.push(inlined.artifact);
    }

    return changed ? { ...output, artifacts } : output;
  } catch {
    // Defense in depth: the invariant is that an attachment NEVER costs a turn.
    return output;
  }
}
