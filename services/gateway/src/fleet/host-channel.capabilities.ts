import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { FleetCapabilitySchema, FleetRuntimeCapabilitySchema, type FleetCapability } from '@cauce/protocol';
import type { DatabaseClient, DatabasePool } from '@cauce/store';

const Identifier=z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u);
const Template=FleetRuntimeCapabilitySchema.safeExtend({template_id:Identifier,
  provider:z.enum(['codex','claude','gemini','minimax','grok','feihoa','muse'])});
const QuotaProvider=z.enum(['codex','claude','gemini','grok']);
const QuotaActions=z.array(z.enum(['create','authenticate','query','update_cli','delete'])).max(5)
  .refine(value=>new Set(value).size===value.length);
export const HostCapabilitiesSchema=z.object({resource:z.literal('host'),action:z.literal('capabilities'),schemaVersion:z.literal(1),
  executor_version:z.string().min(1).max(128),policy_sha256:z.string().regex(/^[a-f0-9]{64}$/u),
  fleet_executor:z.boolean(),quota_executor:z.boolean(),templates:z.array(Template).max(100),
  quota_providers:z.array(QuotaProvider).max(4).default([]),
  quota_provider_actions:z.partialRecord(QuotaProvider,QuotaActions).default({}),
}).strict().refine(value=>new Set(value.templates.map(template=>template.template_id)).size===value.templates.length)
  .refine(value=>new Set(value.quota_providers).size===value.quota_providers.length)
  .refine(value=>Object.keys(value.quota_provider_actions).every(provider=>value.quota_providers.some(candidate=>candidate===provider)));
export type HostCapabilities=z.infer<typeof HostCapabilitiesSchema>;
interface Identity {host_id:string;company_id:string}
const unavailable: FleetCapability={available:false,actions:[],placements:[],reason:'executor_unconfigured'};
const actions=['create','update','start','stop','retire','restore','purge'] as const;
function quotaReady(capabilities:HostCapabilities):boolean {
  return capabilities.quota_executor&&capabilities.quota_providers.some(provider=>(capabilities.quota_provider_actions[provider]?.length??0)>0);
}

export async function recordHostCapabilities(client:DatabaseClient,identity:Identity,capabilities:HostCapabilities) {
  const previous=(await client.query<{capabilities:unknown}>('SELECT capabilities FROM fleet_host_identities WHERE host_id=$1 AND company_id=$2',
    [identity.host_id,identity.company_id])).rows[0];
  await client.query(`UPDATE fleet_host_identities SET capabilities=$2::jsonb,capabilities_seen_at=now()
    WHERE host_id=$1 AND company_id=$3`,[identity.host_id,JSON.stringify(capabilities),identity.company_id]);
  if (!isDeepStrictEqual(previous?.capabilities,capabilities)) await client.query(`INSERT INTO audit_events(action,decision,company_id,metadata) VALUES('fleet_host.capabilities','allow',$1,$2::jsonb)`,
    [identity.company_id,JSON.stringify({host_id:identity.host_id,policy_sha256:capabilities.policy_sha256,
      template_ids:capabilities.templates.map(template=>template.template_id),fleet_executor:capabilities.fleet_executor,quota_executor:capabilities.quota_executor})]);
  return {...identity,accepted:true,executor_ready:capabilities.fleet_executor&&capabilities.templates.length>0,
    quota_executor_ready:quotaReady(capabilities)};
}
export class HostCapabilityRegistry {
  constructor(private readonly pool:DatabasePool) {}
  async read(companyId:string):Promise<{host_id:string;executor_ready:boolean;quota_executor_ready:boolean;capabilities:HostCapabilities}[]> {
    const rows=(await this.pool.query<{host_id:string;capabilities:unknown}>(`SELECT identity.host_id,identity.capabilities
      FROM fleet_host_identities identity JOIN fleet_hosts host ON host.host_id=identity.host_id AND host.company_id=identity.company_id
      JOIN companies company ON company.id=identity.company_id WHERE identity.company_id=$1 AND identity.enabled AND host.enabled
        AND company.enabled AND company.retired_at IS NULL AND identity.capabilities_seen_at>now()-interval '120 seconds'
      ORDER BY identity.host_id`,[companyId])).rows;
    return rows.flatMap(row=>{
      const parsed=HostCapabilitiesSchema.safeParse(row.capabilities); if (!parsed.success) return [];
      return [{host_id:row.host_id,capabilities:parsed.data,executor_ready:parsed.data.fleet_executor&&parsed.data.templates.length>0,
        quota_executor_ready:quotaReady(parsed.data)}];
    });
  }
  async fleet(companyId:string,configured:FleetCapability=unavailable):Promise<FleetCapability> {
    const enrolled=await this.read(companyId);
    const owned=new Set((await this.pool.query<{host_id:string}>('SELECT host_id FROM fleet_hosts WHERE company_id=$1 AND enabled',[companyId])).rows.map(row=>row.host_id));
    const signed=new Set((await this.pool.query<{host_id:string}>('SELECT host_id FROM fleet_host_identities WHERE company_id=$1',[companyId])).rows.map(row=>row.host_id));
    const placements=configured.placements.filter(placement=>owned.has(placement.host_id)&&!signed.has(placement.host_id));
    for (const row of enrolled.filter(host=>host.executor_ready)) {
      const runtimes=row.capabilities.templates.map(({template_id:_id,...runtime})=>runtime);
      placements.push({host_id:row.host_id,runtimes,modes:[...new Set(runtimes.map(runtime=>runtime.mode))],
        runtime_users:[...new Set(runtimes.map(runtime=>runtime.runtime_user))],
        systemd_users:[...new Set(runtimes.flatMap(runtime=>runtime.systemd_user?[runtime.systemd_user]:[]))],
        home_roots:[...new Set(runtimes.map(runtime=>runtime.home_directory))],state_roots:[...new Set(runtimes.map(runtime=>runtime.state_root))]});
    }
    return placements.length===0?unavailable:FleetCapabilitySchema.parse({available:true,
      actions:[...new Set([...configured.actions,...(enrolled.some(row=>row.executor_ready)?actions:[])])],placements});
  }
}
