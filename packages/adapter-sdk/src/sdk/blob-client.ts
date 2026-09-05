import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { readFile, rename, stat, unlink } from "node:fs/promises";
import { request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { pipeline } from "node:stream/promises";
import { blobArtifactUri, blobLocator, MAX_BLOB_BYTES } from "@cauce/protocol";
import { readBearerTokenFile } from "./secure-files.js";

/* The adapter's side of the blob store: `PUT /v3/blobs` streams a file up from disk and
   `GET /v3/blobs/<sha256>` streams one down to disk, both hashed in flight and never buffered.
   The credentials are the ones the WebSocket already uses -- the same mTLS leg or the same bearer
   file -- so a blob is reachable exactly where the bus is. */

export type BlobClientErrorCode =
  | "UNAUTHORIZED" | "NOT_FOUND" | "DIGEST_MISMATCH" | "SIZE_MISMATCH" | "TOO_LARGE" | "REJECTED" | "TRANSPORT";

export class BlobClientError extends Error {
  constructor(readonly code: BlobClientErrorCode, message: string) {
    super(message);
    this.name = "BlobClientError";
  }
}

export interface BlobClientOptions {
  readonly mutualTls?: { readonly certFile: string; readonly keyFile: string; readonly caFile: string };
  readonly bearerTokenFile?: string;
  readonly developmentIdentity?: { readonly tenant_id: string; readonly alias: string };
  readonly timeoutMs?: number;
}

export interface BlobUploadReceipt {
  readonly sha256: string;
  readonly bytes: number;
  readonly mediaType: string;
  readonly name: string;
  readonly uri: string;
  readonly blob: string;
}

export interface BlobDownloadResult {
  readonly sha256: string;
  readonly bytes: number;
  readonly mediaType: string;
}

export interface BlobUploader {
  upload(path: string, options: { name: string; mediaType: string; sha256?: string }): Promise<BlobUploadReceipt>;
}

export interface BlobFetcher {
  download(sha256: string, destination: string, options: { expectedBytes?: number }): Promise<BlobDownloadResult>;
}

const DEFAULT_TIMEOUT_MS = 30 * 60_000;
const HEX_SHA256 = /^[a-f0-9]{64}$/u;

async function digestOfFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function statusError(status: number, body: string): BlobClientError {
  const detail = body.slice(0, 200);
  if (status === 401 || status === 403) return new BlobClientError("UNAUTHORIZED", `blob store refused the credential (${String(status)}): ${detail}`);
  if (status === 404) return new BlobClientError("NOT_FOUND", `blob is unknown to the store: ${detail}`);
  if (status === 413) return new BlobClientError("TOO_LARGE", `blob exceeds the store cap: ${detail}`);
  return new BlobClientError("REJECTED", `blob store answered ${String(status)}: ${detail}`);
}

async function drain(response: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of response) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export class BlobClient implements BlobUploader, BlobFetcher {
  private agent: HttpsAgent | undefined;

  private constructor(readonly baseUrl: string, private readonly options: BlobClientOptions) {}

  /** `wss://host:port/v3/ws` becomes `https://host:port`; `ws:` becomes `http:` (development). */
  static fromRelayUrl(relayUrl: string, options: BlobClientOptions): BlobClient {
    const parsed = new URL(relayUrl);
    const protocol = parsed.protocol === "wss:" ? "https:" : parsed.protocol === "ws:" ? "http:" : parsed.protocol;
    if (protocol !== "https:" && protocol !== "http:") throw new Error(`blob client cannot derive an origin from ${relayUrl}`);
    return new BlobClient(`${protocol}//${parsed.host}`, options);
  }

  private async transport(): Promise<{ request: typeof httpsRequest; agent?: HttpsAgent }> {
    if (!this.baseUrl.startsWith("https:")) return { request: httpRequest as unknown as typeof httpsRequest };
    const tls = this.options.mutualTls;
    if (tls === undefined) return { request: httpsRequest };
    this.agent ??= new HttpsAgent({
      cert: await readFile(tls.certFile),
      key: await readFile(tls.keyFile),
      ca: await readFile(tls.caFile),
      keepAlive: false,
    });
    return { request: httpsRequest, agent: this.agent };
  }

  private async headers(extra: OutgoingHttpHeaders): Promise<OutgoingHttpHeaders> {
    const headers: OutgoingHttpHeaders = { ...extra };
    if (this.options.bearerTokenFile !== undefined) {
      headers.authorization = `Bearer ${await readBearerTokenFile(this.options.bearerTokenFile)}`;
    }
    if (this.options.developmentIdentity !== undefined) {
      headers["x-cauce-tenant"] = this.options.developmentIdentity.tenant_id;
      headers["x-cauce-alias"] = this.options.developmentIdentity.alias;
    }
    return headers;
  }

  private async open(
    method: "PUT" | "GET", path: string, headers: OutgoingHttpHeaders,
  ): Promise<{ request: ReturnType<typeof httpsRequest>; response: Promise<IncomingMessage> }> {
    const { request, agent } = await this.transport();
    const url = new URL(path, this.baseUrl);
    let settle: { resolve: (response: IncomingMessage) => void; reject: (error: Error) => void } | undefined;
    const response = new Promise<IncomingMessage>((resolve, reject) => { settle = { resolve, reject }; });
    const outgoing = request(url, {
      method, headers, ...(agent === undefined ? {} : { agent }),
      timeout: this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    }, (incoming) => settle?.resolve(incoming));
    outgoing.on("error", (error) => settle?.reject(new BlobClientError("TRANSPORT", `blob store unreachable: ${error.message}`)));
    outgoing.on("timeout", () => outgoing.destroy(new Error("blob transfer timed out")));
    return { request: outgoing, response };
  }

  async upload(path: string, options: { name: string; mediaType: string; sha256?: string }): Promise<BlobUploadReceipt> {
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size <= 0) throw new BlobClientError("REJECTED", `${path} is not a readable regular file`);
    if (metadata.size > MAX_BLOB_BYTES) throw new BlobClientError("TOO_LARGE", `${path} exceeds the blob ceiling`);
    const digest = options.sha256 ?? await digestOfFile(path);
    const { request, response } = await this.open("PUT", "/v3/blobs", await this.headers({
      "content-type": "application/octet-stream",
      "content-length": String(metadata.size),
      "x-cauce-blob-name": options.name,
      "x-cauce-blob-media-type": options.mediaType,
      "x-cauce-blob-sha256": digest,
    }));
    await pipeline(createReadStream(path), request).catch((error: unknown) => {
      request.destroy();
      throw error instanceof BlobClientError ? error : new BlobClientError("TRANSPORT", `blob upload failed: ${String(error)}`);
    });
    const incoming = await response;
    const body = await drain(incoming);
    if (incoming.statusCode !== 201) throw statusError(incoming.statusCode ?? 0, body);
    const receipt = JSON.parse(body) as { sha256?: unknown; bytes?: unknown; media_type?: unknown; name?: unknown };
    if (receipt.sha256 !== digest || receipt.bytes !== metadata.size) {
      throw new BlobClientError("DIGEST_MISMATCH", "blob store registered different bytes than the ones sent");
    }
    return {
      sha256: digest, bytes: metadata.size,
      mediaType: typeof receipt.media_type === "string" ? receipt.media_type : options.mediaType,
      name: typeof receipt.name === "string" ? receipt.name : options.name,
      uri: blobArtifactUri(digest), blob: blobLocator(digest),
    };
  }

  async download(sha256: string, destination: string, options: { expectedBytes?: number }): Promise<BlobDownloadResult> {
    if (!HEX_SHA256.test(sha256)) throw new BlobClientError("REJECTED", "blob digest must be sha256 hex");
    const { request, response } = await this.open("GET", `/v3/blobs/${sha256}`, await this.headers({}));
    request.end();
    const incoming = await response;
    if (incoming.statusCode !== 200) throw statusError(incoming.statusCode ?? 0, await drain(incoming));
    const temporary = `${destination}.parcial-${String(process.pid)}`;
    const hash = createHash("sha256");
    let bytes = 0;
    const limit = options.expectedBytes ?? MAX_BLOB_BYTES;
    try {
      await pipeline(incoming, async function* (source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          bytes += chunk.length;
          if (bytes > limit) throw new BlobClientError("SIZE_MISMATCH", "blob is larger than announced");
          hash.update(chunk);
          yield chunk;
        }
      }, createWriteStream(temporary, { mode: 0o600, flags: "wx" }));
      const digest = hash.digest("hex");
      if (digest !== sha256) throw new BlobClientError("DIGEST_MISMATCH", "blob bytes do not match their digest");
      if (options.expectedBytes !== undefined && bytes !== options.expectedBytes) {
        throw new BlobClientError("SIZE_MISMATCH", "blob size does not match the announced size");
      }
      await rename(temporary, destination);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error instanceof BlobClientError ? error : new BlobClientError("TRANSPORT", `blob download failed: ${String(error)}`);
    }
    const mediaType = incoming.headers["content-type"] ?? "application/octet-stream";
    return { sha256, bytes, mediaType: mediaType.split(";")[0]?.trim() ?? "application/octet-stream" };
  }
}
