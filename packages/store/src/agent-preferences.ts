import {
  AgentAppearanceStyleSchema, AgentHueSchema, AliasSchema, MAX_AGENT_APPEARANCE_AUTHOR_LENGTH,
  MAX_AGENT_FAVORITES_PER_HUMAN, TenantSchema, isAgentGlyph, isAnyUuid,
  type AgentAppearance, type AgentAppearanceStyle, type AgentFavorite,
} from '@cauce/protocol';
import { withTransaction, type DatabaseClient, type DatabasePool } from './db.js';
import { StoreError } from './repository/errors.js';

/** Two-key advisory namespace: (this constant, hashtext(human_id)) serializes one human's favorite cap. */
const FAVORITE_CAP_LOCK_NAMESPACE = 783_047;

export class AgentFavoriteLimitError extends StoreError {
  readonly reason = 'favorite_limit_reached';
  constructor(readonly limit: number) {
    super('conflict', `at most ${String(limit)} favorite agents are allowed per person`);
  }
}

export class AgentAppearanceRevisionError extends StoreError {
  readonly reason = 'revision_conflict';
  constructor(readonly currentRevision: number | null) {
    super('conflict', currentRevision === null
      ? 'the agent has no stored appearance'
      : `the stored appearance is at revision ${String(currentRevision)}`);
  }
}

export interface AgentAppearanceWrite {
  readonly tenant_id: string;
  readonly alias: string;
  readonly glyph: string | null;
  readonly hue: number | null;
  readonly style: AgentAppearanceStyle;
  readonly expected_revision: number | null;
}

export interface AgentAppearanceActor {
  readonly tenant_id: string;
  readonly alias: string;
  /** Shown next to the appearance; the audit row carries the authenticated identity. */
  readonly display: string;
  readonly human_subject?: string;
}

export type AgentAppearanceDenial = 'forbidden' | 'not_found' | 'revision_conflict';

export interface AgentAppearanceDenialRecord {
  readonly target_tenant: string;
  readonly target_alias: string;
  readonly operation: 'set' | 'reset';
  readonly reason: AgentAppearanceDenial;
  readonly expected_revision?: number | null;
  readonly current_revision?: number | null;
}

export interface AgentPreferencesRepository {
  listFavorites(humanId: string, viewerTenant: string): Promise<AgentFavorite[]>;
  listAppearances(viewerTenant: string): Promise<AgentAppearance[]>;
  /** The viewer tenant decides which stored favorites still count: hidden ones yield to new ones at the cap. */
  addFavorite(humanId: string, viewerTenant: string, tenantId: string, alias: string): Promise<void>;
  removeFavorite(humanId: string, tenantId: string, alias: string): Promise<void>;
  setAppearance(input: AgentAppearanceWrite, actor: AgentAppearanceActor): Promise<AgentAppearance>;
  resetAppearance(
    tenantId: string, alias: string, expectedRevision: number, actor: AgentAppearanceActor,
  ): Promise<void>;
  recordAppearanceDenial(actor: AgentAppearanceActor, denial: AgentAppearanceDenialRecord): Promise<void>;
}

interface AppearanceRow {
  tenant_id: string;
  alias: string;
  glyph: string | null;
  hue: number | null;
  style: AgentAppearanceStyle;
  revision: string;
  updated_at: Date;
  updated_by: string;
}

const APPEARANCE_COLUMNS = 'tenant_id,alias,glyph,hue,style,revision::text AS revision,updated_at,updated_by';

/**
 * Target side of `authorizeAgentTarget(..., 'read')`: enabled target tenant, and for another tenant an
 * enabled read edge between enabled tenants with a hub endpoint. The caller asserts the viewer's own
 * read permission. `$1` is the viewer tenant.
 */
function readableBy(table: string): string {
  return `EXISTS (SELECT 1 FROM tenants target_tenant
     WHERE target_tenant.id=${table}.tenant_id AND target_tenant.enabled
       AND (${table}.tenant_id=$1 OR EXISTS (
         SELECT 1 FROM acl_edges edge
           JOIN tenants source_tenant ON source_tenant.id=edge.from_tenant
          WHERE edge.from_tenant=$1 AND edge.to_tenant=${table}.tenant_id
            AND edge.enabled AND edge.allow_read AND source_tenant.enabled
            AND (source_tenant.is_hub OR target_tenant.is_hub))))`;
}

function appearance(row: AppearanceRow): AgentAppearance {
  return {
    tenant_id: row.tenant_id,
    alias: row.alias,
    glyph: row.glyph,
    hue: row.hue,
    style: row.style,
    revision: Number(row.revision),
    updated_at: row.updated_at.toISOString(),
    updated_by: row.updated_by,
  };
}

