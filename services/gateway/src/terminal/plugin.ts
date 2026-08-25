import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { CauceRepository, StoreError, type DatabasePool } from '@cauce/store';
import type { Tenant } from '@cauce/protocol';
import {
  AuthError, AuthorizationError, requireOperatorPermission, validatePrincipal,
  type AuthProvider, type Principal
} from '../auth.js';
import { registerAgentDirectiveRoutes } from '../console/agent-directive.routes.js';
import {
  TerminalRelayFactsProbe, type GovernanceRelayClient, type MeasuredFactsSource
} from '../console/agent-documents.js';
import { HttpGovernanceRelayClient } from '../console/relay-governance-client.js';
import { recordTerminalAudit, terminalAuditMetadata, type TerminalAuditContext } from './audit.js';
import {
  GrantStore, attributionAllows, cohortRoutingAuthority, containerCohort, fleetIdentity,
  fleetIdentityLabel, fleetPlacement, loadFleetPlacements, resolveOperator, routingAuthority,
  type RoutingAuthority
} from './authority.js';
import type { TerminalConfig } from './config.js';
import { hechosDelRegistro } from './hechos-del-registro.js';
import { AgentRegistry, parseAgentPresence } from './registry.js';
import {
  deriveAliasKey, issueResumeToken, issueTicket, parseAndVerify, parseResumeToken,
  ticketDigest, ticketSha256,
  TicketError, type TicketPayload
} from './tickets.js';
import { isTerminalMode, type TerminalMode, type TerminalSessionRow, type TerminalTarget } from './types.js';

/**
 * PTY control plane. The gateway DECIDES and AUDITS; it never carries a byte of PTY.
 *
 * Topology this plugin has to live with: the gateway, the console and PostgreSQL run on
 * `agora-storage`, while the fourteen agent containers live on `kratos`. Every terminal
 * therefore crosses that host boundary, and it crosses it through terminal-relay — the only
 * component with a route into the containers. The browser talks to the relay over the
 * WebSocket path announced in the capability; the relay talks back here over
 * /v3/terminal/relay/* to redeem a ticket, revalidate it every few seconds and report closure.
 * Nothing in that path lets the browser name a container: it names `(tenant, alias)` and the
 * enabled PostgreSQL registry resolves placement.  The release gate separately proves that
 * registry matches the declarative operations inventory.
 *
 * Route placement is deliberate:
 *  - /v3/console/terminal/*  browser routes, covered by the global console security hook
 *    (Origin allowlist, Vary: Origin, Sec-Fetch-Site rejection) that app.ts registered first.
 *  - /v3/terminal/relay/*    relay routes, OUTSIDE /v3/console/ because that hook demands a
 *    same-origin Origin header on every non-GET and the relay is not a browser.
 */

const REASON_MIN = 8;
const REASON_MAX = 280;
const COLS_MIN = 20;
const COLS_MAX = 500;
const ROWS_MIN = 5;
const ROWS_MAX = 200;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TerminalControlPlaneOptions {
  readonly pool: DatabasePool;
  readonly authProvider: AuthProvider;
  readonly config: TerminalConfig;
  /** Injectable for tests; production uses a fresh in-memory registry per process. */
  readonly registry?: AgentRegistry;
  readonly repository?: { assertPermission(tenantId: Tenant, alias: string, permission: 'control'): Promise<void> };
  /**
   * De dónde salen los hechos MEDIDOS de cada alias (arnés, HOME, CODEX_HOME) para resolver la
   * ruta de su manual del sitio.
   *
   * Hoy nadie los mide: el pty-agent conoce su `home` y su `harness` por el bundle con el que
   * arranca, pero no los publica ni en el hello ni en la presencia, así que no hay ninguna fuente
   * en producción. El default es honesto —«no medido»— y la ruta lo dice con esas palabras en vez
   * de deducir la ruta del registro, que el 23-ago-2026 se equivocaba de arnés en 5 de 14 alias.
   */
  readonly measuredFacts?: MeasuredFactsSource;
  /** Inyectable para los tests; en producción sale de `config.relayUrl`. */
  readonly governanceRelay?: GovernanceRelayClient;
}

/**
 * El cliente hacia el terminal-relay, o uno que explica por qué no hay ninguno.
 *
 * El material TLS se lee AQUÍ, al registrar el plugin, y no en la primera lectura: un fichero de
 * certificado que no se puede leer tiene que matar el arranque, no descubrirse cuando un operador
 * abre el modal.
 */
