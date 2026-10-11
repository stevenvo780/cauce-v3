import { ProviderAuthError, ProviderAuthRequestSchema } from '../console/provider-auth.contracts.js';
import type { ProviderAuthService } from '../console/provider-auth.types.js';
import type { QuotaAuthBroker } from './quota-auth-broker.js';

export function quotaAwareProviderAuthService(quota: QuotaAuthBroker, fleet?: ProviderAuthService): ProviderAuthService {
  const sessions = new Map<string, { service: ProviderAuthService; expires: number }>();
  const reap = () => {
    for (const [id, binding] of sessions) if (binding.expires <= Date.now()) sessions.delete(id);
  };
  const operation = async (id: string): Promise<ProviderAuthService> => {
    if (await quota.ownsOperation(id)) return quota.service;
    if (!fleet) throw new ProviderAuthError('HOST_UNAVAILABLE');
    return fleet;
  };
  const session = (id: string): ProviderAuthService => {
    reap();
    const selected = sessions.get(id)?.service ?? fleet;
    if (!selected) throw new ProviderAuthError('AUTHORITY_REVOKED');
    return selected;
  };
  return {
    resolve: async (actor, id) => {
      const selected = await operation(id);
      if (!selected.resolve) throw new ProviderAuthError('HOST_UNAVAILABLE');
      return selected.resolve(actor, id);
    },
    start: async (actor, input) => {
      reap();
      if (sessions.size >= 2000) throw new ProviderAuthError('SESSION_CONFLICT');
      const request = ProviderAuthRequestSchema.parse(input);
      const selected = await operation(request.operation_id);
      const receipt = await selected.start(actor, request);
      sessions.set(receipt.session_id, { service: selected, expires: Date.parse(receipt.expires_at) + 900_000 }); return receipt;
    },
    get: (actor, id) => session(id).get(actor, id),
    verify: (actor, id) => session(id).verify(actor, id),
    cancel: (actor, id) => session(id).cancel(actor, id),
    issueSocketTicket: (actor, id) => session(id).issueSocketTicket(actor, id),
    consumeSocketTicket: (actor, id, ticket) => session(id).consumeSocketTicket(actor, id, ticket),
    attach: (actor, id, output) => session(id).attach(actor, id, output),
    revokeOperation: async id => { await (await operation(id)).revokeOperation(id); },
    shutdown: async () => { await quota.service.shutdown(); await fleet?.shutdown(); sessions.clear(); },
  };
}
