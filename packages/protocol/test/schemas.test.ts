import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AgentAccountBindingConfigMutationSchema, AgentConfigMutationSchema,
  AliasRoutingCeilingConfigMutationSchema, ConfigMutationSchema,
  buildPublishReceipt, DeliveryEnvelopeSchema,
  ConsolePublishIntentConfirmResultSchema, ConsolePublishIntentConfirmSchema,
  ConsolePublishIntentExpiredSchema, ConsolePublishIntentRateLimitedSchema,
  ConsolePublishIntentPrepareResultSchema, ConsolePublishIntentPrepareSchema,
  ConsolePublishIntentReconciliationSchema,
  consolePublishIntentRequestedHash, consolePublishIntentSemanticHash,
  AttachmentContentSchema, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_TOTAL_BYTES,
  MAX_DELEGATION_FEEDBACK_ITEMS,
  ProviderAccountConfigMutationSchema, PublishMessageSchema,
  ProfileRuntimeAdoptionEvidenceSchema, ProfileRuntimeContractSchema,
  publishReceiptCausalHash, publishRequestHash, PublishResultSchema, WsOutboundSchema
} from '../src/index.js';

const publishBase = {
  version: '3.0', request_id: randomUUID(), trace_id: 'media-contract',
  tenant_id: 'Steven', room_id: 'grp.steven', actor_alias: 'argos',
  recipients: [{ tenant_id: 'Steven', alias: 'jarvis' }],
  idempotency_key: 'media-contract-1'
} as const;

describe('publish receipt correlation contract', () => {
  const command = PublishMessageSchema.parse({
    ...publishBase,
    body: { text: 'receipt contract' },
    lane: 'interactive',
    priority: 10,
  });
  const receipt = buildPublishReceipt(command, {
    message_id: randomUUID(),
    delivery_ids: [randomUUID()],
    duplicate: false,
    request_id: command.request_id,
    trace_id: command.trace_id,
  });

  it('requires tenant, actor, durable request hash and exact effect binding on every receipt', () => {
    expect(PublishResultSchema.parse(receipt).idempotency_key).toBe(publishBase.idempotency_key);
    expect(receipt.request_hash).toBe(publishRequestHash(command));
    expect(receipt.causal_hash).toBe(publishReceiptCausalHash(receipt));
    for (const field of ['idempotency_key', 'tenant_id', 'actor_alias', 'request_hash', 'causal_hash'] as const) {
      const uncorrelated = { ...receipt };
      Reflect.deleteProperty(uncorrelated, field);
      expect(PublishResultSchema.safeParse(uncorrelated).success, field).toBe(false);
    }
  });

  it('keeps the historical semantic hash stable across retry request/trace ids', () => {
    const retry = { ...command, request_id: randomUUID(), trace_id: `retry-${randomUUID()}` };
    expect(publishRequestHash(retry)).toBe(receipt.request_hash);
    expect(publishRequestHash({ ...retry, body: { text: 'another effect' } }))
      .not.toBe(receipt.request_hash);
    expect(publishRequestHash({ ...retry, tenant_id: 'Pablo' })).not.toBe(receipt.request_hash);
  });

  it('keeps effect ids canonical v4 while accepting a historical deterministic v5 request id', () => {
    expect(PublishResultSchema.safeParse({ ...receipt, extra: true }).success).toBe(false);
    const deterministicRequestId = '21f7f8de-8051-5b89-8680-0195ef798b6a';
    expect(PublishResultSchema.parse({ ...receipt, request_id: deterministicRequestId }).request_id)
      .toBe(deterministicRequestId);
    for (const messageId of [
      '10000000-0000-4000-8000-00000000000A',
      '10000000-0000-7000-8000-00000000000a',
      deterministicRequestId,
      '10000000-0000-4000-c000-00000000000a',
    ]) {
      expect(PublishResultSchema.safeParse({ ...receipt, message_id: messageId }).success, messageId)
        .toBe(false);
    }
  });
});

