import {
  ConsolePublishIntentConfirmResultSchema, ConsolePublishIntentConfirmSchema,
  ConsolePublishIntentPrepareResultSchema, ConsolePublishIntentPrepareSchema,
  type ConsolePublishIntentConfirmResult, type ConsolePublishIntentPrepareResult,
} from '@cauce/protocol';
import { PublishIntentRateLimitedError, PublishIntentReconciliationRequired, type HumanMessageOptions } from '@cauce/store';
import type { GatewayRepository } from './app.js';
import { requirePermission, type Principal } from './auth.js';
import type { ConsolePublishTelemetry } from './console-publish-telemetry.js';
import type { PublishOperationInput } from './publish-operation.js';
import { redactPublishBody } from './routes/publish-redaction.js';
import {
  consolePublishOperatorScope, trustedPublishSemanticsForContext,
  type TrustedPublishIntentCommand,
} from './routes/shared.js';

export type ConsolePublishRepository = Pick<GatewayRepository,
  'prepareConsolePublishIntent' | 'confirmConsolePublishIntent'
>;

export interface PrepareConsolePublishOperationInput extends Pick<PublishOperationInput,
  'actor' | 'body' | 'priorityLog' | 'logRedaction'
> {
  readonly interactiveHumanEntry: boolean;
  readonly consoleIntentOperatorScope?: string;
  readonly humanAccess?: HumanMessageOptions;
}

export interface ConfirmConsolePublishOperationInput {
  readonly actor: Principal;
  readonly body: unknown;
  readonly consoleIntentOperatorScope?: string;
  readonly humanAccess?: HumanMessageOptions;
}

export async function prepareConsolePublishOperation(
  repository: ConsolePublishRepository,
  input: PrepareConsolePublishOperationInput,
  telemetry: ConsolePublishTelemetry,
): Promise<ConsolePublishIntentPrepareResult> {
  try {
    requirePermission(input.actor, 'route');
    const submitted = ConsolePublishIntentPrepareSchema.parse(input.body);
    const redaction = redactPublishBody(submitted.body);
    input.logRedaction(input.actor, redaction);
    const command: TrustedPublishIntentCommand = {
      ...trustedPublishSemanticsForContext(input.actor, { ...submitted, body: redaction.body }, {
        interactiveHumanEntry: input.interactiveHumanEntry, log: input.priorityLog,
      }),
      intent_nonce: submitted.intent_nonce,
      requested_priority: submitted.priority,
    };
    const result = ConsolePublishIntentPrepareResultSchema.parse(
      await (input.humanAccess === undefined
        ? repository.prepareConsolePublishIntent(command,
          input.consoleIntentOperatorScope ?? consolePublishOperatorScope(input.actor))
        : repository.prepareConsolePublishIntent(command,
          input.consoleIntentOperatorScope ?? consolePublishOperatorScope(input.actor), input.humanAccess)),
    );
    telemetry.record({ operation: 'prepare', result: result.state });
    return result;
  } catch (error) {
    const result = error instanceof PublishIntentReconciliationRequired ? 'reconciliation_required'
      : error instanceof PublishIntentRateLimitedError ? 'rate_limited' : 'error';
    telemetry.record({ operation: 'prepare', result });
    throw error;
  }
}

export async function confirmConsolePublishOperation(
  repository: ConsolePublishRepository,
  input: ConfirmConsolePublishOperationInput,
  telemetry: ConsolePublishTelemetry,
): Promise<ConsolePublishIntentConfirmResult> {
  try {
    requirePermission(input.actor, 'route');
    const confirmation = ConsolePublishIntentConfirmSchema.parse(input.body);
    const result = ConsolePublishIntentConfirmResultSchema.parse(
      await (input.humanAccess === undefined
        ? repository.confirmConsolePublishIntent(input.actor.tenant_id, input.actor.alias,
          input.consoleIntentOperatorScope ?? consolePublishOperatorScope(input.actor), confirmation)
        : repository.confirmConsolePublishIntent(input.actor.tenant_id, input.actor.alias,
          input.consoleIntentOperatorScope ?? consolePublishOperatorScope(input.actor), confirmation, input.humanAccess)),
    );
    telemetry.record({ operation: 'confirm', result: 'confirmed' });
    return result;
  } catch (error) {
    telemetry.record({ operation: 'confirm', result: 'error' });
    throw error;
  }
}
