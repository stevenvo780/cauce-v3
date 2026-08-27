import { DeliveryAcksRepository } from './deliveries/acks.js';

export {
  handlePattern,
  maxAgentOutputMessages,
  maxNotifyBodyBytes,
  notifyKinds,
  postgresTextSafe,
} from './deliveries/contracts.js';
export type {
  AckResult,
  AgentNotifyEntry,
  AgentOutputEntry,
  AgentOutputOutcome,
  ClaimedDeliveryEnvelope,
  DelegationMaterialization,
  DelegationRejection,
  DeliveryAdmission,
  LeaseAcquireOptions,
  LeaseResult,
  LiveDeliveryClaim,
  NotifyDenialCode,
  OpenChainGate,
  RoutingTarget,
} from './deliveries/contracts.js';

export abstract class DeliveriesRepository extends DeliveryAcksRepository {}
