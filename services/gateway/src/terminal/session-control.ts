import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  withTransaction, type AuthorizedAgentTarget, type DatabaseClient, type DatabasePool,
} from '@cauce/store';
import { isLiteralTrue, type Tenant } from '@cauce/protocol';
import { requireOperatorPermission, type Principal } from '../auth.js';
import {
  recordTerminalAudit, terminalAuditMetadata, type TerminalAuditContext, type TerminalAuditEntry,
} from './audit.js';
import {
  attributionAllows, cohortRoutingAuthority, containerCohort, fleetIdentity, fleetPlacement,
  loadFleetPlacements, resolveOperator, type GrantStore, type ResolvedOperator,
} from './authority.js';
import type { TerminalConfig } from './config.js';
import type { AgentRegistry } from './registry.js';
import { registerTerminalTargetRoute } from './session-control/targets.js';
import {
  deriveAliasKey, issueTicket, ticketDigest, ticketSha256, type TicketPayload,
} from './tickets.js';
import { type TerminalMode, type TerminalSessionRow } from './types.js';

const MAX_TERMINAL_CLOCK_SKEW_MS = 5_000;

class TerminalTransactionNoop extends Error {}

export class TerminalClockSkewError extends Error {
  constructor() {
    super('terminal issuance clock is not synchronized with PostgreSQL');
    this.name = 'TerminalClockSkewError';
  }
}

export interface SessionRequestBody {
  tenant_id: string;
  alias: string;
  mode: TerminalMode;
  reason: string;
  cols: number;
  rows: number;
  request_id: string;
  owner_token: string;
}

export interface OwnerRotationBody {
  request_id: string;
  expected_owner_generation: string;
  owner_token: string;
}

export interface DeleteSessionBody {
  request_id: string;
  owner_generation: string;
  owner_token: string;
}

function terminalRelayWebsocketPath(relayInstanceId: string): string {
  if (!/^[0-9a-f]{64}$/.test(relayInstanceId)) throw new Error('database terminal relay instance id is invalid');
  return `/v3/console/terminal/relays/${relayInstanceId}/ws`;
}

function sessionState(row: TerminalSessionRow, occupiesSlot: boolean): 'issued' | 'active' | 'closed' {
  // `occupiesSlot` is calculated by PostgreSQL with the exact admission predicate and DB clock.
  // A browser clock must never decide that a server-side slot does or does not exist.
  if (!occupiesSlot) return 'closed';
  return row.consumed_at === null ? 'issued' : 'active';
}

function subjectFor(actor: Pick<Principal, 'tenant_id' | 'alias'>): string {
  return `${actor.tenant_id}:${actor.alias}`;
}

function terminalAdmissionRequestSha256(input: {
  body: SessionRequestBody;
  actor: Pick<Principal, 'tenant_id' | 'alias'>;
  operator: Pick<ResolvedOperator, 'operator_id' | 'attributed'>;
  consoleSubject: string;
  container: string;
  presenceGeneration: string;
  imageId: string;
  runtimeUser: string;
  runtimeUid: number;
  relayInstanceId: string;
}): Buffer {
  // Fixed construction, not caller JSON: identity and placement are server-derived and the owner
  // token is deliberately absent. That token has its own digest and may only change through the
  // explicit ownership endpoint.
  const material = {
    suite: 'cauce-v3-terminal-browser-admission',
    version: 1,
    request_id: input.body.request_id,
    actor: { tenant_id: input.actor.tenant_id, alias: input.actor.alias },
    operator: {
      operator_id: input.operator.operator_id,
      attributed: input.operator.attributed,
      console_subject: input.consoleSubject,
    },
    target: {
      tenant_id: input.body.tenant_id,
      alias: input.body.alias,
      container: input.container,
      presence_generation: input.presenceGeneration,
      image_id: input.imageId,
      runtime_user: input.runtimeUser,
      runtime_uid: input.runtimeUid,
      mode: input.body.mode,
      relay_instance_id: input.relayInstanceId,
    },
    reason: input.body.reason,
    cols: input.body.cols,
    rows: input.body.rows,
  };
  return createHash('sha256').update(JSON.stringify(material)).digest();
}

function ticketTtlSeconds(row: Pick<TerminalSessionRow, 'issued_at' | 'expires_at'>): number {
  const milliseconds = row.expires_at.getTime() - row.issued_at.getTime();
  const seconds = milliseconds / 1_000;
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 120) {
    throw new Error('database terminal ticket TTL is invalid');
  }
  return seconds;
}

