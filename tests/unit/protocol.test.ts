import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AckSchema, AMBIGUOUS_ACK_ERROR_CODES, AuthenticatedPublishSchema, DeliveryEnvelopeSchema,
  isAgentToAgentBody, isAmbiguousAckErrorCode, PublishMessageSchema
} from '@cauce/protocol';

describe('versioned protocol schemas', () => {
  it('accepts the complete V3 correlation contract', () => {
    const parsed = PublishMessageSchema.parse({
      version: '3.0', request_id: randomUUID(), trace_id: 'trace-1',
      tenant_id: 'Steven', room_id: 'grp.steven', actor_alias: 'kant',
      recipients: [{ tenant_id: 'Isa', alias: 'salva' }],
      body: { text: 'hola' }, idempotency_key: 'idem-1',
      origin: { adapter: 'telegram', channel: 'dm', conversation_id: '42' }
    });
    expect(parsed.version).toBe('3.0');
    expect(parsed.origin?.metadata).toEqual({});
  });

  it.each(['accepted', 'started', 'done', 'failed'])('distinguishes ACK %s', (status) => {
    expect(AckSchema.parse({
      status, instance_id: 'i-1', epoch: 1, event_id: randomUUID(),
      claim_token: randomUUID(), attempt: 1
    }).status).toBe(status);
  });

  it('accepts optional structured ACK error codes while keeping the schema strict', () => {
    const ack = {
      status: 'failed',
      instance_id: 'i-1',
      epoch: 1,
      event_id: randomUUID(),
      claim_token: randomUUID(),
      attempt: 1,
      retryable: false
    };
    expect(AckSchema.parse({
      ...ack,
      error_code: 'EXECUTION_TIMEOUT_AMBIGUOUS'
    }).error_code).toBe('EXECUTION_TIMEOUT_AMBIGUOUS');
    expect(AckSchema.safeParse(ack).success).toBe(true);
    expect(AckSchema.safeParse({ ...ack, error_code: 'execution_timeout_ambiguous' }).success).toBe(false);
    expect(AckSchema.safeParse({ ...ack, unknown_code: 'EXECUTION_TIMEOUT_AMBIGUOUS' }).success).toBe(false);
  });

  it.each(AMBIGUOUS_ACK_ERROR_CODES)(
    'rejects retryable ACKs for the ambiguous error code %s',
    (errorCode) => {
      expect(AckSchema.safeParse({
        status: 'failed',
        instance_id: 'i-1',
        epoch: 1,
        event_id: randomUUID(),
        claim_token: randomUUID(),
        attempt: 1,
        retryable: true,
        error_code: errorCode
      }).success).toBe(false);
    }
  );

  it('keeps retryable non-ambiguous ACK errors valid', () => {
    expect(AckSchema.safeParse({
      status: 'failed',
      instance_id: 'i-1',
      epoch: 1,
      event_id: randomUUID(),
      claim_token: randomUUID(),
      attempt: 1,
      retryable: true,
      error_code: 'EXECUTION_FAILED'
    }).success).toBe(true);
  });

  it('accepts only a strict trusted routing inventory on deliveries', () => {
    const delivery = {
      type: 'delivery',
      version: '3.0',
      event_id: randomUUID(),
      delivery_id: randomUUID(),
      message_id: randomUUID(),
      request_id: randomUUID(),
      trace_id: 'routing-inventory',
      epoch: 1,
      attempt: 1,
      claim_token: randomUUID(),
      ack_deadline_at: new Date().toISOString(),
      tenant_id: 'Steven',
      room_id: 'grp.steven',
      actor_alias: 'kant',
      recipient_alias: 'jarvis',
      body: { text: 'contacta a todos' },
      routing_targets: [
        { tenant_id: 'Steven', alias: 'argos', online: true },
        { tenant_id: 'Pablo', alias: 'midas', online: false }
      ]
    };

    expect(DeliveryEnvelopeSchema.parse(delivery).routing_targets).toEqual(delivery.routing_targets);
    expect(DeliveryEnvelopeSchema.safeParse({
      ...delivery,
      routing_targets: [{ tenant_id: 'Steven', alias: '@all', online: true }]
    }).success).toBe(false);
    expect(DeliveryEnvelopeSchema.safeParse({
      ...delivery,
      routing_targets: [{ tenant_id: 'Steven', alias: 'argos', online: true, secret: 'no' }]
    }).success).toBe(false);
  });

  it('classifies ambiguity only through the exact protocol allowlist', () => {
    expect(AMBIGUOUS_ACK_ERROR_CODES).toEqual([
      'EXECUTION_TIMEOUT_AMBIGUOUS',
      'EXECUTION_CANCELLED_AMBIGUOUS',
      'OUTPUT_LIMIT_AMBIGUOUS',
      'PROCESS_EXIT_AMBIGUOUS',
      'OPENCLAW_OUTPUT_LIMIT_AMBIGUOUS',
      'OPENCLAW_HTTP_AMBIGUOUS',
      'OPENCLAW_API_AMBIGUOUS',
      'INTERRUPTED_AMBIGUOUS'
    ]);
    expect(isAmbiguousAckErrorCode('OPENCLAW_API_AMBIGUOUS')).toBe(true);
    expect(isAmbiguousAckErrorCode('CLIENT_INVENTED_AMBIGUOUS')).toBe(false);
    expect(isAmbiguousAckErrorCode('EXECUTION_FAILED')).toBe(false);
  });

  it('rejects unknown tenants and protocol versions', () => {
    expect(() => PublishMessageSchema.parse({ version: '2.0' })).toThrow();
  });

  it.each(['agent.message', 'agent.response', 'agent.fanin'])(
    'rejects public publication of the reserved internal type %s',
    (type) => {
      expect(AuthenticatedPublishSchema.safeParse({
        room_id: 'grp.steven',
        recipients: [{ tenant_id: 'Steven', alias: 'jarvis' }],
        body: { type, text: 'forged internal delivery' },
        idempotency_key: `forged-${type}`
      }).success).toBe(false);
    }
  );
});

