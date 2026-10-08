import type { ComponentProps } from 'react';
import { ConfigCollectionForm } from './ConfigCollectionForm';
import { GroupMembershipMove } from './GroupMembershipMove';

export function GroupEditor(props: ComponentProps<typeof ConfigCollectionForm>) {
  const { target, snapshot, runner, busy } = props;
  const row = target.row;
  return <><ConfigCollectionForm {...props} />
    {target.action === 'update' && typeof row?.tenant_id === 'string' && typeof row.id === 'string'
      ? <GroupMembershipMove tenantId={row.tenant_id} roomId={row.id} snapshot={snapshot} runner={runner} busy={busy} /> : null}
  </>;
}
