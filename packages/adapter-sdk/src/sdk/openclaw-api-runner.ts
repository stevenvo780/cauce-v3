import { isIP } from "node:net"; /* eslint @typescript-eslint/no-unnecessary-condition: "error" */
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { signalAborted } from "../runtime-state.js";
import { ProcessExecutionError } from "./errors.js";
import { readBearerTokenFile } from "./secure-files.js";
import type { CommandRunRequest, CommandRunResult, CommandRunner } from "./types.js";

interface OpenClawApiRunnerOptions {
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

async function boundedResponse(response: IncomingMessage, limit: number): Promise<string> {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of response as AsyncIterable<Uint8Array>) {
    bytes += chunk.byteLength;
    if (bytes > limit) {
      response.destroy();
      throw new ProcessExecutionError(
        "OPENCLAW_OUTPUT_LIMIT_AMBIGUOUS",
        "OpenClaw API output exceeded the configured limit after dispatch",
        false,
      );
    }
    chunks.push(chunk);
  }
  return new TextDecoder().decode(Buffer.concat(chunks, bytes));
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
    if (request.signal.aborted) throw this.cancelledBeforeDispatch();

    const token = await readBearerTokenFile(this.tokenFile);
    if (signalAborted(request.signal)) throw this.cancelledBeforeDispatch();
    const controller = new AbortController();
    let timedOut = false;
    let cancelled = false;
    let dispatched = false;
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
      dispatched = true;
      const { stdout, status } = await this.requestCompletion(
        JSON.stringify({
          model: this.agentTarget,
          stream: false,
          ...(request.sessionId === undefined ? {} : { user: request.sessionId }),
          messages: [{ role: "user", content: request.stdin }],
        }),
        token,
        controller.signal,
      );
      if (status < 200 || status >= 300) {
        if (status === 425 || status === 429) {
          throw new ProcessExecutionError(
            "OPENCLAW_HTTP_PRE_EXECUTION",
            "OpenClaw API rejected the request before execution",
            true,
          );
        }
        const ambiguous = status === 408 || status >= 500;
        throw new ProcessExecutionError(
          ambiguous ? "OPENCLAW_HTTP_AMBIGUOUS" : "OPENCLAW_HTTP",
          ambiguous
            ? "OpenClaw API failed after request dispatch; execution state is unknown"
            : "OpenClaw API rejected the request",
          false,
        );
      }
      return {
        stdout,
        stderr: "",
        exitCode: 0,
        signal: null,
        timedOut: false,
        cancelled: false,
      };
    } catch (error) { // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Abort callbacks can mutate both flags before the transport rejects.
      if (timedOut || cancelled) {
        if (!dispatched) throw this.cancelledBeforeDispatch();
        return this.abortedResult(timedOut);
      }
      if (error instanceof ProcessExecutionError) throw error;
      throw new ProcessExecutionError(
        "OPENCLAW_API_AMBIGUOUS",
        "OpenClaw API transport failed after request dispatch; execution state is unknown",
        false,
      );
    } finally {
      clearTimeout(timeout);
      request.signal.removeEventListener("abort", onAbort);
    }
  }

  private requestCompletion(body: string, token: string, signal: AbortSignal): Promise<{ stdout: string; status: number }> {
    return new Promise((resolveResponse, rejectResponse) => {
      let responseReceived = false;
      const send = this.endpoint.protocol === "https:" ? httpsRequest : httpRequest;
      const outgoing = send(this.endpoint, {
        method: "POST",
        agent: false,
        timeout: 0,
        signal,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          "accept-encoding": "identity",
        },
      }, (response) => {
        responseReceived = true;
        const status = response.statusCode ?? 500;
        if ([301, 302, 303, 307, 308].includes(status)) {
          response.destroy();
          rejectResponse(new Error("OpenClaw API redirects are forbidden"));
          return;
        }
        void boundedResponse(response, this.maxOutputBytes).then(
          (stdout) => { resolveResponse({ stdout, status }); },
          rejectResponse,
        );
      });
      outgoing.once("error", rejectResponse);
      outgoing.once("upgrade", (_response, socket) => {
        socket.destroy();
        rejectResponse(new Error("OpenClaw API protocol upgrades are forbidden"));
      });
      outgoing.once("close", () => {
        if (!responseReceived) rejectResponse(new Error("OpenClaw API connection closed before a response"));
      });
      outgoing.end(body);
    });
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

  private cancelledBeforeDispatch(): ProcessExecutionError {
    return new ProcessExecutionError(
      "CANCELLED",
      "OpenClaw API request was cancelled before dispatch",
      false,
    );
  }
}
