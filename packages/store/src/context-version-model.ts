import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { AliasSchema, TenantSchema, hasGovernanceSensitivePathSegment, hasUnsafeTextCodePoint, redactSecrets } from '@cauce/protocol';
import { COMPANY_ID_PATTERN } from './company-authority.js';
import { StoreError } from './repository/errors.js';

const MAX_FILE_CHARACTERS = 262_144;
const MAX_TOTAL_BYTES = 1_048_576;
/** Formats the shared redactor misses, aligned with SENSITIVE_CONTENT in ops/cli/space_archive.py; a version is immutable once pushed. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN (?:[A-Z0-9 ]{1,64} )?PRIVATE KEY-----/iu,
  /\bsk-[A-Za-z0-9_-]{20,}/iu,
  /\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bglpat-[A-Za-z0-9_-]{20,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|\b(?:AKIA|ASIA)[0-9A-Z]{16}\b|\bnpm_[A-Za-z0-9]{36}\b/u,
  /\baws_secret_access_key["']?\s{0,16}[:=]\s{0,16}["']?(?!\$\{)[A-Za-z0-9/+]{20,}/iu,
  /_authToken["']?\s{0,16}[:=]\s{0,16}["']?(?!\$\{)[^\s"']{8,}/iu,
  /:\/\/[^\s/:@"']{1,256}:[^\s/@"']{1,256}@/u,
  /["']?\b(?:access_token|refresh_token|client_secret|api_key|password)["']?\s{0,16}[:=]\s{0,16}["']?(?!\$\{)[^\s"']{6,}/iu,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/u,
];
const DESCRIPTOR_NAME = /^[a-z][a-z0-9_-]{0,63}\.json$/u;

function descriptorDirectory(): URL {
  const configured = process.env.CAUCE_HARNESS_DESCRIPTOR_DIRECTORY;
  if (configured !== undefined) {
    if (!isAbsolute(configured)) throw new Error('CAUCE_HARNESS_DESCRIPTOR_DIRECTORY must be an absolute path');
    return pathToFileURL(configured.endsWith('/') ? configured : `${configured}/`);
  }
  const here = import.meta.url;
  const candidates = [
    new URL('../../adapter-sdk/descriptors/', here),
    new URL('../../adapter-sdk/dist/descriptors/', here),
    new URL('../../../../packages/adapter-sdk/descriptors/', here),
    new URL('../../../../packages/adapter-sdk/dist/descriptors/', here),
  ];
  for (const candidate of candidates) {
    try {
      if (readdirSync(candidate).some((name) => DESCRIPTOR_NAME.test(name))) return candidate;
    } catch {
      // The next candidate is another layout of the same package (source, package dist, repo dist).
    }
  }
  throw new Error('packaged harness descriptors were not found');
}

/** `context.max_bytes` read from the packaged descriptors. A missing or unreadable directory refuses the limit. */
function loadHarnessContextMaxBytes(): ReadonlyMap<string, number> {
  const directory = descriptorDirectory();
  const limits = new Map<string, number>();
  for (const name of readdirSync(directory)) {
    if (!DESCRIPTOR_NAME.test(name)) continue;
    const id = name.slice(0, -5);
    const parsed: unknown = JSON.parse(readFileSync(new URL(name, directory), 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`descriptor ${id} is not an object`);
    }
    const context = 'context' in parsed ? parsed.context : undefined;
    const harness = 'harness' in parsed ? parsed.harness : undefined;
    const maxBytes = context !== null && typeof context === 'object' && 'max_bytes' in context
      ? context.max_bytes : undefined;
    if (harness !== id || typeof maxBytes !== 'number' || !Number.isSafeInteger(maxBytes)) {
      throw new Error(`descriptor ${id} has no context.max_bytes`);
    }
    limits.set(id, maxBytes);
  }
  if (limits.size === 0) throw new Error('packaged harness descriptors were not found');
  return limits;
}

const HARNESS_CONTEXT_MAX_BYTES: ReadonlyMap<string, number> = loadHarnessContextMaxBytes();
/** The only files an agent may change through native ingest: the rest of a version is governed by its operators. */
export const NATIVE_CONTEXT_WRITABLE_PREFIX = 'context/notes/';
/** Where the legacy hook versions the native document of one kind (directive, identity, tools...). */
export function nativeDocumentContextPath(kind: string): string {
  return `directives/native-${kind}.md`;
}