describe('durable console publish-intent contract', () => {
  const prepare = {
    room_id: 'grp.steven',
    recipients: [{ tenant_id: 'Steven', alias: 'jarvis' }],
    body: { text: 'intent contract' },
    lane: 'interactive',
    priority: 10,
    intent_nonce: randomUUID(),
  } as const;
  const receiptCommand = PublishMessageSchema.parse({
    ...publishBase,
    room_id: prepare.room_id,
    recipients: prepare.recipients,
    body: prepare.body,
    lane: prepare.lane,
    priority: prepare.priority,
    authenticated_context: { session_id: 'opaque-session', channel: 'console' },
  });
  const receipt = buildPublishReceipt(receiptCommand, {
    message_id: randomUUID(),
    delivery_ids: [randomUUID()],
    duplicate: false,
    request_id: receiptCommand.request_id,
    trace_id: receiptCommand.trace_id,
  });

  it('accepts exactly AuthenticatedPublish without a caller-controlled idempotency key', () => {
    expect(ConsolePublishIntentPrepareSchema.parse(prepare)).toEqual(prepare);
    expect(ConsolePublishIntentPrepareSchema.safeParse({ ...prepare, idempotency_key: 'forged' }).success)
      .toBe(false);
    expect(ConsolePublishIntentPrepareSchema.safeParse({ ...prepare, actor_alias: 'kant' }).success)
      .toBe(false);
  });

  it('binds semantic meaning while excluding transport ids and the opaque key', () => {
    const semantic = consolePublishIntentSemanticHash(receiptCommand);
    expect(consolePublishIntentSemanticHash({
      ...receiptCommand,
      request_id: randomUUID(),
      trace_id: `retry-${randomUUID()}`,
      idempotency_key: 'another-opaque-key',
    })).toBe(semantic);
    expect(consolePublishIntentSemanticHash({
      ...receiptCommand,
      recipients: [...receiptCommand.recipients].reverse(),
    })).toBe(semantic);
    expect(consolePublishIntentSemanticHash({
      ...receiptCommand,
      body: { text: 'different meaning' },
    })).not.toBe(semantic);
    expect(consolePublishIntentSemanticHash({
      ...receiptCommand,
      authenticated_context: { session_id: 'another-session', channel: 'console' },
    })).toBe(semantic);
    expect(consolePublishIntentSemanticHash({
      ...receiptCommand,
      actor_alias: 'socrates',
    })).not.toBe(semantic);
  });

  it('keeps the requested intent stable across effective priority policy changes', () => {
    const requestedCommand = {
      ...receiptCommand,
      intent_nonce: prepare.intent_nonce,
      requested_priority: prepare.priority,
    };
    const requested = consolePublishIntentRequestedHash(requestedCommand);
    const policyChanged = {
      ...requestedCommand,
      request_id: randomUUID(),
      trace_id: `requested-retry-${randomUUID()}`,
      priority: 90,
      authenticated_context: { session_id: 'new-policy-session', channel: 'console' },
      recipients: [...requestedCommand.recipients].reverse(),
    };
    expect(consolePublishIntentRequestedHash(policyChanged)).toBe(requested);
    expect(consolePublishIntentRequestedHash({
      ...requestedCommand,
      requested_priority: prepare.priority + 1,
    })).not.toBe(requested);
    expect(consolePublishIntentRequestedHash({
      ...requestedCommand,
      body: { text: 'different requested effect' },
    })).not.toBe(requested);
  });

  it('keeps prepare and confirm responses strict and causally exact', () => {
    expect(ConsolePublishIntentPrepareResultSchema.parse({
      version: 1, state: 'prepared', idempotency_key: receipt.idempotency_key, receipt: null,
    })).toMatchObject({ state: 'prepared', receipt: null });
    expect(ConsolePublishIntentPrepareResultSchema.parse({
      version: 1, state: 'committed', idempotency_key: receipt.idempotency_key, receipt,
    })).toMatchObject({ state: 'committed', receipt });
    expect(ConsolePublishIntentPrepareResultSchema.safeParse({
      version: 1, state: 'prepared', idempotency_key: receipt.idempotency_key, receipt,
    }).success).toBe(false);
    expect(ConsolePublishIntentConfirmSchema.safeParse({
      idempotency_key: receipt.idempotency_key,
      message_id: receipt.message_id,
      causal_hash: receipt.causal_hash,
      extra: true,
    }).success).toBe(false);
    expect(ConsolePublishIntentConfirmResultSchema.parse({
      version: 1,
      confirmed: true,
      idempotency_key: receipt.idempotency_key,
      message_id: receipt.message_id,
      causal_hash: receipt.causal_hash,
    })).toMatchObject({ confirmed: true, message_id: receipt.message_id });
    expect(ConsolePublishIntentReconciliationSchema.safeParse({
      version: 1,
      error: 'publish_intent_reconciliation_required',
      state: 'committed',
      idempotency_key: receipt.idempotency_key,
      receipt,
      extra: true,
    }).success).toBe(false);
    expect(ConsolePublishIntentExpiredSchema.parse({
      version: 1,
      error: 'publish_intent_expired',
      state: 'expired',
      idempotency_key: receipt.idempotency_key,
      safe_to_resubmit: true,
    })).toMatchObject({ state: 'expired', safe_to_resubmit: true });
    expect(ConsolePublishIntentExpiredSchema.safeParse({
      version: 1,
      error: 'publish_intent_expired',
      state: 'expired',
      idempotency_key: receipt.idempotency_key,
      safe_to_resubmit: true,
      retry: true,
    }).success).toBe(false);
    expect(ConsolePublishIntentRateLimitedSchema.parse({
      version: 1,
      error: 'publish_intent_rate_limited',
      retry_after_seconds: 86_400,
      safe_to_retry: true,
    })).toMatchObject({ retry_after_seconds: 86_400, safe_to_retry: true });
  });
});

