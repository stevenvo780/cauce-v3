import type { FastifyReply, FastifyRequest } from 'fastify';
import { requireOperatorPermission, type Principal } from '../../auth.js';
import type { TerminalSessionControlOptions } from '../session-control.js';

type ControlAuthorizationOptions = Pick<
  TerminalSessionControlOptions,
  'principal' | 'repository'
>;

export async function authorizeTerminalControlActor(
  request: FastifyRequest,
  reply: FastifyReply,
  options: ControlAuthorizationOptions,
): Promise<Principal | undefined> {
  const actor = await options.principal(request);
  requireOperatorPermission(actor, 'control');
  try {
    await options.repository.assertPermission(actor.tenant_id, actor.alias, 'control');
  } catch {
    await reply.code(403).send({ error: 'forbidden', reason: 'control_permission_required' });
    return undefined;
  }
  return actor;
}
