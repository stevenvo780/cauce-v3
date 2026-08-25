import {
  AgentProfileError, countCodePoints, normalizeAgentProfile, ROLE_BRIEF_MAX_CODE_POINTS
} from '@cauce/protocol';
import type { AgentProfile, ConfigMutation, Tenant } from '@cauce/protocol';
import type { DatabaseClient, DatabasePool } from './db.js';
import { withTransaction } from './db.js';

/**
 * `invalid_input` existe para que un texto que el operador tipeó de más NO llegue al CHECK de
 * Postgres: una violación de CHECK sube como 500 opaco y la pantalla no puede decir qué corregir.
 * El gateway lo traduce a 422 (`statusFor()` en services/gateway/src/app.ts).
 */
export type ConfigurationErrorCode = 'forbidden' | 'conflict' | 'not_found' | 'invalid_input';

export class ConfigurationError extends Error {
  constructor(readonly code: ConfigurationErrorCode, message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

export interface ConfigurationChangeResult {
  applied: boolean;
  dry_run: boolean;
  revision: number;
  summary: string;
  mutation: ConfigMutation;
  inverse_mutation: ConfigMutation;
}

interface RevisionRow {
  id: string;
  actor_tenant: string;
  actor_alias: string;
  operation: ConfigMutation;
  inverse_operation: ConfigMutation;
  summary: string;
  rolled_back_revision_id: string | null;
  created_at: Date;
}

const activeDeliveryStates = "('pending','retry','leased','accepted','started')";

interface DestinationRow {
  adapter: string;
  channel: string;
  conversation_id: string;
  conversation_kind: 'dm' | 'group';
  display_label: string | null;
  allow_kinds: string[];
  require_prior_contact: boolean;
  contact_ttl_days: number;
  min_interval_seconds: number;
  max_per_hour: number;
  max_per_day: number;
  max_per_root: number;
  quiet_hours_start: number | null;
  quiet_hours_end: number | null;
  quiet_hours_tz: string;
  enabled: boolean;
}

const destinationColumns = `adapter,channel,conversation_id,conversation_kind,display_label,allow_kinds,
  require_prior_contact,contact_ttl_days,min_interval_seconds,max_per_hour,max_per_day,max_per_root,
  quiet_hours_start,quiet_hours_end,quiet_hours_tz,enabled`;

/** The exact prior state, so a rollback restores every limit rather than a default. */
function destinationValue(row: DestinationRow): Record<string, unknown> {
  return {
    adapter: row.adapter, channel: row.channel, conversation_id: row.conversation_id,
    conversation_kind: row.conversation_kind, display_label: row.display_label,
    allow_kinds: row.allow_kinds, require_prior_contact: row.require_prior_contact,
    contact_ttl_days: row.contact_ttl_days, min_interval_seconds: row.min_interval_seconds,
    max_per_hour: row.max_per_hour, max_per_day: row.max_per_day, max_per_root: row.max_per_root,
    quiet_hours_start: row.quiet_hours_start, quiet_hours_end: row.quiet_hours_end,
    quiet_hours_tz: row.quiet_hours_tz, enabled: row.enabled
  };
}

class RollbackResult<T> extends Error {
  constructor(readonly result: T) {
    super('configuration preview rollback');
  }
}

function has(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/** alias_routing_ceiling is excluded because it carries no mutable state at all: it is granted
 *  and revoked, so there is never a value to require. */
type ValuedConfigMutation = Exclude<ConfigMutation, { resource: 'alias_routing_ceiling' }>;

function valueRequired(mutation: ValuedConfigMutation): Record<string, unknown> {
  if (mutation.action === 'delete') return {};
  if (!mutation.value) throw new ConfigurationError('conflict', `${mutation.resource} ${mutation.action} requires value`);
  return mutation.value;
}

/**
 * Valida el perfil arrastrando el NOMBRE DEL CAMPO hasta la pantalla.
 *
 * `AgentProfileError` lleva `field` justamente para que la consola sepa qué caja pintar en rojo.
 * Si se dejara subir tal cual, `transaction()` lo pasaría por `databaseError()` y saldría como un
 * 500 opaco; traducido a `invalid_input` el gateway lo manda como 422 con el mensaje entero, que
 * ya nombra el campo y dice cuántos caracteres se enviaron.
 *
 * El CHECK de la migración 026 sigue siendo la última palabra —esto no lo reemplaza—, pero un
 * `23514` sólo nombra el constraint, y sobre un formulario de seis cajas eso no es una respuesta.
 */
function normalizeAgentProfileOrInvalidInput(input: Record<string, unknown>): AgentProfile {
  try {
    return normalizeAgentProfile(input);
  } catch (error) {
    if (error instanceof AgentProfileError) {
      throw new ConfigurationError('invalid_input', `${error.field}: ${error.message}`);
    }
    throw error;
  }
}

function databaseError(error: unknown): never {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (['23503', '23505', '23514', '23P01'].includes(code)) {
    throw new ConfigurationError('conflict', 'configuration change violates a durable constraint');
  }
  throw error;
}

/**
 * Normaliza `role_brief` antes de que lo vea Postgres.
 *
 * El tope NO se declara acá: es `ROLE_BRIEF_MAX_CODE_POINTS` de `@cauce/protocol`, el mismo valor
 * que usan el CHECK `agents_role_brief_len` de la migración 020 y `self_role` en el esquema del
 * sobre. Había una copia a mano de 1200 en este fichero; se eliminó porque si las capas dejan de
 * coincidir el brief se guarda, la pantalla dice «guardado» y el adaptador rechaza la entrega
 * ENTERA: el alias queda SORDO sin un solo error visible.
 *
 * Cuenta con `countCodePoints` y no con `text.length` porque son magnitudes distintas: JS mide
 * unidades UTF-16 (un emoji fuera del BMP vale 2) y `char_length` de Postgres mide puntos de
 * código (ese mismo emoji vale 1). Contar con `String.length` rechazaría un brief de 1200 puntos
 * de código con emoji que la base acepta sin chistar — el operador vería un error inventado por
 * nosotros sobre un texto legítimo. Los puntos de código son exactamente lo que la columna mide.
 *
 * Vacío o sólo espacios se guarda como NULL, no como '': el CHECK exige longitud >= 1, así que ''
 * sería una violación; y NULL es lo que `selfRoleBrief()` (repository.ts) espera para OMITIR la
 * línea `Tu rol:` en vez de anteponer una vacía. Borrar el brief es una operación legítima.
 */
function normalizeRoleBrief(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') {
    throw new ConfigurationError('invalid_input', 'agent role_brief must be text or null');
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const characters = countCodePoints(trimmed);
  if (characters > ROLE_BRIEF_MAX_CODE_POINTS) {
    throw new ConfigurationError(
      'invalid_input',
      `agent role_brief admits ${ROLE_BRIEF_MAX_CODE_POINTS} characters at most; ${characters} were sent`
    );
  }
  return trimmed;
}

export class ConfigurationRepository {
  constructor(private readonly pool: DatabasePool) {}

  async get(actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown>> {
    const hub = await withTransaction(this.pool, (client) => this.assertControl(client, actorTenant, actorAlias));
    const scope = hub ? null : actorTenant;
    const [
      revision, tenants, rooms, memberships, edges, harnesses, policies, destinations, chainPolicies,
      agents, providerAccounts, routingCeiling, agentAccountBindings, revisions, agentProfiles
    ] = await Promise.all([
        this.pool.query<{ revision: string }>('SELECT COALESCE(max(id),0)::text AS revision FROM config_revisions'),
        this.pool.query<Record<string, unknown>>(
          `SELECT id,display_name,is_hub,enabled,created_at FROM tenants
           WHERE $1::text IS NULL OR id=$1 ORDER BY id`, [scope]
        ),
        this.pool.query<Record<string, unknown>>(
          `SELECT id,tenant_id,display_name,enabled,created_at FROM rooms
           WHERE $1::text IS NULL OR tenant_id=$1 ORDER BY tenant_id,id`, [scope]
        ),
        this.pool.query<Record<string, unknown>>(
          `SELECT tenant_id,room_id,alias,role,enabled,created_at FROM memberships
           WHERE $1::text IS NULL OR tenant_id=$1 ORDER BY tenant_id,room_id,alias`, [scope]
        ),
        this.pool.query<Record<string, unknown>>(
          `SELECT from_tenant,to_tenant,enabled,allow_route,allow_read,allow_control,created_at FROM acl_edges
           WHERE $1::text IS NULL OR from_tenant=$1 OR to_tenant=$1 ORDER BY from_tenant,to_tenant`, [scope]
        ),
        this.pool.query<Record<string, unknown>>(
          `SELECT id,display_name,command,capabilities,enabled,created_at,updated_at
           FROM harness_definitions ORDER BY id`
        ),
        this.pool.query<Record<string, unknown>>(
          `SELECT role,allow_route,allow_read,allow_control,allow_notify,created_at FROM role_policies ORDER BY role`
        ),
        this.pool.query<Record<string, unknown>>(
          `SELECT tenant_id,alias,handle,adapter,channel,conversation_id,conversation_kind,display_label,
                  allow_kinds,require_prior_contact,contact_ttl_days,min_interval_seconds,max_per_hour,
                  max_per_day,max_per_root,quiet_hours_start,quiet_hours_end,quiet_hours_tz,enabled,
                  created_at,updated_at
           FROM egress_destinations WHERE $1::text IS NULL OR tenant_id=$1
           ORDER BY tenant_id,alias,handle`, [scope]
        ),
        this.pool.query<Record<string, unknown>>(
          /*
           * Los cinco topes de la migración 019 van en el snapshot porque el servidor LOS APLICA
           * —`repository.ts` los lee y corta delegaciones con ellos— y la consola no podía ni
           * verlos. Un tope que gobierna la producción y no aparece en ninguna pantalla sólo se
           * puede tocar con un `UPDATE` a mano: sin revisión, sin inversa y sin quién lo hizo.
           *
           * La 019 documenta en un comentario el apagado de emergencia como un `UPDATE` crudo
           * contra la base. Eso es lo que estas columnas vienen a dejar de necesitar.
           */
          `SELECT id,progress_relay_enabled,progress_relay_max_events,cycle_cut_enabled,
                  failure_coalesce_enabled,failure_coalesce_window_seconds,
                  delegation_caps_enabled,max_fanout_per_turn,max_edge_repeats_per_root,
                  max_delegations_per_root,human_gate_enabled,updated_at
           FROM agent_chain_policies ORDER BY id`
        ),
        this.pool.query<Record<string, unknown>>(
          // role_brief viaja en el snapshot porque es lo que la consola EDITA: sin él la pantalla
          // mostraría una caja vacía y el primer guardado borraría el rol que el alias ya tenía.
          /*
           * `max_concurrent_deliveries` (migración 015) es el techo REAL de entregas en vuelo de
           * un agente: `repository.ts` lo aplica al repartir cupo. No estaba en el snapshot ni en
           * la mutación, así que sólo se podía cambiar por SQL — y la propia 015 documenta el
           * `UPDATE ... = NULL` como la salida de emergencia cuando el techo estrangula a un
           * agente que sí puede paralelizar. Esa salida ahora tiene pantalla.
           */
          `SELECT tenant_id,alias,harness_id,display_name,enabled,
                  container_name,runtime_user,home_directory,state_directory,role_brief,
                  max_concurrent_deliveries,created_at,updated_at
           FROM agents WHERE $1::text IS NULL OR tenant_id=$1 ORDER BY tenant_id,alias`, [scope]
        ),
        // credential_ref never leaves the database, not even for its payer: it is a locator, not a
        // secret, but rendering a listing has never needed it. A borrowing tenant additionally
        // sees only the shape of a pooled account (who pays, which provider, its label);
        // external_account_id and credential_ref_kind describe the payer's own credential
        // material and stay behind the payer scope.
        this.pool.query<Record<string, unknown>>(
          `SELECT id,provider,payer_tenant_id,label,shared_with_pool,enabled,created_at,updated_at,
                  CASE WHEN $1::text IS NULL OR payer_tenant_id=$1 THEN external_account_id END AS external_account_id,
                  CASE WHEN $1::text IS NULL OR payer_tenant_id=$1 THEN credential_ref_kind END AS credential_ref_kind
           FROM provider_accounts
           WHERE $1::text IS NULL OR payer_tenant_id=$1 OR shared_with_pool
           ORDER BY id`, [scope]
        ),
        this.pool.query<Record<string, unknown>>(
          `SELECT tenant_id,alias,account_id,account_payer_tenant,created_by_tenant,created_at
           FROM alias_routing_ceiling
           WHERE $1::text IS NULL OR tenant_id=$1 OR account_payer_tenant=$1
           ORDER BY tenant_id,alias,account_id`, [scope]
        ),
        this.pool.query<Record<string, unknown>>(
          `SELECT tenant_id,agent_alias,account_id,priority,enabled,created_at,updated_at
           FROM agent_account_bindings WHERE $1::text IS NULL OR tenant_id=$1
           ORDER BY tenant_id,agent_alias,priority,account_id`, [scope]
        ),
        this.pool.query<Record<string, unknown>>(
          // `ORDER BY config_revisions.id` CALIFICADO, y no `ORDER BY id` a secas.
          //
          // `id::text` deja una columna de salida que TAMBIÉN se llama `id`, y en `ORDER BY` un
          // nombre suelto se resuelve primero contra la salida: ordenaba el TEXTO. Medido contra
          // producción el 2026-08-23 con 121 revisiones: la lista salía 99, 98, …, 90, 9, 89, …,
          // 13, 121, 120, 12, 119, 118 — orden lexicográfico — y el `LIMIT 100` recortaba por ahí,
          // así que se perdían 21 revisiones, entre ellas el bloque 100–117 entero.
          //
          // Importa porque el botón de deshacer sólo puede revertir una revisión que la consola
          // LISTE: 18 cambios seguidos quedaban fuera de alcance sin que nada avisara. Una
          // referencia calificada nunca ve el alias de salida, así que ordena por el bigint.
          `SELECT id::text,actor_tenant,actor_alias,operation,summary,rolled_back_revision_id::text,created_at
           FROM config_revisions WHERE $1::text IS NULL OR actor_tenant=$1
           ORDER BY config_revisions.id DESC LIMIT 100`, [scope]
        ),
        this.pool.query<Record<string, unknown>>(
          // El perfil viaja en el snapshot por la MISMA razón que `role_brief`: es lo que la
          // consola EDITA. Sin él la pantalla enseñaría seis cajas vacías, y como la mutación
          // fusiona sobre lo que hay en la base, el primer guardado escribiría esos seis vacíos
          // encima del perfil que el alias ya tenía.
          `SELECT tenant_id,alias,purpose,role_summary,human_brief,responsibilities,restrictions,
                  tools,operating_rules,created_at,updated_at
           FROM agent_profiles WHERE $1::text IS NULL OR tenant_id=$1
           ORDER BY tenant_id,alias`, [scope]
        )
    ]);
    return {
      revision: Number(revision.rows[0]?.revision ?? 0), observed_at: new Date().toISOString(),
      tenants: tenants.rows, rooms: rooms.rows, memberships: memberships.rows,
      acl_edges: edges.rows, harness_definitions: harnesses.rows, role_policies: policies.rows,
      chain_policies: chainPolicies.rows,
      egress_destinations: destinations.rows,
      agents: agents.rows, provider_accounts: providerAccounts.rows,
      alias_routing_ceiling: routingCeiling.rows, agent_account_bindings: agentAccountBindings.rows,
      agent_profiles: agentProfiles.rows,
      revisions: revisions.rows
    };
  }

  async apply(
    actorTenant: Tenant,
    actorAlias: string,
    mutation: ConfigMutation,
    dryRun: boolean,
    expectedRevision?: number
  ): Promise<ConfigurationChangeResult> {
    return this.transaction<ConfigurationChangeResult>(async (client) => {
      const hub = await this.assertControl(client, actorTenant, actorAlias);
      this.authorizeMutation(mutation, actorTenant, hub);
      const revision = await this.lockRevision(client, expectedRevision);
      const { inverse, summary } = await this.execute(client, mutation);
      await this.assertControl(client, actorTenant, actorAlias);
      if (dryRun) {
        return { result: {
          applied: false, dry_run: true, revision, summary, mutation, inverse_mutation: inverse
        }, rollback: true };
      }
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO config_revisions(actor_tenant,actor_alias,operation,inverse_operation,summary)
         VALUES($1,$2,$3::jsonb,$4::jsonb,$5) RETURNING id::text`,
        [actorTenant, actorAlias, JSON.stringify(mutation), JSON.stringify(inverse), summary]
      );
      const nextRevision = Number(inserted.rows[0]!.id);
      await this.audit(client, actorTenant, actorAlias, 'config.change', {
        revision: nextRevision, mutation, summary
      });
      return { result: {
        applied: true, dry_run: false, revision: nextRevision, summary, mutation, inverse_mutation: inverse
      }, rollback: false };
    });
  }

  async rollback(
    actorTenant: Tenant,
    actorAlias: string,
    revisionId: number,
    dryRun: boolean,
    expectedRevision?: number
  ): Promise<ConfigurationChangeResult> {
    if (!Number.isSafeInteger(revisionId) || revisionId < 1) {
      throw new ConfigurationError('not_found', 'configuration revision is invalid');
    }
    return this.transaction<ConfigurationChangeResult>(async (client) => {
      const hub = await this.assertControl(client, actorTenant, actorAlias);
      const currentRevision = await this.lockRevision(client, expectedRevision);
      const selected = await client.query<RevisionRow>(
        `SELECT id::text,actor_tenant,actor_alias,operation,inverse_operation,summary,
                rolled_back_revision_id::text,created_at
         FROM config_revisions WHERE id=$1 FOR UPDATE`, [revisionId]
      );
      const original = selected.rows[0];
      if (!original) throw new ConfigurationError('not_found', 'configuration revision was not found');
      if (!hub && original.actor_tenant !== actorTenant) {
        throw new ConfigurationError('forbidden', 'configuration revision is outside the actor tenant');
      }
      this.authorizeMutation(original.inverse_operation, actorTenant, hub);
      const { inverse: redo, summary } = await this.execute(client, original.inverse_operation);
      await this.assertControl(client, actorTenant, actorAlias);
      const rollbackSummary = `rollback ${revisionId}: ${summary}`;
      if (dryRun) {
        return { result: {
          applied: false, dry_run: true, revision: currentRevision, summary: rollbackSummary,
          mutation: original.inverse_operation, inverse_mutation: redo
        }, rollback: true };
      }
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO config_revisions(
           actor_tenant,actor_alias,operation,inverse_operation,summary,rolled_back_revision_id
         ) VALUES($1,$2,$3::jsonb,$4::jsonb,$5,$6) RETURNING id::text`,
        [actorTenant, actorAlias, JSON.stringify(original.inverse_operation), JSON.stringify(redo),
          rollbackSummary, revisionId]
      );
      const nextRevision = Number(inserted.rows[0]!.id);
      await this.audit(client, actorTenant, actorAlias, 'config.rollback', {
        revision: nextRevision, rolled_back_revision: revisionId, mutation: original.inverse_operation
      });
      return { result: {
        applied: true, dry_run: false, revision: nextRevision, summary: rollbackSummary,
        mutation: original.inverse_operation, inverse_mutation: redo
      }, rollback: false };
    });
  }

  private async transaction<T>(
    work: (client: DatabaseClient) => Promise<{ result: T; rollback: boolean }>
  ): Promise<T> {
    try {
      return await withTransaction(this.pool, async (client) => {
        const output = await work(client);
        if (output.rollback) throw new RollbackResult(output.result);
        return output.result;
      });
    } catch (error) {
      if (error instanceof RollbackResult) return error.result as T;
      databaseError(error);
    }
  }

  private async assertControl(client: DatabaseClient, tenant: Tenant, alias: string): Promise<boolean> {
    const result = await client.query<{ is_hub: boolean }>(
      `SELECT tenant.is_hub FROM memberships membership
       JOIN role_policies role ON role.role=membership.role
       JOIN tenants tenant ON tenant.id=membership.tenant_id
       WHERE membership.tenant_id=$1 AND membership.alias=$2 AND membership.enabled
         AND tenant.enabled AND role.allow_control LIMIT 1`, [tenant, alias]
    );
    const row = result.rows[0];
    if (!row) throw new ConfigurationError('forbidden', 'control permission is required for configuration');
    return row.is_hub;
  }

  private authorizeMutation(mutation: ConfigMutation, actorTenant: Tenant, hub: boolean): void {
    // Waiving prior contact means writing to a group nobody in it ever addressed.
    // That is a hub-only decision even for a destination inside the actor tenant.
    if (mutation.resource === 'egress_destination' && !hub && mutation.value?.require_prior_contact === false) {
      throw new ConfigurationError('forbidden', 'waiving prior contact on an egress destination requires the hub');
    }
    if (hub) return;
    // The registry resources (agent, provider_account, alias_routing_ceiling,
    // agent_account_binding) are absent from this list on purpose: lending a subscription is a
    // decision about somebody else's money, so it stays hub-only by the default-deny fall-through
    // below rather than by a rule a future edit could soften.
    //
    // `agent_profile` TAMPOCO está en la lista, y por una razón propia que conviene dejar escrita
    // porque es el error natural: tiene `tenant_id`, así que la simetría con `room`/`membership`
    // invita a añadirlo «porque es del inquilino». No. El perfil es lo que el agente LEE EN CADA
    // TURNO: quien lo escribe decide qué cree ese agente sobre lo que puede y no puede hacer. Eso
    // es la misma clase de decisión que el registro, no la misma que una sala. Se queda en la
    // caída por defecto de abajo, hub-only, y hay una prueba con su control negativo que lo mide.
    if (mutation.resource === 'room' || mutation.resource === 'membership'
      || mutation.resource === 'egress_destination') {
      if (mutation.tenant_id === actorTenant) return;
    } else if (mutation.resource === 'acl_edge') {
      if (mutation.from_tenant === actorTenant) return;
    }
    throw new ConfigurationError('forbidden', 'configuration resource is outside the actor tenant');
  }

  private async lockRevision(client: DatabaseClient, expected?: number): Promise<number> {
    await client.query(`SELECT pg_advisory_xact_lock(783_003_004)`);
    const selected = await client.query<{ revision: string }>(
      'SELECT COALESCE(max(id),0)::text AS revision FROM config_revisions'
    );
    const revision = Number(selected.rows[0]?.revision ?? 0);
    if (expected !== undefined && revision !== expected) {
      throw new ConfigurationError('conflict', `configuration revision changed: expected ${expected}, current ${revision}`);
    }
    return revision;
  }

  private async execute(
    client: DatabaseClient,
    mutation: ConfigMutation
  ): Promise<{ inverse: ConfigMutation; summary: string }> {
    if (mutation.resource === 'tenant') return this.tenant(client, mutation);
    if (mutation.resource === 'room') return this.room(client, mutation);
    if (mutation.resource === 'membership') return this.membership(client, mutation);
    if (mutation.resource === 'acl_edge') return this.edge(client, mutation);
    if (mutation.resource === 'harness') return this.harness(client, mutation);
    if (mutation.resource === 'chain_policy') return this.chainPolicy(client, mutation);
    if (mutation.resource === 'egress_destination') return this.destination(client, mutation);
    if (mutation.resource === 'agent') return this.agent(client, mutation);
    if (mutation.resource === 'agent_profile') return this.agentProfile(client, mutation);
    if (mutation.resource === 'provider_account') return this.providerAccount(client, mutation);
    if (mutation.resource === 'alias_routing_ceiling') return this.routingCeiling(client, mutation);
    if (mutation.resource === 'agent_account_binding') return this.agentAccountBinding(client, mutation);
    return this.policy(client, mutation);
  }

  private async chainPolicy(
    client: DatabaseClient, mutation: Extract<ConfigMutation, { resource: 'chain_policy' }>
  ): Promise<{ inverse: ConfigMutation; summary: string }> {
    const selected = await client.query<{
      progress_relay_enabled: boolean; progress_relay_max_events: number; cycle_cut_enabled: boolean;
      failure_coalesce_enabled: boolean; failure_coalesce_window_seconds: number;
      delegation_caps_enabled: boolean; max_fanout_per_turn: number;
      max_edge_repeats_per_root: number; max_delegations_per_root: number;
      human_gate_enabled: boolean;
    }>(
      // Los cinco topes van en este SELECT o el DESHACER los borra: `oldValue` es literalmente el
      // cuerpo de la mutación inversa, así que una columna que no se lea aquí vuelve como ausente
      // y el `update` de deshacer la deja en su valor por defecto. Deshacer un cambio de umbral y
      // que se muevan OTROS cuatro es peor que no tener el botón.
      `SELECT progress_relay_enabled,progress_relay_max_events,cycle_cut_enabled,
              failure_coalesce_enabled,failure_coalesce_window_seconds,
              delegation_caps_enabled,max_fanout_per_turn,max_edge_repeats_per_root,
              max_delegations_per_root,human_gate_enabled
       FROM agent_chain_policies WHERE id=$1 FOR UPDATE`, [mutation.id]
    );
    const old = selected.rows[0];
    if (!old) throw new ConfigurationError('not_found', 'chain policy was not found');
    const value = valueRequired(mutation);
    const next = {
      progress_relay_enabled: has(value, 'progress_relay_enabled')
        ? value.progress_relay_enabled as boolean : old.progress_relay_enabled,
      progress_relay_max_events: has(value, 'progress_relay_max_events')
        ? value.progress_relay_max_events as number : old.progress_relay_max_events,
      cycle_cut_enabled: has(value, 'cycle_cut_enabled')
        ? value.cycle_cut_enabled as boolean : old.cycle_cut_enabled,
      failure_coalesce_enabled: has(value, 'failure_coalesce_enabled')
        ? value.failure_coalesce_enabled as boolean : old.failure_coalesce_enabled,
      failure_coalesce_window_seconds: has(value, 'failure_coalesce_window_seconds')
        ? value.failure_coalesce_window_seconds as number : old.failure_coalesce_window_seconds,
      delegation_caps_enabled: has(value, 'delegation_caps_enabled')
        ? value.delegation_caps_enabled as boolean : old.delegation_caps_enabled,
      max_fanout_per_turn: has(value, 'max_fanout_per_turn')
        ? value.max_fanout_per_turn as number : old.max_fanout_per_turn,
      max_edge_repeats_per_root: has(value, 'max_edge_repeats_per_root')
        ? value.max_edge_repeats_per_root as number : old.max_edge_repeats_per_root,
      max_delegations_per_root: has(value, 'max_delegations_per_root')
        ? value.max_delegations_per_root as number : old.max_delegations_per_root,
      human_gate_enabled: has(value, 'human_gate_enabled')
        ? value.human_gate_enabled as boolean : old.human_gate_enabled
    };
    await client.query(
      `UPDATE agent_chain_policies
       SET progress_relay_enabled=$2,progress_relay_max_events=$3,cycle_cut_enabled=$4,
           failure_coalesce_enabled=$5,failure_coalesce_window_seconds=$6,
           delegation_caps_enabled=$7,max_fanout_per_turn=$8,max_edge_repeats_per_root=$9,
           max_delegations_per_root=$10,human_gate_enabled=$11,updated_at=now()
       WHERE id=$1`,
      [mutation.id, next.progress_relay_enabled, next.progress_relay_max_events,
        next.cycle_cut_enabled, next.failure_coalesce_enabled, next.failure_coalesce_window_seconds,
        next.delegation_caps_enabled, next.max_fanout_per_turn, next.max_edge_repeats_per_root,
        next.max_delegations_per_root, next.human_gate_enabled]
    );
    return {
      inverse: {
        resource: 'chain_policy', action: 'update', id: mutation.id,
        value: {
          progress_relay_enabled: old.progress_relay_enabled,
          progress_relay_max_events: old.progress_relay_max_events,
          cycle_cut_enabled: old.cycle_cut_enabled,
          failure_coalesce_enabled: old.failure_coalesce_enabled,
          failure_coalesce_window_seconds: old.failure_coalesce_window_seconds,
          delegation_caps_enabled: old.delegation_caps_enabled,
          max_fanout_per_turn: old.max_fanout_per_turn,
          max_edge_repeats_per_root: old.max_edge_repeats_per_root,
          max_delegations_per_root: old.max_delegations_per_root,
          human_gate_enabled: old.human_gate_enabled
        }
      },
      summary: `update chain policy ${mutation.id}`
    };
  }

  private async tenant(
    client: DatabaseClient, mutation: Extract<ConfigMutation, { resource: 'tenant' }>
  ): Promise<{ inverse: ConfigMutation; summary: string }> {
    const selected = await client.query<{
      id: string; display_name: string | null; is_hub: boolean; enabled: boolean;
    }>('SELECT id,display_name,is_hub,enabled FROM tenants WHERE id=$1 FOR UPDATE', [mutation.id]);
    const old = selected.rows[0];
    if (mutation.action === 'create') {
      if (old) throw new ConfigurationError('conflict', 'tenant already exists');
      const value = valueRequired(mutation);
      await client.query(
        `INSERT INTO tenants(id,display_name,is_hub,enabled) VALUES($1,$2,$3,$4)`,
        [mutation.id, value.display_name ?? null, value.is_hub ?? false, value.enabled ?? true]
      );
      return { inverse: { resource: 'tenant', action: 'delete', id: mutation.id }, summary: `create tenant ${mutation.id}` };
    }
    if (!old) throw new ConfigurationError('not_found', 'tenant was not found');
    const oldValue = { display_name: old.display_name, is_hub: old.is_hub, enabled: old.enabled };
    if (mutation.action === 'delete') {
      const active = await client.query(
        `SELECT 1 FROM deliveries d JOIN messages m ON m.id=d.message_id
         WHERE d.status IN ${activeDeliveryStates} AND (m.tenant_id=$1 OR d.recipient_tenant=$1) LIMIT 1`, [mutation.id]
      );
      if (active.rowCount) throw new ConfigurationError('conflict', 'tenant has active deliveries');
      await client.query('DELETE FROM tenants WHERE id=$1', [mutation.id]);
      return { inverse: { resource: 'tenant', action: 'create', id: mutation.id, value: oldValue }, summary: `delete tenant ${mutation.id}` };
    }
    const value = valueRequired(mutation);
    const next = {
      display_name: has(value, 'display_name') ? value.display_name as string | null : old.display_name,
      is_hub: has(value, 'is_hub') ? value.is_hub as boolean : old.is_hub,
      enabled: has(value, 'enabled') ? value.enabled as boolean : old.enabled
    };
    await client.query('UPDATE tenants SET display_name=$2,is_hub=$3,enabled=$4 WHERE id=$1',
      [mutation.id, next.display_name, next.is_hub, next.enabled]);
    return { inverse: { resource: 'tenant', action: 'update', id: mutation.id, value: oldValue }, summary: `update tenant ${mutation.id}` };
  }

  private async room(
    client: DatabaseClient, mutation: Extract<ConfigMutation, { resource: 'room' }>
  ): Promise<{ inverse: ConfigMutation; summary: string }> {
    const selected = await client.query<{
      id: string; tenant_id: string; display_name: string | null; enabled: boolean;
    }>('SELECT id,tenant_id,display_name,enabled FROM rooms WHERE id=$1 AND tenant_id=$2 FOR UPDATE', [mutation.id, mutation.tenant_id]);
    const old = selected.rows[0];
    if (mutation.action === 'create') {
      if (old) throw new ConfigurationError('conflict', 'room already exists');
      const value = valueRequired(mutation);
      await client.query('INSERT INTO rooms(id,tenant_id,display_name,enabled) VALUES($1,$2,$3,$4)',
        [mutation.id, mutation.tenant_id, value.display_name ?? null, value.enabled ?? true]);
      return { inverse: { resource: 'room', action: 'delete', tenant_id: mutation.tenant_id, id: mutation.id }, summary: `create room ${mutation.id}` };
    }
    if (!old) throw new ConfigurationError('not_found', 'room was not found');
    const oldValue = { display_name: old.display_name, enabled: old.enabled };
    if (mutation.action === 'delete') {
      const active = await client.query(
        `SELECT 1 FROM messages m JOIN deliveries d ON d.message_id=m.id
         WHERE m.tenant_id=$1 AND m.room_id=$2 AND d.status IN ${activeDeliveryStates} LIMIT 1`,
        [mutation.tenant_id, mutation.id]
      );
      if (active.rowCount) throw new ConfigurationError('conflict', 'room has active deliveries');
      await client.query('DELETE FROM rooms WHERE id=$1 AND tenant_id=$2', [mutation.id, mutation.tenant_id]);
      return { inverse: { resource: 'room', action: 'create', tenant_id: mutation.tenant_id, id: mutation.id, value: oldValue }, summary: `delete room ${mutation.id}` };
    }
    const value = valueRequired(mutation);
    await client.query('UPDATE rooms SET display_name=$3,enabled=$4 WHERE id=$1 AND tenant_id=$2', [
      mutation.id, mutation.tenant_id,
      has(value, 'display_name') ? value.display_name : old.display_name,
      has(value, 'enabled') ? value.enabled : old.enabled
    ]);
    return { inverse: { resource: 'room', action: 'update', tenant_id: mutation.tenant_id, id: mutation.id, value: oldValue }, summary: `update room ${mutation.id}` };
  }

  private async membership(
    client: DatabaseClient, mutation: Extract<ConfigMutation, { resource: 'membership' }>
  ): Promise<{ inverse: ConfigMutation; summary: string }> {
    const selected = await client.query<{ role: string; enabled: boolean }>(
      `SELECT role,enabled FROM memberships WHERE tenant_id=$1 AND room_id=$2 AND alias=$3 FOR UPDATE`,
      [mutation.tenant_id, mutation.room_id, mutation.alias]
    );
    const old = selected.rows[0];
    if (mutation.action === 'create') {
      if (old) throw new ConfigurationError('conflict', 'membership already exists');
      const value = valueRequired(mutation);
      await client.query(
        `INSERT INTO memberships(tenant_id,room_id,alias,role,enabled) VALUES($1,$2,$3,$4,$5)`,
        [mutation.tenant_id, mutation.room_id, mutation.alias, value.role ?? 'agent', value.enabled ?? true]
      );
      return { inverse: {
        resource: 'membership', action: 'delete', tenant_id: mutation.tenant_id,
        room_id: mutation.room_id, alias: mutation.alias
      }, summary: `create membership ${mutation.tenant_id}/${mutation.room_id}/${mutation.alias}` };
    }
    if (!old) throw new ConfigurationError('not_found', 'membership was not found');
    const oldValue = { role: old.role, enabled: old.enabled };
    if (mutation.action === 'delete') {
      const active = await client.query(
        `SELECT 1 FROM deliveries d JOIN messages m ON m.id=d.message_id
         WHERE d.status IN ${activeDeliveryStates} AND (
           (d.recipient_tenant=$1 AND d.recipient_alias=$3) OR
           (m.tenant_id=$1 AND m.room_id=$2 AND m.actor_alias=$3)
         ) LIMIT 1`, [mutation.tenant_id, mutation.room_id, mutation.alias]
      );
      const liveLease = await client.query(
        `SELECT 1 FROM connection_leases WHERE tenant_id=$1 AND alias=$2 AND lease_until>now() LIMIT 1`,
        [mutation.tenant_id, mutation.alias]
      );
      if (active.rowCount || liveLease.rowCount) throw new ConfigurationError('conflict', 'membership has active deliveries or a live lease');
      await client.query('DELETE FROM memberships WHERE tenant_id=$1 AND room_id=$2 AND alias=$3',
        [mutation.tenant_id, mutation.room_id, mutation.alias]);
      return { inverse: {
        resource: 'membership', action: 'create', tenant_id: mutation.tenant_id,
        room_id: mutation.room_id, alias: mutation.alias, value: oldValue
      }, summary: `delete membership ${mutation.tenant_id}/${mutation.room_id}/${mutation.alias}` };
    }
    const value = valueRequired(mutation);
    await client.query(
      `UPDATE memberships SET role=$4,enabled=$5 WHERE tenant_id=$1 AND room_id=$2 AND alias=$3`,
      [mutation.tenant_id, mutation.room_id, mutation.alias,
        has(value, 'role') ? value.role : old.role, has(value, 'enabled') ? value.enabled : old.enabled]
    );
    return { inverse: {
      resource: 'membership', action: 'update', tenant_id: mutation.tenant_id,
      room_id: mutation.room_id, alias: mutation.alias, value: oldValue
    }, summary: `update membership ${mutation.tenant_id}/${mutation.room_id}/${mutation.alias}` };
  }

  private async edge(
    client: DatabaseClient, mutation: Extract<ConfigMutation, { resource: 'acl_edge' }>
  ): Promise<{ inverse: ConfigMutation; summary: string }> {
    if (mutation.from_tenant === mutation.to_tenant) throw new ConfigurationError('conflict', 'self ACL edges are forbidden');
    const selected = await client.query<{
      enabled: boolean; allow_route: boolean; allow_read: boolean; allow_control: boolean;
    }>('SELECT enabled,allow_route,allow_read,allow_control FROM acl_edges WHERE from_tenant=$1 AND to_tenant=$2 FOR UPDATE',
      [mutation.from_tenant, mutation.to_tenant]);
    const old = selected.rows[0];
    if (mutation.action === 'create') {
      if (old) throw new ConfigurationError('conflict', 'ACL edge already exists');
      const value = valueRequired(mutation);
      await client.query(
        `INSERT INTO acl_edges(from_tenant,to_tenant,enabled,allow_route,allow_read,allow_control)
         VALUES($1,$2,$3,$4,$5,$6)`,
        [mutation.from_tenant, mutation.to_tenant, value.enabled ?? true,
          value.allow_route ?? false, value.allow_read ?? false, value.allow_control ?? false]
      );
      return { inverse: { resource: 'acl_edge', action: 'delete', from_tenant: mutation.from_tenant, to_tenant: mutation.to_tenant }, summary: `create ACL ${mutation.from_tenant}->${mutation.to_tenant} default-deny` };
    }
    if (!old) throw new ConfigurationError('not_found', 'ACL edge was not found');
    const oldValue = { enabled: old.enabled, allow_route: old.allow_route, allow_read: old.allow_read, allow_control: old.allow_control };
    if (mutation.action === 'delete') {
      await client.query('DELETE FROM acl_edges WHERE from_tenant=$1 AND to_tenant=$2', [mutation.from_tenant, mutation.to_tenant]);
      return { inverse: {
        resource: 'acl_edge', action: 'create', from_tenant: mutation.from_tenant,
        to_tenant: mutation.to_tenant, value: oldValue
      }, summary: `delete ACL ${mutation.from_tenant}->${mutation.to_tenant}` };
    }
    const value = valueRequired(mutation);
    await client.query(
      `UPDATE acl_edges SET enabled=$3,allow_route=$4,allow_read=$5,allow_control=$6
       WHERE from_tenant=$1 AND to_tenant=$2`,
      [mutation.from_tenant, mutation.to_tenant,
        has(value, 'enabled') ? value.enabled : old.enabled,
        has(value, 'allow_route') ? value.allow_route : old.allow_route,
        has(value, 'allow_read') ? value.allow_read : old.allow_read,
        has(value, 'allow_control') ? value.allow_control : old.allow_control]
    );
    return { inverse: {
      resource: 'acl_edge', action: 'update', from_tenant: mutation.from_tenant,
      to_tenant: mutation.to_tenant, value: oldValue
    }, summary: `update ACL ${mutation.from_tenant}->${mutation.to_tenant}` };
  }

  private async harness(
    client: DatabaseClient, mutation: Extract<ConfigMutation, { resource: 'harness' }>
  ): Promise<{ inverse: ConfigMutation; summary: string }> {
    const selected = await client.query<{
      display_name: string; command: string | null; capabilities: string[]; enabled: boolean;
    }>('SELECT display_name,command,capabilities,enabled FROM harness_definitions WHERE id=$1 FOR UPDATE', [mutation.id]);
    const old = selected.rows[0];
    if (mutation.action === 'create') {
      if (old) throw new ConfigurationError('conflict', 'harness definition already exists');
      const value = valueRequired(mutation);
      if (typeof value.display_name !== 'string') throw new ConfigurationError('conflict', 'harness display_name is required');
      await client.query(
        `INSERT INTO harness_definitions(id,display_name,command,capabilities,enabled)
         VALUES($1,$2,$3,$4::jsonb,$5)`,
        [mutation.id, value.display_name, value.command ?? null, JSON.stringify(value.capabilities ?? []), value.enabled ?? true]
      );
      return { inverse: { resource: 'harness', action: 'delete', id: mutation.id }, summary: `create harness ${mutation.id}` };
    }
    if (!old) throw new ConfigurationError('not_found', 'harness definition was not found');
    const oldValue = { display_name: old.display_name, command: old.command, capabilities: old.capabilities, enabled: old.enabled };
    if (mutation.action === 'delete') {
      await client.query('DELETE FROM harness_definitions WHERE id=$1', [mutation.id]);
      return { inverse: { resource: 'harness', action: 'create', id: mutation.id, value: oldValue }, summary: `delete harness ${mutation.id}` };
    }
    const value = valueRequired(mutation);
    await client.query(
      `UPDATE harness_definitions SET display_name=$2,command=$3,capabilities=$4::jsonb,enabled=$5,updated_at=now()
       WHERE id=$1`, [mutation.id,
        has(value, 'display_name') ? value.display_name : old.display_name,
        has(value, 'command') ? value.command : old.command,
        JSON.stringify(has(value, 'capabilities') ? value.capabilities : old.capabilities),
        has(value, 'enabled') ? value.enabled : old.enabled]
    );
    return { inverse: { resource: 'harness', action: 'update', id: mutation.id, value: oldValue }, summary: `update harness ${mutation.id}` };
  }

  private async policy(
    client: DatabaseClient, mutation: Extract<ConfigMutation, { resource: 'role_policy' }>
  ): Promise<{ inverse: ConfigMutation; summary: string }> {
    const selected = await client.query<{
      allow_route: boolean; allow_read: boolean; allow_control: boolean; allow_notify: boolean;
    }>('SELECT allow_route,allow_read,allow_control,allow_notify FROM role_policies WHERE role=$1 FOR UPDATE', [mutation.role]);
    const old = selected.rows[0];
    if (mutation.action === 'create') {
      if (old) throw new ConfigurationError('conflict', 'role policy already exists');
      const value = valueRequired(mutation);
      await client.query(
        `INSERT INTO role_policies(role,allow_route,allow_read,allow_control,allow_notify) VALUES($1,$2,$3,$4,$5)`,
        [mutation.role, value.allow_route ?? false, value.allow_read ?? false, value.allow_control ?? false,
          value.allow_notify ?? false]
      );
      return { inverse: { resource: 'role_policy', action: 'delete', role: mutation.role }, summary: `create role policy ${mutation.role} default-deny` };
    }
    if (!old) throw new ConfigurationError('not_found', 'role policy was not found');
    const oldValue = {
      allow_route: old.allow_route, allow_read: old.allow_read,
      allow_control: old.allow_control, allow_notify: old.allow_notify
    };
    if (mutation.action === 'delete') {
      await client.query('DELETE FROM role_policies WHERE role=$1', [mutation.role]);
      return { inverse: { resource: 'role_policy', action: 'create', role: mutation.role, value: oldValue }, summary: `delete role policy ${mutation.role}` };
    }
    const value = valueRequired(mutation);
    await client.query(
      `UPDATE role_policies SET allow_route=$2,allow_read=$3,allow_control=$4,allow_notify=$5 WHERE role=$1`,
      [mutation.role,
        has(value, 'allow_route') ? value.allow_route : old.allow_route,
        has(value, 'allow_read') ? value.allow_read : old.allow_read,
        has(value, 'allow_control') ? value.allow_control : old.allow_control,
        has(value, 'allow_notify') ? value.allow_notify : old.allow_notify]
    );
    return { inverse: { resource: 'role_policy', action: 'update', role: mutation.role, value: oldValue }, summary: `update role policy ${mutation.role}` };
  }

  /**
   * The proactive-egress allowlist. It lives in config_revisions like every other
   * ACL surface, so creating a destination has a preview, optimistic concurrency,
   * an audit event and an exact inverse operation for rollback.
   */
  private async destination(
    client: DatabaseClient, mutation: Extract<ConfigMutation, { resource: 'egress_destination' }>
  ): Promise<{ inverse: ConfigMutation; summary: string }> {
    const key = `${mutation.tenant_id}/${mutation.alias}/${mutation.handle}`;
    const selected = await client.query<DestinationRow>(
      `SELECT ${destinationColumns} FROM egress_destinations
       WHERE tenant_id=$1 AND alias=$2 AND handle=$3 FOR UPDATE`,
      [mutation.tenant_id, mutation.alias, mutation.handle]
    );
    const old = selected.rows[0];
    const identity = {
      resource: 'egress_destination' as const, tenant_id: mutation.tenant_id,
      alias: mutation.alias, handle: mutation.handle
    };
    if (mutation.action === 'create') {
      if (old) throw new ConfigurationError('conflict', 'egress destination already exists');
      const value = valueRequired(mutation);
      if (typeof value.conversation_id !== 'string') {
        throw new ConfigurationError('conflict', 'egress destination conversation_id is required');
      }
      if (value.conversation_kind !== 'dm' && value.conversation_kind !== 'group') {
        throw new ConfigurationError('conflict', 'egress destination conversation_kind is required');
      }
      if (!Array.isArray(value.allow_kinds) || value.allow_kinds.length === 0) {
        throw new ConfigurationError('conflict', 'egress destination allow_kinds is required');
      }
      await client.query(
        `INSERT INTO egress_destinations(
           tenant_id,alias,handle,adapter,channel,conversation_id,conversation_kind,display_label,
           allow_kinds,require_prior_contact,contact_ttl_days,min_interval_seconds,max_per_hour,
           max_per_day,max_per_root,quiet_hours_start,quiet_hours_end,quiet_hours_tz,enabled
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [mutation.tenant_id, mutation.alias, mutation.handle,
          value.adapter ?? 'telegram', value.channel ?? 'telegram',
          value.conversation_id, value.conversation_kind, value.display_label ?? null,
          value.allow_kinds, value.require_prior_contact ?? true,
          value.contact_ttl_days ?? 30, value.min_interval_seconds ?? 300,
          value.max_per_hour ?? 2, value.max_per_day ?? 8, value.max_per_root ?? 1,
          value.quiet_hours_start ?? null, value.quiet_hours_end ?? null,
          value.quiet_hours_tz ?? 'UTC', value.enabled ?? true]
      );
      return {
        inverse: { ...identity, action: 'delete' },
        summary: `create egress destination ${key}`
      };
    }
    if (!old) throw new ConfigurationError('not_found', 'egress destination was not found');
    const oldValue = destinationValue(old);
    if (mutation.action === 'delete') {
      await client.query(
        'DELETE FROM egress_destinations WHERE tenant_id=$1 AND alias=$2 AND handle=$3',
        [mutation.tenant_id, mutation.alias, mutation.handle]
      );
      return {
        inverse: { ...identity, action: 'create', value: oldValue },
        summary: `delete egress destination ${key}`
      };
    }
    const value = valueRequired(mutation);
    const next = (field: keyof DestinationRow): unknown => has(value, field) ? value[field] : old[field];
    await client.query(
      `UPDATE egress_destinations SET adapter=$4,channel=$5,conversation_id=$6,conversation_kind=$7,
         display_label=$8,allow_kinds=$9,require_prior_contact=$10,contact_ttl_days=$11,
         min_interval_seconds=$12,max_per_hour=$13,max_per_day=$14,max_per_root=$15,
         quiet_hours_start=$16,quiet_hours_end=$17,quiet_hours_tz=$18,enabled=$19
       WHERE tenant_id=$1 AND alias=$2 AND handle=$3`,
      [mutation.tenant_id, mutation.alias, mutation.handle,
        next('adapter'), next('channel'), next('conversation_id'), next('conversation_kind'),
        next('display_label'), next('allow_kinds'), next('require_prior_contact'),
        next('contact_ttl_days'), next('min_interval_seconds'), next('max_per_hour'),
        next('max_per_day'), next('max_per_root'), next('quiet_hours_start'),
        next('quiet_hours_end'), next('quiet_hours_tz'), next('enabled')]
    );
    return {
      inverse: { ...identity, action: 'update', value: oldValue },
      summary: `update egress destination ${key}`
    };
  }

  private async agent(
    client: DatabaseClient, mutation: Extract<ConfigMutation, { resource: 'agent' }>
  ): Promise<{ inverse: ConfigMutation; summary: string }> {
    const key = `${mutation.tenant_id}/${mutation.alias}`;
    // role_brief viaja en el SELECT porque `oldValue` es lo ÚNICO de lo que sale la mutación
    // inversa: sin leerlo acá, un rollback restauraría el agente con el brief en NULL y el texto
    // anterior quedaría irrecuperable. Un cambio de identidad sin vuelta atrás no es auditable,
    // que es justamente lo que esta pantalla viene a dar.
    const selected = await client.query<{
      harness_id: string | null; display_name: string | null; enabled: boolean;
      container_name: string | null; runtime_user: string | null;
      home_directory: string | null; state_directory: string | null; role_brief: string | null;
      max_concurrent_deliveries: number | null;
    }>(
      // Va en este SELECT o el DESHACER lo borra: `oldValue` es el cuerpo de la inversa, y una
      // columna ausente vuelve como no declarada. `NULL` aquí SIGNIFICA algo —«sin techo», la
      // salida de emergencia de la 015—, así que perderlo al deshacer no deja el valor por
      // defecto: le pone techo a un agente que alguien había destechado a propósito.
      `SELECT harness_id,display_name,enabled,container_name,runtime_user,home_directory,
              state_directory,role_brief,max_concurrent_deliveries
       FROM agents WHERE tenant_id=$1 AND alias=$2 FOR UPDATE`, [mutation.tenant_id, mutation.alias]
    );
    const old = selected.rows[0];
    if (mutation.action === 'create') {
      if (old) throw new ConfigurationError('conflict', 'agent already exists');
      const value = valueRequired(mutation);
      await client.query(
        `INSERT INTO agents(tenant_id,alias,harness_id,display_name,enabled,container_name,runtime_user,home_directory,state_directory,role_brief,max_concurrent_deliveries)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [mutation.tenant_id, mutation.alias, value.harness_id ?? null, value.display_name ?? null,
          value.enabled ?? false, value.container_name ?? null, value.runtime_user ?? null,
          value.home_directory ?? null, value.state_directory ?? null,
          // Un alta sin role_brief sigue naciendo sin rol declarado, como antes de esta columna:
          // el adaptador omite la línea `Tu rol:` y nadie le inventa una identidad al alias.
          normalizeRoleBrief(value.role_brief),
          /*
           * `undefined` (no declarado) cae al DEFAULT 2 de la columna, que es lo que reciben hoy
           * los quince alias vivos. `null` DECLARADO es otra cosa: significa «sin techo», la
           * salida de emergencia de la migración 015. Distinguirlos importa — colapsarlos dejaría
           * sin techo a todo agente que se cree sin nombrar el campo.
           */
          has(value, 'max_concurrent_deliveries')
            ? value.max_concurrent_deliveries as number | null
            : 2]
      );
      return {
        inverse: { resource: 'agent', action: 'delete', tenant_id: mutation.tenant_id, alias: mutation.alias },
        summary: `create agent ${key}`
      };
    }
    if (!old) throw new ConfigurationError('not_found', 'agent was not found');
    const oldValue = { ...old };
    if (mutation.action === 'delete') {
      const active = await client.query(
        `SELECT 1 FROM deliveries d JOIN messages m ON m.id=d.message_id
         WHERE d.status IN ${activeDeliveryStates} AND (
           (d.recipient_tenant=$1 AND d.recipient_alias=$2) OR (m.tenant_id=$1 AND m.actor_alias=$2)
         ) LIMIT 1`, [mutation.tenant_id, mutation.alias]
      );
      const liveLease = await client.query(
        `SELECT 1 FROM connection_leases WHERE tenant_id=$1 AND alias=$2 AND lease_until>now() LIMIT 1`,
        [mutation.tenant_id, mutation.alias]
      );
      if (active.rowCount || liveLease.rowCount) {
        throw new ConfigurationError('conflict', 'agent has active deliveries or a live lease');
      }
      await client.query('DELETE FROM agents WHERE tenant_id=$1 AND alias=$2', [mutation.tenant_id, mutation.alias]);
      return {
        inverse: { resource: 'agent', action: 'create', tenant_id: mutation.tenant_id, alias: mutation.alias, value: oldValue },
        summary: `delete agent ${key}`
      };
    }
    const value = valueRequired(mutation);
    const next = {
      harness_id: has(value, 'harness_id') ? value.harness_id as string | null : old.harness_id,
      display_name: has(value, 'display_name') ? value.display_name as string | null : old.display_name,
      enabled: has(value, 'enabled') ? value.enabled as boolean : old.enabled,
      container_name: has(value, 'container_name') ? value.container_name as string | null : old.container_name,
      runtime_user: has(value, 'runtime_user') ? value.runtime_user as string | null : old.runtime_user,
      home_directory: has(value, 'home_directory') ? value.home_directory as string | null : old.home_directory,
      state_directory: has(value, 'state_directory') ? value.state_directory as string | null : old.state_directory,
      // Se valida sólo lo que el operador MANDÓ. Reusar la clave ausente para revalidar `old`
      // convertiría cualquier edición de otro campo en un rechazo por un brief que ya está en la
      // base — y las filas anteriores a esta validación entran por un CHECK NOT VALID.
      role_brief: has(value, 'role_brief') ? normalizeRoleBrief(value.role_brief) : old.role_brief,
      max_concurrent_deliveries: has(value, 'max_concurrent_deliveries')
        ? value.max_concurrent_deliveries as number | null
        : old.max_concurrent_deliveries
    };
    await client.query(
      `UPDATE agents SET harness_id=$3,display_name=$4,enabled=$5,container_name=$6,runtime_user=$7,
         home_directory=$8,state_directory=$9,role_brief=$10,max_concurrent_deliveries=$11,
         updated_at=now()
       WHERE tenant_id=$1 AND alias=$2`,
      [mutation.tenant_id, mutation.alias, next.harness_id, next.display_name, next.enabled,
        next.container_name, next.runtime_user, next.home_directory, next.state_directory,
        next.role_brief, next.max_concurrent_deliveries]
    );
    return {
      inverse: { resource: 'agent', action: 'update', tenant_id: mutation.tenant_id, alias: mutation.alias, value: oldValue },
      summary: `update agent ${key}`
    };
  }

  /**
   * EL PERFIL AUTORADO de un alias (tabla `agent_profiles`, migración 026).
   *
   * Sigue el molde de `agent()` porque las razones son las mismas, y una de ellas cuesta cara:
   *
   *  - `SELECT` de TODAS las columnas y `FOR UPDATE`. `oldValue` es lo ÚNICO de lo que sale la
   *    mutación inversa, así que una columna que no se lee queda irrecuperable tras un rollback.
   *    Y sin `FOR UPDATE`, dos operadores que guarden a la vez leen el mismo «antes» y el segundo
   *    fabrica una inversa que restauraría un estado que nunca existió.
   *  - La inversa lleva el perfil ENTERO, no el campo tocado. Deshacer un cambio de identidad
   *    tiene que devolver la identidad completa.
   *  - Un campo AUSENTE se conserva (`has(value, campo) ? … : old.campo`). Sin eso, editar sólo
   *    `purpose` desde la pantalla borraría las cuatro listas, y el operador vería «guardado»
   *    sobre un perfil que acaba de perder lo que no estaba mirando.
   *
   * LA VALIDACIÓN LA HACE `normalizeAgentProfile()` Y NO EL CHECK DE POSTGRES. El CHECK está y es
   * la última palabra, pero llega como `23514` — un código que sólo nombra el constraint. La
   * pantalla necesita saber QUÉ CAJA pintar en rojo, y eso sólo lo sabe la función que midió. Por
   * eso el `AgentProfileError` se traduce a `invalid_input` (422) arrastrando el nombre del campo,
   * en vez de dejar que suba un 500 opaco.
   *
   * Se valida el perfil FUSIONADO, no lo que mandó el operador: el presupuesto TOTAL es del perfil
   * completo, y un `tools` nuevo que no entra sólo se puede detectar sumándolo a lo que ya había.
   */
  private async agentProfile(
    client: DatabaseClient, mutation: Extract<ConfigMutation, { resource: 'agent_profile' }>
  ): Promise<{ inverse: ConfigMutation; summary: string }> {
    const key = `${mutation.tenant_id}/${mutation.alias}`;
    const selected = await client.query<{
      purpose: string | null; role_summary: string | null; human_brief: string | null;
      responsibilities: string[] | null; restrictions: string[] | null;
      tools: string[] | null; operating_rules: string[] | null;
    }>(
      // `human_brief` va en este SELECT o el DESHACER lo borra: `oldValue` es literalmente el
      // cuerpo de la mutación inversa, así que un campo que no se lea aquí vuelve como ausente y
      // el `update` de deshacer lo deja en NULL. Perder prosa al pulsar «deshacer» es peor que no
      // tener el botón.
      `SELECT purpose,role_summary,human_brief,responsibilities,restrictions,tools,operating_rules
       FROM agent_profiles WHERE tenant_id=$1 AND alias=$2 FOR UPDATE`,
      [mutation.tenant_id, mutation.alias]
    );
    const old = selected.rows[0];
    /*
     * `oldValue` es la forma que viaja en la inversa. Las listas se normalizan a `[]` acá y no en
     * el sitio de uso: la columna es NOT NULL DEFAULT '{}', pero un driver puede devolver `null`
     * para un array vacío según cómo se haya escrito, y una inversa con `null` donde va una lista
     * la rechazaría el esquema al deshacer — un rollback que falla en el momento en que hace falta.
     */
    const oldValue = old === undefined ? undefined : {
      purpose: old.purpose,
      role_summary: old.role_summary,
      human_brief: old.human_brief,
      responsibilities: old.responsibilities ?? [],
      restrictions: old.restrictions ?? [],
      tools: old.tools ?? [],
      operating_rules: old.operating_rules ?? []
    };

    if (mutation.action === 'delete') {
      // «No hay» NO es «hecho». Contestar éxito sobre un alias sin perfil le enseña al operador
      // que borró algo, que es el defecto que la consola ya arregló y no puede volver por acá.
      if (oldValue === undefined) throw new ConfigurationError('not_found', 'agent profile was not found');
      await client.query(
        'DELETE FROM agent_profiles WHERE tenant_id=$1 AND alias=$2',
        [mutation.tenant_id, mutation.alias]
      );
      return {
        inverse: {
          resource: 'agent_profile', action: 'create',
          tenant_id: mutation.tenant_id, alias: mutation.alias, value: oldValue
        },
        summary: `delete agent profile ${key}`
      };
    }
    if (mutation.action === 'create' && oldValue !== undefined) {
      throw new ConfigurationError('conflict', 'agent profile already exists');
    }

    const value = valueRequired(mutation);
    const base = oldValue ?? {
      purpose: null, role_summary: null, human_brief: null,
      responsibilities: [], restrictions: [], tools: [], operating_rules: []
    };
    const fusionado = {
      tenant_id: mutation.tenant_id,
      alias: mutation.alias,
      purpose: has(value, 'purpose') ? value.purpose : base.purpose,
      role_summary: has(value, 'role_summary') ? value.role_summary : base.role_summary,
      human_brief: has(value, 'human_brief') ? value.human_brief : base.human_brief,
      responsibilities: has(value, 'responsibilities') ? value.responsibilities : base.responsibilities,
      restrictions: has(value, 'restrictions') ? value.restrictions : base.restrictions,
      tools: has(value, 'tools') ? value.tools : base.tools,
      operating_rules: has(value, 'operating_rules') ? value.operating_rules : base.operating_rules
    };
    const perfil = normalizeAgentProfileOrInvalidInput(fusionado);

    await client.query(
      `INSERT INTO agent_profiles
         (tenant_id,alias,purpose,role_summary,human_brief,
          responsibilities,restrictions,tools,operating_rules)
       VALUES($1,$2,$3,$4,$5,$6::text[],$7::text[],$8::text[],$9::text[])
       ON CONFLICT (tenant_id,alias) DO UPDATE SET
         purpose=EXCLUDED.purpose,
         role_summary=EXCLUDED.role_summary,
         human_brief=EXCLUDED.human_brief,
         responsibilities=EXCLUDED.responsibilities,
         restrictions=EXCLUDED.restrictions,
         tools=EXCLUDED.tools,
         operating_rules=EXCLUDED.operating_rules,
         updated_at=now()`,
      [
        perfil.tenant_id, perfil.alias, perfil.purpose, perfil.role_summary, perfil.human_brief,
        [...perfil.responsibilities], [...perfil.restrictions],
        [...perfil.tools], [...perfil.operating_rules]
      ]
    );

    /*
     * Un alta se deshace BORRANDO, y una edición reponiendo lo de antes. Si el alta se deshiciera
     * con un `update` al perfil vacío quedaría una fila con todo en NULL, que NO es lo mismo que no
     * tener perfil: el compilador distingue «no declarado» de «declarado vacío», y una fila
     * fantasma le haría emitir un bloque donde no debería haber ninguno.
     */
    return {
      inverse: oldValue === undefined
        ? {
          resource: 'agent_profile', action: 'delete',
          tenant_id: mutation.tenant_id, alias: mutation.alias
        }
        : {
          resource: 'agent_profile', action: 'update',
          tenant_id: mutation.tenant_id, alias: mutation.alias, value: oldValue
        },
      summary: `${mutation.action} agent profile ${key}`
    };
  }

  /**
   * A provider subscription. Identity, payer and credential locator are immutable: an account id
   * is referenced from alias_routing_ceiling, so silently repointing it at another subscription
   * would retroactively change what every existing loan means. Only the label, the pool
   * publication and the enabled flag can move.
   */
  private async providerAccount(
    client: DatabaseClient, mutation: Extract<ConfigMutation, { resource: 'provider_account' }>
  ): Promise<{ inverse: ConfigMutation; summary: string }> {
    const selected = await client.query<{
      provider: string; external_account_id: string; payer_tenant_id: Tenant; label: string | null;
      credential_ref_kind: 'env_path' | 'file' | 'secret_manager'; credential_ref: string;
      shared_with_pool: boolean; enabled: boolean;
    }>(
      `SELECT provider,external_account_id,payer_tenant_id,label,credential_ref_kind,credential_ref,
              shared_with_pool,enabled
       FROM provider_accounts WHERE id=$1 FOR UPDATE`, [mutation.id]
    );
    const old = selected.rows[0];
    if (mutation.action === 'create') {
      if (old) throw new ConfigurationError('conflict', 'provider account already exists');
      const value = valueRequired(mutation);
      if (typeof value.provider !== 'string' || typeof value.external_account_id !== 'string' ||
          typeof value.payer_tenant_id !== 'string' || typeof value.credential_ref_kind !== 'string' ||
          typeof value.credential_ref !== 'string') {
        throw new ConfigurationError(
          'conflict',
          'provider_account create requires provider, external_account_id, payer_tenant_id, credential_ref_kind and credential_ref'
        );
      }
      await client.query(
        `INSERT INTO provider_accounts(id,provider,external_account_id,payer_tenant_id,label,
           credential_ref_kind,credential_ref,shared_with_pool,enabled)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [mutation.id, value.provider, value.external_account_id, value.payer_tenant_id,
          value.label ?? null, value.credential_ref_kind, value.credential_ref,
          value.shared_with_pool ?? false, value.enabled ?? false]
      );
      return {
        inverse: { resource: 'provider_account', action: 'delete', id: mutation.id },
        summary: `create provider account ${mutation.id} paid by ${String(value.payer_tenant_id)}`
      };
    }
    if (!old) throw new ConfigurationError('not_found', 'provider account was not found');
    const oldValue = { ...old };
    if (mutation.action === 'delete') {
      // No explicit guard: alias_routing_ceiling holds a plain foreign key into this table, so
      // Postgres already refuses (23503) to delete an account any alias may still be routed to.
      await client.query('DELETE FROM provider_accounts WHERE id=$1', [mutation.id]);
      return {
        inverse: { resource: 'provider_account', action: 'create', id: mutation.id, value: oldValue },
        summary: `delete provider account ${mutation.id}`
      };
    }
    const value = valueRequired(mutation);
    if (has(value, 'provider') || has(value, 'external_account_id') || has(value, 'payer_tenant_id') ||
        has(value, 'credential_ref_kind') || has(value, 'credential_ref')) {
      throw new ConfigurationError(
        'conflict', 'provider_account identity and credential rotation require delete and create, not update'
      );
    }
    const next = {
      label: has(value, 'label') ? value.label as string | null : old.label,
      // Withdrawing an account from the pool while another tenant is still routed to it raises
      // 23503 from alias_routing_ceiling_borrow_requires_pool; databaseError() maps it to conflict.
      shared_with_pool: has(value, 'shared_with_pool') ? value.shared_with_pool as boolean : old.shared_with_pool,
      enabled: has(value, 'enabled') ? value.enabled as boolean : old.enabled
    };
    await client.query(
      `UPDATE provider_accounts SET label=$2,shared_with_pool=$3,enabled=$4,updated_at=now() WHERE id=$1`,
      [mutation.id, next.label, next.shared_with_pool, next.enabled]
    );
    return {
      inverse: {
        resource: 'provider_account', action: 'update', id: mutation.id,
        value: {
          label: oldValue.label, shared_with_pool: oldValue.shared_with_pool, enabled: oldValue.enabled
        }
      },
      summary: `update provider account ${mutation.id}`
    };
  }

  /** Granting or revoking an account for one alias. The payer mirror is read from
   *  provider_accounts here rather than accepted from the caller, so the row Postgres validates
   *  against the borrow guard is always the real payer. */
  private async routingCeiling(
    client: DatabaseClient, mutation: Extract<ConfigMutation, { resource: 'alias_routing_ceiling' }>
  ): Promise<{ inverse: ConfigMutation; summary: string }> {
    const identity = {
      resource: 'alias_routing_ceiling', tenant_id: mutation.tenant_id,
      alias: mutation.alias, account_id: mutation.account_id
    } as const;
    const key = `${mutation.tenant_id}/${mutation.alias} -> ${mutation.account_id}`;
    const selected = await client.query(
      `SELECT 1 FROM alias_routing_ceiling WHERE tenant_id=$1 AND alias=$2 AND account_id=$3 FOR UPDATE`,
      [mutation.tenant_id, mutation.alias, mutation.account_id]
    );
    if (mutation.action === 'create') {
      if (selected.rowCount) throw new ConfigurationError('conflict', 'routing ceiling entry already exists');
      const account = await client.query<{ payer_tenant_id: Tenant }>(
        'SELECT payer_tenant_id FROM provider_accounts WHERE id=$1 FOR SHARE', [mutation.account_id]
      );
      const payer = account.rows[0]?.payer_tenant_id;
      if (!payer) throw new ConfigurationError('not_found', 'provider account was not found');
      await client.query(
        `INSERT INTO alias_routing_ceiling(tenant_id,alias,account_id,account_payer_tenant,created_by_tenant)
         VALUES($1,$2,$3,$4,$5)`,
        [mutation.tenant_id, mutation.alias, mutation.account_id, payer, mutation.tenant_id]
      );
      return { inverse: { ...identity, action: 'delete' }, summary: `grant routing ceiling ${key}` };
    }
    if (!selected.rowCount) throw new ConfigurationError('not_found', 'routing ceiling entry was not found');
    // agent_account_bindings cascades: revoking the ceiling withdraws the routing in one step.
    await client.query(
      'DELETE FROM alias_routing_ceiling WHERE tenant_id=$1 AND alias=$2 AND account_id=$3',
      [mutation.tenant_id, mutation.alias, mutation.account_id]
    );
    return { inverse: { ...identity, action: 'create' }, summary: `revoke routing ceiling ${key}` };
  }

  private async agentAccountBinding(
    client: DatabaseClient, mutation: Extract<ConfigMutation, { resource: 'agent_account_binding' }>
  ): Promise<{ inverse: ConfigMutation; summary: string }> {
    const identity = {
      resource: 'agent_account_binding', tenant_id: mutation.tenant_id,
      agent_alias: mutation.agent_alias, account_id: mutation.account_id
    } as const;
    const key = `${mutation.tenant_id}/${mutation.agent_alias} -> ${mutation.account_id}`;
    const selected = await client.query<{ priority: number; enabled: boolean }>(
      `SELECT priority,enabled FROM agent_account_bindings
       WHERE tenant_id=$1 AND agent_alias=$2 AND account_id=$3 FOR UPDATE`,
      [mutation.tenant_id, mutation.agent_alias, mutation.account_id]
    );
    const old = selected.rows[0];
    if (mutation.action === 'create') {
      if (old) throw new ConfigurationError('conflict', 'agent account binding already exists');
      const value = valueRequired(mutation);
      await client.query(
        `INSERT INTO agent_account_bindings(tenant_id,agent_alias,account_id,priority,enabled)
         VALUES($1,$2,$3,$4,$5)`,
        [mutation.tenant_id, mutation.agent_alias, mutation.account_id,
          value.priority ?? 100, value.enabled ?? false]
      );
      return { inverse: { ...identity, action: 'delete' }, summary: `create agent account binding ${key}` };
    }
    if (!old) throw new ConfigurationError('not_found', 'agent account binding was not found');
    const oldValue = { priority: old.priority, enabled: old.enabled };
    if (mutation.action === 'delete') {
      await client.query(
        'DELETE FROM agent_account_bindings WHERE tenant_id=$1 AND agent_alias=$2 AND account_id=$3',
        [mutation.tenant_id, mutation.agent_alias, mutation.account_id]
      );
      return {
        inverse: { ...identity, action: 'create', value: oldValue },
        summary: `delete agent account binding ${key}`
      };
    }
    const value = valueRequired(mutation);
    await client.query(
      `UPDATE agent_account_bindings SET priority=$4,enabled=$5,updated_at=now()
       WHERE tenant_id=$1 AND agent_alias=$2 AND account_id=$3`,
      [mutation.tenant_id, mutation.agent_alias, mutation.account_id,
        has(value, 'priority') ? value.priority as number : old.priority,
        has(value, 'enabled') ? value.enabled as boolean : old.enabled]
    );
    return {
      inverse: { ...identity, action: 'update', value: oldValue },
      summary: `update agent account binding ${key}`
    };
  }

  private async audit(
    client: DatabaseClient,
    tenant: Tenant,
    alias: string,
    action: string,
    metadata: Record<string, unknown>
  ): Promise<void> {
    await client.query(
      `INSERT INTO audit_events(tenant_id,actor_alias,action,decision,metadata)
       VALUES($1,$2,$3,'allow',$4::jsonb)`, [tenant, alias, action, JSON.stringify(metadata)]
    );
  }
}