describe('behavioral runtime-profile contract', () => {
  const runtimeContract = {
    revision: 7,
    generation: 'runtime-generation-a',
    documents: [{
      name: 'AGENTS.md', path: '/home/dev/.codex/AGENTS.md', sha: 'a'.repeat(64),
    }],
  } as const;
  const delivery = {
    type: 'delivery', version: '3.0', event_id: randomUUID(), delivery_id: randomUUID(),
    message_id: randomUUID(), request_id: randomUUID(), trace_id: 'profile-runtime-contract',
    epoch: 1, attempt: 1, claim_token: randomUUID(), ack_deadline_at: new Date().toISOString(),
    tenant_id: 'Steven', room_id: 'grp.steven', actor_alias: 'kant', recipient_alias: 'argos',
    body: { text: 'consume the current profile' }, profile_runtime_contract: runtimeContract,
  } as const;

  it('carries an exact strict contract on a delivery and matching adapter evidence', () => {
    expect(DeliveryEnvelopeSchema.parse(delivery).profile_runtime_contract).toEqual(runtimeContract);
    expect(ProfileRuntimeAdoptionEvidenceSchema.parse({
      evidence: 'adapter_delivery', ...runtimeContract,
    })).toMatchObject(runtimeContract);
  });

  it.each([
    { ...runtimeContract, documents: [] },
    { ...runtimeContract, generation: '' },
    { ...runtimeContract, documents: [{ ...runtimeContract.documents[0], sha: 'A'.repeat(64) }] },
    { ...runtimeContract, documents: [{ ...runtimeContract.documents[0], name: 'TOOLS.md' }] },
    { ...runtimeContract, documents: [runtimeContract.documents[0], runtimeContract.documents[0]] },
    { ...runtimeContract, unexpected: true },
  ])('rejects malformed or ambiguous runtime evidence %#', (invalid) => {
    expect(ProfileRuntimeContractSchema.safeParse(invalid).success).toBe(false);
    expect(DeliveryEnvelopeSchema.safeParse({ ...delivery, profile_runtime_contract: invalid }).success)
      .toBe(false);
  });
});

