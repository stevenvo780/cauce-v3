import {
  AGENT_PROFILE_LIST_FIELDS, AGENT_PROFILE_TEXT_FIELDS, AliasSchema, TenantSchema, hasGovernanceSensitivePathSegment,
  isValidUtf8Text, normalizeAgentProfile, redactSecrets, redactSecretsDeep, type AgentProfile,
} from '@cauce/protocol';
import { isJournalCursor } from '@cauce/store';

export const CONTEXT_REPOSITORY_LIMITS = {
  files: 256, blobBytes: 128 * 1024, totalBytes: 2 * 1024 * 1024, agents: 64,
} as const;

export interface ContextScope {
  readonly instance_id: string;
  readonly tenant_id: string;
  readonly alias: string;
}

export interface ContextSourceAgent {
  readonly tenant_id: string;
  readonly alias: string;
  readonly source_journal: { readonly id: string; readonly revision: number } | null;
}

export interface ContextManifest {
  readonly schema_version: 1 | 2;
  readonly instance_id: string;
  readonly agents: readonly ContextSourceAgent[];
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

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  requireContext(value !== null && typeof value === 'object' && !Array.isArray(value), 'invalid_schema');
  const result = value as Record<string, unknown>;
  requireContext(Object.keys(result).length === keys.length
    && keys.every((key) => Object.hasOwn(result, key)), 'invalid_schema');
  return result;
}

function identifier(value: unknown, kind: 'instance' | 'tenant' | 'alias' = 'instance'): string {
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

function parseJson(text: string): unknown {
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

function parseAgent(value: unknown, schema: 1 | 2): ContextSourceAgent {
  const input = record(value, ['tenant_id', 'alias', 'source_journal']);
  if (schema === 2) {
    requireContext(input.source_journal === null, 'invalid_provenance');
    return { tenant_id: identifier(input.tenant_id, 'tenant'), alias: identifier(input.alias, 'alias'), source_journal: null };
  }
  const journal = record(input.source_journal, ['id', 'revision']);
  requireContext(isJournalCursor(journal.id), 'invalid_journal_id');
  requireContext(typeof journal.revision === 'number' && Number.isSafeInteger(journal.revision)
    && journal.revision > 0, 'invalid_revision');
  return {
    tenant_id: identifier(input.tenant_id, 'tenant'), alias: identifier(input.alias, 'alias'),
    source_journal: { id: journal.id, revision: journal.revision },
  };
}

export function parseContextManifest(text: string): ContextManifest {
  const input = record(parseJson(text), ['schema_version', 'instance_id', 'agents']);
  requireContext(input.schema_version === 1 || input.schema_version === 2, 'unsupported_schema');
  const schema = input.schema_version;
  requireContext(Array.isArray(input.agents) && input.agents.length > 0
    && input.agents.length <= CONTEXT_REPOSITORY_LIMITS.agents, 'invalid_agents');
  const agents = input.agents.map((agent) => parseAgent(agent, schema));
  requireContext(new Set(agents.map(sourceAgentPath)).size === agents.length, 'duplicate_agent');
  return { schema_version: schema, instance_id: identifier(input.instance_id), agents };
}

function sourceAgentPath(agent: Pick<ContextSourceAgent, 'tenant_id' | 'alias'>): string {
  return `tenants/${agent.tenant_id}/agents/${agent.alias}`;
}

export function sourceProfilePath(agent: Pick<ContextSourceAgent, 'tenant_id' | 'alias'>): string {
  return `${sourceAgentPath(agent)}/profile.json`;
}

export function parseSourceProfile(text: string, agent: Pick<ContextSourceAgent, 'tenant_id' | 'alias'>): AgentProfile {
  const input = record(parseJson(text), [...AGENT_PROFILE_TEXT_FIELDS, ...AGENT_PROFILE_LIST_FIELDS]);
  try {
    return normalizeAgentProfile({ ...input, tenant_id: agent.tenant_id, alias: agent.alias });
  } catch {
    throw new ContextRepositoryError('invalid_profile');
  }
}

function authoredFields(profile: AgentProfile): Record<string, unknown> {
  return Object.fromEntries([...AGENT_PROFILE_TEXT_FIELDS, ...AGENT_PROFILE_LIST_FIELDS]
    .map((field) => [field, profile[field]]));
}

export function serializeSourceProfile(profile: AgentProfile, scope: ContextScope): string {
  validateContextScope(scope);
  requireContext(profile.tenant_id === scope.tenant_id && profile.alias === scope.alias, 'scope_unavailable');
  const normalized = parseSourceProfile(JSON.stringify(authoredFields(profile)), scope);
  return admitContextText(Buffer.from(`${JSON.stringify(authoredFields(normalized), null, 2)}\n`));
}
