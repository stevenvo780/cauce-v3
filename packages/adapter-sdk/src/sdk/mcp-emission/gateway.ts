import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { readBearerTokenFile, readOwnerOnlyFile } from "../secure-files.js";
import type { loadCliRuntimeConfig } from "../../bin/config.js";
import type { EmissionGateway } from "./tools.js";

export function emissionGateway(runtime: Awaited<ReturnType<typeof loadCliRuntimeConfig>>): EmissionGateway {
  const base = new URL(runtime.relayUrl);
  base.protocol = base.protocol === "wss:" ? "https:" : "http:";
  return async (method, path, body) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (runtime.bearerTokenFile !== undefined) headers.authorization = `Bearer ${await readBearerTokenFile(runtime.bearerTokenFile)}`;
    if (runtime.environment !== "production" && runtime.developmentIdentity) {
      headers["x-cauce-tenant"] = runtime.tenant;
      headers["x-cauce-alias"] = runtime.alias;
    }
    const tls = runtime.mutualTls;
    const material = tls === undefined ? {} : {
      cert: await readOwnerOnlyFile(tls.certFile, "mTLS certificate"),
      key: await readOwnerOnlyFile(tls.keyFile, "mTLS private key"),
      ca: await readOwnerOnlyFile(tls.caFile, "mTLS CA certificate"),
      rejectUnauthorized: true,
    };
    const url = new URL(path, base);
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    return new Promise((resolve, reject) => {
      const outgoing = send(url, { method, headers, ...material }, (response) => {
        let result = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          result += chunk;
          if (Buffer.byteLength(result) > 1024 * 1024) outgoing.destroy(new Error("Gateway response exceeds limit"));
        });
        response.on("error", reject);
        response.on("end", () => {
          try {
            const parsed: unknown = result.length === 0 ? {} : JSON.parse(result);
            if (response.statusCode === undefined || response.statusCode >= 300) {
              const message = typeof parsed === "object" && parsed !== null && "error" in parsed
                ? String(parsed.error) : "request rejected";
              throw new Error(`Gateway HTTP ${String(response.statusCode)}: ${message}`);
            }
            resolve(parsed);
          } catch (error) { reject(error instanceof Error ? error : new Error("Invalid gateway response")); }
        });
      });
      outgoing.setTimeout(20_000, () => { outgoing.destroy(new Error("Gateway request timed out")); });
      outgoing.on("error", reject);
      outgoing.end(body === undefined ? undefined : JSON.stringify(body));
    });
  };
}
