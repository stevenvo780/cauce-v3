import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import {
  withTransaction, StoreError, takeControlHoldWithinTransaction, releaseSessionControlHolds,
  TerminalAgentBusyError, type DatabaseClient,
} from '@cauce/store';
import { UUID_ANY_PATTERN } from '@cauce/protocol';
import {
  terminalAuditMetadata, terminalSessionAuditContext, type TerminalAuditEntry,
} from '../audit.js';
import { writableModeRequiresAttribution } from '../authority.js';
import { cohortLabels, ownedLiveSessionQuery } from '../helpers.js';
import { terminalDatabaseNow } from '../session-authority.js';
import { encodeTerminalSubject } from '../authority-continuity.js';
import type { TerminalSessionControlOptions } from '../session-control.js';
import { UNATTRIBUTED_OPERATOR, type TerminalSessionRow } from '../types.js';
import { authorizeTerminalControlActor } from './control-authorization.js';

type TeardownSessionRow = Pick<TerminalSessionRow,
  'id' | 'tenant_id' | 'alias' | 'mode' | 'trace_id' | 'operator_id' | 'attributed' | 'container'>;

export function registerTerminalControlRoute(app: FastifyInstance, options: TerminalSessionControlOptions): void {
  const { pool, config, grants, repository, authority, principal, currentCohort,
    parseControlRequest, replyError, recordTransactionalTerminalAudit } = options;
  app.post<{ Params: { sid: string } }>('/v3/console/terminal/sessions/:sid/control', async (request, reply) => {
    try {
      const actor = await authorizeTerminalControlActor(request, reply, { principal, repository });
      if (actor === undefined) return;
      if (config.writableTuiEnabled !== true) {
        await reply.code(403).send({ error: 'forbidden', reason: 'writable_tui_disabled' }); return;
      }
      if (!UUID_ANY_PATTERN.test(request.params.sid)) throw new Error('session id is invalid');
      const body = parseControlRequest(request.body);
      const proof = await authority.browserProof(request, body.authority_proof);
      if (proof.sessionId !== request.params.sid) throw new Error('terminal authority is unavailable');
      const outcome = await withTransaction(pool, async (client) => {
        const deadline = await authority.lockSession(client, proof, repository);
        const owned = ownedLiveSessionQuery({ sessionId: request.params.sid, body,
          operator: { operator_id: actor.operator_id ?? UNATTRIBUTED_OPERATOR, attributed: true },
          consoleSubject: encodeTerminalSubject(proof.origin), config, lock: true });
        const row = (await client.query<TerminalSessionRow>(owned.text, owned.values)).rows[0];
        if (row === undefined) return { status: 409, body: { error: 'conflict', reason: 'stale_terminal_owner' } };
        const cohort = await currentCohort(row.tenant_id, row.alias, client);
        const audit = async (action: 'terminal.control_taken' | 'terminal.control_released', metadata: Record<string, unknown>, decision: 'allow' | 'deny' = 'allow') => {
          await recordTransactionalTerminalAudit(client, { tenant_id: actor.tenant_id, actor_alias: actor.alias,
            action, decision, ...(row.trace_id === null ? {} : { trace_id: row.trace_id }),
            metadata: terminalAuditMetadata(terminalSessionAuditContext(row, cohortLabels(cohort)),
              { session_id: row.id, ...metadata }) });
        };
        const deny = async (status: 403 | 409, reason: string, extra: Record<string, unknown> = {}) => {
          await audit(body.action === 'take' ? 'terminal.control_taken' : 'terminal.control_released', { reason }, 'deny');
          await terminalDatabaseNow(client, deadline);
          return { status, body: { error: status === 403 ? 'forbidden' : 'conflict', reason, ...extra } };
        };
        if (row.mode !== 'harness_rw') return deny(409, 'no_recognized_mode');
        if (body.action === 'release') {
          const live = (await client.query<{ id: string; session_id: string }>(
            `SELECT id,session_id FROM terminal_control_holds WHERE tenant_id=$1 AND alias=$2
             AND released_at IS NULL AND expires_at>clock_timestamp() FOR UPDATE`, [row.tenant_id, row.alias],
          )).rows[0];
          if (live === undefined) return { status: 200, body: { session_id: row.id, hold_id: null, released: true } };
          if (live.session_id !== row.id) return deny(409, 'control_held');
          const reason = body.reason ?? 'operator_released';
          await releaseSessionControlHolds(client, row.id, reason);
          await audit('terminal.control_released', { hold_id: live.id, reason });
          await terminalDatabaseNow(client, deadline);
          return { status: 200, body: { session_id: row.id, hold_id: live.id, released: true } };
        }
        if (row.operator_id === UNATTRIBUTED_OPERATOR || writableModeRequiresAttribution(row.mode, row.attributed)) {
          return deny(403, row.operator_id === UNATTRIBUTED_OPERATOR ? 'writable_requires_named_operator' : 'writable_requires_attribution');
        }
        if (!(await grants.allowsCohort(row.operator_id, cohort, row.mode))) {
          return deny(403, 'no_grant_for_operator');
        }
        if (body.reason === undefined) throw new Error('taking control requires a typed reason');
        await client.query('SAVEPOINT terminal_control_take');
        let hold;
        try { hold = await takeControlHoldWithinTransaction(client, { tenantId: row.tenant_id, alias: row.alias,
          sessionId: row.id, operatorId: row.operator_id, reason: body.reason, allowBusy: body.allow_busy === true,
          windowMs: Math.max(1, (config.controlHoldSeconds ?? 0) * 1000), sessionTtlSeconds: config.sessionTtlSeconds,
          sessionMaxTotalSeconds: config.sessionMaxTotalSeconds ?? null }, deadline);
          await client.query('RELEASE SAVEPOINT terminal_control_take');
        } catch (error) {
          await client.query('ROLLBACK TO SAVEPOINT terminal_control_take');
          await client.query('RELEASE SAVEPOINT terminal_control_take');
          if (error instanceof TerminalAgentBusyError) return deny(409, 'agent_busy');
          if (error instanceof StoreError && error.code === 'not_found') return deny(409, 'stale_terminal_owner');
          if (!(error instanceof StoreError) || error.code !== 'conflict') throw error;
          const live = (await client.query<{ operator_id: string; expires_at: Date }>(
            `SELECT operator_id,expires_at FROM terminal_control_holds WHERE tenant_id=$1 AND alias=$2
             AND released_at IS NULL AND expires_at>clock_timestamp()`, [row.tenant_id, row.alias],
          )).rows[0];
          return deny(409, 'control_held', { held_by: live?.operator_id ?? null, expires_at: live?.expires_at.toISOString() ?? null });
        }
        await audit('terminal.control_taken', { operator_reason: body.reason, allow_busy: body.allow_busy === true,
          hold_id: hold.id, expires_at: hold.expires_at.toISOString() });
        await terminalDatabaseNow(client, deadline);
        return { status: 200, body: { session_id: row.id, hold_id: hold.id,
          held_by: hold.operator_id, expires_at: hold.expires_at.toISOString() } };
      });
      await reply.code(outcome.status).send(outcome.body);
    } catch (error) {
      if (error instanceof TerminalAgentBusyError) { await reply.code(409).send({ error: 'conflict', reason: 'agent_busy' }); return; }
      if (error instanceof StoreError && error.code === 'conflict') {
        await reply.code(409).send({ error: 'conflict', reason: 'control_held' }); return;
      }
      replyError(reply, error);
    }
  });
}

