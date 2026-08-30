import type { z } from 'zod';
import type {
  DeliveryStateSchema,
  LaneSchema,
  OriginSchema,
  RoutingTargetSchema,
  TenantSchema,
} from './core.js';
import type {
  ConsolePublishIntentPrepareSchema,
  NotifyKindSchema,
  NotifyRequestSchema,
  PublishMessageSchema,
} from './messages.js';
import type { ConfigMutationSchema } from './configuration.js';
import type {
  ConsolePublishIntentConfirmResultSchema,
  ConsolePublishIntentConfirmSchema,
  ConsolePublishIntentExpiredSchema,
  ConsolePublishIntentPrepareResultSchema,
  ConsolePublishIntentRateLimitedSchema,
  ConsolePublishIntentReconciliationSchema,
  PublishResultSchema,
} from './publish.js';
import type {
  AckSchema,
  ChainGateSchema,
  DELEGATION_REJECTION_CODES,
  DelegationMaterializationSchema,
  DelegationRejectionSchema,
  DeliveryEnvelopeSchema,
  HelloSchema,
  ProfileRuntimeAdoptionEvidenceSchema,
  ProfileRuntimeContractSchema,
  WsInboundSchema,
  WsOutboundSchema,
} from './realtime.js';
import type { QuotaProviderReportSchema, QuotaSampleRequestSchema } from './quotas.js';

export type Tenant = z.infer<typeof TenantSchema>;
export type PublishMessage = z.infer<typeof PublishMessageSchema>;
export type PublishResult = z.infer<typeof PublishResultSchema>;
export type ConsolePublishIntentPrepare = z.infer<typeof ConsolePublishIntentPrepareSchema>;
export type ConsolePublishIntentPrepareResult = z.infer<typeof ConsolePublishIntentPrepareResultSchema>;
export type ConsolePublishIntentReconciliation = z.infer<typeof ConsolePublishIntentReconciliationSchema>;
export type ConsolePublishIntentExpired = z.infer<typeof ConsolePublishIntentExpiredSchema>;
export type ConsolePublishIntentRateLimited = z.infer<typeof ConsolePublishIntentRateLimitedSchema>;
export type ConsolePublishIntentConfirm = z.infer<typeof ConsolePublishIntentConfirmSchema>;
export type ConsolePublishIntentConfirmResult = z.infer<typeof ConsolePublishIntentConfirmResultSchema>;
export type Ack = z.infer<typeof AckSchema>;
export type ClaimedAck = Ack;
export type Hello = z.infer<typeof HelloSchema>;
export type Origin = z.infer<typeof OriginSchema>;
export type RoutingTarget = z.infer<typeof RoutingTargetSchema>;
export type Lane = z.infer<typeof LaneSchema>;
export type DeliveryState = z.infer<typeof DeliveryStateSchema>;
export type DeliveryEnvelope = z.infer<typeof DeliveryEnvelopeSchema>;
export type ProfileRuntimeContract = z.infer<typeof ProfileRuntimeContractSchema>;
export type ProfileRuntimeAdoptionEvidence = z.infer<typeof ProfileRuntimeAdoptionEvidenceSchema>;
export type DelegationRejectionCode = (typeof DELEGATION_REJECTION_CODES)[number];
export type DelegationRejectionNotice = z.infer<typeof DelegationRejectionSchema>;
export type DelegationMaterializationNotice = z.infer<typeof DelegationMaterializationSchema>;
export type ChainGateNotice = z.infer<typeof ChainGateSchema>;
export type ConfigMutation = z.infer<typeof ConfigMutationSchema>;
export type NotifyKind = z.infer<typeof NotifyKindSchema>;
export type NotifyRequest = z.infer<typeof NotifyRequestSchema>;
export type WsInbound = z.infer<typeof WsInboundSchema>;
export type WsOutbound = z.infer<typeof WsOutboundSchema>;
export type QuotaProviderReport = z.infer<typeof QuotaProviderReportSchema>;
export type QuotaSampleRequest = z.infer<typeof QuotaSampleRequestSchema>;
