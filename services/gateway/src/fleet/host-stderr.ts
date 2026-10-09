export const MAX_STDERR_BYTES = 4096;
const REDACTED = '[redacted]';
const PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(?:-----END [A-Z0-9 ]+-----|$)/gu, REDACTED],
  [/\bbearer\s+[^\s"']+/giu, `Bearer ${REDACTED}`],
  [/\b((?:pass(?:word|wd)?|secret|token|api[_-]?key)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s"',;]+)/giu, `$1${REDACTED}`],
  [/[A-Za-z0-9+/]{33,}={0,2}/gu, REDACTED],
  [/\b[0-9a-f]{33,}\b/giu, REDACTED],
];

export class BoundedTail {
  private tail = Buffer.alloc(0);
  push(chunk: Buffer): void {
    this.tail = Buffer.concat([this.tail, chunk]);
    if (this.tail.byteLength > MAX_STDERR_BYTES) this.tail = this.tail.subarray(this.tail.byteLength - MAX_STDERR_BYTES);
  }
  text(): string { return this.tail.toString('utf8'); }
}

export function redactExecutorStderr(text: string): string {
  let redacted = text;
  for (const [pattern, replacement] of PATTERNS) redacted = redacted.replace(pattern, replacement);
  return redacted.replace(/[\p{Cc}\s]+/gu, ' ').trim();
}

export function logHostCommandFailure(step: string, code: number | null, stderr: string): void {
  console.error(`fleet host command failed step=${step} exit=${code === null ? 'signal' : String(code)} stderr=${redactExecutorStderr(stderr)}`);
}
