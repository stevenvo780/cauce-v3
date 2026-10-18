import type { QuotaAccount, QuotaEnvironmentsSnapshot } from '../../api/client/my-quotas-client';
import { quotaHostSupports } from './quota-environment-capabilities';

export interface AccountLoginTarget {
  key: string;
  environmentId?: string;
  hostId: string;
  label: string;
  available: boolean;
  withoutSession: boolean;
}

export function accountLoginTargets(snapshot: QuotaEnvironmentsSnapshot | undefined, account: QuotaAccount): AccountLoginTarget[] {
  if (!snapshot) return [];
  const environments = snapshot.environments.filter(environment => environment.account_id === account.id
    && environment.status !== 'deleted' && environment.status !== 'deleting');
  const hosts = snapshot.capabilities.hosts;
  return [
    ...environments.map(environment => {
      const host = hosts.find(host => host.host_id === environment.host_id);
      return { key: environment.id, environmentId: environment.id, hostId: environment.host_id,
        label: `${environment.label} · ${host?.display_name ?? environment.host_id}`,
        available: !!host && quotaHostSupports(host, account.provider, 'authenticate'),
        withoutSession: environment.refresh_status === 'not_authenticated' };
    }),
    ...hosts.filter(host => !environments.some(environment => environment.host_id === host.host_id)
      && quotaHostSupports(host, account.provider, 'create') && quotaHostSupports(host, account.provider, 'authenticate'))
      .map(host => ({ key: `host:${host.host_id}`, hostId: host.host_id, label: `Nuevo entorno · ${host.display_name}`,
        available: true, withoutSession: true })),
  ];
}