function operatorLockIdentity(operator: ResolvedOperator, consoleSubject: string): string {
  return operator.attributed
    ? operator.operator_id
    : JSON.stringify([operator.operator_id, consoleSubject]);
}

function operatorScopePredicate(
  operatorParameter: number,
  attributedParameter: number,
  subjectParameter: number,
): string {
  return `operator_id=$${String(operatorParameter)}
          AND ($${String(attributedParameter)}::boolean OR console_subject=$${String(subjectParameter)})`;
}

interface TerminalSessionRepository {
  assertPermission(tenantId: Tenant, alias: string, permission: 'control'): Promise<void>;
  authorizeAgentTarget(
    actorTenant: Tenant,
    actorAlias: string,
    targetTenant: Tenant,
    targetAlias: string,
    permission: 'read' | 'control',
  ): Promise<AuthorizedAgentTarget | undefined>;
}

type FleetCohort = ReturnType<typeof containerCohort>;

interface TerminalSessionControlOptions {
  readonly pool: DatabasePool;
  readonly config: TerminalConfig;
  readonly registry: AgentRegistry;
  readonly grants: GrantStore;
  readonly repository: TerminalSessionRepository;
  readonly UUID_PATTERN: RegExp;
  readonly principal: (request: FastifyRequest) => Promise<Principal>;
  readonly openPredicate: (ttlParameter: number) => string;
  readonly currentCohort: (
    tenantId: string,
    alias: string,
    database?: DatabasePool | DatabaseClient,
  ) => Promise<FleetCohort>;
  readonly cohortLabels: (cohort: FleetCohort) => string[];
  readonly sessionExpiry: (row: TerminalSessionRow) => Date | undefined;
  readonly parseSessionRequest: (value: unknown) => SessionRequestBody;
  readonly parseOwnerRotation: (value: unknown) => OwnerRotationBody;
  readonly parseDeleteSession: (value: unknown) => DeleteSessionBody;
  readonly browserOwnerGeneration: (value: string) => string;
  readonly replyError: (reply: FastifyReply, error: unknown) => void;
  readonly recordTransactionalTerminalAudit: (
    client: DatabaseClient,
    entry: TerminalAuditEntry,
  ) => Promise<void>;
}

