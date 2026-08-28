/** Duck-typed slice of `AgentProfile` this module reads and writes; matches `@cauce/protocol`. */
export interface AgentProfileLike {
  tenant_id: string;
  alias: string;
  purpose: string | null;
  role_summary: string | null;
  human_brief: string | null;
  responsibilities: readonly string[];
  restrictions: readonly string[];
  tools: readonly string[];
  operating_rules: readonly string[];
}

export interface StoredAgentProfileLike {
  perfil: AgentProfileLike;
  exists: boolean;
  revision: number | null;
  applied_revision: number | null;
}

/** Duck-typed slice of `AgentProfileRepository` this module calls. */
export interface AgentProfileRepositoryLike {
  readWithPresence(tenantId: string, alias: string): Promise<StoredAgentProfileLike>;
  replace(
    input: AgentProfileLike | Record<string, unknown>,
    expectedRevision: number | null,
    actor: { tenant_id: string; alias: string },
  ): Promise<StoredAgentProfileLike & { revision: number }>;
}

export interface GroupsRosterEntry {
  tenantId: string;
  group: string;
  alias: string;
  rol: string;
}

export function parseGroupsRoster(document: unknown): GroupsRosterEntry[];
export function capitalizeTenant(group: string): string;
export function composeHumanBrief(entry: Pick<GroupsRosterEntry, 'tenantId' | 'group' | 'rol'>): string;

export interface InspectRow {
  tenant_id: string;
  group: string;
  alias: string;
  exists: boolean;
  revision: number | null;
  applied_revision: number | null;
  current_purpose: string | null;
  target_purpose: string;
  already_seeded: boolean;
}

export function inspectRoster(
  repository: AgentProfileRepositoryLike,
  roster: readonly GroupsRosterEntry[],
): Promise<InspectRow[]>;

export type ApplyRow =
  | { tenant_id: string; alias: string; status: 'skipped-no-profile-row' }
  | { tenant_id: string; alias: string; status: 'skipped-already-seeded'; revision: number | null }
  | { tenant_id: string; alias: string; status: 'written'; previous_revision: number | null; revision: number }
  | { tenant_id: string; alias: string; status: 'error'; message: string };

export function applyRoster(
  repository: AgentProfileRepositoryLike,
  roster: readonly GroupsRosterEntry[],
  options?: { actorAlias?: string },
): Promise<ApplyRow[]>;

export interface VerifyRow {
  tenant_id: string;
  alias: string;
  exists: boolean;
  revision: number | null;
  purpose_matches: boolean;
  human_brief_matches: boolean;
}

export function verifyRoster(
  repository: AgentProfileRepositoryLike,
  roster: readonly GroupsRosterEntry[],
): Promise<VerifyRow[]>;
