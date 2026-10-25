import { readFile } from 'node:fs/promises';
import type { FastifyRequest } from 'fastify';
import { hubStarRouteSql, type DatabaseClient, type DatabasePool } from '@cauce/store';
import type { Principal } from '../auth.js';
import { scalarHeaderValue } from '../http-auth-primitives.js';
import type { TerminalConfig } from './config.js';
import {
  UNATTRIBUTED_OPERATOR, isTerminalMode, isWritableMode,
  type FleetIdentity, type FleetPlacement, type TerminalMode,
} from './types.js';

/**
 * Every authorization input of the PTY plane lives here: the grants file, the routing
 * authority replicated from the publish path, the fixed alias->container map and the
 * operator attribution invariant.
 */

/* -------------------------------------------------------------------------- */
/* Fleet placement                                                            */
/* -------------------------------------------------------------------------- */

interface FleetPlacementRow {
  readonly tenant_id: string;
  readonly alias: string;
  readonly container_name: string | null;
  readonly runtime_user: string | null;
  readonly company_id: string;
  readonly host_id: string | null;
}

export interface CompanyFleetPlacement extends FleetPlacement {
  readonly company_id: string;
  readonly host_id: string | null;
}

/**
 * PostgreSQL is the live registry and the only source used to authorize a browser request.
 * The declarative ops inventory is compared against it by the release parity gate; copying that
 * inventory into compiled gateway code created a third, stale authority and made same aliases in
 * different tenants impossible to represent.
 */
export async function loadFleetPlacements(
  database: DatabasePool | DatabaseClient,
): Promise<readonly CompanyFleetPlacement[]> {
  const result = await database.query<FleetPlacementRow>(
    `SELECT tenant_id,alias,container_name,runtime_user,company_id,host_id
       FROM agents
      WHERE enabled
      ORDER BY tenant_id,alias`
  );
  return result.rows.map((row) => {
    if (!row.tenant_id || !row.alias || !row.container_name || !row.runtime_user) {
      throw new Error(`enabled agent has incomplete placement: ${row.tenant_id}:${row.alias}`);
    }
    return {
      tenant_id: row.tenant_id,
      alias: row.alias,
      container: row.container_name,
      runtime_user: row.runtime_user,
      company_id: row.company_id,
      host_id: row.host_id
    };
  });
}

export function fleetPlacement<Placement extends FleetPlacement>(
  placements: readonly Placement[], tenantId: string, alias: string
): Placement | undefined {
  return placements.find((entry) => entry.tenant_id === tenantId && entry.alias === alias);
}

/**
 * Every alias of the company sharing the requested alias' container and host, itself included; a
 * hostless agent may run on any host of its company, so it widens a cohort and never splits one.
 * SET RULE: authorizing target X requires routing authority AND a grant over EVERY member of X's
 * cohort: a shell in a shared container sees every co-located agent directory.
 */
export function containerCohort(
  placements: readonly CompanyFleetPlacement[], tenantId: string, alias: string
): CompanyFleetPlacement[] {
  const placement = fleetPlacement(placements, tenantId, alias);
  if (!placement) return [];
  return placements
    .filter((entry) => entry.company_id === placement.company_id && entry.container === placement.container
      && (entry.host_id === null || placement.host_id === null || entry.host_id === placement.host_id))
    .sort((left, right) => `${left.tenant_id}\0${left.alias}`.localeCompare(`${right.tenant_id}\0${right.alias}`));
}

export function fleetIdentity(placement: FleetPlacement): FleetIdentity {
  return { tenant_id: placement.tenant_id, alias: placement.alias };
}

export function fleetIdentityLabel(placement: FleetIdentity): string {
  return `${placement.tenant_id}:${placement.alias}`;
}

/* -------------------------------------------------------------------------- */
/* Grants file                                                                */
/* -------------------------------------------------------------------------- */

interface TerminalGrant {
  readonly operator: string;
  readonly tenant_id: string;
  readonly alias: string;
  readonly modes: readonly string[];
  readonly note?: string;
}

const GRANTS_CACHE_MS = 1_000;
const GRANTS_LOG_INTERVAL_MS = 60_000;

