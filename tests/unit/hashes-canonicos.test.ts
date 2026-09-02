import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  consolePublishIntentRequestedHash,
  consolePublishIntentSemanticHash,
  publishReceiptCausalHash,
  publishRequestHash,
  type PublishMessage,
} from '@cauce/protocol';
import {
  consolePublishConversationHash,
  consolePublishIntentNonceHash,
} from '../../packages/store/src/repository/config/publish-policy.js';

const COMMAND: PublishMessage = {
  version: '3.0',
  request_id: '11111111-1111-4111-8111-111111111111',
  trace_id: '22222222-2222-4222-8222-222222222222',
  tenant_id: 'Steven',
  room_id: 'grp.steven',
  actor_alias: 'zeus',
  recipients: [
    { tenant_id: 'Steven', alias: 'kant' },
    { tenant_id: 'Miguel', alias: 'janus' },
  ],
  body: { type: 'agent.message', text: 'pin de bytes canonicos' },
  idempotency_key: 'pin-hashes-canonicos-1',
  lane: 'interactive',
  priority: 0,
};

const INTENT_NONCE = '33333333-3333-4333-8333-333333333333';

describe('bytes canónicos con filas durables detrás', () => {
  // These bytes are `idempotency_keys.request_hash`: a change turns every valid pre-upgrade
  // retry into a 409 as soon as the process restarts.
  it('publishRequestHash fija los bytes de idempotency_keys.request_hash', () => {
    expect(publishRequestHash(COMMAND))
      .toBe('43f95834b88dbe913840895ccee7ab93b12ea456aab87d8efbbb70702a88c142');
  });

  it('publishRequestHash ignora el par de transporte, que el reintento renueva', () => {
    const retry: PublishMessage = {
      ...COMMAND,
      request_id: '44444444-4444-4444-8444-444444444444',
      trace_id: '55555555-5555-4555-8555-555555555555',
    };
    expect(publishRequestHash(retry)).toBe(publishRequestHash(COMMAND));
  });

  // These bytes are `audit_events.metadata->>'conversation_hash'`, matched by SQL equality
  // when the console publish head is looked up.
  it('consolePublishConversationHash fija los bytes de metadata.conversation_hash', () => {
    expect(consolePublishConversationHash(COMMAND))
      .toBe('6fb66d02c4df6497ecce5294bff1705e8b64e1c0e98edd39241da15a9f3b5182');
  });

  it('consolePublishConversationHash no depende del orden de los destinatarios', () => {
    const swapped: PublishMessage = { ...COMMAND, recipients: [...COMMAND.recipients].reverse() };
    expect(consolePublishConversationHash(swapped)).toBe(consolePublishConversationHash(COMMAND));
  });

  // These bytes are `audit_events.metadata->>'intent_nonce_hash'`, also matched by SQL equality
  // with no error path: an orphaned row is silently invisible, never a failure.
  it('consolePublishIntentNonceHash fija los bytes de metadata.intent_nonce_hash', () => {
    expect(consolePublishIntentNonceHash(INTENT_NONCE))
      .toBe('098dc18ee78f0a778274f25866e422f237230334394e8412a007c28e6d1afdc8');
  });

  it('consolePublishIntentNonceHash hashea la cadena cruda, no su forma JSON', () => {
    const raw = `cauce-v3:console-publish-intent-nonce:v1\n${INTENT_NONCE}`;
    expect(consolePublishIntentNonceHash(INTENT_NONCE))
      .toBe(createHash('sha256').update(raw).digest('hex'));
    expect(consolePublishIntentNonceHash(INTENT_NONCE))
      .not.toBe(createHash('sha256').update(JSON.stringify(raw)).digest('hex'));
  });
});

describe('bytes canónicos del intento de consola y del recibo', () => {
  it('consolePublishIntentRequestedHash fija los bytes de metadata.requested_hash', () => {
    expect(consolePublishIntentRequestedHash({ ...COMMAND, requested_priority: 0 }))
      .toBe('33a57573b40547f82f7987dfd0843ebd5533192c260bd65e6f7a6f1898206a0e');
  });

  it('consolePublishIntentSemanticHash fija los bytes de metadata.semantic_hash', () => {
    expect(consolePublishIntentSemanticHash(COMMAND))
      .toBe('333aac5c50a309a3ee01d365fbb2d42ba065533cb8a43a07187c0b8ebb7f5a41');
  });

  it('publishReceiptCausalHash fija los bytes de metadata.causal_hash', () => {
    expect(publishReceiptCausalHash({
      tenant_id: 'Steven',
      actor_alias: 'zeus',
      idempotency_key: 'pin-hashes-canonicos-1',
      request_hash: '43f95834b88dbe913840895ccee7ab93b12ea456aab87d8efbbb70702a88c142',
      request_id: COMMAND.request_id,
      trace_id: COMMAND.trace_id,
      message_id: '66666666-6666-4666-8666-666666666666',
      delivery_ids: ['77777777-7777-4777-8777-777777777777', '88888888-8888-4888-8888-888888888888'],
    })).toBe('d13e06d24c402c21b89fff0d0eb96500757b35d5670513cffb9dfa2564d56ba9');
  });
});
