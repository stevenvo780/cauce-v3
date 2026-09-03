import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  StoreError, currentControlHold, releaseControlHold, takeControlHold, type DatabasePool,
} from '@cauce/store';
import { UUID_ANY_PATTERN } from '@cauce/protocol';
import { requireOperatorPermission, type Principal } from '../../auth.js';
import {
  recordTerminalAudit, terminalAuditMetadata, type TerminalAuditContext,
} from '../audit.js';
import {
  resolveOperator, writableModeRequiresAttribution, type ResolvedOperator,
} from '../authority.js';
import {
  cohortLabels, ownedLiveSessionQuery, subjectFor, type OwnedTerminalSession,
} from '../helpers.js';
import type { TerminalSessionControlOptions } from '../session-control.js';
import { UNATTRIBUTED_OPERATOR, type TerminalSessionRow } from '../types.js';

/**
 * Taking control is the writable action and its reason is hand typed, never generated. Giving it
 * back is not: `beforeunload` has nobody left to type, so a release without a reason carries this
 * one and still leaves the audit trail saying who gave the alias back.
 */
const DEFAULT_RELEASE_REASON = 'operator_released';

type TeardownSessionRow = Pick<
  TerminalSessionRow,
  'id' | 'tenant_id' | 'alias' | 'mode' | 'trace_id' | 'operator_id' | 'attributed' | 'container'
>;

/**
 * Taking and giving back the control of a writable TUI. While the hold is live the deliveries of
 * the alias stay `pending`: `claimOne` does not select them, so nothing is lost and nothing is
 * reordered. The hold is bounded twice — by `controlHoldSeconds` and by the session window — so a
 * browser that dies without releasing can never mute an alias beyond its own session.
 */
