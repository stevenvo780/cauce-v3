import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AgentAccountBindingConfigMutationSchema, AgentConfigMutationSchema, AliasRoutingCeilingConfigMutationSchema, ConfigMutationSchema, MAX_ATTACHMENTS_TOTAL_BYTES, ProviderAccountConfigMutationSchema, PublishMessageSchema, WsOutboundSchema } from '../src/index.js';
const publishBase = {
    version: '3.0', request_id: randomUUID(), trace_id: 'media-contract',
    tenant_id: 'Steven', room_id: 'grp.steven', actor_alias: 'argos',
    recipients: [{ tenant_id: 'Steven', alias: 'jarvis' }],
    idempotency_key: 'media-contract-1'
};
describe('attachment transport contract', () => {
    const payload = Buffer.from('%PDF-1.7\nfixture', 'utf8');
    const attachment = {
        kind: 'document', name: 'report.pdf', mime_type: 'application/pdf',
        file_size: payload.length, sha256: 'a'.repeat(64), content_base64: payload.toString('base64')
    };
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
        { ...attachment, mime_type: 'application/x-sh' },
        { ...attachment, file_size: 10_000_001 },
        { ...attachment, content_base64: 'not-base64!' },
        { ...attachment, sha256: 'token=secret-value' }
    ])('rejects unsafe attachment metadata %#', (invalid) => {
        expect(PublishMessageSchema.safeParse({ ...publishBase, body: { attachments_v1: [invalid] } }).success).toBe(false);
    });
    it('rejects excessive attachment count and aggregate size', () => {
        expect(PublishMessageSchema.safeParse({
            ...publishBase, body: { attachments_v1: Array.from({ length: 5 }, () => attachment) }
        }).success).toBe(false);
        expect(MAX_ATTACHMENTS_TOTAL_BYTES).toBe(10_000_000);
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
    };
    it.each(['applied', 'duplicate', 'superseded', 'ownership_lost'])('accepts the %s receipt', (receipt) => {
        expect(WsOutboundSchema.parse({ ...receiptFrame, receipt })).toMatchObject({ receipt });
    });
    it('rejects an unknown receipt', () => {
        expect(WsOutboundSchema.safeParse({
            ...receiptFrame,
            receipt: 'renewed'
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
//# sourceMappingURL=schemas.test.js.map