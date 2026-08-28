/**
 * Flattens grupos.json into one roster entry per agent, deriving `tenant_id` from the group name.
 * Throws on any malformed shape instead of silently skipping a broken entry.
 */
export function parseGroupsRoster(document) {
  if (document === null || typeof document !== 'object' || !Array.isArray(document.grupos)) {
    throw new Error('grupos.json must have a "grupos" array');
  }
  const roster = [];
  const seen = new Set();
  for (const grupo of document.grupos) {
    if (grupo === null || typeof grupo !== 'object'
      || typeof grupo.nombre !== 'string' || grupo.nombre.trim().length === 0) {
      throw new Error('every group needs a non-empty "nombre"');
    }
    const group = grupo.nombre.trim();
    if (!Array.isArray(grupo.agentes)) {
      throw new Error(`group "${group}" needs an "agentes" array`);
    }
    const tenantId = capitalizeTenant(group);
    for (const agente of grupo.agentes) {
      if (agente === null || typeof agente !== 'object'
        || typeof agente.nombre !== 'string' || agente.nombre.trim().length === 0
        || typeof agente.rol !== 'string' || agente.rol.trim().length === 0) {
        throw new Error(`group "${group}" has an agent with an invalid "nombre" or "rol"`);
      }
      const alias = agente.nombre.trim();
      const key = `${tenantId}/${alias}`;
      if (seen.has(key)) throw new Error(`duplicate alias in grupos.json: ${key}`);
      seen.add(key);
      roster.push({ tenantId, group, alias, rol: agente.rol.trim() });
    }
  }
  return roster;
}

/** `grupos.json` group names are lower-case; tenant identity capitalizes the first letter. */
export function capitalizeTenant(group) {
  return group.charAt(0).toUpperCase() + group.slice(1);
}

/** The single sentence written to `human_brief`: tenant, group and role in one line. */
export function composeHumanBrief({ tenantId, group, rol }) {
  return `Agente de ${tenantId} (grupo ${group}); rol: ${rol}`;
}

/** Read-only comparison of the current profile against the desired grupos.json role. */
export async function inspectRoster(repository, roster) {
  const rows = [];
  for (const entry of roster) {
    const stored = await repository.readWithPresence(entry.tenantId, entry.alias);
    rows.push({
      tenant_id: entry.tenantId,
      group: entry.group,
      alias: entry.alias,
      exists: stored.exists,
      revision: stored.revision,
      applied_revision: stored.applied_revision,
      current_purpose: stored.perfil.purpose,
      target_purpose: entry.rol,
      already_seeded: stored.exists && stored.perfil.purpose === entry.rol,
    });
  }
  return rows;
}

/**
 * Writes `purpose`/`human_brief` for every roster entry that already has an `agent_profiles` row,
 * preserving every other field of the stored profile and using its revision as the CAS guard.
 * An alias with no row, or whose purpose already matches, is left untouched (idempotent).
 */
export async function applyRoster(repository, roster, options = {}) {
  const actorAlias = options.actorAlias ?? 'cauce-profile-seed';
  const results = [];
  for (const entry of roster) {
    const stored = await repository.readWithPresence(entry.tenantId, entry.alias);
    if (!stored.exists) {
      results.push({ tenant_id: entry.tenantId, alias: entry.alias, status: 'skipped-no-profile-row' });
      continue;
    }
    if (stored.perfil.purpose === entry.rol) {
      results.push({
        tenant_id: entry.tenantId, alias: entry.alias, status: 'skipped-already-seeded',
        revision: stored.revision,
      });
      continue;
    }
    const input = { ...stored.perfil, purpose: entry.rol, human_brief: composeHumanBrief(entry) };
    const actor = { tenant_id: entry.tenantId, alias: actorAlias };
    try {
      const written = await repository.replace(input, stored.revision, actor);
      results.push({
        tenant_id: entry.tenantId, alias: entry.alias, status: 'written',
        previous_revision: stored.revision, revision: written.revision,
      });
    } catch (error) {
      results.push({
        tenant_id: entry.tenantId, alias: entry.alias, status: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

/** Confirms every roster entry with a profile row landed on the desired `purpose`/`human_brief`. */
export async function verifyRoster(repository, roster) {
  const rows = [];
  for (const entry of roster) {
    const stored = await repository.readWithPresence(entry.tenantId, entry.alias);
    rows.push({
      tenant_id: entry.tenantId,
      alias: entry.alias,
      exists: stored.exists,
      revision: stored.revision,
      purpose_matches: stored.exists && stored.perfil.purpose === entry.rol,
      human_brief_matches: stored.exists && stored.perfil.human_brief === composeHumanBrief(entry),
    });
  }
  return rows;
}
