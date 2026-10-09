import { useCallback, useEffect, useState, type ComponentProps } from 'react';
import { ConfigCollectionForm } from './ConfigCollectionForm';
import { GroupMembershipMove } from './GroupMembershipMove';

export function GroupEditor(props: ComponentProps<typeof ConfigCollectionForm>) {
  const { target, snapshot, runner, busy, onDirtyChange } = props;
  const row = target.row;
  const [formDirty, setFormDirty] = useState(false);
  const [moveDirty, setMoveDirty] = useState(false);
  const dirty = formDirty || moveDirty;
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  const reportForm = useCallback((value: boolean) => { setFormDirty(value); }, []);
  const reportMove = useCallback((value: boolean) => { setMoveDirty(value); }, []);
  return <><ConfigCollectionForm {...props} onDirtyChange={reportForm} />
    {target.action === 'update' && typeof row?.tenant_id === 'string' && typeof row.id === 'string'
      ? <GroupMembershipMove tenantId={row.tenant_id} roomId={row.id} snapshot={snapshot} runner={runner} busy={busy}
        onDirtyChange={reportMove} /> : null}
  </>;
}
