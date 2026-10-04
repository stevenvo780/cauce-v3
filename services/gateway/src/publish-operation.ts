import { SYSTEM_GATE_PROBE_MESSAGE_TYPE, SystemGateProbeBodySchema } from '@cauce/protocol';
import { StoreError, type HumanMessageOptions, type PublishOptions, type PublishResult } from '@cauce/store';
import { AuthorizationError, isAgentPrincipal, requirePermission, type Principal } from './auth.js';
import type { GatewayRepository } from './app.js';
import { consoleMessageAuthor } from './console-message-author.js';
import { redactPublishBody, type PublishRedaction } from './routes/publish-redaction.js';
import {
  consolePublishOperatorScope, publicPublish, trustedPublishSemanticsForContext,
  validatedPublishReceipt, type PublishSemanticsContext, type TrustedPublishCommand,
} from './routes/shared.js';

export interface PublishOperationInput {
  readonly actor: Principal;
  readonly body: unknown;
  /** Selected by the authenticated transport adapter, never by the submitted body. */
  readonly entry: 'direct' | 'console';
  readonly authMechanism: string | undefined;
  readonly priorityLog: PublishSemanticsContext['log'];
  readonly logRedaction: (actor: Principal, redaction: PublishRedaction) => void;
  readonly consoleIntentOperatorScope?: string;
  readonly humanAccess?: HumanMessageOptions;
}

export async function publishOperation(
  repository: Pick<GatewayRepository, 'publish' | 'verifyPublishReceipt'>,
  input: PublishOperationInput,
): Promise<PublishResult> {
  const { actor } = input;
  const consolePublish = input.entry === 'console';
  requirePermission(actor, 'route');
  const submitted = publicPublish(input.body);
  const redaction = redactPublishBody(submitted.body);
  input.logRedaction(actor, redaction);
  const command = { ...submitted, body: redaction.body };
  const systemGateProbe = command.body.type === SYSTEM_GATE_PROBE_MESSAGE_TYPE;
  if (systemGateProbe) {
    const probeBody = SystemGateProbeBodySchema.parse(command.body);
    const exactRole = actor.roles.length === 1 && actor.roles[0] === 'agent';
    const exactPermissions = actor.permissions.length === 2
      && actor.permissions.includes('route') && actor.permissions.includes('read');
    if (input.authMechanism !== 'mtls' || actor.tenant_id !== 'Steven' ||
        actor.alias !== 'gate-probe' || actor.session_id !== 'gate-probe' ||
        actor.channel !== 'gate' || actor.origin !== undefined || !exactRole || !exactPermissions) {
      throw new AuthorizationError('system gate probe requires the exact dedicated mTLS identity');
    }
    const recipient = command.recipients[0];
    if (command.room_id !== 'grp.steven' || command.recipients.length !== 1 ||
        command.lane !== 'interactive' || command.priority !== -100 ||
        command.idempotency_key !== `gate:${String(recipient?.tenant_id)}:${String(recipient?.alias)}:${probeBody.nonce}`) {
      throw new Error('system gate probe payload is not canonical');
    }
  }
  // `gate-probe` intentionally has no membership/agent/lease and can never become a routing
  // target. Kant is only the durable actor required by the messages FK; the authenticated
  // context still preserves the exact mTLS gate authority.
  const trustedCommand: TrustedPublishCommand = {
    ...trustedPublishSemanticsForContext(actor, command, {
      interactiveHumanEntry: consolePublish, log: input.priorityLog,
    }, systemGateProbe ? 'kant' : actor.alias),
    idempotency_key: command.idempotency_key,
  };
  const author = consolePublish ? consoleMessageAuthor(actor) : undefined;
  const options: PublishOptions = {
      requirePreparedConsoleIntent: consolePublish,
      ...(author === undefined ? {} : { consoleAuthor: author }),
      ...(!systemGateProbe && isAgentPrincipal(actor) ? { agentRoot: true } : {}),
      ...(consolePublish
        ? { consoleIntentOperatorScope: input.consoleIntentOperatorScope ?? consolePublishOperatorScope(actor) }
        : {}),
      ...(input.humanAccess ?? {}),
  };
  const receipt = validatedPublishReceipt(
    await repository.publish(trustedCommand, options),
    trustedCommand,
    command.recipients.length,
  );
  if (typeof repository.verifyPublishReceipt !== 'function'
      || !(await (input.humanAccess === undefined
        ? repository.verifyPublishReceipt(trustedCommand, receipt)
        : repository.verifyPublishReceipt(trustedCommand, receipt, options)))) {
    throw new StoreError('conflict', 'publish receipt does not match its durable effect');
  }
  return receipt;
}