function parseGrants(raw: string): TerminalGrant[] {
  const decoded: unknown = JSON.parse(raw);
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new Error('grants document must be an object');
  }
  const document = decoded as Record<string, unknown>;
  if (document.version !== 1 || !Array.isArray(document.grants)) throw new Error('grants document is invalid');
  return document.grants.map((value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('grant is not an object');
    const grant = value as Record<string, unknown>;
    if (typeof grant.operator !== 'string' || grant.operator.length === 0 ||
        typeof grant.tenant_id !== 'string' || grant.tenant_id.length === 0 ||
        typeof grant.alias !== 'string' || grant.alias.length === 0 ||
        !Array.isArray(grant.modes) || grant.modes.some((mode) => typeof mode !== 'string')) {
      throw new Error('grant fields are invalid');
    }
    if (grant.operator === '*' && grant.modes.some(
      (mode) => isTerminalMode(mode) && isWritableMode(mode))) {
      throw new Error('wildcard operator cannot hold a writable mode');
    }
    if (grant.operator === '*' && grant.alias === '*') throw new Error('wildcard operator cannot hold a wildcard alias');
    return {
      operator: grant.operator,
      tenant_id: grant.tenant_id,
      alias: grant.alias,
      modes: grant.modes as string[],
      ...(typeof grant.note === 'string' ? { note: grant.note } : {})
    };
  });
}

/**
 * Reads grants.json on every request. The file is rotated by atomic rename onto a bind mount
 * (same shape as mtls_identities.json), so a 1 s cache is the whole budget: emptying the file
 * must shut the door in under a second without restarting anything.
 * Missing, unreadable or invalid file = ZERO grants. Fail closed, logged once per minute.
 */
/** Database half of the grants union: a live row of `terminal_grants` for this operator. */
export type DatabaseGrantChecker = (
  operatorId: string, tenantId: string, alias: string, mode: TerminalMode,
) => Promise<boolean>;

export class GrantStore {
  private cached: { grants: TerminalGrant[]; loadedAt: number } | undefined;
  private lastFailureLogAt: number | undefined;
  private lastDatabaseFailureLogAt: number | undefined;

  constructor(
    private readonly path: string,
    private readonly onFailure: (message: string) => void = () => undefined,
    private readonly databaseGrants?: DatabaseGrantChecker,
  ) {}

  /** Same sources with an empty file cache, so a revocation has no cache window. */
  cloneFresh(): GrantStore {
    return new GrantStore(this.path, this.onFailure, this.databaseGrants);
  }

  private async databaseAllows(
    operatorId: string, tenantId: string, alias: string, mode: TerminalMode, now: number,
  ): Promise<boolean> {
    if (this.databaseGrants === undefined) return false;
    try {
      return await this.databaseGrants(operatorId, tenantId, alias, mode);
    } catch (error) {
      if (this.lastDatabaseFailureLogAt === undefined
        || now - this.lastDatabaseFailureLogAt >= GRANTS_LOG_INTERVAL_MS) {
        this.lastDatabaseFailureLogAt = now;
        this.onFailure(
          `terminal grants database is unavailable, denying its PTY targets: ${
            error instanceof Error ? error.message : 'unknown error'}`);
      }
      return false;
    }
  }

  async grants(now: number = Date.now()): Promise<TerminalGrant[]> {
    if (this.cached && now - this.cached.loadedAt < GRANTS_CACHE_MS) return this.cached.grants;
    try {
      const grants = parseGrants(await readFile(this.path, 'utf8'));
      this.cached = { grants, loadedAt: now };
      return grants;
    } catch (error) {
      this.cached = { grants: [], loadedAt: now };
      if (this.lastFailureLogAt === undefined || now - this.lastFailureLogAt >= GRANTS_LOG_INTERVAL_MS) {
        this.lastFailureLogAt = now;
        this.onFailure(
          `terminal grants file is unavailable or invalid, denying every PTY target: ${this.path} (${
            error instanceof Error ? error.message : 'unknown error'})`
        );
      }
      return [];
    }
  }

  /**
   * A grant matches on the exact operator, or via '*' when the mode is read-only. Alias '*' covers every
   * agent of that tenant (exact operator only), so agents created later from the console get a terminal
   * without editing this file; the tenant still has to match exactly.
   *
   * Union with the database: either source admitting is enough, so a row of `terminal_grants`
   * never revokes what the file grants and emptying the file never revokes a database row.
   * Fully closing the plane therefore clears both sources (docs/terminal-pty.md §3).
   */
  async allows(
    operatorId: string, tenantId: string, alias: string, mode: TerminalMode, now: number = Date.now()
  ): Promise<boolean> {
    const fromFile = (await this.grants(now)).some((grant) =>
      (grant.operator === operatorId || (grant.operator === '*' && !isWritableMode(mode))) &&
      grant.tenant_id === tenantId && (grant.alias === alias || (grant.alias === '*' && grant.operator === operatorId))
      && grant.modes.includes(mode));
    return fromFile || this.databaseAllows(operatorId, tenantId, alias, mode, now);
  }