export function registerTerminalSessionControl(
  app: FastifyInstance,
  options: TerminalSessionControlOptions,
): void {
  const {
    pool, config, registry, grants, repository, UUID_PATTERN, principal, openPredicate,
    currentCohort, cohortLabels, sessionExpiry, parseSessionRequest, parseOwnerRotation,
    parseDeleteSession, browserOwnerGeneration, replyError, recordTransactionalTerminalAudit,
  } = options;

  /* ------------------------------------------------------------------ */
  /* Browser routes: /v3/console/terminal                                */
  /* ------------------------------------------------------------------ */

  registerTerminalTargetRoute(app, options);

  app.post('/v3/console/terminal/sessions', async (request, reply) => {
    const traceId = `trace-${randomUUID()}`;
    try {
      const actor = await principal(request);
      requireOperatorPermission(actor, 'control');
      const operator = resolveOperator(request, actor, config);
      const body = parseSessionRequest(request.body);
      const consoleSubject = subjectFor(actor);
      const redactedAudit: TerminalAuditContext = {
        operator_id: operator.operator_id,
        attributed: operator.attributed,
        target_tenant: body.tenant_id,
        target_alias: body.alias,
        container: null,
        cohort: [],
        mode: body.mode,
      };
      const denyRedacted = async (
        status: 403 | 404,
        reason: string,
      ): Promise<void> => {
        await recordTerminalAudit(pool, {
          tenant_id: actor.tenant_id,
          actor_alias: actor.alias,
          action: 'terminal.session.request',
          decision: 'deny',
          trace_id: traceId,
          metadata: terminalAuditMetadata(redactedAudit, {
            reason,
            operator_reason: body.reason,
          }),
        });
        await reply.code(status).send(status === 404
          ? { error: 'not_found' }
          : { error: 'forbidden', reason });
      };

      // Canonical actor permission and target visibility run before the fleet table is expanded.
      // Missing and hidden targets therefore have one response and an audit row with no placement
      // or cohort metadata supplied by the server.
      try {
        await repository.assertPermission(actor.tenant_id, actor.alias, 'control');
      } catch {
        await denyRedacted(403, 'control_permission_required');
        return;
      }
      const canonicalTarget = await repository.authorizeAgentTarget(
        actor.tenant_id, actor.alias, body.tenant_id, body.alias, 'control',
      );
      if (canonicalTarget === undefined) {
        await denyRedacted(404, 'target_unavailable');
        return;
      }
      const placements = await loadFleetPlacements(pool);
      const placement = fleetPlacement(placements, canonicalTarget.tenant_id, canonicalTarget.alias);
      if (placement === undefined) {
        await denyRedacted(404, 'target_unavailable');
        return;
      }
      const cohort = containerCohort(placements, placement.tenant_id, placement.alias);
      const cohortVisible = (await Promise.all(cohort.map(async (member) =>
        (await repository.authorizeAgentTarget(
          actor.tenant_id, actor.alias, member.tenant_id, member.alias, 'control',
        )) !== undefined
      ))).every(Boolean);
      if (!cohortVisible) {
        await denyRedacted(404, 'target_unavailable');
        return;
      }
      const audit: TerminalAuditContext = {
        ...redactedAudit,
        target_tenant: placement.tenant_id,
        target_alias: placement.alias,
        container: placement.container,
        cohort: cohortLabels(cohort),
      };
      const deny = async (
        status: 403 | 409,
        reason: string,
        extra: Record<string, unknown> = {},
      ): Promise<void> => {
        await recordTerminalAudit(pool, {
          tenant_id: actor.tenant_id,
          actor_alias: actor.alias,
          action: 'terminal.session.request',
          decision: 'deny',
          trace_id: traceId,
          metadata: terminalAuditMetadata(audit, {
            reason,
            operator_reason: body.reason,
            ...extra,
          }),
        });
        await reply.code(status).send(
          status === 403 ? { error: 'forbidden', reason } : { error: 'conflict', reason },
        );
      };

      if (!attributionAllows(operator.attributed, actor.tenant_id, placement.tenant_id)) {
        await deny(403, 'attribution_required');
        return;
      }
      for (const member of cohort) {
        if (!attributionAllows(operator.attributed, actor.tenant_id, member.tenant_id)) {
          await deny(403, 'attribution_required');
          return;
        }
      }
      // Gate 4: routing authority over EVERY alias sharing the container.
      const authority = await cohortRoutingAuthority(pool, actor.tenant_id, actor.alias, cohort);
      if (!authority.allowed) {
        await deny(403, 'no_routing_authority', { authority_reason: authority.reason });
        return;
      }
      // Gate 5: grants file, re-read from disk, over the whole cohort.
      if (!(await grants.allowsCohort(operator.operator_id, cohort, body.mode))) {
        await deny(403, 'no_grant');
        return;
      }
      // Gate 6: a live pty-agent inside the target container.
      const resolution = registry.resolve(placement.tenant_id, body.alias);
      if (resolution.status !== 'online' || !resolution.observation.presence.modes.includes(body.mode)) {
        await deny(409, 'agent_offline', {
          pty_state: registry.state(placement.tenant_id, body.alias),
          ...(resolution.status === 'ambiguous' ? { routing_state: 'relay_ambiguous' } : {}),
        });
        return;
      }
      const observation = resolution.observation;
      const requestSha256 = terminalAdmissionRequestSha256({
        body,
        actor,
        operator,
        consoleSubject,
        container: observation.presence.container_id,
        presenceGeneration: observation.presence.generation,
        imageId: observation.presence.image_id,
        runtimeUser: observation.presence.runtime_user,
        runtimeUid: observation.presence.runtime_uid,
        relayInstanceId: observation.relay_instance_id,
      });
      const browserOwnerSha256 = ticketSha256(body.owner_token);
      const sessionId = randomUUID();
      let conflict: 'session_limit' | 'container_busy' | 'request_conflict' | undefined;
      let receipt: { row: TerminalSessionRow; ticket: string; recovered: boolean } | undefined;
      await withTransaction(pool, async (admissionClient) => {
        await admissionClient.query(
          `SELECT pg_advisory_xact_lock(hashtextextended('terminal:operator:' || $1, 0))`,
          [operatorLockIdentity(operator, consoleSubject)],
        );
        await admissionClient.query(
          `SELECT pg_advisory_xact_lock(hashtextextended('terminal:container:' || $1, 0))`,
          [observation.presence.container_id],
        );
        await admissionClient.query(
          `SELECT pg_advisory_xact_lock(hashtextextended('terminal:request:' || $1, 0))`,
          [body.request_id],
        );

        // A retry after a lost HTTP 201 is identified by request_id, never by coincidentally equal
        // UI fields. Both semantic and owner digests must match. A new logical tab necessarily has
        // another request id, so it can neither adopt nor later revoke this row.
        const recoverable = await admissionClient.query<TerminalSessionRow & { request_unexpired: boolean }>(
          `SELECT terminal_sessions.*,expires_at>now() AS request_unexpired
             FROM terminal_sessions WHERE request_id=$1 FOR UPDATE`,
          [body.request_id],
        );
        const previous = recoverable.rows[0];
        if (previous !== undefined) conflict = 'request_conflict';
        const exactPrevious = previous?.operator_id === operator.operator_id
            && (operator.attributed || previous.console_subject === consoleSubject)
            && previous.console_subject === consoleSubject
            && previous.tenant_id === placement.tenant_id
            && previous.alias === body.alias
            && previous.container === observation.presence.container_id
            && previous.relay_instance_id === observation.relay_instance_id
            && previous.mode === body.mode
            && previous.reason === body.reason
            && previous.cols === body.cols
            && previous.rows === body.rows
            && previous.request_sha256.equals(requestSha256)
            && previous.browser_owner_sha256.equals(browserOwnerSha256)
            && previous.consumed_at === null
            && previous.revoked_at === null
            && previous.closed_at === null
            && previous.request_unexpired;
        if (exactPrevious
            && previous.generation === observation.presence.generation
            && previous.image_id === observation.presence.image_id
            && previous.runtime_user === observation.presence.runtime_user
            && previous.container === observation.presence.container_id) {
          const rebuilt = issueTicket({
            v: 1,
            sid: previous.id,
            op: previous.operator_id,
            sub: previous.console_subject,
            tgt: {
              tenant: previous.tenant_id,
              alias: previous.alias,
              container: previous.container,
              generation: previous.generation,
              image: previous.image_id,
              uid: observation.presence.runtime_uid,
              user: previous.runtime_user,
            },
            mode: previous.mode,
            iat: Math.floor(previous.issued_at.getTime() / 1_000),
            exp: Math.floor(previous.expires_at.getTime() / 1_000),
          }, deriveAliasKey(config.ticketKey, previous.tenant_id, previous.alias));
          if (ticketSha256(rebuilt).equals(previous.ticket_sha256)) {
            await recordTransactionalTerminalAudit(admissionClient, {
              tenant_id: actor.tenant_id,
              actor_alias: actor.alias,
              action: 'terminal.session.request',
              decision: 'allow',
              ...(previous.trace_id === null ? {} : { trace_id: previous.trace_id }),
              metadata: terminalAuditMetadata(audit, {
                session_id: previous.id,
                operator_reason: previous.reason,
                ticket_sha256: ticketDigest(rebuilt),
                receipt_recovered: true,
                source_room_ids: authority.source_room_ids,
              }),
            });
            receipt = { row: previous, ticket: rebuilt, recovered: true };
          }
        }

        if (receipt === undefined && previous === undefined) {
          const localBeforeClockQuery = Date.now();
          const clock = await admissionClient.query<{ database_now: Date }>(
            'SELECT clock_timestamp() AS database_now',
          );
          const localAfterClockQuery = Date.now();
          const issuedAt = clock.rows[0]?.database_now;
          if (!(issuedAt instanceof Date) || !Number.isFinite(issuedAt.getTime())) {
            throw new Error('database returned an invalid terminal admission timestamp');
          }
          if (issuedAt.getTime() < localBeforeClockQuery - MAX_TERMINAL_CLOCK_SKEW_MS
              || issuedAt.getTime() > localAfterClockQuery + MAX_TERMINAL_CLOCK_SKEW_MS) {
            throw new TerminalClockSkewError();
          }
          const expiresAt = new Date(issuedAt.getTime() + config.ticketTtlSeconds * 1_000);
          const payload: TicketPayload = {
            v: 1,
            sid: sessionId,
            op: operator.operator_id,
            sub: consoleSubject,
            tgt: {
              tenant: placement.tenant_id,
              alias: body.alias,
              container: observation.presence.container_id,
              generation: observation.presence.generation,
              image: observation.presence.image_id,
              uid: observation.presence.runtime_uid,
              user: observation.presence.runtime_user
            },
            mode: body.mode,
            iat: Math.floor(issuedAt.getTime() / 1_000),
            exp: Math.floor(expiresAt.getTime() / 1_000)
          };
          const ticket = issueTicket(
            payload,
            deriveAliasKey(config.ticketKey, placement.tenant_id, body.alias),
          );
          const admitted = await admissionClient.query<{
            reason: 'ok' | 'session_limit' | 'container_busy'; id: string | null;
          }>(
            `WITH decision AS MATERIALIZED (
           SELECT CASE
             WHEN (SELECT count(*) FROM terminal_sessions
                    WHERE ${operatorScopePredicate(1, 6, 7)}
                      AND ${openPredicate(3)}) >= $4 THEN 'session_limit'
             WHEN EXISTS (SELECT 1 FROM terminal_sessions
                    WHERE container=$2 AND ${openPredicate(3)}) THEN 'container_busy'
             ELSE 'ok'
           END AS reason
         ), inserted AS (
           INSERT INTO terminal_sessions(
             id, operator_id, attributed, console_subject, tenant_id, alias, container, generation,
             image_id, runtime_user, mode, ticket_sha256, reason, cols, rows, trace_id,
             issued_at, expires_at, request_id, request_sha256, browser_owner_sha256,
             browser_owner_generation, relay_instance_id, relay_boot_id
           )
           SELECT $5,$1,$6,$7,$8,$9,$2,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,1,$24,NULL
             FROM decision WHERE reason='ok'
           RETURNING id
         )
         SELECT decision.reason, inserted.id
           FROM decision LEFT JOIN inserted ON true`,
            [
              operator.operator_id, observation.presence.container_id, config.sessionTtlSeconds,
              config.maxSessionsPerOperator, sessionId, operator.attributed,
              consoleSubject, placement.tenant_id, body.alias,
              observation.presence.generation, observation.presence.image_id,
              observation.presence.runtime_user, body.mode, ticketSha256(ticket), body.reason,
              body.cols, body.rows, traceId, issuedAt.toISOString(), expiresAt.toISOString(),
              body.request_id, requestSha256, browserOwnerSha256,
              observation.relay_instance_id,
            ]
          );
          const admission = admitted.rows[0];
          if (admission?.reason === 'ok' && admission.id === sessionId) {
            const inserted = await admissionClient.query<TerminalSessionRow>(
              'SELECT * FROM terminal_sessions WHERE id=$1 FOR UPDATE',
              [sessionId],
            );
            const row = inserted.rows[0];
            if (row === undefined) throw new Error('terminal admission lost its inserted receipt');
            await recordTransactionalTerminalAudit(admissionClient, {
              tenant_id: actor.tenant_id,
              actor_alias: actor.alias,
              action: 'terminal.session.request',
              decision: 'allow',
              trace_id: traceId,
              metadata: terminalAuditMetadata(audit, {
                session_id: sessionId,
                image_id: observation.presence.image_id,
                generation: observation.presence.generation,
                runtime_user: observation.presence.runtime_user,
                operator_reason: body.reason,
                cols: body.cols,
                rows: body.rows,
                ticket_sha256: ticketDigest(ticket),
                receipt_recovered: false,
                source_room_ids: authority.source_room_ids,
              }),
            });
            receipt = { row, ticket, recovered: false };
          } else {
            conflict = admission?.reason === 'session_limit' ? 'session_limit' : 'container_busy';
          }
        }
      });
      if (receipt === undefined) {
        await deny(409, conflict ?? 'container_busy');
        return;
      }
      return await reply.code(201).send({
        session_id: receipt.row.id,
        ticket: receipt.ticket,
        websocket_path: terminalRelayWebsocketPath(receipt.row.relay_instance_id),
        expires_at: receipt.row.expires_at.toISOString(),
        ttl_seconds: ticketTtlSeconds(receipt.row),
        receipt_recovered: receipt.recovered,
        request_id: receipt.row.request_id,
        owner_generation: browserOwnerGeneration(receipt.row.browser_owner_generation),
        target: {
          tenant_id: placement.tenant_id,
          alias: body.alias,
          container: observation.presence.container_id,
          runtime_user: observation.presence.runtime_user,
          mode: body.mode,
          shares_container_with: cohort
            .filter((member) => member.tenant_id !== body.tenant_id || member.alias !== body.alias)
            .map(fleetIdentity)
        }
      });
    } catch (error) { replyError(reply, error); }
  });

  app.get('/v3/console/terminal/sessions', async (request, reply) => {
    try {
      const actor = await principal(request);
      requireOperatorPermission(actor, 'control');
      const operator = resolveOperator(request, actor, config);
      const consoleSubject = subjectFor(actor);
      const result = await pool.query<TerminalSessionRow & { occupies_slot: boolean }>(
        // The endpoint is the operator's escape hatch for slots that remain open after a tab
        // newer closed rows to push a still-open session out of the bounded response. Open rows
        // therefore come first, using the exact same predicate as admission.
        `SELECT terminal_sessions.*, (${openPredicate(2)}) AS occupies_slot
           FROM terminal_sessions
          WHERE ${operatorScopePredicate(1, 3, 4)}
          ORDER BY occupies_slot DESC, issued_at DESC
          LIMIT 100`,
        [operator.operator_id, config.sessionTtlSeconds, operator.attributed, consoleSubject]
      );
      return {
        items: result.rows.map((row) => ({
          session_id: row.id,
          tenant_id: row.tenant_id,
          alias: row.alias,
          mode: row.mode,
          opened_at: row.issued_at.toISOString(),
          expires_at: (sessionExpiry(row) ?? row.expires_at).toISOString(),
          state: sessionState(row, isLiteralTrue(row.occupies_slot)),
          request_id: row.request_id,
          owner_generation: browserOwnerGeneration(row.browser_owner_generation),
        }))
      };
    } catch (error) { replyError(reply, error); }
  });

  app.post<{ Params: { sid: string } }>('/v3/console/terminal/sessions/:sid/owner', async (request, reply) => {
    try {
      const actor = await principal(request);
      requireOperatorPermission(actor, 'control');
      try {
        await repository.assertPermission(actor.tenant_id, actor.alias, 'control');
      } catch {
        await reply.code(403).send({ error: 'forbidden', reason: 'control_permission_required' });
        return;
      }
      const operator = resolveOperator(request, actor, config);
      const consoleSubject = subjectFor(actor);
      if (!UUID_PATTERN.test(request.params.sid)) throw new Error('session id is invalid');
      const body = parseOwnerRotation(request.body);
      let row: TerminalSessionRow | undefined;
      try {
        row = await withTransaction(pool, async (ownerClient) => {
          const rotated = await ownerClient.query<TerminalSessionRow>(
            `UPDATE terminal_sessions
                SET browser_owner_sha256=$4,
                    browser_owner_generation=browser_owner_generation+1
              WHERE id=$1 AND request_id=$2 AND browser_owner_generation=$3::bigint
                AND ${operatorScopePredicate(5, 6, 7)}
                AND browser_owner_generation<9223372036854775807
                AND revoked_at IS NULL AND closed_at IS NULL
              RETURNING *`,
            [
              request.params.sid,
              body.request_id,
              body.expected_owner_generation,
              ticketSha256(body.owner_token),
              operator.operator_id,
              operator.attributed,
              consoleSubject,
            ],
          );
          const rotatedRow = rotated.rows[0];
          if (rotatedRow === undefined) throw new TerminalTransactionNoop();
          await recordTransactionalTerminalAudit(ownerClient, {
            tenant_id: actor.tenant_id,
            actor_alias: actor.alias,
            action: 'terminal.session.owner_rotated',
            decision: 'info',
            ...(rotatedRow.trace_id === null ? {} : { trace_id: rotatedRow.trace_id }),
            metadata: terminalAuditMetadata({
              operator_id: rotatedRow.operator_id,
              attributed: rotatedRow.attributed,
              target_tenant: rotatedRow.tenant_id,
              target_alias: rotatedRow.alias,
              container: rotatedRow.container,
              cohort: cohortLabels(await currentCohort(
                rotatedRow.tenant_id,
                rotatedRow.alias,
                ownerClient,
              )),
              mode: rotatedRow.mode,
            }, {
              session_id: rotatedRow.id,
              request_id: rotatedRow.request_id,
              owner_generation: rotatedRow.browser_owner_generation,
              reason: 'operator_owner_takeover',
            }),
          });
          return rotatedRow;
        });
      } catch (error) {
        if (!(error instanceof TerminalTransactionNoop)) throw error;
      }
      if (row === undefined) {
        await reply.code(409).send({ error: 'conflict', reason: 'stale_terminal_owner' });
        return;
      }
      return {
        session_id: row.id,
        request_id: row.request_id,
        owner_generation: browserOwnerGeneration(row.browser_owner_generation),
      };
    } catch (error) { replyError(reply, error); }
  });

  app.delete<{ Params: { sid: string } }>('/v3/console/terminal/sessions/:sid', async (request, reply) => {
    try {
      const actor = await principal(request);
      requireOperatorPermission(actor, 'control');
      try {
        await repository.assertPermission(actor.tenant_id, actor.alias, 'control');
      } catch {
        await reply.code(403).send({ error: 'forbidden', reason: 'control_permission_required' });
        return;
      }
      const operator = resolveOperator(request, actor, config);
      const consoleSubject = subjectFor(actor);
      if (!UUID_PATTERN.test(request.params.sid)) throw new Error('session id is invalid');
      const body = parseDeleteSession(request.body);
      // Revocation is a flag, not a socket kill: terminal-relay revalidates every few seconds
      // and closes the WebSocket with 4403 once /authz stops answering ok.
      let outcome: { row: TerminalSessionRow | undefined; settled: boolean } | undefined;
      try {
        outcome = await withTransaction(pool, async (releaseClient) => {
          const revoked = await releaseClient.query<TerminalSessionRow>(
            `UPDATE terminal_sessions SET revoked_at=now()
              WHERE id=$1 AND ${operatorScopePredicate(2, 3, 4)}
                AND request_id=$5
                AND browser_owner_generation=$6::bigint
                AND browser_owner_sha256=$7
                AND revoked_at IS NULL AND closed_at IS NULL RETURNING *`,
            [
              request.params.sid,
              operator.operator_id,
              operator.attributed,
              consoleSubject,
              body.request_id,
              body.owner_generation,
              ticketSha256(body.owner_token),
            ]
          );
          const row = revoked.rows[0];
          let settled = false;
          if (row === undefined) {
            // A lost 204 is safe to retry with the exact same owner. A stale owner, another subject
            // or a different request all receive the same conflict and can mutate nothing.
            const existing = await releaseClient.query<{ settled: boolean }>(
              `SELECT EXISTS(
                 SELECT 1 FROM terminal_sessions
                  WHERE id=$1 AND ${operatorScopePredicate(2, 3, 4)}
                    AND request_id=$5 AND browser_owner_generation=$6::bigint
                    AND browser_owner_sha256=$7 AND (revoked_at IS NOT NULL OR closed_at IS NOT NULL)
               ) AS settled`,
              [
                request.params.sid,
                operator.operator_id,
                operator.attributed,
                consoleSubject,
                body.request_id,
                body.owner_generation,
                ticketSha256(body.owner_token),
              ],
            );
            settled = existing.rows[0]?.settled === true;
          } else {
            await recordTransactionalTerminalAudit(releaseClient, {
              tenant_id: actor.tenant_id,
              actor_alias: actor.alias,
              action: 'terminal.session.revoked',
              decision: 'info',
              ...(row.trace_id === null ? {} : { trace_id: row.trace_id }),
              metadata: terminalAuditMetadata({
                operator_id: row.operator_id,
                attributed: row.attributed,
                target_tenant: row.tenant_id,
                target_alias: row.alias,
                container: row.container,
                cohort: cohortLabels(await currentCohort(row.tenant_id, row.alias, releaseClient)),
                mode: row.mode
              }, {
                session_id: row.id,
                request_id: row.request_id,
                owner_generation: row.browser_owner_generation,
                reason: 'operator_revoked',
              })
            });
          }
          if (row === undefined && !settled) throw new TerminalTransactionNoop();
          return { row, settled };
        });
      } catch (error) {
        if (!(error instanceof TerminalTransactionNoop)) throw error;
      }
      if (outcome === undefined) {
        await reply.code(409).send({ error: 'conflict', reason: 'stale_terminal_owner' });
        return;
      }
      return await reply.code(204).send();
    } catch (error) { replyError(reply, error); }
  });
}
