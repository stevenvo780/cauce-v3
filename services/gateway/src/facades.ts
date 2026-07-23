import type { Principal } from './auth.js';

type Row = Record<string, unknown>;

function object(value: unknown): Row | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : undefined;
}

function participant(value: unknown, principal: Principal): boolean {
  const row = object(value);
  return row?.tenant_id === principal.tenant_id && (row.alias === principal.alias || row.actor_alias === principal.alias);
}

function deliveries(row: Row): Row[] {
  return Array.isArray(row.deliveries) ? row.deliveries.map(object).filter((item): item is Row => item !== undefined) : [];
}

export function messageVisible(row: Row, principal: Principal): boolean {
  const senderTenant = row.message_tenant_id ?? row.tenant_id;
  if (senderTenant === principal.tenant_id && row.actor_alias === principal.alias) return true;
  if (Array.isArray(row.participants) && row.participants.some((item) => participant(item, principal))) return true;
  return deliveries(row).some((delivery) => {
    const tenant = delivery.recipient_tenant ?? delivery.tenant_id;
    const alias = delivery.recipient_alias ?? delivery.alias;
    return tenant === principal.tenant_id && alias === principal.alias;
  });
}

function redactMessage(row: Row, principal: Principal): Row {
  const isSender = (row.message_tenant_id ?? row.tenant_id) === principal.tenant_id && row.actor_alias === principal.alias;
  if (isSender || !Array.isArray(row.deliveries)) return row;
  return {
    ...row,
    deliveries: deliveries(row).filter((delivery) =>
      (delivery.recipient_tenant ?? delivery.tenant_id) === principal.tenant_id &&
      (delivery.recipient_alias ?? delivery.alias) === principal.alias
    )
  };
}

export function visibleMessageList(value: Row, principal: Principal): Row {
  if (!Array.isArray(value.items)) return { ...value, items: [] };
  return {
    ...value,
    items: value.items.map(object).filter((item): item is Row => item !== undefined)
      .filter((item) => messageVisible(item, principal))
      .map((item) => redactMessage(item, principal))
  };
}

export function visibleMessage(value: Row, principal: Principal): Row | undefined {
  return messageVisible(value, principal) ? redactMessage(value, principal) : undefined;
}

function queueRowVisible(row: Row, principal: Principal): boolean {
  const recipientTenant = row.recipient_tenant ?? row.tenant_id;
  if (recipientTenant === principal.tenant_id && row.recipient_alias === principal.alias) return true;
  const senderTenant = row.message_tenant_id ?? row.sender_tenant_id;
  return senderTenant === principal.tenant_id && row.actor_alias === principal.alias;
}

export function visibleQueue(value: Row, principal: Principal): Row {
  const items = Array.isArray(value.items)
    ? value.items.map(object).filter((item): item is Row => item !== undefined).filter((item) => queueRowVisible(item, principal))
    : [];
  const counts = items.reduce<{ pending: number; retrying: number; dead: number }>((result, row) => {
    if (row.state === 'retry') result.retrying += 1;
    else if (row.state === 'dead') result.dead += 1;
    else if (['pending', 'leased', 'accepted', 'started'].includes(String(row.state))) result.pending += 1;
    return result;
  }, { pending: 0, retrying: 0, dead: 0 });
  return { ...value, ...counts, items };
}

export function sameTenantRows(value: Row, principal: Principal): Row {
  const items = Array.isArray(value.items)
    ? value.items.map(object).filter((item): item is Row => item !== undefined)
      .filter((item) => item.tenant_id === principal.tenant_id)
    : [];
  return { ...value, items };
}

export function visibleOriginRelays(value: Row, principal: Principal): Row {
  const items = Array.isArray(value.items)
    ? value.items.map(object).filter((item): item is Row => item !== undefined).filter((item) => {
      if (item.actor_alias === principal.alias && item.tenant_id === principal.tenant_id) return true;
      if (Array.isArray(item.participants) && item.participants.some((entry) => participant(entry, principal))) return true;
      return item.recipient_tenant === principal.tenant_id && item.recipient_alias === principal.alias;
    })
    : [];
  return { ...value, items };
}
