import { request as httpRequest, type OutgoingHttpHeaders } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import type { VersionedContext } from "@cauce/protocol";

export interface NativeContextIngestInput {
  readonly base_version: number;
  readonly files: readonly { readonly path: string; readonly content: string }[];
}
export type NativeContextIngestResult =
  | { readonly state: "ingested"; readonly context: VersionedContext }
  | { readonly state: "conflict"; readonly desired_version: number; readonly applied_version: number };
export interface NativeContextIngest {
  ingest(input: NativeContextIngestInput): Promise<NativeContextIngestResult>;
}

export interface ContextIngestClientOptions {
  readonly baseUrl: string;
  readonly mutualTls?: { readonly ca: string; readonly cert: string; readonly key: string; readonly servername?: string };
  readonly allowInsecureHttp?: boolean;
  readonly bearerToken?: string;
  readonly developmentIdentity?: { readonly tenantId: string; readonly alias: string };
  readonly headers?: Readonly<Record<string, string>>;
  readonly requestTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
let defaultClient: NativeContextIngest | undefined;
export function configureDefaultContextIngestClient(client: NativeContextIngest): void { defaultClient = client; }
export function defaultContextIngestClient(): NativeContextIngest | undefined { return defaultClient; }

/** Native context ingest over the same mTLS/bearer transports the adapter already uses. */
export class ContextIngestClient implements NativeContextIngest {
  readonly #base: URL;
  readonly #options: ContextIngestClientOptions;
  readonly #agent: HttpsAgent | undefined;
  constructor(options: ContextIngestClientOptions) {
    this.#options = { ...options };
    this.#base = new URL(options.baseUrl);
    if (this.#base.protocol !== "https:" && !(this.#base.protocol === "http:" && options.allowInsecureHttp === true)) {
      throw new Error("ContextIngestClient requires an HTTPS gateway URL");
    }
    if (options.developmentIdentity !== undefined && !(this.#base.protocol === "http:" && options.allowInsecureHttp === true)) {
      throw new Error("ContextIngestClient development identity requires insecure HTTP");
    }
    const mtls = options.mutualTls;
    this.#agent = mtls === undefined ? undefined : new HttpsAgent({ ca: mtls.ca, cert: mtls.cert, key: mtls.key,
      rejectUnauthorized: true, ...(mtls.servername === undefined ? {} : { servername: mtls.servername }) });
  }
  static fromRelayUrl(relayUrl: string, options: Omit<ContextIngestClientOptions, "baseUrl"> = {}): ContextIngestClient {
    const base = new URL(relayUrl);
    if (base.protocol === "ws:") base.protocol = "http:";
    else if (base.protocol === "wss:") base.protocol = "https:";
    base.pathname = ""; base.search = ""; base.hash = "";
    return new ContextIngestClient({ ...options, baseUrl: base.href });
  }
  #headers(contentLength: number): OutgoingHttpHeaders {
    const headers: Record<string, string> = { "content-type": "application/json",
      "content-length": String(contentLength), ...(this.#options.headers ?? {}) };
    if (this.#options.bearerToken !== undefined) headers.authorization = `Bearer ${this.#options.bearerToken}`;
    const dev = this.#options.developmentIdentity;
    if (dev !== undefined) { headers["x-cauce-dev-tenant"] = dev.tenantId; headers["x-cauce-dev-alias"] = dev.alias; }
    return headers;
  }
  async #send(body: Buffer): Promise<{ status: number; body: string }> {
    const url = new URL("/v3/context/ingest", this.#base);
    const timeout = this.#options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const request = url.protocol === "https:"
        ? httpsRequest(url, { method: "POST", headers: this.#headers(body.byteLength), agent: this.#agent })
        : httpRequest(url, { method: "POST", headers: this.#headers(body.byteLength) });
      request.setTimeout(timeout, () => request.destroy(new Error("Context ingest request timed out")));
      request.once("error", reject);
      request.once("response", (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
        response.once("error", reject);
      });
      request.end(body);
    });
  }
  async ingest(input: NativeContextIngestInput): Promise<NativeContextIngestResult> {
    const response = await this.#send(Buffer.from(JSON.stringify(input)));
    if (response.status === 202) {
      const snapshot = JSON.parse(response.body) as { company_id?: unknown; tenant_id?: unknown; alias?: unknown;
        version?: unknown; digest?: unknown; files?: unknown };
      if (typeof snapshot.company_id !== "string" || typeof snapshot.tenant_id !== "string" || typeof snapshot.alias !== "string"
        || typeof snapshot.version !== "number" || typeof snapshot.digest !== "string" || !Array.isArray(snapshot.files)) {
        throw new Error("ContextIngestClient received an invalid ingest snapshot");
      }
      return { state: "ingested", context: { company_id: snapshot.company_id, tenant_id: snapshot.tenant_id,
        alias: snapshot.alias, version: snapshot.version, digest: snapshot.digest,
        files: snapshot.files as VersionedContext["files"] } };
    }
    if (response.status === 409) {
      let conflict: { desired_version?: unknown; applied_version?: unknown } = {};
      try { conflict = JSON.parse(response.body) as typeof conflict; } catch { conflict = {}; }
      return { state: "conflict",
        desired_version: typeof conflict.desired_version === "number" ? conflict.desired_version : input.base_version,
        applied_version: typeof conflict.applied_version === "number" ? conflict.applied_version : input.base_version };
    }
    throw new Error(`Context ingest failed with HTTP ${String(response.status)}`);
  }
}
