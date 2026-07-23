import { isIP } from "node:net";
import { ProcessExecutionError } from "./errors.js";
import { readBearerTokenFile } from "./secure-files.js";
import type { CommandRunRequest, CommandRunResult, CommandRunner } from "./types.js";

export interface OpenClawApiRunnerOptions {
  readonly endpoint: string;
  readonly tokenFile: string;
  readonly agentTarget?: string;
  readonly maxOutputBytes?: number;
}

function loopbackEndpoint(endpoint: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error("OpenClaw API endpoint is not a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("OpenClaw API endpoint must use HTTP(S)");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Credentials, query strings and fragments are forbidden in the OpenClaw API URL");
  }
  const hostname = parsed.hostname.toLowerCase();
  const ipv4Loopback = isIP(hostname) === 4 && hostname.split(".")[0] === "127";
  if (hostname !== "localhost" && hostname !== "[::1]" && hostname !== "::1" && !ipv4Loopback) {
    throw new Error("OpenClaw API endpoint must be loopback-only");
  }
  if (parsed.pathname !== "/v1/chat/completions") {
    throw new Error("OpenClaw API endpoint must target /v1/chat/completions");
  }
  return parsed;
}

async function boundedResponse(response: Response, limit: number): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    bytes += next.value.byteLength;
    if (bytes > limit) {
      await reader.cancel().catch(() => undefined);
      throw new ProcessExecutionError("OUTPUT_LIMIT", "OpenClaw API output exceeded the configured limit", true);
    }
    chunks.push(next.value);
  }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

/** Secure, non-streaming OpenClaw OpenAI-compatible loopback client. */
export class OpenClawApiRunner implements CommandRunner {
  private readonly endpoint: URL;
  private readonly tokenFile: string;
  private readonly agentTarget: string;
  private readonly maxOutputBytes: number;

  constructor(options: OpenClawApiRunnerOptions) {
    this.endpoint = loopbackEndpoint(options.endpoint);
    this.tokenFile = options.tokenFile;
    this.agentTarget = options.agentTarget ?? "openclaw/default";
    this.maxOutputBytes = options.maxOutputBytes ?? 2 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxOutputBytes) || this.maxOutputBytes <= 0) {
      throw new Error("OpenClaw API output limit must be a positive integer");
    }
    if (!/^openclaw(?:[/:][A-Za-z0-9._-]+)?$/u.test(this.agentTarget)) {
      throw new Error("OpenClaw API agent target is invalid");
    }
  }

  async run(request: CommandRunRequest): Promise<CommandRunResult> {
    if (request.harness !== "openclaw") {
      throw new ProcessExecutionError("INVALID_HARNESS", "OpenClaw API runner received another harness", false);
    }
    if (request.timeoutMs <= 0 || !Number.isFinite(request.timeoutMs)) {
      throw new ProcessExecutionError("INVALID_TIMEOUT", "Timeout must be positive", false);
    }
    if (request.signal.aborted) return this.abortedResult(false);

    const token = await readBearerTokenFile(this.tokenFile);
    if (request.signal.aborted) return this.abortedResult(false);
    const controller = new AbortController();
    let timedOut = false;
    let cancelled = false;
    const onAbort = (): void => {
      cancelled = true;
      controller.abort();
    };
    request.signal.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, request.timeoutMs);
    timeout.unref();

    try {
      const response = await fetch(this.endpoint, {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.agentTarget,
          stream: false,
          ...(request.sessionId === undefined ? {} : { user: request.sessionId }),
          messages: [{ role: "user", content: request.stdin }],
        }),
      });
      const stdout = await boundedResponse(response, this.maxOutputBytes);
      if (!response.ok) {
        const retryable = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
        throw new ProcessExecutionError("OPENCLAW_HTTP", "OpenClaw API rejected the request", retryable);
      }
      return {
        stdout,
        stderr: "",
        exitCode: 0,
        signal: null,
        timedOut: false,
        cancelled: false,
      };
    } catch (error) {
      if (timedOut || cancelled) return this.abortedResult(timedOut);
      if (error instanceof ProcessExecutionError) throw error;
      throw new ProcessExecutionError("OPENCLAW_API_FAILED", "OpenClaw API request failed", true);
    } finally {
      clearTimeout(timeout);
      request.signal.removeEventListener("abort", onAbort);
    }
  }

  private abortedResult(timedOut: boolean): CommandRunResult {
    return {
      stdout: "",
      stderr: "",
      exitCode: null,
      signal: null,
      timedOut,
      cancelled: !timedOut,
    };
  }
}
