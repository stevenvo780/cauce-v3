import { readFile } from "node:fs/promises";
import { request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import type { VersionedContext } from "@cauce/protocol";
import { readBearerTokenFile } from "./secure-files.js";

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
  readonly mutualTls?: { readonly certFile: string; readonly keyFile: string; readonly caFile: string };
  readonly bearerTokenFile?: string;
  readonly developmentIdentity?: { readonly tenant_id: string; readonly alias: string };
  readonly timeoutMs?: number;
}

export type ContextIngestErrorCode = "UNAUTHORIZED" | "REJECTED" | "TOO_LARGE" | "TRANSPORT";
export class ContextIngestError extends Error {
  constructor(readonly code: ContextIngestErrorCode, message: string) {
    super(message);
    this.name = "ContextIngestError";
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;
let defaultClient: NativeContextIngest | undefined;
export function configureDefaultContextIngestClient(client: NativeContextIngest): void { defaultClient = client; }
export function defaultContextIngestClient(): NativeContextIngest | undefined { return defaultClient; }

async function drain(response: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of response) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export class ContextIngestClient implements NativeContextIngest {
  private agent: HttpsAgent | undefined;

  private constructor(readonly baseUrl: string, private readonly options: ContextIngestClientOptions) {}

  /** `wss://host:port/v3/ws` becomes `https://host:port`; `ws:` becomes `http:` (development). */
  static fromRelayUrl(relayUrl: string, options: ContextIngestClientOptions): ContextIngestClient {
    const parsed = new URL(relayUrl);
    const protocol = parsed.protocol === "wss:" ? "https:" : parsed.protocol === "ws:" ? "http:" : parsed.protocol;
    if (protocol !== "https:" && protocol !== "http:") throw new Error(`context ingest client cannot derive an origin from ${relayUrl}`);
    return new ContextIngestClient(`${protocol}//${parsed.host}`, options);
  }

  private async transport(): Promise<{ request: typeof httpsRequest; agent?: HttpsAgent }> {
    if (!this.baseUrl.startsWith("https:")) return { request: httpRequest };
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

  async ingest(input: NativeContextIngestInput): Promise<NativeContextIngestResult> {
    const { request, agent } = await this.transport();
    const url = new URL("/v3/context/ingest", this.baseUrl);
    const body = Buffer.from(JSON.stringify(input));
    const headers = await this.headers({ "content-type": "application/json", "content-length": String(body.byteLength) });
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const outgoing = request(url, {
        method: "POST", headers,
        ...(agent === undefined ? {} : { agent }), timeout: this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      }, incoming => resolve(incoming));
      outgoing.on("error", error => reject(new ContextIngestError("TRANSPORT", `context ingest gateway unreachable: ${error.message}`)));
      outgoing.on("timeout", () => outgoing.destroy(new Error("context ingest timed out")));
      outgoing.end(body);
    });
    const text = await drain(response);
    const status = response.statusCode ?? 0;
    if (status === 202) {
      const snapshot = JSON.parse(text) as { company_id?: unknown; tenant_id?: unknown; alias?: unknown;
        version?: unknown; digest?: unknown; files?: unknown };
      if (typeof snapshot.company_id !== "string" || typeof snapshot.tenant_id !== "string" || typeof snapshot.alias !== "string"
        || typeof snapshot.version !== "number" || typeof snapshot.digest !== "string" || !Array.isArray(snapshot.files)) {
        throw new ContextIngestError("REJECTED", "context ingest gateway returned an invalid snapshot");
      }
      return { state: "ingested", context: { company_id: snapshot.company_id, tenant_id: snapshot.tenant_id,
        alias: snapshot.alias, version: snapshot.version, digest: snapshot.digest,
        files: snapshot.files as VersionedContext["files"] } };
    }
    if (status === 409) {
      let conflict: { desired_version?: unknown; applied_version?: unknown } = {};
      try { conflict = JSON.parse(text) as typeof conflict; } catch { conflict = {}; }
      return { state: "conflict",
        desired_version: typeof conflict.desired_version === "number" ? conflict.desired_version : input.base_version,
        applied_version: typeof conflict.applied_version === "number" ? conflict.applied_version : input.base_version };
    }
    const detail = text.slice(0, 200);
    if (status === 401 || status === 403) throw new ContextIngestError("UNAUTHORIZED", `context ingest refused the credential (${String(status)}): ${detail}`);
    if (status === 413) throw new ContextIngestError("TOO_LARGE", `context ingest exceeds the gateway cap: ${detail}`);
    if (status >= 400 && status < 500) throw new ContextIngestError("REJECTED", `context ingest answered ${String(status)}: ${detail}`);
    throw new ContextIngestError("TRANSPORT", `context ingest answered ${String(status)}: ${detail}`);
  }
}
