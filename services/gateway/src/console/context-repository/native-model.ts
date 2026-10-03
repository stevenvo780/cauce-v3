import {
  CONTEXT_REPOSITORY_LIMITS, identifier, parseJson, record, requireContext, sourceProfilePath,
} from './model.js';

export type NativeContextHarness = 'claude' | 'codex' | 'openclaw';

export interface NativeContextSourceAgent {
  readonly tenant_id: string;
  readonly alias: string;
  readonly source_journal: null;
  readonly native_manual: { readonly harness: NativeContextHarness };
}

export interface NativeContextManifest {
  readonly schema_version: 3;
  readonly instance_id: string;
  readonly agents: readonly NativeContextSourceAgent[];
}

function parseAgent(value: unknown): NativeContextSourceAgent {
  const input = record(value, ['tenant_id', 'alias', 'source_journal', 'native_manual']);
  requireContext(input.source_journal === null, 'invalid_provenance');
  const { harness } = record(input.native_manual, ['harness']);
  requireContext(harness === 'claude' || harness === 'codex' || harness === 'openclaw', 'unsupported_harness');
  return { tenant_id: identifier(input.tenant_id, 'tenant'), alias: identifier(input.alias, 'alias'),
    source_journal: null, native_manual: { harness } };
}

export function parseNativeContextManifest(text: string): NativeContextManifest {
  const input = record(parseJson(text), ['schema_version', 'instance_id', 'agents']);
  requireContext(input.schema_version === 3, 'unsupported_schema');
  requireContext(Array.isArray(input.agents) && input.agents.length > 0
    && input.agents.length <= CONTEXT_REPOSITORY_LIMITS.agents, 'invalid_agents');
  const agents = input.agents.map(parseAgent);
  requireContext(new Set(agents.map(sourceProfilePath)).size === agents.length, 'duplicate_agent');
  return { schema_version: 3, instance_id: identifier(input.instance_id), agents };
}

export function sourceNativeManualPath(agent: NativeContextSourceAgent): string {
  const harness = agent.native_manual.harness;
  return `tenants/${agent.tenant_id}/agents/${agent.alias}/native/${harness}/${harness === 'claude' ? 'CLAUDE.md' : 'AGENTS.md'}`;
}