function identity(tenantId: string, alias: string): void {
  if (!TenantSchema.safeParse(tenantId).success || !AliasSchema.safeParse(alias).success) {
    throw new StoreError('invalid_input', 'tenant or alias is invalid');
  }
}

function human(humanId: string): void {
  if (!isAnyUuid(humanId)) throw new StoreError('invalid_input', 'human id is invalid');
}

function revision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new StoreError('invalid_input', 'revision is invalid');
}

function validAppearance(input: AgentAppearanceWrite, actor: AgentAppearanceActor): void {
  identity(input.tenant_id, input.alias);
  if (input.glyph !== null && !isAgentGlyph(input.glyph)) throw new StoreError('invalid_input', 'glyph is invalid');
  if (input.hue !== null && !AgentHueSchema.safeParse(input.hue).success) {
    throw new StoreError('invalid_input', 'hue is invalid');
  }
  if (!AgentAppearanceStyleSchema.safeParse(input.style).success) throw new StoreError('invalid_input', 'style is invalid');
  if (input.expected_revision !== null) revision(input.expected_revision);
  if (actor.display.length === 0 || actor.display.length > MAX_AGENT_APPEARANCE_AUTHOR_LENGTH) {
    throw new StoreError('invalid_input', 'appearance author is invalid');
  }
}

function missingReference(error: unknown): never {
  const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (code === '23503') throw new StoreError('not_found', 'agent or person not found');
  throw error;
}

export class AgentPreferencesStore implements AgentPreferencesRepository {
  constructor(private readonly pool: DatabasePool) {}

  async listFavorites(humanId: string, viewerTenant: string): Promise<AgentFavorite[]> {
    human(humanId);
    const result = await this.pool.query<{ tenant_id: string; alias: string; created_at: Date }>(
      `SELECT favorite.tenant_id,favorite.alias,favorite.created_at
         FROM console_agent_favorites favorite
        WHERE favorite.human_id=$2 AND ${readableBy('favorite')}
        ORDER BY favorite.created_at,favorite.tenant_id,favorite.alias`,
      [viewerTenant, humanId],
    );
    return result.rows.map((row) => ({
      tenant_id: row.tenant_id, alias: row.alias, created_at: row.created_at.toISOString(),
    }));
  }

  async listAppearances(viewerTenant: string): Promise<AgentAppearance[]> {
    const result = await this.pool.query<AppearanceRow>(
      `SELECT ${APPEARANCE_COLUMNS} FROM agent_appearances look
        WHERE ${readableBy('look')} ORDER BY look.tenant_id,look.alias`,
      [viewerTenant],
    );
    return result.rows.map(appearance);
  }

