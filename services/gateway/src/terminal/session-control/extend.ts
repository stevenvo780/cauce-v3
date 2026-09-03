import type { FastifyInstance } from 'fastify';
import { withTransaction } from '@cauce/store';
import { UUID_ANY_PATTERN } from '@cauce/protocol';
import { requireOperatorPermission } from '../../auth.js';
import { terminalAuditMetadata } from '../audit.js';
import { resolveOperator } from '../authority.js';
import {
  cohortLabels, operatorScopePredicate, ownedLiveSessionQuery, sessionWindowExpression, subjectFor,
  type OwnedTerminalSession,
} from '../helpers.js';
import type { TerminalSessionControlOptions } from '../session-control.js';
import { ticketSha256 } from '../tickets.js';

/**
 * TUI-06: the operator pushes the window of a live session forward, never past
 * `consumed_at + sessionMaxTotalSeconds`. `consumed_at` is NOT touched — it feeds the slot
 * accounting of the console — so the extension lives in `window_extended_to` alone.
 *
 * A longer window is safe because it does not weaken revocation: terminal-relay revalidates the
 * session against `/authz` every 30 s, and that route re-evaluates `currentSessionPolicy` —
 * grants.json included — on every cycle, so withdrawing a grant still closes the socket.
 *
 * This call is also the presence proof for idle: neither PTY output nor a browser ping rearms
 * the idle timer of a writable session, because a forgotten tab with a chatty process would
 * otherwise keep an abandoned shell alive forever.
 */
export function registerTerminalExtendRoute(
  app: FastifyInstance,
  options: TerminalSessionControlOptions,
): void {
  const {
    pool, config, repository, principal, currentCohort, parseSessionExtend, replyError,
    recordTransactionalTerminalAudit,
  } = options;

  app.post<{ Params: { sid: string } }>('/v3/console/terminal/sessions/:sid/extend', async (request, reply) => {
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
      if (!UUID_ANY_PATTERN.test(request.params.sid)) throw new Error('session id is invalid');
      const body = parseSessionExtend(request.body);
      const owned = ownedLiveSessionQuery({
        sessionId: request.params.sid,
        body,
        operator,
        consoleSubject: subjectFor(actor),
        config,
        lock: true,
      });
      const windowSql = sessionWindowExpression(8, 9);
      const pushed = 'LEAST(now()+make_interval(secs => $8), consumed_at+make_interval(secs => $9))';
      type ExtendOutcome =
        | { readonly row: OwnedTerminalSession }
        | { readonly reason: 'stale_terminal_owner' | 'extension_exhausted' };
      const outcome: ExtendOutcome = await withTransaction<ExtendOutcome>(pool, async (client) => {
        const locked = await client.query<OwnedTerminalSession>(owned.text, owned.values);
        if (locked.rows[0] === undefined) return { reason: 'stale_terminal_owner' };
        const extended = await client.query<OwnedTerminalSession>(
          `UPDATE terminal_sessions SET window_extended_to=${pushed}
            WHERE id=$1 AND ${operatorScopePredicate(2, 3, 4)}
              AND request_id=$5
              AND browser_owner_generation=$6::bigint
              AND browser_owner_sha256=$7
              AND consumed_at IS NOT NULL AND revoked_at IS NULL AND closed_at IS NULL
              AND ${pushed}>${windowSql}
            RETURNING *, ${windowSql} AS session_expires_at`,
          [
            request.params.sid,
            operator.operator_id,
            operator.attributed,
            subjectFor(actor),
            body.request_id,
            body.owner_generation,
            ticketSha256(body.owner_token),
            config.sessionTtlSeconds,
            config.sessionMaxTotalSeconds ?? null,
          ],
        );
        const row = extended.rows[0];
        if (row === undefined) return { reason: 'extension_exhausted' };
        await recordTransactionalTerminalAudit(client, {
          tenant_id: actor.tenant_id,
          actor_alias: actor.alias,
          action: 'terminal.session.extended',
          decision: 'info',
          ...(row.trace_id === null ? {} : { trace_id: row.trace_id }),
          metadata: terminalAuditMetadata({
            operator_id: row.operator_id,
            attributed: row.attributed,
            target_tenant: row.tenant_id,
            target_alias: row.alias,
            container: row.container,
            cohort: cohortLabels(await currentCohort(row.tenant_id, row.alias, client)),
            mode: row.mode,
          }, {
            session_id: row.id,
            request_id: row.request_id,
            expires_at: row.session_expires_at.toISOString(),
          }),
        });
        return { row };
      });
      if (!('row' in outcome)) {
        await reply.code(409).send({ error: 'conflict', reason: outcome.reason });
        return;
      }
      return await reply.code(200).send({
        session_id: outcome.row.id,
        request_id: outcome.row.request_id,
        expires_at: outcome.row.session_expires_at.toISOString(),
      });
    } catch (error) { replyError(reply, error); }
  });
}
