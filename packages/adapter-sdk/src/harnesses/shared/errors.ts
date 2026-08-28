import { AdapterError, ProcessExecutionError } from "../../sdk/errors.js";
import type { CommandRunResult } from "../../sdk/types.js";
import { HARNESS_START_MARKER } from "../../sdk/types.js";

export function esInterrupcionDelDuenio(detalle: string | undefined): boolean {
  if (detalle === undefined || detalle === "") return false;
  return /interrup|interrupt|aborted by user|turn_aborted|cancell?ed by user/i.test(detalle);
}

export function esDiagnosticoDeArranque(detalle: string | undefined): boolean {
  if (detalle === undefined || detalle === "") return false;
  return [
    // Error in initial config
    /error loading config\.toml/i,
    /unknown variant `/i,
    // Error in session resolution or resume
    /thread\/resume[^\n]*fail/i,
    /no rollout found/i,
    /session id[^\n]*already in use/i,
    /no conversation found with session id/i,
    // Missing binary or invalid arguments
    /\bcommand not found\b/i,
    /spawn[^\n]*\bENOENT\b/i,
    /\b(?:unexpected argument|unrecognized (?:option|argument))\b/i,
    // stdin bridge initialization failure
    /stdin bridge failed[^\n]*(?:modules|import|cannot find)/i,
  ].some((patron) => patron.test(detalle));
}

/**
 * Determines with certainty whether the harness process failed before starting the turn execution.
 */
export function nuncaEmpezoElTurno(result: CommandRunResult, detalle: string | undefined): boolean {
  if (result.stdout.length > 0) return false;
  if (result.timedOut || result.cancelled) return false;
  if (result.signal !== null || result.exitCode === null) return false;
  return result.harnessStarted === false || esDiagnosticoDeArranque(detalle);
}

/**
 * Checks whether the transport's witness confirms that the harness's execution never started.
 */
export function elTestigoDiceQueNoEmpezo(result: CommandRunResult): boolean {
  return result.stdout.length === 0 && result.harnessStarted === false;
}

/**
 * Is this abort the adapter's shutdown?
 *
 * `AdapterEngine.stop()` aborts with `AdapterError("SHUTDOWN", …, true)`: the reason travels on
 * the `AbortSignal`'s `reason` and is still there when the transport picks it up. Restarting an
 * adapter is an INFRASTRUCTURE failure, not a verdict on the work.
 */
export function abortadoPorApagado(signal: AbortSignal): boolean {
  const reason: unknown = signal.reason;
  return reason instanceof AdapterError && reason.code === "SHUTDOWN" && reason.retryable;
}

/**
 * Removes the start mark from stderr before it becomes a visible cause.
 *
 * The mark is internal protocol between the bridge and the runner; the operator reading
 * `last_error` has no need to see it, and worse: it would count as useful text and push the real
 * cause out of the character budget.
 */
export function sinMarcaDeArranque(stderr: string): string {
  if (!stderr.includes(HARNESS_START_MARKER)) return stderr;
  return stderr
    .split(/\r?\n/u)
    .filter((linea) => linea.trim() !== HARNESS_START_MARKER)
    .join("\n");
}

export function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof AdapterError) return signal.reason;
  const detail = describeAbortReason(signal);
  return new ProcessExecutionError(
    "CANCELLED",
    detail === ""
      ? "Harness execution was cancelled"
      : `Harness execution was cancelled (${detail})`,
    false,
  );
}

/**
 * Describes the reason execution was aborted, for inclusion in logs and diagnostics.
 */
function describeAbortReason(signal: AbortSignal): string {
  if (!signal.aborted) return "";
  const reason: unknown = signal.reason;
  if (reason === undefined || reason === null) return "";
  const raw = reason instanceof AdapterError
    ? `${reason.code}: ${reason.message}`
    : reason instanceof Error
      ? `${reason.name}: ${reason.message}`
      : typeof reason === "string"
        ? reason
        : "";
  return sanitizeProcessOutput(raw, ABORT_REASON_DETAIL_BUDGET);
}

export function cancellationMessage(signal: AbortSignal): string {
  const detail = describeAbortReason(signal);
  return detail === ""
    ? "Harness transport was cancelled after dispatch; completion state is unknown and requires manual replay"
    : `Harness transport was cancelled after dispatch (${detail}); completion state is unknown and requires manual replay`;
}

export function executionError(error: unknown): AdapterError {
  if (error instanceof AdapterError) return error;
  return new AdapterError("EXECUTION_FAILED", "Harness execution failed", true);
}

/**
 * Stderr byte budget kept for the harness error detail.
 */
const STDERR_DETAIL_BUDGET = 1_200;

/** Abort reasons are written by the SDK and are one line; they don't need the large budget. */
const ABORT_REASON_DETAIL_BUDGET = 300;

/**
 * What fraction of the budget is spent on the head of the text. The rest goes to the tail.
 *
 * Not symmetry for its own sake: in a long stderr the head carries the error banner and the TAIL
 * carries the root cause —last line of a stack, "caused by", the parser hint—. Truncating only
 * from the head systematically drops the useful half.
 */
const STDERR_HEAD_SHARE = 0.6;

/**
 * Sanitize process output by removing secret-like patterns and truncating.
 *
 * Redaction runs BEFORE truncation. That alone is NOT enough: raising the budget from 100 to 1200
 * bytes AND emitting the TAIL —where env and config dumps land— greatly widens what can leak,
 * and `last_error` ends up in the database, which the agents read. That's why the patterns
 * below cover the four forms the previous version let through:
 *
 *   1. `ANTHROPIC_API_KEY=…` — a `\b` before `api_key` does not anchor, because `_` is a word
 *      character and there is no boundary inside `ANTHROPIC_API_KEY`. Word prefix is admitted.
 *   2. `Authorization: Bearer sk-…` — `[^\s]+` used to swallow `Bearer` and leave the token in
 *      the clear. The scheme (Bearer/Basic/Token) is consumed before the value.
 *   3. `postgres://user:pass@host` — there was no pattern for URL credentials.
 *   4. `{"api_key":"…"}` — the quote between the key and the colon broke the pattern.
 *
 * As a final net, known credential prefixes are redacted even when they appear bare, without
 * a key naming them.
 */
export function sanitizeProcessOutput(stderr: string, maxLengthBytes: number = STDERR_DETAIL_BUDGET): string {
  if (!stderr || stderr.trim().length === 0) return "";

  const KEYWORD = String.raw`(?:api[_-]?key|api[_-]?secret|client[_-]?secret|secret|password|passwd|pwd|token|bearer|authorization|x-api-key|aws_access_key_id|aws_secret_access_key|(?:oauth|refresh|access|id)[_-]?token)`;
  // Optional word prefix (ANTHROPIC_, GITHUB_, …) and optional quotes around the key.
  const KEY = String.raw`[\w.-]*${KEYWORD}["']?`;
  // Optional HTTP scheme before the value, so we don't lose it inside `Bearer <token>`.
  const SCHEME = String.raw`(?:\s*(?:Bearer|Basic|Token|Digest))?`;

  const sanitized = stderr
    // key = value  ·  "key": "value"  ·  Authorization: Bearer <token>
    .replace(new RegExp(String.raw`${KEY}\s*[:=]${SCHEME}\s*["']?[^\s"',;}\]]+`, "gi"), "[REDACTED]")
    // credentials embedded in a URL: scheme://user:pass@host
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):[^\s@]+@/gi, "$1:[REDACTED]@")
    // known credential prefixes, even when no key names them
    .replace(/\b(?:sk-ant-|sk-proj-|sk-|ghp_|gho_|ghs_|ghu_|github_pat_|napi_|xox[baprs]-|AIza|glpat-)[A-Za-z0-9_-]{16,}/g, "[REDACTED]")
    // bare JWT (three base64url segments separated by dots)
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[REDACTED]")
    // PEM private key: the whole body is collapsed
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED]")
    .trim();

  return clampPreservingTail(sanitized, maxLengthBytes);
}

/**
 * "First N … [k omitted] … last M" truncation, which preserves both ends of the text.
 *
 * The marker is sized with `text.length` —upper bound on the digits the actual omitted count
 * can have—, so the final marker is never longer than the provisional one, and the result never
 * exceeds `maxLengthBytes`.
 */
function clampPreservingTail(text: string, maxLengthBytes: number): string {
  if (text.length <= maxLengthBytes) return text;

  const provisionalMarker = truncationMarker(text.length);
  const available = Math.max(2, maxLengthBytes - provisionalMarker.length);
  const headLength = Math.max(1, Math.floor(available * STDERR_HEAD_SHARE));
  const tailLength = Math.max(1, available - headLength);
  const omitted = text.length - headLength - tailLength;
  if (omitted <= 0) return text;

  return text.slice(0, headLength)
    + truncationMarker(omitted)
    + text.slice(text.length - tailLength);
}

function truncationMarker(omitted: number): string {
  return `\n… [${omitted} caracteres omitidos] …\n`;
}