const StoredFilePath = z.string().max(256).regex(/^(?:context|directives)\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.(?:md|txt|json|yaml|yml)$/u);
const FilePath = StoredFilePath.refine(path => !path.split('/').some(hasGovernanceSensitivePathSegment));
function distinctPaths(files: readonly { path: string }[], context: z.RefinementCtx): void {
  if (new Set(files.map(file => file.path)).size !== files.length) context.addIssue({ code: 'custom', message: 'duplicate context path' });
}
const ContextFileSchema = z.object({ path: FilePath, content: z.string() }).strict();
const ContextFileListSchema = z.array(ContextFileSchema).max(100).superRefine(distinctPaths);
const StoredContextFileListSchema = z.array(z.object({ path: StoredFilePath, content: z.string().max(MAX_FILE_CHARACTERS) }).strict())
  .max(100).superRefine((files, context) => {
    distinctPaths(files, context);
    if (files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0) > MAX_TOTAL_BYTES) {
      context.addIssue({ code: 'custom', message: 'stored context exceeds its total size' });
    }
  });
export type ContextFile = z.infer<typeof ContextFileSchema>;
export type ContextRejectionReason = 'context_invalid_files' | 'context_too_large' | 'context_secret_detected' | 'context_unsafe_text'
  | 'context_harness_limit' | 'context_governed_path' | 'context_version_failed' | 'context_version_unreadable';