async function buildGovernanceRelay(config: TerminalConfig): Promise<GovernanceRelayClient> {
  if (config.relayUrl === undefined) {
    return {
      readFile: async () => ({
        error: 'unavailable',
        reason: 'el gateway no tiene configurada la dirección del terminal-relay (CAUCE_TERMINAL_RELAY_URL)'
      })
    };
  }
  const [ca, clientCert, clientKey] = await Promise.all([
    config.relayCaFile === undefined ? undefined : readFile(config.relayCaFile),
    config.relayClientCertFile === undefined ? undefined : readFile(config.relayClientCertFile),
    config.relayClientKeyFile === undefined ? undefined : readFile(config.relayClientKeyFile)
  ]);
  return new HttpGovernanceRelayClient({
    relayUrl: config.relayUrl,
    token: config.relayToken,
    ...(ca === undefined ? {} : { ca }),
    ...(clientCert === undefined || clientKey === undefined ? {} : { clientCert, clientKey })
  });
}

interface SessionRequestBody {
  tenant_id: string;
  alias: string;
  mode: TerminalMode;
  reason: string;
  cols: number;
  rows: number;
}

function replyError(reply: FastifyReply, error: unknown): void {
  if (error instanceof AuthError) {
    void reply.code(401).send({ error: error.code, message: error.message });
    return;
  }
  if (error instanceof AuthorizationError) {
    void reply.code(403).send({ error: error.code, message: error.message });
    return;
  }
  if (error instanceof StoreError) {
    void reply.code(error.code === 'not_found' ? 404 : 403).send({ error: error.code, message: error.message });
    return;
  }
  const message = error instanceof Error ? error.message : 'unknown error';
  void reply.code(400).send({ error: 'invalid_request', message });
}

function boundedInteger(value: unknown, min: number, max: number, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function parseSessionRequest(value: unknown): SessionRequestBody {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('session request must be an object');
  }
  const body = value as Record<string, unknown>;
  if (typeof body.tenant_id !== 'string' || body.tenant_id.length === 0 || body.tenant_id.length > 64) {
    throw new Error('tenant_id is required');
  }
  if (typeof body.alias !== 'string' || !/^[a-z][a-z0-9_-]{1,63}$/.test(body.alias)) {
    throw new Error('alias is invalid');
  }
  if (!isTerminalMode(body.mode)) throw new Error("mode must be 'shell' or 'harness'");
  // The operator reason is mandatory and hand written: it is the only human explanation the
  // audit row will ever carry, so it is never defaulted or auto-generated.
  if (typeof body.reason !== 'string' || body.reason.trim().length < REASON_MIN || body.reason.length > REASON_MAX) {
    throw new Error(`reason must be between ${REASON_MIN} and ${REASON_MAX} characters`);
  }
  return {
    tenant_id: body.tenant_id,
    alias: body.alias,
    mode: body.mode,
    reason: body.reason.trim(),
    cols: boundedInteger(body.cols, COLS_MIN, COLS_MAX, 'cols'),
    rows: boundedInteger(body.rows, ROWS_MIN, ROWS_MAX, 'rows')
  };
}

function relayAuthorized(request: FastifyRequest, expected: string): boolean {
  const header: unknown = request.headers.authorization;
  const authorization = typeof header === 'string' ? header : undefined;
  if (authorization === undefined || !authorization.startsWith('Bearer ')) return false;
  // Compare digests: constant time, and a length mismatch never throws nor leaks the length.
  return timingSafeEqual(ticketSha256(authorization.slice(7)), ticketSha256(expected));
}

function sessionState(row: TerminalSessionRow): 'issued' | 'active' | 'closed' {
  if (row.closed_at !== null || row.revoked_at !== null) return 'closed';
  return row.consumed_at === null ? 'issued' : 'active';
}

function counterValue(value: string | number): number {
  return typeof value === 'number' ? value : Number(value);
}

