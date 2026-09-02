import { hasUnsafeTextCodePoint } from './content-safety.js';

export const GOVERNANCE_NEVER_SERVE_BASENAMES: readonly string[] = [
  '.credentials.json',
  'auth.json',
  '.claude.json',
  'openclaw.json',
  '.env',
  '.netrc',
  'id_ed25519',
  'id_rsa',
  'known_hosts',
  'authorized_keys',
];

export const GOVERNANCE_NEVER_SERVE_SUFFIXES: readonly string[] = [
  '.pem',
  '.key',
  '.p12',
  '.pfx',
];

export const MAX_CODEX_PROJECT_DOC_BYTES = 16 * 1024 * 1024;
export const MAX_CODEX_PROJECT_DOC_FALLBACKS = 16;

export type GovernanceSensitiveBasenameKind = 'forbidden_basename' | 'credential_suffix';

export function governanceSensitiveBasenameKind(
  value: string,
): GovernanceSensitiveBasenameKind | undefined {
  const normalized = value.toLowerCase();
  if (GOVERNANCE_NEVER_SERVE_BASENAMES.includes(normalized)) return 'forbidden_basename';
  if (GOVERNANCE_NEVER_SERVE_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) {
    return 'credential_suffix';
  }
  return undefined;
}

export function hasGovernanceSensitivePathSegment(path: string): boolean {
  return path.split('/').some((segment) => governanceSensitiveBasenameKind(segment) !== undefined);
}

export interface CodexProjectDocumentConfig {
  readonly maxBytes: number;
  readonly fallbackFilenames: readonly string[];
}

export interface RawCodexProjectDocumentConfig {
  readonly harness: unknown;
  readonly maxBytes: unknown;
  readonly fallbackFilenames: unknown;
}

function validFallbackFilename(value: string): boolean {
  return value.length > 0 && value.length <= 128 && !value.includes('/') && !value.includes('\\')
    && !value.includes('..') && !hasUnsafeTextCodePoint(value)
    && governanceSensitiveBasenameKind(value) === undefined;
}

export function parseCodexProjectDocumentConfig(
  input: RawCodexProjectDocumentConfig,
): CodexProjectDocumentConfig | undefined {
  const { harness, maxBytes, fallbackFilenames } = input;
  if (harness !== 'codex' || typeof maxBytes !== 'number' || !Number.isSafeInteger(maxBytes)
      || maxBytes < 1 || maxBytes > MAX_CODEX_PROJECT_DOC_BYTES
      || !Array.isArray(fallbackFilenames)
      || fallbackFilenames.length > MAX_CODEX_PROJECT_DOC_FALLBACKS) return undefined;
  const seen = new Set<string>(['agents.override.md', 'agents.md']);
  const accepted: string[] = [];
  for (const candidate of fallbackFilenames) {
    if (typeof candidate !== 'string' || !validFallbackFilename(candidate)) return undefined;
    const normalized = candidate.toLowerCase();
    if (seen.has(normalized)) return undefined;
    seen.add(normalized);
    accepted.push(candidate);
  }
  return { maxBytes, fallbackFilenames: accepted };
}
