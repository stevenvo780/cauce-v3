import { useEffect, useState } from 'react';
import type { FleetHost } from '@cauce/protocol/fleet-hosts';
import type { HostEnrollmentList } from '../../api/client/host-enrollment-client';
import type { QuotaEnvironmentsSnapshot } from '../../api/client/my-quotas-client';
import { useApi } from '../../api/context';

/**
 * Computers that only run the quota executor: they appear in the quota capabilities, hold no agent and their
 * executor does not offer agent templates. They are query hosts for Mis cuotas, never a place to run an agent.
 */
export function quotaOnlyHostIds(
  hosts: readonly FleetHost[], quota: QuotaEnvironmentsSnapshot | undefined, enrollments: HostEnrollmentList | undefined,
): ReadonlySet<string> {
  const quotaHosts = new Set(quota?.capabilities.hosts.map(host => host.host_id));
  const ready = new Set(enrollments?.enrollments.filter(row => row.executor_ready === true).map(row => row.host_id));
  return new Set(hosts.filter(host => quotaHosts.has(host.host_id) && host.agents.length === 0 && !ready.has(host.host_id))
    .map(host => host.host_id));
}

export function placementHosts(hosts: readonly FleetHost[], quotaOnly: ReadonlySet<string>, keep?: string): FleetHost[] {
  return hosts.filter(host => !quotaOnly.has(host.host_id) || host.host_id === keep);
}

/** Reads what tells a quota-only computer apart. A failed read hides nothing: the server still validates every placement. */
export function useQuotaOnlyInputs(open: boolean) {
  const api = useApi();
  const [quota, setQuota] = useState<QuotaEnvironmentsSnapshot>();
  const [enrollments, setEnrollments] = useState<HostEnrollmentList>();
  useEffect(() => {
    if (!open) return undefined;
    let alive = true;
    void api.getQuotaEnvironments().then(value => { if (alive) setQuota(value); }).catch(() => undefined);
    void api.getHostEnrollments().then(value => { if (alive) setEnrollments(value); }).catch(() => undefined);
    return () => { alive = false; };
  }, [api, open]);
  return { quota, enrollments };
}
