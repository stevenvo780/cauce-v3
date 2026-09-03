import type { FastifyBaseLogger } from 'fastify';
import {
  MAX_ATTACHMENT_NAME_LENGTH, MessageBodySchema,
  redactAttachmentName, redactionEnabledFromEnv, redactSecretsDeep,
  type RedactionKind, type RedactionOptions, type RedactionUnscanned,
} from '@cauce/protocol';

/**
 * The single publish-time redaction. Both legs of the console two-phase publish call it over the
 * same submitted body, so the semantic hash the store prepares and the one it later verifies are
 * computed over the same bytes; a helper applied on only one leg turns every message carrying a
 * secret shape into a permanent 409, which is the opposite of "a publish is never refused".
 */
export interface PublishRedaction {
  readonly body: Record<string, unknown>;
  /** Families found, never a value and never a fragment. */
  readonly kinds: readonly RedactionKind[];
  readonly count: number;
  /** Attachment names the rewrite grew past the protocol cap and this pass clamped back. */
  readonly truncated: number;
  readonly unscanned?: RedactionUnscanned;
  /** The redacted body no longer parses. Recorded, never a reason to refuse the publish. */
  readonly schemaBroken: boolean;
}

export interface PublishRedactionActor {
  readonly tenant_id: string;
  readonly alias: string;
  readonly channel: string;
}

interface PublishRedactionCounters {
  hits: number;
  truncated_names: number;
  unscanned: number;
  schema_broken: number;
}

const counters: PublishRedactionCounters = {
  hits: 0, truncated_names: 0, unscanned: 0, schema_broken: 0,
};

/** Process-local, identity-free counters: no tenant, alias, name or value label can reach them. */
export function publishRedactionMetrics(): Readonly<PublishRedactionCounters> {
  return { ...counters };
}

/* Clamping, never refusing: `bearer <token>` grows by three characters per hit, so a legal
   255-character name leaves the redactor illegal and the delivery undeliverable downstream. */
function boundedName(name: string): string {
  if (name.length <= MAX_ATTACHMENT_NAME_LENGTH) return name;
  const cut = name.slice(0, MAX_ATTACHMENT_NAME_LENGTH);
  const tail = cut.charCodeAt(cut.length - 1);
  return tail >= 0xd800 && tail <= 0xdbff ? cut.slice(0, -1) : cut;
}

function namedAttachment(value: unknown): value is Record<string, unknown> & { name: string } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && typeof (value as { name?: unknown }).name === 'string';
}

export function redactPublishBody(body: Record<string, unknown>): PublishRedaction {
  const options: RedactionOptions = {
    enabled: redactionEnabledFromEnv(process.env, 'CAUCE_REDACT_PUBLISH', true),
  };
  const deep = redactSecretsDeep(body, options);
  const found = {
    kinds: deep.kinds,
    count: deep.count,
    ...(deep.unscanned === undefined ? {} : { unscanned: deep.unscanned }),
  };
  const attachments = deep.value.attachments_v1;
  if (!options.enabled || !Array.isArray(attachments)) {
    return { ...found, body: deep.value, truncated: 0, schemaBroken: false };
  }
  let truncated = 0;
  let rewritten = 0;
  const entries: readonly unknown[] = attachments;
  const named = entries.map((entry) => {
    if (!namedAttachment(entry)) return entry;
    const redacted = redactAttachmentName(entry.name, options);
    const name = boundedName(redacted);
    if (name !== entry.name) rewritten += 1;
    if (name !== redacted) truncated += 1;
    return { ...entry, name };
  });
  const value = { ...deep.value, attachments_v1: named };
  // Re-validated through the schema the route already applied: a rewrite may only break the
  // attachment fields, and this is what proves the clamp above put the name back inside the cap.
  const schemaBroken = rewritten > 0 && !MessageBodySchema.safeParse(value).success;
  return { ...found, body: value, truncated, schemaBroken };
}

export function logPublishRedaction(
  log: FastifyBaseLogger, actor: PublishRedactionActor, redaction: PublishRedaction,
): void {
  const identity = { tenant_id: actor.tenant_id, alias: actor.alias, channel: actor.channel };
  if (redaction.count > 0) {
    counters.hits += redaction.count;
    log.info({
      event: 'publish_secret_redacted', ...identity,
      count: redaction.count, kinds: redaction.kinds,
    }, 'publish body redacted before it reached the durable store');
  }
  if (redaction.truncated > 0) {
    counters.truncated_names += redaction.truncated;
    log.warn({
      event: 'publish_redaction_name_truncated', ...identity, count: redaction.truncated,
    }, 'redacted attachment names were clamped back inside the protocol cap');
  }
  if (redaction.unscanned !== undefined) {
    counters.unscanned += 1;
    log.warn({
      event: 'publish_redaction_unscanned', ...identity,
      reason: redaction.unscanned.reason, count: redaction.unscanned.count,
      reasons: redaction.unscanned.reasons,
    }, 'part of the publish body travelled past the redaction bound unread');
  }
  if (redaction.schemaBroken) {
    counters.schema_broken += 1;
    log.error({
      event: 'publish_redaction_schema_break', ...identity,
    }, 'the redacted publish body no longer satisfies the message body schema');
  }
}