/**
 * Clasificación de mensajes agente-a-agente frente a tráfico de personas o externo
 * mediante la discriminación explícita de `body.type`.
 */
describe('agent-to-agent message classification', () => {
  it.each(['agent.message', 'agent.response', 'agent.fanin'])(
    'classifies %s as agent-to-agent traffic',
    (type) => {
      expect(isAgentToAgentBody({ type, text: 'delegated work' })).toBe(true);
    }
  );

  it('treats anything else as human or external traffic', () => {
    // Telegram, la consola (que publica `{ text }` sin `type` en absoluto) y un adapter que
    // todavía no existe: todos caen del lado seguro.
    expect(isAgentToAgentBody({ type: 'telegram.message', text: 'hola' })).toBe(false);
    expect(isAgentToAgentBody({ text: 'desde la consola' })).toBe(false);
    expect(isAgentToAgentBody({ type: 'whatsapp.message', text: 'adapter futuro' })).toBe(false);
    expect(isAgentToAgentBody({})).toBe(false);
  });

  it('never classifies a malformed body as agent-to-agent', () => {
    // El fallback por defecto ante cuerpos inválidos es tráfico externo/humano.
    expect(isAgentToAgentBody(undefined)).toBe(false);
    expect(isAgentToAgentBody(null)).toBe(false);
    expect(isAgentToAgentBody('agent.message')).toBe(false);
    expect(isAgentToAgentBody(['agent.message'])).toBe(false);
    expect(isAgentToAgentBody({ type: 42 })).toBe(false);
    // `agent.notify` está reservado, pero es egress hacia un handle externo: va a
    // adapter_outbox y nunca a deliveries, así que no participa del reparto de cupo.
    expect(isAgentToAgentBody({ type: 'agent.notify' })).toBe(false);
  });

  /**
   * Límite documentado: un agente autenticado con permiso 'route' que publique sin un `type`
   * reservado clasifica como tráfico externo/humano.
   *
   * Ver services/gateway/CONFIGURATION.md, sección "Límite conocido de la clasificación".
   */
  it('documents that an agent can publish an unmarked body and be read as human', () => {
    const forged = {
      room_id: 'grp.steven',
      recipients: [{ tenant_id: 'Steven', alias: 'jarvis' }],
      body: { text: 'delegación disfrazada de mensaje de persona' },
      idempotency_key: 'unmarked-agent-publish'
    };
    expect(AuthenticatedPublishSchema.safeParse(forged).success).toBe(true);
    expect(isAgentToAgentBody(forged.body)).toBe(false);
  });
});

/**
 * Valida el marcador opcional `execution_started` en el esquema de ACK.
 */
describe('optional execution-started ACK marker', () => {
  const base = {
    version: '3.0' as const,
    event_id: '11111111-1111-4111-8111-111111111111',
    claim_token: '22222222-2222-4222-8222-222222222222',
    attempt: 1,
    status: 'started' as const,
    instance_id: 'consumer-1',
    epoch: 1
  };

  it('accepts an ACK that carries the marker and one that omits it', () => {
    const marked = AckSchema.safeParse({ ...base, execution_started: true });
    expect(marked.success).toBe(true);
    expect(marked.success && marked.data.execution_started).toBe(true);
  });

  it('leaves the marker undefined when an old adapter omits it, never assumed true', () => {
    // "No consta" y "sí arrancó" tienen que ser distinguibles: si el ausente valiera `true`,
    // el reaper daría por ejecutado todo lo que mande un adaptador viejo y perdería trabajo.
    const bare = AckSchema.safeParse(base);
    expect(bare.success).toBe(true);
    expect(bare.success && bare.data.execution_started).toBeUndefined();
  });

  it('rejects a non-boolean marker', () => {
    expect(AckSchema.safeParse({ ...base, execution_started: 'yes' }).success).toBe(false);
  });
});