  /** Cohort form of `allows`: every alias sharing the container must be granted. */
  async allowsCohort(
    operatorId: string, cohort: readonly FleetIdentity[], mode: TerminalMode, now: number = Date.now()
  ): Promise<boolean> {
    if (cohort.length === 0) return false;
    for (const member of cohort) {
      if (!(await this.allows(operatorId, member.tenant_id, member.alias, mode, now))) return false;
    }
    return true;
  }
}

/* -------------------------------------------------------------------------- */
/* Routing authority                                                          */
/* -------------------------------------------------------------------------- */

export interface RoutingAuthority {
  readonly allowed: boolean;
  readonly reason: string;
  readonly source_room_ids: string[];
}

interface RoomSideRow {
  side: 'actor' | 'target';
  room_id: string;
}

interface EdgeRow {
  ok: boolean;
}

/**
 * Read-only replica of the rule that already authorizes publishing to an agent. Same-tenant
 * needs a shared enabled room with both memberships enabled and tenant/room enabled;
 * cross-tenant additionally needs acl_edges(from->to) with enabled AND allow_route AND
 * allow_control that the company star (across companies, a live link) admits. Nothing here writes.
 */
export async function routingAuthority(
  pool: DatabasePool | DatabaseClient,
  actorTenant: string,
  actorAlias: string,
  targetTenant: string,
  targetAlias: string,
  humanId?: string,
): Promise<RoutingAuthority> {
  const rooms = await pool.query<RoomSideRow>(
    `SELECT 'actor'::text AS side, room.id AS room_id
       FROM memberships membership
       JOIN rooms room ON room.id=membership.room_id AND room.tenant_id=membership.tenant_id
       JOIN tenants tenant ON tenant.id=membership.tenant_id
      WHERE membership.tenant_id=$1 AND membership.alias=$2
        AND membership.enabled AND room.enabled AND tenant.enabled
        AND (($5::uuid IS NULL AND EXISTS (
          SELECT 1 FROM agents agent
          WHERE agent.tenant_id=membership.tenant_id AND agent.alias=membership.alias AND agent.enabled
        )) OR ($5::uuid IS NOT NULL AND EXISTS (
          SELECT 1 FROM console_users person
          JOIN human_tenant_memberships human ON human.human_id=person.id
            AND human.tenant_id=person.tenant_id AND human.actor_alias=person.alias
          JOIN companies company ON company.id=tenant.company_id
          WHERE person.id=$5 AND person.active AND person.role='operator'
            AND person.tenant_id=membership.tenant_id AND person.alias=membership.alias
            AND human.enabled AND human.revoked_at IS NULL AND 'control'=ANY(human.permissions)
            AND tenant.retired_at IS NULL AND company.enabled AND company.retired_at IS NULL
        )))
     UNION ALL
     SELECT 'target'::text AS side, room.id AS room_id
       FROM memberships membership
       JOIN rooms room ON room.id=membership.room_id AND room.tenant_id=membership.tenant_id
       JOIN tenants tenant ON tenant.id=membership.tenant_id
       JOIN agents agent ON agent.tenant_id=membership.tenant_id AND agent.alias=membership.alias
      WHERE membership.tenant_id=$3 AND membership.alias=$4
        AND membership.enabled AND room.enabled AND tenant.enabled AND agent.enabled`,
    [actorTenant, actorAlias, targetTenant, targetAlias, humanId ?? null]
  );
  const actorRooms = rooms.rows.filter((row) => row.side === 'actor').map((row) => row.room_id);
  const targetRooms = new Set(rooms.rows.filter((row) => row.side === 'target').map((row) => row.room_id));
  if (actorRooms.length === 0) {
    return { allowed: false, reason: 'actor_not_routable', source_room_ids: [] };
  }
  if (targetRooms.size === 0) {
    return { allowed: false, reason: 'target_not_routable', source_room_ids: [] };
  }
  if (actorTenant === targetTenant) {
    const shared = [...new Set(actorRooms.filter((room) => targetRooms.has(room)))].sort();
    if (shared.length === 0) return { allowed: false, reason: 'no_shared_room', source_room_ids: [] };
    return { allowed: true, reason: 'same_tenant_room', source_room_ids: shared };
  }
  const edge = await pool.query<EdgeRow>(
    `SELECT true AS ok FROM acl_edges edge
       JOIN tenants source ON source.id=edge.from_tenant
       JOIN tenants target ON target.id=edge.to_tenant
      WHERE edge.from_tenant=$1 AND edge.to_tenant=$2 AND edge.enabled AND edge.allow_route AND edge.allow_control
        AND ${hubStarRouteSql('source', 'target')} LIMIT 1`,
    [actorTenant, targetTenant]
  );
  if (edge.rows.length === 0) {
    return { allowed: false, reason: 'acl_edge_missing', source_room_ids: [] };
  }
  return { allowed: true, reason: 'acl_edge', source_room_ids: [...new Set(actorRooms)].sort() };
}