export async function registerTerminalControlPlane(
  app: FastifyInstance,
  options: TerminalControlPlaneOptions
): Promise<void> {
  const { pool, authProvider, config } = options;
  const registry = options.registry ?? new AgentRegistry();
  const grants = new GrantStore(config.grantsFile, (message) => app.log.warn(message));
  const repository = options.repository ?? new CauceRepository(pool);

  async function principal(request: FastifyRequest): Promise<Principal> {
    return validatePrincipal(await authProvider.authenticateHttp(request));
  }

  /** Open = neither closed nor revoked, and still inside its ticket or session window. */
  function openPredicate(ttlParameter: number): string {
    return `closed_at IS NULL AND revoked_at IS NULL
            AND ((consumed_at IS NULL AND expires_at > now())
                 OR (consumed_at IS NOT NULL AND consumed_at + make_interval(secs => $${ttlParameter}) > now()))`;
  }

  async function loadSession(sid: string): Promise<TerminalSessionRow | undefined> {
    const result = await pool.query<TerminalSessionRow>('SELECT * FROM terminal_sessions WHERE id=$1', [sid]);
    return result.rows[0];
  }

  async function currentCohort(tenantId: string, alias: string) {
    const placements = await loadFleetPlacements(pool);
    return containerCohort(placements, tenantId, alias);
  }

  function cohortLabels(cohort: Awaited<ReturnType<typeof currentCohort>>): string[] {
    return cohort.map(fleetIdentityLabel);
  }

  function sessionExpiry(row: TerminalSessionRow): Date | undefined {
    if (row.consumed_at === null) return undefined;
    return new Date(row.consumed_at.getTime() + config.sessionTtlSeconds * 1_000);
  }

  function relayGrant(row: TerminalSessionRow, resumeToken: string): Record<string, unknown> {
    const expiry = sessionExpiry(row) ?? row.expires_at;
    return {
      ok: true,
      tenant_id: row.tenant_id,
      alias: row.alias,
      mode: row.mode,
      cols: row.cols,
      rows: row.rows,
      operator_id: row.operator_id,
      container: row.container,
      runtime_user: row.runtime_user,
      expires_at: row.expires_at.toISOString(),
      session_expires_at: expiry.toISOString(),
      // Never persisted or logged. It only crosses the relay mTLS path and then the already
      // authenticated browser WebSocket as part of `ready`.
      resume_token: resumeToken
    };
  }

  interface LiveSessionAuthorization {
    readonly allowed: boolean;
    readonly reason: string;
    readonly expires_at?: Date;
  }

  /** One authority implementation shared by periodic authz and browser reconnect. */
  async function liveSessionAuthorization(row: TerminalSessionRow): Promise<LiveSessionAuthorization> {
    if (row.consumed_at === null) return { allowed: false, reason: 'not_consumed' };
    if (row.revoked_at !== null) return { allowed: false, reason: 'revoked' };
    if (row.closed_at !== null) return { allowed: false, reason: 'closed' };
    const expiry = sessionExpiry(row);
    if (!expiry || expiry.getTime() <= Date.now()) return { allowed: false, reason: 'session_expired' };
    const [actorTenant, actorAlias] = row.console_subject.split(':', 2) as [string, string?];
    if (actorAlias === undefined) return { allowed: false, reason: 'unknown_session' };
    const cohort = await currentCohort(row.tenant_id, row.alias);
    const authority = await cohortRoutingAuthority(pool, actorTenant, actorAlias, cohort);
    if (!authority.allowed) return { allowed: false, reason: 'no_routing_authority' };
    if (!(await grants.allowsCohort(row.operator_id, cohort, row.mode))) {
      return { allowed: false, reason: 'no_grant' };
    }
    return { allowed: true, reason: 'ok', expires_at: expiry };
  }

  /* ------------------------------------------------------------------ */
  /* Browser routes: /v3/console/terminal                                */
  /* ------------------------------------------------------------------ */

  app.get('/v3/console/terminal/targets', async (request, reply) => {
    try {
      const actor = await principal(request);
      requireOperatorPermission(actor, 'control');
      const operator = resolveOperator(request, actor, config);
      const now = Date.now();
      const placements = await loadFleetPlacements(pool);
      // One routing decision per (tenant, alias) even though cohorts overlap heavily.
      const decisions = new Map<string, Promise<RoutingAuthority>>();
      const authorityFor = (tenantId: string, alias: string): Promise<RoutingAuthority> => {
        const cacheKey = `${tenantId}\0${alias}`;
        let pending = decisions.get(cacheKey);
        if (!pending) {
          pending = routingAuthority(pool, actor.tenant_id, actor.alias, tenantId, alias);
          decisions.set(cacheKey, pending);
        }
        return pending;
      };
      const items: TerminalTarget[] = [];
      for (const placement of placements) {
        const cohort = containerCohort(placements, placement.tenant_id, placement.alias);
        const observation = registry.get(placement.tenant_id, placement.alias, now);
        const state = registry.state(placement.tenant_id, placement.alias, now);
        let authorized = attributionAllows(operator.attributed, actor.tenant_id, placement.tenant_id);
        for (const member of cohort) {
          if (!authorized) break;
          if (!attributionAllows(operator.attributed, actor.tenant_id, member.tenant_id)) {
            authorized = false;
            break;
          }
          authorized = (await authorityFor(member.tenant_id, member.alias)).allowed;
        }
        const reported = observation?.presence.modes ?? ['shell'];
        const modes: string[] = [];
        if (authorized) {
          for (const mode of reported) {
            if (!isTerminalMode(mode)) continue;
            if (await grants.allowsCohort(operator.operator_id, cohort, mode, now)) modes.push(mode);
          }
        }
        const usable = authorized && modes.length > 0;
        items.push({
          tenant_id: placement.tenant_id,
          alias: placement.alias,
          // Denial must not confirm what the target looks like, only that authority is missing.
          container: usable ? placement.container : null,
          runtime_user: usable ? (observation?.presence.runtime_user ?? placement.runtime_user) : null,
          harness: usable ? (observation?.presence.harness ?? null) : null,
          image: usable ? (observation?.presence.image_id ?? null) : null,
          shares_container_with: cohort
            .filter((member) => member.tenant_id !== placement.tenant_id || member.alias !== placement.alias)
            .map(fleetIdentity),
          modes: usable ? modes : [],
          pty_state: state,
          last_seen: observation?.observed_at ?? null,
          authorized: usable,
          reason: usable ? 'ok' : `sin autoridad sobre ${placement.tenant_id}:${placement.alias}`
        });
      }
      return {
        observed_at: new Date(now).toISOString(),
        websocket_path: config.wsPath,
        items
      };
    } catch (error) { replyError(reply, error); }
  });

  app.post('/v3/console/terminal/sessions', async (request, reply) => {
    const traceId = `trace-${randomUUID()}`;
    try {
      const actor = await principal(request);
      // Gate 1: in-process operator role and control permission.
      requireOperatorPermission(actor, 'control');
      const operator = resolveOperator(request, actor, config);
      const body = parseSessionRequest(request.body);
      const placements = await loadFleetPlacements(pool);
      const placement = fleetPlacement(placements, body.tenant_id, body.alias);
      const cohort = containerCohort(placements, body.tenant_id, body.alias);
      const audit: TerminalAuditContext = {
        operator_id: operator.operator_id,
        attributed: operator.attributed,
        target_tenant: body.tenant_id,
        target_alias: body.alias,
        container: placement?.container ?? null,
        cohort: cohortLabels(cohort),
        mode: body.mode
      };
      // Every outcome of this route is audited, allow and deny alike.
      const deny = async (status: 403 | 409, reason: string, extra: Record<string, unknown> = {}): Promise<void> => {
        await recordTerminalAudit(pool, {
          tenant_id: actor.tenant_id,
          actor_alias: actor.alias,
          action: 'terminal.session.request',
          decision: 'deny',
          trace_id: traceId,
          metadata: terminalAuditMetadata(audit, { reason, operator_reason: body.reason, ...extra })
        });
        await reply.code(status).send(
          status === 403 ? { error: 'forbidden', reason } : { error: 'conflict', reason }
        );
      };

      if (!placement) {
        await deny(403, 'unknown_alias');
        return;
      }
      // Gate 2: the database still grants `control` to the authenticated principal.
      try {
        await repository.assertPermission(actor.tenant_id, actor.alias, 'control');
      } catch {
        await deny(403, 'control_permission_required');
        return;
      }
      // Gate 3: HARD attribution invariant. Without a named human, only the actor's own tenant.
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
      const observation = registry.get(placement.tenant_id, body.alias);
      if (!observation || observation.stale || !observation.presence.modes.includes(body.mode)) {
        await deny(409, 'agent_offline', { pty_state: registry.state(placement.tenant_id, body.alias) });
        return;
      }
      const sessionId = randomUUID();
      const issuedAt = Date.now();
      const expiresAt = new Date(issuedAt + config.ticketTtlSeconds * 1_000);
      const payload: TicketPayload = {
        v: 1,
        sid: sessionId,
        op: operator.operator_id,
        sub: `${actor.tenant_id}:${actor.alias}`,
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
        iat: Math.floor(issuedAt / 1_000),
        exp: Math.floor(expiresAt.getTime() / 1_000)
      };
      const ticket = issueTicket(payload, deriveAliasKey(config.ticketKey, placement.tenant_id, body.alias));
      // Gate 7 and insertion share a transaction, but the locks MUST be acquired by earlier
      // statements. PostgreSQL takes a READ COMMITTED snapshot at statement start: putting the
      // advisory lock in the same CTE as COUNT lets a waiter resume with the stale pre-lock
      // snapshot and admit a second terminal. The admission statement below gets a fresh
      // snapshot after both ordered locks, and transaction-scoped locks leave no residue.
      const admissionClient = await pool.connect();
      let transactionOpen = false;
      let admitted: { rows: Array<{
        reason: 'ok' | 'session_limit' | 'container_busy'; id: string | null;
      }> };
      try {
        await admissionClient.query('BEGIN');
        transactionOpen = true;
        await admissionClient.query(
          `SELECT pg_advisory_xact_lock(hashtextextended('terminal:operator:' || $1, 0))`,
          [operator.operator_id]
        );
        await admissionClient.query(
          `SELECT pg_advisory_xact_lock(hashtextextended('terminal:container:' || $1, 0))`,
          [observation.presence.container_id]
        );
        admitted = await admissionClient.query<{
          reason: 'ok' | 'session_limit' | 'container_busy'; id: string | null;
        }>(
          `WITH decision AS MATERIALIZED (
           SELECT CASE
             WHEN (SELECT count(*) FROM terminal_sessions
                    WHERE operator_id=$1 AND ${openPredicate(3)}) >= $4 THEN 'session_limit'
             WHEN EXISTS (SELECT 1 FROM terminal_sessions
                    WHERE container=$2 AND ${openPredicate(3)}) THEN 'container_busy'
             ELSE 'ok'
           END AS reason
         ), inserted AS (
           INSERT INTO terminal_sessions(
             id, operator_id, attributed, console_subject, tenant_id, alias, container, generation,
             image_id, runtime_user, mode, ticket_sha256, reason, cols, rows, trace_id, expires_at
           )
           SELECT $5,$1,$6,$7,$8,$9,$2,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19
             FROM decision WHERE reason='ok'
           RETURNING id
         )
         SELECT decision.reason, inserted.id
           FROM decision LEFT JOIN inserted ON true`,
          [
            operator.operator_id, observation.presence.container_id, config.sessionTtlSeconds,
            config.maxSessionsPerOperator, sessionId, operator.attributed,
            `${actor.tenant_id}:${actor.alias}`, placement.tenant_id, body.alias,
            observation.presence.generation, observation.presence.image_id,
            observation.presence.runtime_user, body.mode, ticketSha256(ticket), body.reason,
            body.cols, body.rows, traceId, expiresAt.toISOString()
          ]
        );
        await admissionClient.query('COMMIT');
        transactionOpen = false;
      } catch (error) {
        if (transactionOpen) await admissionClient.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        admissionClient.release();
      }
      const admission = admitted.rows[0];
      if (!admission || admission.reason !== 'ok' || admission.id !== sessionId) {
        const reason = admission?.reason === 'session_limit' ? 'session_limit' : 'container_busy';
        await deny(409, reason);
        return;
      }
      await recordTerminalAudit(pool, {
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
          source_room_ids: authority.source_room_ids
        })
      });
      return await reply.code(201).send({
        session_id: sessionId,
        ticket,
        websocket_path: config.wsPath,
        expires_at: expiresAt.toISOString(),
        ttl_seconds: config.ticketTtlSeconds,
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
      const result = await pool.query<TerminalSessionRow>(
        `SELECT * FROM terminal_sessions WHERE operator_id=$1 ORDER BY issued_at DESC LIMIT 100`,
        [operator.operator_id]
      );
      return {
        items: result.rows.map((row) => ({
          session_id: row.id,
          tenant_id: row.tenant_id,
          alias: row.alias,
          mode: row.mode,
          opened_at: row.issued_at.toISOString(),
          expires_at: (sessionExpiry(row) ?? row.expires_at).toISOString(),
          state: sessionState(row)
        }))
      };
    } catch (error) { replyError(reply, error); }
  });

  app.delete<{ Params: { sid: string } }>('/v3/console/terminal/sessions/:sid', async (request, reply) => {
    try {
      const actor = await principal(request);
      requireOperatorPermission(actor, 'control');
      const operator = resolveOperator(request, actor, config);
      if (!UUID_PATTERN.test(request.params.sid)) throw new Error('session id is invalid');
      // Revocation is a flag, not a socket kill: terminal-relay revalidates every few seconds
      // and closes the WebSocket with 4403 once /authz stops answering ok.
      const revoked = await pool.query<TerminalSessionRow>(
        `UPDATE terminal_sessions SET revoked_at=now()
          WHERE id=$1 AND operator_id=$2 AND revoked_at IS NULL AND closed_at IS NULL RETURNING *`,
        [request.params.sid, operator.operator_id]
      );
      const row = revoked.rows[0];
      if (row) {
        await recordTerminalAudit(pool, {
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
            cohort: cohortLabels(await currentCohort(row.tenant_id, row.alias)),
            mode: row.mode
          }, { session_id: row.id, reason: 'operator_revoked' })
        });
      }
      return await reply.code(204).send();
    } catch (error) { replyError(reply, error); }
  });

  /* ------------------------------------------------------------------ */
  /* Browser route: la DIRECTIVA de un alias                             */
  /* ------------------------------------------------------------------ */

  /**
   * `GET /v3/console/agents/:tenant/:alias/directive` vive aquí, y no en app.ts, porque su
   * contenido sólo existe cuando existe el plano de terminal: el texto sale del pty-agent y viaja
   * por el terminal-relay. Con `CAUCE_TERMINAL_ENABLED` apagado no hay por dónde leer nada, y una
   * ruta que sólo sabría contestar «no disponible» es peor que una ruta que no está.
   *
   * Al colgar de `/v3/console/` hereda el gancho de seguridad de consola (Origin, Sec-Fetch-Site)
   * que app.ts instala ANTES de este plugin, igual que el resto de rutas de navegador.
   */
  const relayGovernance = options.governanceRelay ?? await buildGovernanceRelay(config);
  /*
   * El default deja de ser «nadie ha medido nada nunca» y pasa a ser la presencia REAL que el
   * pty-agent publica. Ver `hechos-del-registro.ts`: el `harness` ya viajaba y el `home` no, y ese
   * hueco era lo que dejaba toda la vía de documentos contestando «no medido» para siempre.
   *
   * Sigue siendo inyectable para los tests, y sigue devolviendo `undefined` cuando el agente no
   * publica su `home` —uno anterior a esta versión— o cuando su medición está vieja.
   */
  const measuredFacts: MeasuredFactsSource = options.measuredFacts ?? hechosDelRegistro(registry);

  async function authorizeDirective(raw: unknown): Promise<{ tenant_id: string; alias: string }> {
    const request = raw as FastifyRequest<{ Params: { tenant?: string; alias?: string } }>;
    const actor = await principal(request);
    // Mismo permiso que `GET /v3/console/agents`: leer el manual de un alias es leer la flota.
    requireOperatorPermission(actor, 'read');
    // El `:tenant` de la URL es parte del contrato y la ruta NO lo usa para resolver: resuelve
    // siempre contra el inquilino del actor. Sin esta comprobación, pedir `/Miguel/kratos/directive`
    // devolvería el manual de `Steven:kratos` con la URL diciendo otra cosa — un identificador sin
    // marco de referencia, que es como se sirve el fichero de otro sin que nadie lo note.
    if (request.params.tenant !== actor.tenant_id) {
      throw new AuthorizationError('ese inquilino no es el tuyo');
    }
    // Y con el inquilino ya clavado al del actor, «poder ver ese alias» ES el permiso `read`: la
    // visibilidad de `listAgents` es el propio inquilino más los que tenga por ACL, así que dentro
    // del propio inquilino no hay ninguna fila que el permiso deje ver y esta ruta no. Una consulta
    // extra a la base no cambiaría ni un resultado.
    if (typeof request.params.alias !== 'string' || !/^[a-z][a-z0-9_-]{1,63}$/.test(request.params.alias)) {
      throw new Error('alias is invalid');
    }
    return { tenant_id: actor.tenant_id, alias: actor.alias };
  }

  // Encapsulado en su propio ámbito para poder darle un manejador de errores: la ruta de directiva
  // no atrapa nada por dentro, así que sin esto un `AuthError` saldría como 500 y un operador sin
  // sesión vería «error interno» en vez de «no estás autenticado».
  const sondaReal = new TerminalRelayFactsProbe(measuredFacts, relayGovernance);

  /*
   * SE INSTALA LA SONDA EN EL HUECO que `app.ts` dejó, para que las rutas de documentos —montadas
   * antes que este plugin, con el resto de `/v3/console`— dejen de contestar «no hay canal».
   *
   * `app.sondaDeDocumentos` es opcional a propósito: los tests montan este plugin sobre instancias
   * de Fastify que no pasaron por `buildGateway`, y ahí no hay hueco que rellenar. No tenerlo no
   * es un fallo, es que ese gateway no sirve la consola.
   */
  app.sondaDeDocumentos?.instalar(sondaReal);

  await app.register(async (scope) => {
    scope.setErrorHandler((error, _request, reply) => { replyError(reply, error); });
    registerAgentDirectiveRoutes(scope, { authorize: authorizeDirective, probe: sondaReal });
  });

  /* ------------------------------------------------------------------ */
  /* Relay routes: /v3/terminal/relay                                    */
  /* ------------------------------------------------------------------ */

  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?', 1)[0];
    if (path?.startsWith('/v3/terminal/relay/') !== true) return;
    if (!relayAuthorized(request, config.relayToken)) {
      // No informative body: an unauthenticated caller learns nothing about the plane.
      await reply.code(401).send();
    }
  });

  app.post('/v3/terminal/relay/agents', async (request, reply) => {
    try {
      const body = request.body;
      if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('body must be an object');
      const agents = (body as Record<string, unknown>).agents;
      if (!Array.isArray(agents)) throw new Error('agents must be an array');
      registry.observe(agents.map(parseAgentPresence));
      return { ok: true };
    } catch (error) { replyError(reply, error); }
  });

  app.post<{ Params: { sid: string } }>('/v3/terminal/relay/sessions/:sid/consume', async (request, reply) => {
    const sid = request.params.sid;
    const invalid = async (): Promise<void> => {
      await reply.code(401).send({ ok: false, reason: 'ticket_invalid' });
    };
    try {
      if (!UUID_PATTERN.test(sid)) { await invalid(); return; }
      const body = request.body;
      const ticket = body !== null && typeof body === 'object' && !Array.isArray(body)
        ? (body as Record<string, unknown>).ticket : undefined;
      if (typeof ticket !== 'string' || ticket.length === 0 || ticket.length > 4_096) { await invalid(); return; }
      const row = await loadSession(sid);
      if (!row) { await invalid(); return; }
      let payload: TicketPayload;
      try {
        payload = parseAndVerify(ticket, deriveAliasKey(config.ticketKey, row.tenant_id, row.alias));
      } catch (error) {
        if (!(error instanceof TicketError)) throw error;
        await invalid();
        return;
      }
      // Bind the presented ticket to the row that was issued: sid inside the payload, and the
      // digest stored at issue time. A ticket minted for another alias fails the HMAC above.
      if (payload.sid !== sid || !ticketSha256(ticket).equals(row.ticket_sha256)) { await invalid(); return; }
      const claimed = await pool.query<TerminalSessionRow>(
        `UPDATE terminal_sessions SET consumed_at=now()
          WHERE id=$1 AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > now() RETURNING *`,
        [sid]
      );
      const session = claimed.rows[0];
      if (!session) {
        // Replaying a ticket is the interesting case and gets its own code; everything else
        // (revoked, expired) is indistinguishable from an invalid ticket on purpose.
        if (row.consumed_at !== null) {
          await recordTerminalAudit(pool, {
            tenant_id: row.tenant_id,
            actor_alias: row.alias,
            action: 'terminal.session.consume',
            decision: 'deny',
            ...(row.trace_id === null ? {} : { trace_id: row.trace_id }),
            metadata: terminalAuditMetadata({
              operator_id: row.operator_id, attributed: row.attributed, target_tenant: row.tenant_id,
              target_alias: row.alias, container: row.container,
              cohort: cohortLabels(await currentCohort(row.tenant_id, row.alias)),
              mode: row.mode
            }, { session_id: sid, reason: 'already_consumed', ticket_sha256: ticketDigest(ticket) })
          });
          await reply.code(409).send({ ok: false, reason: 'already_consumed' });
          return;
        }
        await invalid();
        return;
      }
      await recordTerminalAudit(pool, {
        tenant_id: session.tenant_id,
        actor_alias: session.alias,
        action: 'terminal.session.consume',
        decision: 'info',
        ...(session.trace_id === null ? {} : { trace_id: session.trace_id }),
        metadata: terminalAuditMetadata({
          operator_id: session.operator_id, attributed: session.attributed,
          target_tenant: session.tenant_id, target_alias: session.alias, container: session.container,
          cohort: cohortLabels(await currentCohort(session.tenant_id, session.alias)), mode: session.mode
        }, {
          session_id: sid,
          image_id: session.image_id,
          generation: session.generation,
          operator_reason: session.reason,
          cols: session.cols,
          rows: session.rows,
          ticket_sha256: ticketDigest(ticket)
        })
      });
      const expiry = sessionExpiry(session) ?? session.expires_at;
      const resumeToken = issueResumeToken(
        session.id, session.operator_id, Math.floor(expiry.getTime() / 1_000), config.ticketKey
      );
      return await reply.code(200).send(relayGrant(session, resumeToken));
    } catch (error) { replyError(reply, error); }
  });

  app.post<{ Params: { sid: string } }>('/v3/terminal/relay/sessions/:sid/resume', async (request, reply) => {
    const sid = request.params.sid;
    const refuse = async (status: 401 | 403, reason: string): Promise<void> => {
      // Authentication failures intentionally share the same small body. A caller on this route
      // already passed the relay bearer gate, but a stale/forged browser credential learns no row.
      await reply.code(status).send({ ok: false, reason });
    };
    try {
      if (!UUID_PATTERN.test(sid)) { await refuse(401, 'resume_invalid'); return; }
      const body = request.body;
      const token = body !== null && typeof body === 'object' && !Array.isArray(body)
        ? (body as Record<string, unknown>).resume_token : undefined;
      if (typeof token !== 'string' || token.length < 80 || token.length > 1_024) {
        await refuse(401, 'resume_invalid');
        return;
      }
      const row = await loadSession(sid);
      if (!row) { await refuse(401, 'resume_invalid'); return; }
      let credential;
      try {
        credential = parseResumeToken(token, config.ticketKey);
      } catch (error) {
        if (!(error instanceof TicketError)) throw error;
        await refuse(401, 'resume_invalid');
        return;
      }
      const expiry = sessionExpiry(row);
      if (credential.sid !== sid || credential.op !== row.operator_id || expiry === undefined ||
          credential.exp !== Math.floor(expiry.getTime() / 1_000)) {
        await refuse(401, 'resume_invalid');
        return;
      }
      const authorization = await liveSessionAuthorization(row);
      if (!authorization.allowed) { await refuse(403, authorization.reason); return; }
      await recordTerminalAudit(pool, {
        tenant_id: row.tenant_id,
        actor_alias: row.alias,
        action: 'terminal.session.resume',
        decision: 'info',
        ...(row.trace_id === null ? {} : { trace_id: row.trace_id }),
        metadata: terminalAuditMetadata({
          operator_id: row.operator_id, attributed: row.attributed,
          target_tenant: row.tenant_id, target_alias: row.alias, container: row.container,
          cohort: cohortLabels(await currentCohort(row.tenant_id, row.alias)), mode: row.mode
        }, { session_id: row.id })
      });
      return await reply.code(200).send(relayGrant(row, token));
    } catch (error) { replyError(reply, error); }
  });

  app.get<{ Params: { sid: string } }>('/v3/terminal/relay/sessions/:sid/authz', async (request, reply) => {
    try {
      if (!UUID_PATTERN.test(request.params.sid)) throw new Error('session id is invalid');
      const row = await loadSession(request.params.sid);
      const refuse = async (reason: string): Promise<void> => {
        if (row) {
          await recordTerminalAudit(pool, {
            tenant_id: row.tenant_id,
            actor_alias: row.alias,
            action: 'terminal.session.revoked',
            decision: 'info',
            ...(row.trace_id === null ? {} : { trace_id: row.trace_id }),
            metadata: terminalAuditMetadata({
              operator_id: row.operator_id, attributed: row.attributed, target_tenant: row.tenant_id,
              target_alias: row.alias, container: row.container,
              cohort: cohortLabels(await currentCohort(row.tenant_id, row.alias)),
              mode: row.mode
            }, { session_id: row.id, reason })
          });
        }
        await reply.code(403).send({ ok: false, reason });
      };
      if (!row) { await refuse('unknown_session'); return; }
      // Grants and routing authority are re-read here, never cached across calls: emptying
      // grants.json must cut a live shell within one revalidation round.
      const authorization = await liveSessionAuthorization(row);
      if (!authorization.allowed || authorization.expires_at === undefined) {
        await refuse(authorization.reason);
        return;
      }
      return { ok: true, expires_at: authorization.expires_at.toISOString() };
    } catch (error) { replyError(reply, error); }
  });

  app.post<{ Params: { sid: string } }>('/v3/terminal/relay/sessions/:sid/close', async (request, reply) => {
    try {
      if (!UUID_PATTERN.test(request.params.sid)) throw new Error('session id is invalid');
      const body = request.body;
      if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('body must be an object');
      const record = body as Record<string, unknown>;
      const reason = typeof record.reason === 'string' && record.reason.length > 0
        ? record.reason.slice(0, 128) : 'relay_closed';
      const exitCode = typeof record.exit_code === 'number' && Number.isSafeInteger(record.exit_code)
        ? record.exit_code : null;
      const bytesIn = boundedInteger(record.bytes_in ?? 0, 0, Number.MAX_SAFE_INTEGER, 'bytes_in');
      const bytesOut = boundedInteger(record.bytes_out ?? 0, 0, Number.MAX_SAFE_INTEGER, 'bytes_out');
      const closed = await pool.query<TerminalSessionRow>(
        `UPDATE terminal_sessions
            SET closed_at=now(), close_reason=$2, bytes_in=$3, bytes_out=$4
          WHERE id=$1 AND closed_at IS NULL RETURNING *`,
        [request.params.sid, reason, bytesIn, bytesOut]
      );
      const row = closed.rows[0];
      if (row) {
        await recordTerminalAudit(pool, {
          tenant_id: row.tenant_id,
          actor_alias: row.alias,
          action: 'terminal.session.close',
          decision: 'info',
          ...(row.trace_id === null ? {} : { trace_id: row.trace_id }),
          metadata: terminalAuditMetadata({
            operator_id: row.operator_id, attributed: row.attributed, target_tenant: row.tenant_id,
            target_alias: row.alias, container: row.container,
            cohort: cohortLabels(await currentCohort(row.tenant_id, row.alias)),
            mode: row.mode
          }, {
            session_id: row.id,
            image_id: row.image_id,
            generation: row.generation,
            operator_reason: row.reason,
            close_reason: reason,
            exit_code: exitCode,
            bytes_in: counterValue(row.bytes_in),
            bytes_out: counterValue(row.bytes_out)
          })
        });
      }
      return await reply.code(204).send();
    } catch (error) { replyError(reply, error); }
  });
}
