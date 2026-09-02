import type { FastifyInstance } from 'fastify';
import { withTransaction } from '@cauce/store';
import { UUID_ANY_PATTERN } from '@cauce/protocol';
import { requireOperatorPermission } from '../../auth.js';
import { terminalAuditMetadata } from '../audit.js';
import { resolveOperator } from '../authority.js';
import { cohortLabels, operatorScopePredicate, subjectFor } from '../helpers.js';
import type { TerminalSessionControlOptions } from '../session-control.js';
import { ticketSha256 } from '../tickets.js';
import type { TerminalSessionRow } from '../types.js';

/** Rolls back a guarded transition without turning a no-op into a transport error. */
class TerminalTransactionNoop extends Error {}

/**
 * Ownership of an open terminal slot: takeover by a second browser tab and explicit release.
 *
 * Both write under the operator scope with a fenced `browser_owner_generation`, so a stale tab can
 * observe but never mutate, and both answer the same 409 rather than describing the row.
 */
export function registerTerminalBrowserOwnerRoutes(
  app: FastifyInstance,
  options: TerminalSessionControlOptions,
): void {
  const {
    pool, config, repository, principal, currentCohort, parseOwnerRotation, parseDeleteSession,
    browserOwnerGeneration, replyError, recordTransactionalTerminalAudit,
  } = options;

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
      if (!UUID_ANY_PATTERN.test(request.params.sid)) throw new Error('session id is invalid');
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
      if (!UUID_ANY_PATTERN.test(request.params.sid)) throw new Error('session id is invalid');
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