  async addFavorite(humanId: string, viewerTenant: string, tenantId: string, alias: string): Promise<void> {
    human(humanId);
    identity(tenantId, alias);
    if (!TenantSchema.safeParse(viewerTenant).success) throw new StoreError('invalid_input', 'viewer tenant is invalid');
    await withTransaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1::integer, hashtext($2::text))',
        [FAVORITE_CAP_LOCK_NAMESPACE, humanId]);
      const existing = await client.query(
        'SELECT 1 FROM console_agent_favorites WHERE human_id=$1 AND tenant_id=$2 AND alias=$3',
        [humanId, tenantId, alias],
      );
      if ((existing.rowCount ?? 0) > 0) return;
      if (await favoriteCount(client, humanId) >= MAX_AGENT_FAVORITES_PER_HUMAN) {
        await client.query(
          `DELETE FROM console_agent_favorites favorite
            WHERE favorite.human_id=$2 AND NOT ${readableBy('favorite')}`,
          [viewerTenant, humanId],
        );
        if (await favoriteCount(client, humanId) >= MAX_AGENT_FAVORITES_PER_HUMAN) {
          throw new AgentFavoriteLimitError(MAX_AGENT_FAVORITES_PER_HUMAN);
        }
      }
      await client.query(
        `INSERT INTO console_agent_favorites(human_id,tenant_id,alias) VALUES($1,$2,$3)
         ON CONFLICT DO NOTHING`,
        [humanId, tenantId, alias],
      ).catch(missingReference);
    });
  }

  async removeFavorite(humanId: string, tenantId: string, alias: string): Promise<void> {
    human(humanId);
    identity(tenantId, alias);
    await this.pool.query(
      'DELETE FROM console_agent_favorites WHERE human_id=$1 AND tenant_id=$2 AND alias=$3',
      [humanId, tenantId, alias],
    );
  }

  async setAppearance(input: AgentAppearanceWrite, actor: AgentAppearanceActor): Promise<AgentAppearance> {
    validAppearance(input, actor);
    return withTransaction(this.pool, async (client) => {
      const stored = await lockedAppearance(client, input.tenant_id, input.alias);
      const current = stored === undefined ? null : Number(stored.revision);
      let written: AppearanceRow | undefined;
      if (input.expected_revision === null) {
        if (current !== null) throw new AgentAppearanceRevisionError(current);
        written = (await client.query<AppearanceRow>(
          `INSERT INTO agent_appearances(tenant_id,alias,glyph,hue,style,updated_by)
           VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING ${APPEARANCE_COLUMNS}`,
          [input.tenant_id, input.alias, input.glyph, input.hue, input.style, actor.display],
        ).catch(missingReference)).rows[0];
        if (written === undefined) {
          const raced = await lockedAppearance(client, input.tenant_id, input.alias);
          throw new AgentAppearanceRevisionError(raced === undefined ? null : Number(raced.revision));
        }
      } else {
        if (stored === undefined || current !== input.expected_revision) throw new AgentAppearanceRevisionError(current);
        if (stored.glyph === input.glyph && stored.hue === input.hue && stored.style === input.style) {
          return appearance(stored);
        }
        written = (await client.query<AppearanceRow>(
          `UPDATE agent_appearances
              SET glyph=$3,hue=$4,style=$5,updated_by=$6,revision=revision+1,updated_at=clock_timestamp()
            WHERE tenant_id=$1 AND alias=$2 AND revision=$7
            RETURNING ${APPEARANCE_COLUMNS}`,
          [input.tenant_id, input.alias, input.glyph, input.hue, input.style, actor.display, input.expected_revision],
        )).rows[0];
        if (written === undefined) throw new AgentAppearanceRevisionError(current);
      }
      const saved = appearance(written);
      await audit(client, actor, 'agent_appearance.set', 'allow', {
        target_tenant: saved.tenant_id,
        target_alias: saved.alias,
        previous_revision: current,
        revision: saved.revision,
        glyph: saved.glyph,
        hue: saved.hue,
        style: saved.style,
      });
      return saved;
    });
  }

  async resetAppearance(
    tenantId: string, alias: string, expectedRevision: number, actor: AgentAppearanceActor,
  ): Promise<void> {
    identity(tenantId, alias);
    revision(expectedRevision);
    await withTransaction(this.pool, async (client) => {
      const stored = await lockedAppearance(client, tenantId, alias);
      const current = stored === undefined ? null : Number(stored.revision);
      if (current !== expectedRevision) throw new AgentAppearanceRevisionError(current);
      await client.query('DELETE FROM agent_appearances WHERE tenant_id=$1 AND alias=$2', [tenantId, alias]);
      await audit(client, actor, 'agent_appearance.reset', 'allow', {
        target_tenant: tenantId, target_alias: alias, previous_revision: current,
      });
    });
  }

  async recordAppearanceDenial(actor: AgentAppearanceActor, denial: AgentAppearanceDenialRecord): Promise<void> {
    identity(denial.target_tenant, denial.target_alias);
    await audit(this.pool, actor, 'agent_appearance.denied', 'deny', { ...denial });
  }
}

async function favoriteCount(client: DatabaseClient, humanId: string): Promise<number> {
  const count = await client.query<{ total: number }>(
    'SELECT count(*)::integer AS total FROM console_agent_favorites WHERE human_id=$1', [humanId],
  );
  return count.rows[0]?.total ?? 0;
}

async function lockedAppearance(
  client: DatabaseClient, tenantId: string, alias: string,
): Promise<AppearanceRow | undefined> {
  return (await client.query<AppearanceRow>(
    `SELECT ${APPEARANCE_COLUMNS} FROM agent_appearances WHERE tenant_id=$1 AND alias=$2 FOR UPDATE`,
    [tenantId, alias],
  )).rows[0];
}

/**
 * The row is keyed by the actor (`tenant_id`, `actor_alias`) because the audit reader lists rows by
 * that pair; keying by the target tenant would credit the act to a same-named alias there.
 */
async function audit(
  client: Pick<DatabaseClient, 'query'>,
  actor: AgentAppearanceActor,
  action: 'agent_appearance.set' | 'agent_appearance.reset' | 'agent_appearance.denied',
  decision: 'allow' | 'deny',
  metadata: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO audit_events(tenant_id,actor_alias,action,decision,metadata)
     VALUES($1,$2,$3,$4,$5::jsonb)`,
    [actor.tenant_id, actor.alias, action, decision, JSON.stringify({
      ...metadata, ...(actor.human_subject === undefined ? {} : { human_subject: actor.human_subject }),
    })],
  );
}