describe('attachment transport contract', () => {
  const payload = Buffer.from('%PDF-1.7\nfixture', 'utf8');
  const attachment = {
    kind: 'document', name: 'report.pdf', mime_type: 'application/pdf',
    file_size: payload.length, sha256: 'a'.repeat(64), content_base64: payload.toString('base64')
  } as const;

  it('carries strict usable attachment metadata and content through publish and delivery frames', () => {
    const body = { type: 'telegram.message', attachments_v1: [attachment] };
    expect(PublishMessageSchema.parse({ ...publishBase, body }).body).toEqual(body);
    expect(WsOutboundSchema.parse({
      type: 'delivery', version: '3.0', event_id: randomUUID(), delivery_id: randomUUID(),
      message_id: randomUUID(), request_id: randomUUID(), trace_id: 'media-delivery', epoch: 1,
      attempt: 1, claim_token: randomUUID(), ack_deadline_at: new Date().toISOString(),
      tenant_id: 'Steven', room_id: 'grp.steven', actor_alias: 'argos', recipient_alias: 'jarvis', body
    })).toMatchObject({ body });
  });

  it.each([
    { ...attachment, name: '../report.pdf' },
    { ...attachment, name: 'report\u202Efdp.exe' },
    { ...attachment, file_size: 10_000_001 },
    { ...attachment, content_base64: 'not-base64!' },
    { ...attachment, sha256: 'token=secret-value' }
  ])('rejects unsafe attachment metadata %#', (invalid) => {
    expect(PublishMessageSchema.safeParse({ ...publishBase, body: { attachments_v1: [invalid] } }).success).toBe(false);
  });

  // No format is turned away: the type is carried, never vetted. The extension is free to disagree
  // with it, or to be absent, because neither is what makes an attachment safe.
  it.each([
    { mime_type: 'application/x-sh', name: 'deploy.sh' },
    { mime_type: 'application/zip', name: 'evidencia.zip' },
    { mime_type: 'video/mp4', name: 'captura.mp4' },
    { mime_type: 'application/vnd.sqlite3', name: 'cauce.db' },
    { mime_type: 'font/woff2', name: 'tipografia.woff2' },
    { mime_type: 'application/octet-stream', name: 'volcado' },
    { mime_type: 'text/markdown', name: 'notas.csv' },
    { mime_type: 'text/csv', name: 'notas.md' },
    { mime_type: 'text/plain', name: 'informe con espacios y acentos.txt' },
    { mime_type: 'image/svg+xml', name: 'diagrama.svg' }
  ])('accepts any format, whatever its extension says %#', (any) => {
    const content = Buffer.from('# informe\n', 'utf8');
    expect(PublishMessageSchema.safeParse({
      ...publishBase,
      body: {
        attachments_v1: [{
          ...attachment, ...any, file_size: content.length, content_base64: content.toString('base64')
        }]
      }
    }).success).toBe(true);
  });

  it.each([
    { mime_type: 'sin-barra' },
    { mime_type: 'text/plain; charset=utf-8' },
    { mime_type: 'text /plain' },
    { mime_type: '' },
    { mime_type: `application/${'x'.repeat(120)}` },
    // `image` is the one routing decision left, so it may not be claimed over a non-image type.
    { mime_type: 'application/zip', kind: 'image' }
  ])('rejects a media type that is not a token, or an image kind over a non-image type %#', (invalid) => {
    expect(PublishMessageSchema.safeParse({
      ...publishBase, body: { attachments_v1: [{ ...attachment, ...invalid }] }
    }).success).toBe(false);
  });

  it('accepts the image kind when the media type is an image', () => {
    expect(PublishMessageSchema.safeParse({
      ...publishBase,
      body: { attachments_v1: [{ ...attachment, kind: 'image', mime_type: 'image/png', name: 'captura.png' }] }
    }).success).toBe(true);
  });

  it('rejects excessive attachment count and aggregate size', () => {
    expect(PublishMessageSchema.safeParse({
      ...publishBase, body: { attachments_v1: Array.from({ length: 5 }, () => attachment) }
    }).success).toBe(false);
    expect(MAX_ATTACHMENTS_TOTAL_BYTES).toBe(10_000_000);
  });

  it.each(['QQ=', 'Q===', 'QQ=Q'])(
    'rejects invalid base64 length or padding: %s',
    (content_base64) => {
      const result = AttachmentContentSchema.safeParse({
        ...attachment, file_size: 1, content_base64
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues).toContainEqual(expect.objectContaining({ path: ['content_base64'] }));
      }
    }
  );

  it('validates a maximum-sized base64 attachment without throwing', () => {
    const payload = Buffer.alloc(MAX_ATTACHMENT_BYTES, 0x41);
    const largeAttachment = {
      ...attachment,
      file_size: payload.length,
      content_base64: payload.toString('base64')
    };
    let result: ReturnType<typeof PublishMessageSchema.safeParse> | undefined;
    expect(() => {
      result = PublishMessageSchema.safeParse({
        ...publishBase, body: { attachments_v1: [largeAttachment] }
      });
    }).not.toThrow();
    expect(result?.success).toBe(true);
  });
});

