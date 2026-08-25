import { readFile } from 'node:fs/promises';
import type { FastifyRequest } from 'fastify';
import type { DatabasePool } from '@cauce/store';
import type { Principal } from '../auth.js';
import type { TerminalConfig } from './config.js';
import { UNATTRIBUTED_OPERATOR, type FleetIdentity, type FleetPlacement, type TerminalMode } from './types.js';

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
}

/**
 * PostgreSQL is the live registry and the only source used to authorize a browser request.
 * The declarative ops inventory is compared against it by the release parity gate; copying that
 * inventory into compiled gateway code created a third, stale authority and made same aliases in
 * different tenants impossible to represent.
 */
export async function loadFleetPlacements(pool: DatabasePool): Promise<readonly FleetPlacement[]> {
  const result = await pool.query<FleetPlacementRow>(
    `SELECT tenant_id,alias,container_name,runtime_user
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
      runtime_user: row.runtime_user
    };
  });
}

export function fleetPlacement(
  placements: readonly FleetPlacement[], tenantId: string, alias: string
): FleetPlacement | undefined {
  return placements.find((entry) => entry.tenant_id === tenantId && entry.alias === alias);
}

/**
 * Every alias sharing the requested alias' container, including the alias itself.
 *
 * SET RULE: authorizing target X requires routing authority AND a grant over EVERY member of
 * X's cohort. A shell in ws-humanizar sees the home of Miguel's three agents, so authority
 * over `iza` alone must not open `atlas` by the back door.
 */
export function containerCohort(
  placements: readonly FleetPlacement[], tenantId: string, alias: string
): FleetPlacement[] {
  const placement = fleetPlacement(placements, tenantId, alias);
  if (!placement) return [];
  return placements
    .filter((entry) => entry.container === placement.container)
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

export interface TerminalGrant {
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
 *
 * Missing, unreadable or invalid file = ZERO grants. Fail closed, logged once per minute.
 */
export class GrantStore {
  private cached: { grants: TerminalGrant[]; loadedAt: number } | undefined;
  private lastFailureLogAt: number | undefined;

  constructor(
    private readonly path: string,
    private readonly onFailure: (message: string) => void = () => undefined
  ) {}

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

  /** A grant matches when the operator matches exactly or via '*', and the mode is listed. */
  async allows(
    operatorId: string, tenantId: string, alias: string, mode: TerminalMode, now: number = Date.now()
  ): Promise<boolean> {
    return (await this.grants(now)).some((grant) =>
      (grant.operator === '*' || grant.operator === operatorId) &&
      grant.tenant_id === tenantId && grant.alias === alias && grant.modes.includes(mode));
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
 * allow_control. Nothing here writes: it is safe against production.
 */
export async function routingAuthority(
  pool: DatabasePool,
  actorTenant: string,
  actorAlias: string,
  targetTenant: string,
  targetAlias: string
): Promise<RoutingAuthority> {
  const rooms = await pool.query<RoomSideRow>(
    `SELECT 'actor'::text AS side, room.id AS room_id
       FROM memberships membership
       JOIN rooms room ON room.id=membership.room_id AND room.tenant_id=membership.tenant_id
       JOIN tenants tenant ON tenant.id=membership.tenant_id
       JOIN agents agent ON agent.tenant_id=membership.tenant_id AND agent.alias=membership.alias
      WHERE membership.tenant_id=$1 AND membership.alias=$2
        AND membership.enabled AND room.enabled AND tenant.enabled AND agent.enabled
     UNION ALL
     SELECT 'target'::text AS side, room.id AS room_id
       FROM memberships membership
       JOIN rooms room ON room.id=membership.room_id AND room.tenant_id=membership.tenant_id
       JOIN tenants tenant ON tenant.id=membership.tenant_id
       JOIN agents agent ON agent.tenant_id=membership.tenant_id AND agent.alias=membership.alias
      WHERE membership.tenant_id=$3 AND membership.alias=$4
        AND membership.enabled AND room.enabled AND tenant.enabled AND agent.enabled`,
    [actorTenant, actorAlias, targetTenant, targetAlias]
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
    `SELECT true AS ok FROM acl_edges
      WHERE from_tenant=$1 AND to_tenant=$2 AND enabled AND allow_route AND allow_control LIMIT 1`,
    [actorTenant, targetTenant]
  );
  if (edge.rows.length === 0) {
    return { allowed: false, reason: 'acl_edge_missing', source_room_ids: [] };
  }
  return { allowed: true, reason: 'acl_edge', source_room_ids: [...new Set(actorRooms)].sort() };
}

/** Cohort form: routing authority is required over every alias sharing the container. */
export async function cohortRoutingAuthority(
  pool: DatabasePool,
  actorTenant: string,
  actorAlias: string,
  cohort: readonly FleetIdentity[]
): Promise<RoutingAuthority> {
  if (cohort.length === 0) return { allowed: false, reason: 'unknown_alias', source_room_ids: [] };
  const roomIds = new Set<string>();
  for (const member of cohort) {
    const decision = await routingAuthority(pool, actorTenant, actorAlias, member.tenant_id, member.alias);
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

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Quién es la persona, en orden de autoridad.
 *
 * 1. `actor.operator_id`, si el proveedor de autenticación lo estableció. Es el caso del login
 *    por contraseña de la consola: sale del JWT verificado y de la fila de `console_users`, o
 *    sea del servidor. Cuando existe, GANA y la cabecera ni se mira — no hace falta que el
 *    correo esté en `CAUCE_TERMINAL_OPERATORS`, porque tener sesión ya es la inscripción.
 * 2. La cabecera `CAUCE_TERMINAL_OPERATOR_HEADER`, sólo desde el canal `console` y sólo con un
 *    valor inscripto en `CAUCE_TERMINAL_OPERATORS`. Este es el camino de HOY, y su límite está
 *    medido: Caddy y nginx inyectan `X-Cauce-Operator: steven` fijo, así que la auditoría dice
 *    `steven` entre quien entre. Es una pista, nunca una credencial, y por eso sobrevive sólo
 *    mientras no haya una identidad de verdad en el request.
 * 3. Sin ninguna de las dos, la sesión queda sin atribuir y `attributionAllows` la encierra en
 *    su propio tenant.
 */
export function resolveOperator(
  request: FastifyRequest, actor: Principal, config: TerminalConfig
): ResolvedOperator {
  if (actor.operator_id !== undefined && actor.operator_id.length > 0) {
    return { operator_id: actor.operator_id, attributed: true };
  }
  if (actor.channel !== 'console') return { operator_id: UNATTRIBUTED_OPERATOR, attributed: false };
  const declared = headerValue(request.headers[config.operatorHeader])?.trim();
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
