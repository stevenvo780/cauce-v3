import { screen } from '@testing-library/react';
import type userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../mocks/server';

export interface ChangeRequest {
  dry_run?: boolean;
  expected_revision?: number;
  mutation?: Record<string, unknown>;
}

export type Usuario = ReturnType<typeof userEvent.setup>;

export async function irA(user: Usuario, pestana: RegExp) {
  await user.click(await screen.findByRole('tab', { name: pestana }));
}

export const MEMBERSHIP_JANUS = 'Habilitado en la membresía Miguel/grp.miguel/janus';

const REVISIONES = [{
  id: '1',
  actor_tenant: 'Steven',
  actor_alias: 'kant',
  operation: {
    resource: 'acl_edge', action: 'create', from_tenant: 'Steven', to_tenant: 'Isa',
    value: { enabled: true, allow_route: false, allow_read: false, allow_control: false },
  },
  summary: 'alta de la arista Steven → Isa',
  created_at: '2026-08-20T10:00:00.000Z',
}];

export function recordChanges(sink: ChangeRequest[]) {
  server.use(http.post('http://localhost/v3/console/config/changes', async ({ request }) => {
    const input = await request.json() as ChangeRequest;
    sink.push(input);
    return HttpResponse.json({
      applied: input.dry_run !== true,
      dry_run: input.dry_run === true,
      revision: input.dry_run ? 1 : 2,
      mutation: input.mutation,
      inverse_mutation: input.mutation,
      rolled_back_revision_id: null,
      summary: 'mock configuration validation',
    }, { status: input.dry_run ? 200 : 201 });
  }));
}

export function snapshotDeConfig(revision: number) {
  return {
    revision,
    observed_at: new Date().toISOString(),
    tenants: [{ id: 'Miguel', display_name: 'Miguel', is_hub: false, enabled: true }],
    rooms: [{ id: 'grp.miguel', tenant_id: 'Miguel', display_name: 'grp.miguel', enabled: true }],
    memberships: [{ tenant_id: 'Miguel', room_id: 'grp.miguel', alias: 'janus', role: 'agent', enabled: true }],
    acl_edges: [],
    role_policies: [{ role: 'agent' }, { role: 'operator' }],
    revisions: [],
  };
}

export function snapshotConAudit(revision: number) {
  return { ...snapshotDeConfig(revision), revisions: REVISIONES };
}

export function servirConfig(snapshot: () => Record<string, unknown>) {
  server.use(http.get('*/v3/console/config', () => HttpResponse.json(snapshot())));
}
