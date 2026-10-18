import { useEffect, useState } from 'react';
import type { ConfigLeafMutation, ConfigMutation, ConfigurationSnapshot } from '../../api/types';
import { Button, Notice } from '../../components/kit';
import { onNavClick } from '../../router';
import { bindingMutation, ceilingMutation, readRegistry } from '../accounts/registry';
import { useSnapshotRunner } from './use-snapshot-runner';
import { canUseConfigForm } from './config-form-access';
import type { ConfigFormDefinition } from './config-form-model';

const BINDING_FORM = { resource: 'agent_account_binding', fields: [] } as unknown as ConfigFormDefinition;
const CEILING_FORM = { resource: 'alias_routing_ceiling', fields: [] } as unknown as ConfigFormDefinition;

export function AgentQuotaBinding({ tenantId, alias, snapshot, onReloaded, onDirtyChange }: {
  tenantId: string; alias: string; snapshot: ConfigurationSnapshot;
  onReloaded: (snapshot: ConfigurationSnapshot) => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const { current, runner } = useSnapshotRunner(snapshot, onReloaded, `agent-quota-binding:${tenantId}/${alias}`);
  const registry = readRegistry(current);
  const [accountId, setAccountId] = useState('');
  const bindings = registry.bindings.items.filter(row => row.tenantId === tenantId && row.agentAlias === alias);
  const selected = registry.accounts.items.find(account => account.id === accountId);
  const binding = bindings.find(row => row.accountId === accountId);
  const available = registry.accounts.available && registry.bindings.available && registry.ceiling.available;
  const eligible = registry.accounts.items.filter(account => account.enabled === true
    && (account.payerTenant === tenantId || account.sharedWithPool === true));
  const priorities = bindings.filter(row => row.enabled).map(row => row.priority ?? 0);
  const priority = Math.max(-1, ...priorities) + 1;
  const hasCeiling = registry.ceiling.items.some(row => row.tenantId === tenantId && row.alias === alias && row.accountId === accountId);
  const canAssign = canUseConfigForm(current, BINDING_FORM, binding ? 'update' : 'create', { tenant_id: tenantId })
    && (hasCeiling || canUseConfigForm(current, CEILING_FORM, 'create', { tenant_id: tenantId }));
  const dirty = accountId !== '' && binding?.enabled !== true;
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => { onDirtyChange(false); }, [onDirtyChange]);
  const mutation: ConfigMutation | undefined = !available || !canAssign || !dirty || priority > 32767
    || !eligible.some(account => account.id === accountId) ? undefined : {
      resource: 'batch', action: 'apply', mutations: [
        ...(hasCeiling ? [] : [ceilingMutation('create', tenantId, alias, accountId) as ConfigLeafMutation]),
        bindingMutation(binding ? 'update' : 'create', tenantId, alias, accountId, { priority, enabled: true }) as ConfigLeafMutation,
      ],
    };
  const disabled = !runner.canWrite || runner.busy || !available || !canAssign;
  return <section className="mt-4 grid gap-3 rounded-lg border border-line bg-surface p-3" aria-label={`Cuentas de cuota de ${tenantId}/${alias}`}>
    <h3 className="m-0 text-sm font-semibold">Cuentas de cuota</h3>
    <p className="m-0 text-xs text-muted">Estas cuentas aportan las cuotas de la ficha y el cansancio de la oficina.
      Con varias cuentas, la oficina muestra la mejor disponibilidad entre ellas.
      La cuenta de ejecución se cambia desde «Operar agente» y requiere comprobar su autenticación.</p>
    {!available ? <p className="m-0 text-sm text-muted">No se publicaron las cuentas o sus asignaciones. Relee el inventario.</p> : null}
    {bindings.some(row => row.enabled) ? <ul className="m-0 grid gap-1 pl-4 text-sm">
      {bindings.filter(row => row.enabled).map(row => {
        const account = registry.accounts.items.find(entry => entry.id === row.accountId);
        return <li key={row.accountId}>{account?.label ?? row.accountId} · paga {account?.payerTenant ?? 'sin informar'}</li>;
      })}
    </ul> : <p className="m-0 text-sm text-muted">Sin cuentas de cuota vinculadas.</p>}
    <label>Cuenta de cuota
      <select value={accountId} disabled={disabled} onChange={event => { setAccountId(event.target.value); runner.clear(); }}>
        <option value="">Elige una cuenta</option>
        {eligible.map(account => <option key={account.id} value={account.id}>
          {account.label ?? account.id} · {account.provider} · paga {account.payerTenant}
        </option>)}
      </select>
    </label>
    {available && !eligible.length ? <Notice tone="info">No hay cuentas habilitadas disponibles para este agente. Registra y autentica una cuenta propia, o habilita una existente, desde{' '}
      <a href="/my-quotas" onClick={event => { onNavClick(event, '/my-quotas'); }}>Mis cuotas</a>.</Notice> : null}
    {selected && binding?.enabled ? <p className="m-0 text-xs text-muted">Esta cuenta ya está vinculada.</p> : null}
    {dirty && priority > 32767 ? <Notice role="note">No queda un orden de respaldo disponible para esta cuenta.</Notice> : null}
    {!runner.canWrite || !canAssign ? <Notice role="note">No tienes permiso para cambiar las cuentas de cuota.</Notice> : null}
    {runner.notice ? <Notice role={runner.notice.tone === 'error' ? 'alert' : 'status'}
      tone={runner.notice.tone === 'error' ? 'danger' : 'info'}>{runner.notice.text}</Notice> : null}
    <div className="flex flex-wrap gap-2">
      <Button disabled={disabled || !mutation} onClick={() => { if (mutation) void runner.run(mutation, true); }}>Previsualizar cuenta</Button>
      <Button variant="primary" disabled={disabled || !mutation || !runner.isValidated(mutation)}
        onClick={() => { if (mutation) void runner.run(mutation, false); }}>Guardar cuenta de cuota</Button>
    </div>
  </section>;
}
