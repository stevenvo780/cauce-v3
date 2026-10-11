import { withTransaction, type DatabasePool } from '@cauce/store';
import type { FleetCapability } from '@cauce/protocol';
import { AuthorizationError, type AuthProvider } from '../auth.js';
import { consoleHumanAccess } from '../console-human-authority.js';
import type { FleetCapabilitySource } from '../console/fleet-operations.routes.js';
import type { HostCapabilityRegistry } from './host-channel.capabilities.js';

export function createCompanyFleetCapabilitySource(pool:DatabasePool,provider:AuthProvider,registry:HostCapabilityRegistry,
  configured:FleetCapability={available:false,actions:[],placements:[]}):FleetCapabilitySource {
  return async(request,reply)=>{
    const human=await consoleHumanAccess(provider,request,reply,'read');
    if (!human) throw new AuthorizationError('a verified company console session is required');
    try {
      const authority=await withTransaction(pool,client=>human.companyAuthority(client));
      return await registry.fleet(authority.actingCompany,configured);
    } finally {human.close();}
  };
}