export function registerTerminalControlRoute(
  app: FastifyInstance,
  options: TerminalSessionControlOptions,
): void {
  const {
    pool, config, grants, repository, principal, currentCohort, parseControlRequest, replyError,
  } = options;

  async function auditContext(row: TerminalSessionRow): Promise<TerminalAuditContext> {
    return {
      operator_id: row.operator_id,
      attributed: row.attributed,
      target_tenant: row.tenant_id,
      target_alias: row.alias,
      container: row.container,
      cohort: cohortLabels(await currentCohort(row.tenant_id, row.alias)),
      mode: row.mode,
    };
  }

  async function auditControl(
    actor: Principal,
    row: TerminalSessionRow,
    action: 'terminal.control_taken' | 'terminal.control_released',
    decision: 'allow' | 'deny' | 'info',
    extra: Record<string, unknown>,
  ): Promise<void> {
    await recordTerminalAudit(pool, {
      tenant_id: actor.tenant_id,
      actor_alias: actor.alias,
      action,
      decision,
      ...(row.trace_id === null ? {} : { trace_id: row.trace_id }),
      metadata: terminalAuditMetadata(await auditContext(row), { session_id: row.id, ...extra }),
    });
  }

  async function takeHold(
    reply: FastifyReply,
    actor: Principal,
    operator: ResolvedOperator,
    session: OwnedTerminalSession,
    holdReason: string,
  ): Promise<void> {
    const untilSessionEnds = session.session_expires_at.getTime() - Date.now();
    const windowMs = Math.max(1, Math.min(
      (config.controlHoldSeconds ?? 0) * 1_000,
      untilSessionEnds,
    ));
    let hold;
    try {
      hold = await takeControlHold(pool, {
        tenantId: session.tenant_id,
        alias: session.alias,
        sessionId: session.id,
        operatorId: operator.operator_id,
        reason: holdReason,
        windowMs,
      });
    } catch (error) {
      if (!(error instanceof StoreError) || error.code !== 'conflict') throw error;
      const live = await currentControlHold(pool, session.tenant_id, session.alias);
      await reply.code(409).send({
        error: 'conflict',
        reason: 'control_held',
        held_by: live?.operator_id ?? null,
        expires_at: live?.expires_at.toISOString() ?? null,
      });
      return;
    }
    await auditControl(actor, session, 'terminal.control_taken', 'allow', {
      operator_reason: holdReason,
      hold_id: hold.id,
      expires_at: hold.expires_at.toISOString(),
    });
    await reply.code(200).send({
      session_id: session.id,
      hold_id: hold.id,
      held_by: hold.operator_id,
      expires_at: hold.expires_at.toISOString(),
    });
  }

  app.post<{ Params: { sid: string } }>('/v3/console/terminal/sessions/:sid/control', async (request, reply) => {
    try {
      const actor = await principal(request);
      requireOperatorPermission(actor, 'control');
      try {
        await repository.assertPermission(actor.tenant_id, actor.alias, 'control');
      } catch {
        await reply.code(403).send({ error: 'forbidden', reason: 'control_permission_required' });
        return;
      }
      if (config.writableTuiEnabled !== true) {
        await reply.code(403).send({ error: 'forbidden', reason: 'writable_tui_disabled' });
        return;
      }
      const operator = resolveOperator(request, actor, config);
      if (!UUID_ANY_PATTERN.test(request.params.sid)) throw new Error('session id is invalid');
      const body = parseControlRequest(request.body);
      const query = ownedLiveSessionQuery({
        sessionId: request.params.sid,
        body,
        operator,
        consoleSubject: subjectFor(actor),
        config,
      });
      const owned = await pool.query<OwnedTerminalSession>(query.text, query.values);
      const row = owned.rows[0];
      if (row === undefined) {
        await reply.code(409).send({ error: 'conflict', reason: 'stale_terminal_owner' });
        return;
      }
      const action = body.action === 'take' ? 'terminal.control_taken' : 'terminal.control_released';
      const deny = async (status: 403 | 409, reason: string): Promise<void> => {
        await auditControl(actor, row, action, 'deny', { reason });
        await reply.code(status).send(
          status === 403 ? { error: 'forbidden', reason } : { error: 'conflict', reason },
        );
      };
      if (row.mode !== 'harness_rw') {
        await deny(409, 'no_recognized_mode');
        return;
      }
      if (body.action === 'release') {
        const releaseReason = body.reason ?? DEFAULT_RELEASE_REASON;
        const current = await currentControlHold(pool, row.tenant_id, row.alias);
        const live = current?.session_id === row.id ? current : undefined;
        // A browser retries this from `beforeunload`, so a hold already gone is a success.
        if (live === undefined) {
          await reply.code(200).send({ session_id: row.id, hold_id: null, released: true });
          return;
        }
        if (live.operator_id !== operator.operator_id) {
          await deny(403, 'control_held');
          return;
        }
        const released = await releaseControlHold(
          pool, { tenantId: row.tenant_id, alias: row.alias, holdId: live.id }, releaseReason,
        );
        await auditControl(actor, row, action, 'allow', {
          hold_id: released.id, reason: releaseReason,
        });
        await reply.code(200).send({
          session_id: row.id, hold_id: released.id, released: true,
        });
        return;
      }
      if (operator.operator_id === UNATTRIBUTED_OPERATOR) {
        await deny(403, 'writable_requires_named_operator');
        return;
      }
      if (writableModeRequiresAttribution(row.mode, operator.attributed)) {
        await deny(403, 'writable_requires_attribution');
        return;
      }
      const cohort = await currentCohort(row.tenant_id, row.alias);
      // Re-read from disk over the WHOLE container cohort, like gate 5 of POST /sessions. A '*'
      // grant can never satisfy it: the parser refuses a wildcard carrying a writable mode.
      if (!(await grants.allowsCohort(operator.operator_id, cohort, row.mode))) {
        await deny(403, 'no_grant_for_operator');
        return;
      }
      if (body.reason === undefined) throw new Error('taking control requires a typed reason');
      await takeHold(reply, actor, operator, row, body.reason);
    } catch (error) { replyError(reply, error); }
  });
}

/**
 * Teardown path: closing or revoking a session gives the alias its queue back at once. The hold
 * expiry is only the net under this, never the mechanism, so a lost release costs at most the
 * remaining session window.
 */
export async function releaseHeldControl(
  pool: DatabasePool, row: TeardownSessionRow, reason: string,
): Promise<void> {
  if (row.mode !== 'harness_rw') return;
  try {
    const hold = await currentControlHold(pool, row.tenant_id, row.alias);
    if (hold?.session_id !== row.id) return;
    await releaseControlHold(
      pool, { tenantId: row.tenant_id, alias: row.alias, holdId: hold.id }, reason,
    );
    await recordTerminalAudit(pool, {
      tenant_id: row.tenant_id,
      actor_alias: row.alias,
      action: 'terminal.control_released',
      decision: 'info',
      ...(row.trace_id === null ? {} : { trace_id: row.trace_id }),
      metadata: terminalAuditMetadata({
        operator_id: row.operator_id,
        attributed: row.attributed,
        target_tenant: row.tenant_id,
        target_alias: row.alias,
        container: row.container,
        cohort: [],
        mode: row.mode,
      }, { session_id: row.id, hold_id: hold.id, reason }),
    });
  } catch (error) {
    // A hold released concurrently is not a failure of the close it hangs off.
    if (!(error instanceof StoreError)) throw error;
  }
}