describe('WebSocket ACK result receipts', () => {
  const receiptFrame = {
    type: 'ack_result',
    event_id: randomUUID(),
    delivery_id: randomUUID(),
    attempt: 1,
    claim_token: randomUUID(),
    status: 'started',
    applied: true
  } as const;

  it.each(['applied', 'duplicate', 'superseded', 'ownership_lost'] as const)(
    'accepts the %s receipt',
    (receipt) => {
      expect(WsOutboundSchema.parse({ ...receiptFrame, receipt })).toMatchObject({ receipt });
    }
  );

  it('rejects an unknown receipt', () => {
    expect(WsOutboundSchema.safeParse({
      ...receiptFrame,
      receipt: 'renewed'
    }).success).toBe(false);
  });

  it('accepts bounded exact delegation materializations without message bodies', () => {
    const materialization = {
      output_index: 7,
      target_tenant: 'Steven',
      target_alias: 'socrates',
      child_delivery_id: randomUUID()
    };
    expect(WsOutboundSchema.parse({
      ...receiptFrame,
      delegation_materializations: [materialization]
    })).toMatchObject({ delegation_materializations: [materialization] });
  });

  it('rejects malformed or expansive delegation materialization identities', () => {
    expect(WsOutboundSchema.safeParse({
      ...receiptFrame,
      delegation_materializations: [{
        output_index: -1,
        target_tenant: 'Steven',
        target_alias: 'socrates',
        child_delivery_id: 'not-a-uuid'
      }]
    }).success).toBe(false);
    expect(WsOutboundSchema.safeParse({
      ...receiptFrame,
      delegation_materializations: [{
        output_index: 0,
        target_tenant: 'Steven',
        target_alias: 'socrates',
        child_delivery_id: randomUUID(),
        body: 'must never cross this receipt'
      }]
    }).success).toBe(false);
    expect(WsOutboundSchema.safeParse({
      ...receiptFrame,
      delegation_materializations: Array.from(
        { length: MAX_DELEGATION_FEEDBACK_ITEMS + 1 },
        (_, output_index) => ({
        output_index,
        target_tenant: 'Steven',
        target_alias: 'socrates',
        child_delivery_id: randomUUID()
        })
      )
    }).success).toBe(false);
    expect(MAX_DELEGATION_FEEDBACK_ITEMS).toBe(1_000);
    const child = randomUUID();
    expect(WsOutboundSchema.safeParse({
      ...receiptFrame,
      delegation_materializations: [0, 1].map((output_index) => ({
        output_index,
        target_tenant: 'Steven',
        target_alias: 'socrates',
        child_delivery_id: child
      }))
    }).success).toBe(false);
  });
});

describe('agent registry configuration mutations', () => {
  it('accepts a well-formed agent create mutation and routes it through the discriminated union', () => {
    const mutation = {
      resource: 'agent', action: 'create', tenant_id: 'Pablo', alias: 'newbot',
      value: { harness_id: 'codex', enabled: false }
    };
    expect(AgentConfigMutationSchema.parse(mutation)).toMatchObject(mutation);
    expect(ConfigMutationSchema.parse(mutation)).toMatchObject(mutation);
  });

  it('rejects agent fields that are not part of the schema', () => {
    expect(AgentConfigMutationSchema.safeParse({
      resource: 'agent', action: 'create', tenant_id: 'Pablo', alias: 'newbot',
      value: { harness_id: 'codex', secret_token: 'nope' }
    }).success).toBe(false);
  });

  it('keys a provider account globally and names its payer, never a consumer tenant', () => {
    const valid = {
      resource: 'provider_account', action: 'create', id: 'anthropic-main',
      value: {
        provider: 'anthropic', external_account_id: 'acct-123', payer_tenant_id: 'Steven',
        credential_ref_kind: 'env_path', credential_ref: 'CAUCE_ANTHROPIC_MAIN_PATH',
        shared_with_pool: true, enabled: true
      }
    };
    expect(ProviderAccountConfigMutationSchema.parse(valid)).toMatchObject(valid);
    expect(ProviderAccountConfigMutationSchema.safeParse({
      ...valid, value: { ...valid.value, credential_ref_kind: 'bearer_token' }
    }).success).toBe(false);
    // The account is not scoped to a using tenant: a stray tenant_id must not silently pass.
    expect(ProviderAccountConfigMutationSchema.safeParse({ ...valid, tenant_id: 'Pablo' }).success).toBe(false);
  });

  it('lets the ceiling and a binding point one tenant alias at another tenant account', () => {
    const ceiling = {
      resource: 'alias_routing_ceiling', action: 'create',
      tenant_id: 'Isa', alias: 'salva', account_id: 'anthropic-main'
    };
    expect(AliasRoutingCeilingConfigMutationSchema.parse(ceiling)).toMatchObject(ceiling);
    // The ceiling carries no mutable state, so there is nothing an update could mean.
    expect(AliasRoutingCeilingConfigMutationSchema.safeParse({ ...ceiling, action: 'update' }).success).toBe(false);

    const binding = {
      resource: 'agent_account_binding', action: 'create',
      tenant_id: 'Isa', agent_alias: 'salva', account_id: 'anthropic-main',
      value: { priority: 10, enabled: true }
    };
    expect(AgentAccountBindingConfigMutationSchema.parse(binding)).toMatchObject(binding);
    expect(ConfigMutationSchema.parse(binding)).toMatchObject(binding);
    // 'purpose' belonged to the superseded design; the harness main loop is never a row here.
    expect(AgentAccountBindingConfigMutationSchema.safeParse({
      ...binding, purpose: 'primary'
    }).success).toBe(false);
  });
});