const REJECTION_MESSAGES: Readonly<Record<ContextRejectionReason, string>> = {
  context_invalid_files: 'context files have an invalid path, shape or duplicate',
  context_too_large: `context exceeds ${String(MAX_FILE_CHARACTERS)} characters in a file or ${String(MAX_TOTAL_BYTES)} bytes in total`,
  context_secret_detected: 'context contains a credential or secret and cannot be versioned',
  context_unsafe_text: 'context contains control or invisible formatting characters',
  context_harness_limit: 'context exceeds the document limit of the agent harness',
  context_governed_path: `native ingest may only change files under ${NATIVE_CONTEXT_WRITABLE_PREFIX}; profile, directives and operator context are governed`,
  context_version_failed: 'context version could not be recorded',
  context_version_unreadable: 'la versión actual no se puede leer; restaura una versión anterior desde el historial',
};
export interface ContextSizeLimit { readonly bytes: number; readonly max_bytes: number }
/** A refused version: the reason and the affected paths are safe to show, the content never travels in it. */
export class ContextRejectedError extends StoreError {
  constructor(readonly reason: ContextRejectionReason, readonly paths: readonly string[] = [], readonly limit?: ContextSizeLimit) {
    super(reason === 'context_governed_path' ? 'forbidden' : 'invalid_input', limit === undefined ? REJECTION_MESSAGES[reason]
      : `${REJECTION_MESSAGES[reason]}: ${String(limit.bytes)} bytes for a limit of ${String(limit.max_bytes)} bytes`);
    this.name = 'ContextRejectedError';
  }
}
function containsSecret(content: string): boolean {
  return redactSecrets(content, { enabled: true }).count > 0 || SECRET_PATTERNS.some(pattern => pattern.test(content));
}
function contentRejection(files: readonly ContextFile[]): ContextRejectedError | undefined {
  const large = files.filter(file => file.content.length > MAX_FILE_CHARACTERS).map(file => file.path);
  if (large.length > 0 || files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0) > MAX_TOTAL_BYTES) {
    return new ContextRejectedError('context_too_large', large);
  }
  const secrets = files.filter(file => containsSecret(file.content)).map(file => file.path);
  if (secrets.length > 0) return new ContextRejectedError('context_secret_detected', secrets);
  const unsafe = files.filter(file => hasUnsafeTextCodePoint(file.content.replace(/[\n\r\t]/gu, ''))).map(file => file.path);
  return unsafe.length > 0 ? new ContextRejectedError('context_unsafe_text', unsafe) : undefined;
}
export const ContextFilesSchema = ContextFileListSchema.superRefine((files, context) => {
  const rejection = contentRejection(files);
  if (rejection) context.addIssue({ code: 'custom', message: rejection.reason });
});
export const ContextUpdateSchema = z.object({ expected_version: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  files: ContextFileListSchema, source: z.enum(['ui', 'cli', 'native', 'profile', 'directive']) }).strict();
export const ContextRestoreSchema = z.object({ expected_version: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict();
export const ContextNativeIngestSchema = z.object({ base_version: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  files: ContextFileListSchema }).strict();
export interface ContextTarget { readonly company_id: string; readonly tenant_id: string; readonly alias: string }
export interface ContextVersion extends ContextTarget {
  readonly version: number; readonly files: readonly ContextFile[]; readonly digest: string;
  readonly source: 'ui' | 'cli' | 'native' | 'restore' | 'profile' | 'directive';
  readonly restored_from: number | null; readonly actor_human_id: string | null;
  readonly actor_alias: string; readonly created_at: string;
}
export interface ContextSync {
  readonly state: 'pending' | 'synced' | 'error'; readonly git_commit: string | null;
  readonly pushed_at: string | null; readonly last_error: string | null; readonly attempts: number;
}
export interface ContextSnapshot extends ContextTarget {
  readonly version: number; readonly desired_version: number; readonly applied_version: number;
  readonly files: readonly ContextFile[]; readonly digest: string | null; readonly sync: ContextSync;
  readonly application: { readonly state: 'pending' | 'applied' | 'error'; readonly last_error: string | null };
}
export interface ContextRuntimeSink {
  apply(version: ContextVersion): Promise<{ readonly version: number; readonly digest: string }>;
}
export interface ContextGitSink {
  commit(version: ContextVersion): Promise<string>;
  push(commit: string): Promise<void>;
}
function sortedContextFiles(files: readonly ContextFile[]): ContextFile[] {
  return files.map(file => ({ path: file.path, content: file.content })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
export function canonicalContextFiles(value: unknown): ContextFile[] {
  return sortedContextFiles(ContextFilesSchema.parse(value));
}
/**
 * A stored version was judged when written: reading it checks only its shape, sizes and digest, never the content or path
 * rules, so a stricter rule never makes history unreadable.
 */
export function storedContextFiles(value: unknown, digest: string): ContextFile[] {
  const parsed = StoredContextFileListSchema.safeParse(value);
  const files = parsed.success ? sortedContextFiles(parsed.data) : undefined;
  if (files === undefined || contextDigest(files) !== digest) throw new ContextRejectedError('context_version_unreadable');
  return files;
}
export function harnessContextMaxBytes(harness: string | null): number {
  return (harness === null ? undefined : HARNESS_CONTEXT_MAX_BYTES.get(harness)) ?? Math.min(...HARNESS_CONTEXT_MAX_BYTES.values());
}
export function harnessContextLimits(): ReadonlyMap<string, number> {
  return new Map(HARNESS_CONTEXT_MAX_BYTES);
}
/** The adapter measures this same projection before materializing a version (adapter-sdk context/space-layout.ts). */
export function contextProjectionBytes(files: readonly ContextFile[]): number {
  return Buffer.byteLength(files.map(file => `## ${file.path}\n\n${file.content}`).join('\n\n'));
}
/** Judges a candidate version and refuses it with a typed ContextRejectedError, never a ZodError. */
export function versionableContextFiles(value: unknown, maxBytes: number): ContextFile[] {
  const parsed = ContextFileListSchema.safeParse(value);
  if (!parsed.success) throw new ContextRejectedError('context_invalid_files');
  const files = sortedContextFiles(parsed.data);
  const rejection = contentRejection(files);
  if (rejection) throw rejection;
  const bytes = contextProjectionBytes(files);
  if (bytes > maxBytes) throw new ContextRejectedError('context_harness_limit', [], { bytes, max_bytes: maxBytes });
  return files;
}
export function contextDigest(files: readonly ContextFile[]): string {
  return createHash('sha256').update(JSON.stringify(sortedContextFiles(files))).digest('hex');
}
export function assertContextTarget(target: ContextTarget): void {
  if (!COMPANY_ID_PATTERN.test(target.company_id) || !TenantSchema.safeParse(target.tenant_id).success
    || !AliasSchema.safeParse(target.alias).success) throw new StoreError('invalid_input', 'invalid context target');
}
export function contextRepositoryPrefix(target: ContextTarget): string {
  assertContextTarget(target);
  return `companies/${target.company_id}/tenants/${target.tenant_id}/agents/${target.alias}`;
}
export function contextVersionDiff(before: readonly ContextFile[], after: readonly ContextFile[]): {
  path: string; before: string | null; after: string | null; change: 'added' | 'modified' | 'deleted';
}[] {
  const first = new Map(before.map(file => [file.path, file.content]));
  const second = new Map(after.map(file => [file.path, file.content]));
  return [...new Set([...first.keys(), ...second.keys()])].sort().flatMap(path => {
    const previous = first.get(path) ?? null; const next = second.get(path) ?? null;
    return previous === next ? [] : [{ path, before: previous, after: next,
      change: previous === null ? 'added' as const : next === null ? 'deleted' as const : 'modified' as const }];
  });
}
