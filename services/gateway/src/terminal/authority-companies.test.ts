import { describe, expect, it } from 'vitest';
import type { DatabasePool } from '@cauce/store';
import {
  cohortRoutingAuthority, containerCohort, loadFleetPlacements, routingAuthority, type CompanyFleetPlacement,
} from './authority.js';

function placement(company: string, host: string | null, tenant: string, alias: string, container: string): CompanyFleetPlacement {
  return { company_id: company, host_id: host, tenant_id: tenant, alias, container, runtime_user: 'dev' };
}

/** Two companies reuse one container name; Humanizar also runs it on a second host. */
const PLACEMENTS: readonly CompanyFleetPlacement[] = [
  placement('humanizar', 'server', 'Steven', 'kant', 'shared-runtime'),
  placement('humanizar', 'server', 'Miguel', 'janus', 'shared-runtime'),
  placement('humanizar', 'server2', 'Isa', 'salva', 'shared-runtime'),
  placement('praxis', 'praxis-host', 'PraxisHub', 'operador', 'shared-runtime'),
  placement('praxis', null, 'PraxisTeam', 'auxiliar', 'shared-runtime'),
];

function labels(cohort: readonly CompanyFleetPlacement[]): string[] {
  return cohort.map((member) => `${member.tenant_id}:${member.alias}`);
}

describe('terminal cohorts by company, host and container', () => {
  it('never joins agents of another company or another host behind a shared container name', () => {
    expect(labels(containerCohort(PLACEMENTS, 'Steven', 'kant'))).toEqual(['Miguel:janus', 'Steven:kant']);
    expect(labels(containerCohort(PLACEMENTS, 'Isa', 'salva'))).toEqual(['Isa:salva']);
  });

  it('lets a hostless agent widen the cohort of every host of its own company only', () => {
    expect(labels(containerCohort(PLACEMENTS, 'PraxisHub', 'operador'))).toEqual(['PraxisHub:operador', 'PraxisTeam:auxiliar']);
    expect(labels(containerCohort(PLACEMENTS, 'PraxisTeam', 'auxiliar'))).toEqual(['PraxisHub:operador', 'PraxisTeam:auxiliar']);
  });

  it('reads the company and the host of every enabled placement', async () => {
    const database = {
      query: async (text: string) => ({ rows: text.includes('company_id,host_id') ? [{
        tenant_id: 'PraxisHub', alias: 'operador', container_name: 'shared-runtime', runtime_user: 'dev',
        company_id: 'praxis', host_id: 'praxis-host',
      }] : [] }),
    } as unknown as DatabasePool;
    await expect(loadFleetPlacements(database)).resolves.toEqual([
      placement('praxis', 'praxis-host', 'PraxisHub', 'operador', 'shared-runtime'),
    ]);
  });
});

describe('terminal routing along the company star', () => {
  const rooms: Record<string, string> = { 'Steven:kant': 'grp.steven', 'Miguel:janus': 'grp.miguel', 'PraxisHub:operador': 'grp.praxis' };
  const companies: Record<string, string> = { Steven: 'humanizar', Miguel: 'humanizar', PraxisHub: 'praxis' };
  /** Seeded edges in every direction, as a broken invariant would leave them; only the SQL star decides. */
  function pool(edges: string[][]): DatabasePool {
    const room = (tenant: string | undefined, alias: string | undefined): string[] => {
      const id = rooms[`${String(tenant)}:${String(alias)}`];
      return id === undefined ? [] : [id];
    };
    return {
      query: async (text: string, values: string[]) => {
        if (text.includes('FROM acl_edges')) {
          const [from = '', to = ''] = values;
          edges.push([from, to]);
          const starred = text.includes('company_links') && text.includes('is_hub');
          return { rows: starred && companies[from] === companies[to] ? [{ ok: true }] : [] };
        }
        const [actorTenant, actorAlias, targetTenant, targetAlias] = values;
        return { rows: [
          ...room(actorTenant, actorAlias).map((room_id) => ({ side: 'actor', room_id })),
          ...room(targetTenant, targetAlias).map((room_id) => ({ side: 'target', room_id })),
        ] };
      },
    } as unknown as DatabasePool;
  }

  it('admits a cross-tenant edge only through the hub star or a live company link', async () => {
    const edges: string[][] = [];
    await expect(routingAuthority(pool(edges), 'Steven', 'kant', 'Miguel', 'janus'))
      .resolves.toMatchObject({ allowed: true, reason: 'acl_edge' });
    await expect(routingAuthority(pool(edges), 'Steven', 'kant', 'PraxisHub', 'operador'))
      .resolves.toEqual({ allowed: false, reason: 'acl_edge_missing', source_room_ids: [] });
    expect(edges).toEqual([['Steven', 'Miguel'], ['Steven', 'PraxisHub']]);
  });

  it('authorizes a shared container without asking about, or naming, another company', async () => {
    const edges: string[][] = [];
    const cohort = containerCohort(PLACEMENTS, 'Steven', 'kant');
    await expect(cohortRoutingAuthority(pool(edges), 'Steven', 'kant', cohort))
      .resolves.toEqual({ allowed: true, reason: 'cohort_authorized', source_room_ids: ['grp.steven'] });
    expect(edges).toEqual([['Steven', 'Miguel']]);
  });
});
