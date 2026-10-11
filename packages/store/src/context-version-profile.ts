import { normalizeAgentProfile, type AgentProfile } from '@cauce/protocol';
import type { DatabaseClient } from './db.js';
import { StoreError } from './repository/errors.js';
import type { ContextFile, ContextTarget } from './context-version-model.js';

export const CONTEXT_PROFILE_PATH = 'context/profile.json';
export async function canonicalProfileContext(client: DatabaseClient, target: ContextTarget): Promise<ContextFile | undefined> {
  const profile = (await client.query<AgentProfile>(`SELECT tenant_id,alias,purpose,role_summary,human_brief,responsibilities,
    restrictions,tools,operating_rules FROM agent_profiles WHERE tenant_id=$1 AND alias=$2`, [target.tenant_id, target.alias])).rows[0];
  return profile ? { path: CONTEXT_PROFILE_PATH, content: JSON.stringify(normalizeAgentProfile({ ...profile })) } : undefined;
}
export async function synchronizeContextProfile(client: DatabaseClient, target: ContextTarget, files: readonly ContextFile[]): Promise<ContextFile[]> {
  const supplied = files.find(file => file.path === CONTEXT_PROFILE_PATH);
  const current = await canonicalProfileContext(client, target);
  if (!supplied) return current ? [...files, current] : [...files];
  let profile: AgentProfile;
  try {
    const raw: unknown = JSON.parse(supplied.content);
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('profile must be an object');
    profile = normalizeAgentProfile(raw as Record<string, unknown>);
    if (profile.tenant_id !== target.tenant_id || profile.alias !== target.alias) throw new Error('profile target differs');
  } catch { throw new StoreError('invalid_input', 'context profile is invalid for its target'); }
  const content = JSON.stringify(profile);
  if (current?.content !== content) await client.query(`INSERT INTO agent_profiles
    (tenant_id,alias,purpose,role_summary,human_brief,responsibilities,restrictions,tools,operating_rules)
    VALUES($1,$2,$3,$4,$5,$6::text[],$7::text[],$8::text[],$9::text[])
    ON CONFLICT(tenant_id,alias) DO UPDATE SET purpose=EXCLUDED.purpose,role_summary=EXCLUDED.role_summary,
      human_brief=EXCLUDED.human_brief,responsibilities=EXCLUDED.responsibilities,restrictions=EXCLUDED.restrictions,
      tools=EXCLUDED.tools,operating_rules=EXCLUDED.operating_rules,updated_at=clock_timestamp()`,
  [target.tenant_id, target.alias, profile.purpose, profile.role_summary, profile.human_brief,
    [...profile.responsibilities], [...profile.restrictions], [...profile.tools], [...profile.operating_rules]]);
  return files.map(file => file.path === CONTEXT_PROFILE_PATH ? { path: file.path, content } : file);
}
