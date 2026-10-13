import {
  AGENT_PROFILE_LIST_FIELDS, AGENT_PROFILE_TEXT_FIELDS, AliasSchema, TenantSchema, hasGovernanceSensitivePathSegment,
  isValidUtf8Text, normalizeAgentProfile, redactSecrets, redactSecretsDeep, type AgentProfile,
} from '@cauce/protocol';

export const CONTEXT_REPOSITORY_LIMITS = {
  files: 256, blobBytes: 128 * 1024, totalBytes: 2 * 1024 * 1024, agents: 64,
} as const;

export interface ContextScope {
  readonly instance_id: string;
  readonly tenant_id: string;
  readonly alias: string;
}

export interface ContextSourceFile {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly content: string;
}

export class ContextRepositoryError extends Error {
  constructor(readonly code: string) {
    super(`context repository: ${code}`);
    this.name = 'ContextRepositoryError';
  }
}

export function requireContext(condition: unknown, code: string): asserts condition {
  if (!condition) throw new ContextRepositoryError(code);
}

export function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  requireContext(value !== null && typeof value === 'object' && !Array.isArray(value), 'invalid_schema');
  const result = value as Record<string, unknown>;
  requireContext(Object.keys(result).length === keys.length
    && keys.every((key) => Object.hasOwn(result, key)), 'invalid_schema');
  return result;
}

export function identifier(value: unknown, kind: 'instance' | 'tenant' | 'alias' = 'instance'): string {
  if (kind !== 'instance') {
    const parsed = (kind === 'tenant' ? TenantSchema : AliasSchema).safeParse(value);
    requireContext(parsed.success, 'invalid_identifier');
    requireContext(!hasGovernanceSensitivePathSegment(parsed.data), 'forbidden_content');
    return parsed.data;
  }
  requireContext(typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/u.test(value), 'invalid_identifier');
  requireContext(!hasGovernanceSensitivePathSegment(value), 'forbidden_content');
  return value;
}

export function validateContextScope(scope: ContextScope): void {
  identifier(scope.instance_id);
  identifier(scope.tenant_id, 'tenant');
  identifier(scope.alias, 'alias');
}

export function admitContextText(bytes: Buffer): string {
  requireContext(bytes.length <= CONTEXT_REPOSITORY_LIMITS.blobBytes, 'size_limit');
  requireContext(isValidUtf8Text(bytes), 'invalid_text');
  const text = bytes.toString('utf8');
  assertNoRecognizedSecrets(text);
  return text;
}

function assertNoRecognizedSecrets(text: string): void {
  const scan = redactSecrets(text, { enabled: true });
  requireContext(scan.count === 0 && scan.unscanned === undefined, 'forbidden_content');
}

export function parseJson(text: string): unknown {
  try {
    admitContextText(Buffer.from(text, 'utf8'));
    const result: unknown = JSON.parse(text);
    rejectDuplicateKeys(text);
    const scan = redactSecretsDeep(result, { enabled: true });
    requireContext(scan.count === 0 && scan.unscanned === undefined, 'forbidden_content');
    return result;
  } catch (error) {
    if (error instanceof ContextRepositoryError) throw error;
    throw new ContextRepositoryError('invalid_json');
  }
}

function rejectDuplicateKeys(text: string): void {
  const scopes: (Set<string> | null)[] = [];
  for (const token of text.matchAll(/"(?:\\.|[^"\\])*"|[{}]|\[|\]/gu)) {
    const value = token[0];
    if (value === '{') scopes.push(new Set());
    else if (value === '[') scopes.push(null);
    else if (value === '}' || value === ']') scopes.pop();
    else if (/^\s*:/u.test(text.slice(token.index + value.length))) {
      const key: unknown = JSON.parse(value);
      const current = scopes.at(-1);
      requireContext(typeof key === 'string' && current !== undefined && current !== null, 'invalid_json');
      requireContext(!current.has(key), 'duplicate_json_key');
      current.add(key);
    }
  }
}

function sourceAgentPath(agent: Pick<ContextScope, 'tenant_id' | 'alias'>): string {
  return `tenants/${agent.tenant_id}/agents/${agent.alias}`;
}

export function sourceProfilePath(agent: Pick<ContextScope, 'tenant_id' | 'alias'>): string {
  return `${sourceAgentPath(agent)}/profile.json`;
}

export function parseSourceProfile(text: string, agent: Pick<ContextScope, 'tenant_id' | 'alias'>): AgentProfile {
  const input = record(parseJson(text), [...AGENT_PROFILE_TEXT_FIELDS, ...AGENT_PROFILE_LIST_FIELDS]);
  try {
    return normalizeAgentProfile({ ...input, tenant_id: agent.tenant_id, alias: agent.alias });
  } catch {
    throw new ContextRepositoryError('invalid_profile');
  }
}