export interface TerminalControlTeardown {
  readonly client: DatabaseClient;
  readonly row: TeardownSessionRow;
  readonly reason: string;
  readonly log: FastifyBaseLogger;
  readonly recordAudit: (client: DatabaseClient, entry: TerminalAuditEntry) => Promise<void>;
}

/**
 * Teardown path: closing or revoking a session gives the alias its queue back at once, in the SAME
 * transaction that settles the session. The hold expiry is only the net under this, never the
 * mechanism. A release that fails takes the close down with it — the relay respools and retries —
 * instead of leaving the alias muted with nothing in the log.
 */
export async function releaseHeldControl(teardown: TerminalControlTeardown): Promise<void> {
  const { client, row, reason, log, recordAudit } = teardown;
  if (row.mode !== 'harness_rw') return;
  try {
    for (const hold of await releaseSessionControlHolds(client, row.id, reason)) {
      await recordAudit(client, {
        tenant_id: row.tenant_id,
        actor_alias: row.alias,
        action: 'terminal.control_released',
        decision: 'info',
        ...(row.trace_id === null ? {} : { trace_id: row.trace_id }),
        metadata: terminalAuditMetadata(
          terminalSessionAuditContext(row, []),
          { session_id: row.id, hold_id: hold.id, reason },
        ),
      });
    }
  } catch (error) {
    log.error({ session_id: row.id, reason, err: error }, 'terminal control hold was not released');
    throw error;
  }
}
