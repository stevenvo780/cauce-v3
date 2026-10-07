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
  repository: Pick<GatewayRepository, 'publish' | 'verifyPublishReceipt'>
    & Partial<Pick<GatewayRepository, 'resolveSystemGateProbeActor'>>,
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
    if (input.authMechanism !== 'mtls' ||
        actor.alias !== 'gate-probe' || actor.session_id !== 'gate-probe' ||
        actor.channel !== 'gate' || actor.origin !== undefined || !exactRole || !exactPermissions) {
      throw new AuthorizationError('system gate probe requires the exact dedicated mTLS identity');
    }
    const recipient = command.recipients[0];
    if (command.recipients.length !== 1 ||
        command.lane !== 'interactive' || command.priority !== -100 ||
        command.idempotency_key !== `gate:${String(recipient?.tenant_id)}:${String(recipient?.alias)}:${probeBody.nonce}`) {
      throw new Error('system gate probe payload is not canonical');
    }
  }
  const durableActor = systemGateProbe
    ? await (() => {
      if (repository.resolveSystemGateProbeActor === undefined) {
        throw new AuthorizationError('gate probe runtime authority resolver is unavailable');
      }
      return repository.resolveSystemGateProbeActor(actor.tenant_id, command.room_id);
    })()
    : actor.alias;
  const trustedCommand: TrustedPublishCommand = {
    ...trustedPublishSemanticsForContext(actor, command, {
      interactiveHumanEntry: consolePublish, log: input.priorityLog,
    }, durableActor),
    idempotency_key: command.idempotency_key,
  };
  const author = consolePublish ? consoleMessageAuthor(actor) : undefined;
  const options: PublishOptions = {
      requirePreparedConsoleIntent: consolePublish,
      ...(systemGateProbe ? { systemGateProbeAuthority: {
        tenant_id: actor.tenant_id, alias: 'gate-probe' as const,
        session_id: 'gate-probe' as const, channel: 'gate' as const,
      } } : {}),
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
      || !(await (input.humanAccess === undefined && !systemGateProbe
        ? repository.verifyPublishReceipt(trustedCommand, receipt)
        : repository.verifyPublishReceipt(trustedCommand, receipt, options)))) {
    throw new StoreError('conflict', 'publish receipt does not match its durable effect');
  }
  return receipt;
}
