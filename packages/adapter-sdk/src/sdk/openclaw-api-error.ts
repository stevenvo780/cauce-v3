import { objectRecord } from '@cauce/protocol';

function errorObject(body: string): Record<string, unknown> | undefined {
  try { return objectRecord(JSON.parse(body) as unknown); }
  catch { return undefined; }
}

export function openClawHttpAmbiguous(status: number, body: string): boolean {
  // The compatibility endpoint can return these statuses after running agent tools.
  if (status === 408 || status === 425 || status === 429 || status >= 500) return true;
  return objectRecord(errorObject(body)?.error)?.type === 'api_error';
}

/** Reports classification only; upstream bodies can contain prompts and credentials. */
export function openClawHttpDiagnostic(status: number, body: string): string {
  let message = '';
  {
    const parsed = errorObject(body);
    const error = objectRecord(parsed?.error);
    if (typeof error?.message === 'string') message = error.message;
    else if (typeof parsed?.error === 'string') message = parsed.error;
  }
  let category = 'unclassified';
  if (/\b(?:timed out|timeout)\b/iu.test(message)) category = 'upstream_timeout';
  else if (/\b(?:terminated|socket hang up|ECONNRESET|UND_ERR_SOCKET)\b/u.test(message)) category = 'upstream_stream_interrupted';
  else if (/\b(?:overloaded|temporarily unavailable)\b/iu.test(message)) category = 'upstream_unavailable';
  else if (/\b(?:context length|context window|too many tokens)\b/iu.test(message)) category = 'upstream_context_limit';
  return `HTTP ${String(status)}; category=${category}`;
}
