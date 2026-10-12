import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AliasSchema, TenantSchema, hasGovernanceSensitivePathSegment, hasUnsafeTextCodePoint, redactSecrets } from '@cauce/protocol';
import { COMPANY_ID_PATTERN } from './company-authority.js';
import { StoreError } from './repository/errors.js';

const FilePath = z.string().max(256).regex(/^(?:context|directives)\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.(?:md|txt|json|yaml|yml)$/u)
  .refine(path => !path.split('/').some(hasGovernanceSensitivePathSegment));
export const ContextFilesSchema = z.array(z.object({ path: FilePath, content: z.string().max(262_144) }).strict()).max(100)
  .superRefine((files, context) => {
    if (new Set(files.map(file => file.path)).size !== files.length) context.addIssue({ code: 'custom', message: 'duplicate context path' });
    if (files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0) > 1_048_576) context.addIssue({ code: 'custom', message: 'context size limit' });
    for (const [index, file] of files.entries()) {
      const scan = redactSecrets(file.content, { enabled: true });
      if (scan.count > 0 || scan.unscanned !== undefined || hasUnsafeTextCodePoint(file.content.replace(/[\n\r\t]/gu, ''))) {
        context.addIssue({ code: 'custom', path: [index, 'content'], message: 'unsafe context content' });
      }
    }
  });
export const ContextUpdateSchema = z.object({ expected_version: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  files: ContextFilesSchema, source: z.enum(['ui', 'cli', 'native', 'profile', 'directive']) }).strict();
export const ContextRestoreSchema = z.object({ expected_version: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict();
export const ContextNativeIngestSchema = z.object({ base_version: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  files: ContextFilesSchema }).strict();
export type ContextFile = z.infer<typeof ContextFilesSchema>[number];
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
export function canonicalContextFiles(value: unknown): ContextFile[] {
  return ContextFilesSchema.parse(value).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
export function contextDigest(files: readonly ContextFile[]): string {
  return createHash('sha256').update(JSON.stringify(canonicalContextFiles(files))).digest('hex');
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