/** Cohort form: routing authority is required over every alias sharing the container. */
export async function cohortRoutingAuthority(
  pool: DatabasePool | DatabaseClient,
  actorTenant: string,
  actorAlias: string,
  cohort: readonly FleetIdentity[],
  humanId?: string,
): Promise<RoutingAuthority> {
  if (cohort.length === 0) return { allowed: false, reason: 'unknown_alias', source_room_ids: [] };
  const roomIds = new Set<string>();
  for (const member of cohort) {
    const decision = await routingAuthority(pool, actorTenant, actorAlias, member.tenant_id, member.alias, humanId);
    if (!decision.allowed) {
      return { allowed: false, reason: `${decision.reason}:${fleetIdentityLabel(member)}`, source_room_ids: [] };
    }
    for (const room of decision.source_room_ids) roomIds.add(room);
  }
  return { allowed: true, reason: 'cohort_authorized', source_room_ids: [...roomIds].sort() };
}

/* -------------------------------------------------------------------------- */
/* Operator attribution                                                       */
/* -------------------------------------------------------------------------- */

export interface ResolvedOperator {
  readonly operator_id: string;
  readonly attributed: boolean;
}

/**
 * Who the person is, in order of authority.
 *
 * 1. `actor.operator_id`, if the auth provider set it. This is the console password login case:
 *    it comes from the verified JWT and the `console_users` row, i.e. from the server. When it
 *    exists, it WINS and the header is not even read — the address does not need to be in
 *    `CAUCE_TERMINAL_OPERATORS`, because having a session is already enrollment.
 * 2. The `CAUCE_TERMINAL_OPERATOR_HEADER` header, only from the `console` channel and only with a
 *    value enrolled in `CAUCE_TERMINAL_OPERATORS`.
 * 3. With neither, the session remains unattributed and `attributionAllows` confines it to its
 *    own tenant.
 */
export type OperatorResolution = Pick<TerminalConfig, 'operatorHeader' | 'operators'>;

export function resolveOperator(
  request: FastifyRequest, actor: Principal, config: OperatorResolution
): ResolvedOperator {
  if (actor.operator_id !== undefined && actor.operator_id.length > 0) {
    return { operator_id: actor.operator_id, attributed: true };
  }
  if (actor.channel !== 'console') return { operator_id: UNATTRIBUTED_OPERATOR, attributed: false };
  const declared = scalarHeaderValue(request.headers[config.operatorHeader])?.trim();
  if (declared === undefined || declared.length === 0 || !config.operators.has(declared)) {
    return { operator_id: UNATTRIBUTED_OPERATOR, attributed: false };
  }
  return { operator_id: declared, attributed: true };
}

/**
 * HARD INVARIANT: without a human identity a session may only target the actor's own tenant.
 * Reaching another tenant's agent with the shared basic-auth credential would make the audit
 * trail unattributable, so it is refused with `attribution_required`.
 */
export function attributionAllows(attributed: boolean, actorTenant: string, targetTenant: string): boolean {
  return attributed || actorTenant === targetTenant;
}

/** TUI-08, decided here and nowhere else: `UNATTRIBUTED_OPERATOR` never opens a writable mode. */
export function writableModeRequiresAttribution(mode: TerminalMode, attributed: boolean): boolean {
  return isWritableMode(mode) && !attributed;
}
