import { PencilLine, Power, PowerOff, Lock, Share2, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { ConfigurationSnapshot, ConsoleAccess } from '../../api/types';
import type { Resource } from '../../api/use-resource';
import { cn } from '../../cn';
import { CARD_TABLE, Explain, Kpi, KpiGrid, LinkButton, Notice, SCROLL } from '../../components/kit';
import { FormDialog } from '../../components/dialogs';
import { Badge, Desplazable, EmptyState, Time, Unknown } from '../../components/ui';
import { useConfigMutation } from '../config/use-config-mutation';
import { CONFIG_SIN_CONTROL_REASON, onNavClick } from '../../router';
import { MutationBar } from './MutationBar';
import {
  deleteAccountMutation, describeRegistryError, redactPreview, updateAccountMutation, viewerTenant,
  type ProviderAccount, type RegistryModel,
} from './registry';

interface AccountEdit {
  id: string;
  label: string;
  sharedWithPool: boolean;
  enabled: boolean;
}

type FormState =
  | { kind: 'edit'; edit: AccountEdit }
  | { kind: 'delete'; accountId: string; confirmation: string };

const CHECK = 'flex items-start gap-2 font-normal';
const HINT = 'text-xs font-normal text-muted';

function foreignDetail(count: number | null, names: readonly string[]): string {
  if (count === null) return 'No se puede comparar: la sesión no informa tu espacio.';
  if (count === 0) return 'Ninguna cuenta la paga otra empresa.';
  if (names.length === 1) return `La paga ${names[0]}.`;
  if (names.length > 1) return `Las pagan ${names.join(', ')}.`;
  return 'Las paga otra empresa.';
}

/**
 * An account update rewrites label, shared_with_pool and enabled at once. If the snapshot does
 * not carry one of the two booleans there is no current state to preserve, and sending an
 * invented value would silently change something the operator did not decide.
 */
function editBlocker(account: ProviderAccount): string | undefined {
  if (account.sharedWithPool === null || account.enabled === null) {
    return 'El servidor no informa si la cuenta está habilitada y compartida. Actualiza el inventario antes de editar para conservar sus valores actuales.';
  }
  return undefined;
}

function editFrom(account: ProviderAccount, patch: Partial<AccountEdit> = {}): AccountEdit {
  return {
    id: account.id,
    label: account.label ?? '',
    sharedWithPool: account.sharedWithPool === true,
    enabled: account.enabled === true,
    ...patch,
  };
}

/** Inventory and management of AI provider accounts. */
export function AccountsInventory({ config, access, registry }: {
  config: Resource<ConfigurationSnapshot>;
  access: Resource<ConsoleAccess>;
  registry: RegistryModel;
}) {
  const [form, setForm] = useState<FormState>();
  // Closing a form hides it without discarding what was typed: only starting another one replaces it.
  const [shown, setShown] = useState(false);

  const { accounts, ceiling } = registry;
  const runner = useConfigMutation({
    config,
    access,
    canal: 'account-inventory',
    describeError: (error, mutation) => describeRegistryError(error, mutation, registry.context),
    redactar: redactPreview,
  });
  const writeDisabled = !runner.canWrite || runner.busy;
  const writeProps = { disabled: writeDisabled, ...(!runner.canWrite ? { title: CONFIG_SIN_CONTROL_REASON } : {}) };

  const actorTenant = viewerTenant(access.error ? undefined : access.data?.subject);
  const pooled = accounts.available ? accounts.items.filter((item) => item.sharedWithPool === true).length : null;
  const enabled = accounts.available ? accounts.items.filter((item) => item.enabled === true).length : null;
  const foreignPayers = accounts.available && actorTenant
    ? [...new Set(accounts.items.flatMap((item) => item.payerTenant && item.payerTenant !== actorTenant ? [item.payerTenant] : []))]
    : [];
  const foreign = accounts.available && actorTenant
    ? accounts.items.filter((item) => item.payerTenant !== null && item.payerTenant !== actorTenant).length
    : null;
  const foreignNames = foreignPayers.flatMap((id) => {
    const row = config.data?.tenants?.find((tenant) => tenant.id === id);
    const name = typeof row?.display_name === 'string' ? row.display_name.trim() : '';
    return name && name !== id ? [name] : [];
  });
  const inventoryEmpty = accounts.available && accounts.items.length === 0;

  const editing = form?.kind === 'edit'
    ? accounts.items.find((item) => item.id === form.edit.id)
    : undefined;
  const editInvalid = form?.kind === 'edit'
    ? (editing ? editBlocker(editing) : 'La cuenta que estabas editando ya no está en el snapshot: vuelve al inventario.')
    : undefined;
  const accountCeilings = form?.kind === 'delete'
    ? ceiling.items.filter((entry) => entry.accountId === form.accountId)
    : [];
  const deleteInvalid = form?.kind === 'delete'
    ? !ceiling.available
      ? 'No se puede borrar con seguridad: el servidor no publicó los accesos y no se sabe si algún agente todavía usa la cuenta.'
      : accountCeilings.length > 0
        ? accountCeilings.length === 1
          ? `Primero quita el acceso que todavía usa esta cuenta: ${accountCeilings[0]?.tenantId}/${accountCeilings[0]?.alias}.`
          : `Primero quita los ${String(accountCeilings.length)} accesos que todavía usan esta cuenta: ${accountCeilings.map((entry) => `${entry.tenantId}/${entry.alias}`).join(', ')}.`
        : form.confirmation !== form.accountId
          ? `Escribe exactamente «${form.accountId}» para confirmar el borrado.`
          : undefined
    : undefined;
  const mutation = form?.kind === 'edit'
    ? (editInvalid ? undefined : updateAccountMutation(form.edit.id, {
      label: form.edit.label.trim() || null,
      sharedWithPool: form.edit.sharedWithPool,
      enabled: form.edit.enabled,
    }))
    : form?.kind === 'delete' ? (deleteInvalid ? undefined : deleteAccountMutation(form.accountId)) : undefined;
  const invalid = form?.kind === 'edit' ? editInvalid : deleteInvalid;

  function open(next: FormState) {
    setForm(next);
    setShown(true);
    runner.clear();
  }

  function close() {
    setShown(false);
    runner.clear();
  }

  function patchEdit(patch: Partial<AccountEdit>) {
    setForm((current) => (current?.kind === 'edit' ? { kind: 'edit', edit: { ...current.edit, ...patch } } : current));
    runner.clear();
  }

  return <div className="grid gap-4">
    <KpiGrid label="Indicadores">
      <Kpi label="Cuentas visibles" value={accounts.available ? accounts.items.length : null} detail={accounts.available ? 'propias y compartidas' : 'el servidor no publica el inventario'} />
      <Kpi label="Compartidas" value={pooled} detail="prestadas por su pagador" />
      <Kpi label="Habilitadas" value={enabled} detail="las que el despacho puede usar" />
      <Kpi label="Pagadas por otra empresa" value={foreign} tone={foreign ? 'warning' : 'neutral'} detail={foreignDetail(foreign, foreignNames)} />
    </KpiGrid>

    <section aria-label="Inventario de cuentas">
      <p className="m-0 mb-3 text-xs text-muted">«Deshabilitada» aquí significa que la cuenta no admite uso. Si todavía no inició sesión, la misma cuenta figura como «Pendiente de autenticación» en «Mis cuotas»: son dos vistas del mismo estado, no dos fallos distintos.</p>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <h2 className="m-0 text-sm font-semibold">Inventario</h2>
        {inventoryEmpty ? null : <LinkButton href="/my-quotas" onClick={(event) => { onNavClick(event, '/my-quotas'); }}>Registrar en Mis cuotas</LinkButton>}
      </div>
      <Notice tone="info" className="mb-3">Cauce no autentica cuentas mediante rutas o variables declaradas en el inventario.
        Registra la cuenta e inicia sesión en «Mis cuotas». La ejecución del agente usa el perfil autenticado de su cuenta principal.</Notice>
      {!accounts.available
        ? <><EmptyState>
          No disponible: el servidor no publica el inventario de cuentas. No se muestra nada porque no hay dato, y la consola no lo simula.
        </EmptyState><details><summary>Detalles técnicos</summary><code>provider_accounts</code></details></>
        : accounts.items.length === 0
          ? <EmptyState>
            Todavía no hay cuentas. Es lo normal en una empresa nueva.{' '}
            <LinkButton href="/my-quotas" onClick={(event) => { onNavClick(event, '/my-quotas'); }}>Registrar en Mis cuotas</LinkButton>
            {' '}añade una suscripción para consultar su uso, aunque ningún agente la use todavía.
          </EmptyState>
          : <Desplazable etiqueta="Inventario de cuentas de proveedores de IA" className={SCROLL}>
            <table className={CARD_TABLE}>
              <caption className="sr-only">Inventario de cuentas de proveedores de IA</caption>
              <thead><tr>
                <th>Cuenta</th><th>Proveedor</th><th>Paga</th><th>Compartida</th>
                <th>Estado</th><th>Actualizada</th><th>Acciones</th>
              </tr></thead>
              <tbody>
                {accounts.items.map((account) => {
                  return <tr key={account.id}>
                      <td data-label="Cuenta"><strong className="mono">{account.id}</strong><small className="subline"><Unknown value={account.label} /></small></td>
                      <td data-label="Proveedor"><span className="mono"><Unknown value={account.provider} /></span></td>
                      <td data-label="Paga">
                        <Unknown value={account.payerTenant} />
                        {actorTenant && account.payerTenant && account.payerTenant !== actorTenant
                          ? <span className="chip ml-1.5">prestada</span>
                          : null}
                      </td>
                      <td data-label="Compartida">{account.sharedWithPool === null
                        ? <Badge tone="unknown">SIN DATO</Badge>
                        : <Badge tone={account.sharedWithPool ? 'info' : 'offline'}>{account.sharedWithPool ? 'PUBLICADA' : 'PRIVADA'}</Badge>}</td>
                      <td data-label="Estado">{account.enabled === null
                        ? <Badge tone="unknown">SIN DATO</Badge>
                        : <Badge tone={account.enabled ? 'online' : 'offline'}>{account.enabled ? 'HABILITADA' : 'DESHABILITADA'}</Badge>}</td>
                      <td data-label="Actualizada"><Time value={account.updatedAt} relativo /></td>
                      <td data-label="Acciones" data-wide><span className="inline-flex flex-wrap items-center gap-1.5">
                        <RowAction {...writeProps} label={`Editar «${account.id}»`} text="Editar" onClick={() => { open({ kind: 'edit', edit: editFrom(account) }); }}>
                          <PencilLine size={13} aria-hidden="true" />
                        </RowAction>
                        <RowAction
                          label={account.enabled === true ? `Deshabilitar «${account.id}»` : `Habilitar «${account.id}»`}
                          text={account.enabled === true ? 'Deshabilitar' : 'Habilitar'}
                          {...writeProps}
                          undoes={account.enabled === true}
                          onClick={() => { open({ kind: 'edit', edit: editFrom(account, { enabled: account.enabled !== true }) }); }}
                        >
                          {account.enabled === true ? <PowerOff size={13} aria-hidden="true" /> : <Power size={13} aria-hidden="true" />}
                        </RowAction>
                        <RowAction
                          label={account.sharedWithPool === true ? `Dejar de compartir «${account.id}»` : `Compartir «${account.id}»`}
                          text={account.sharedWithPool === true ? 'Dejar de compartir' : 'Compartir'}
                          {...writeProps}
                          undoes={account.sharedWithPool === true}
                          onClick={() => { open({ kind: 'edit', edit: editFrom(account, { sharedWithPool: account.sharedWithPool !== true }) }); }}
                        >
                          {account.sharedWithPool === true ? <Lock size={13} aria-hidden="true" /> : <Share2 size={13} aria-hidden="true" />}
                        </RowAction>
                        <RowAction {...writeProps} label={`Retirar o rotar «${account.id}»`} text="Retirar" undoes onClick={() => { open({ kind: 'delete', accountId: account.id, confirmation: '' }); }}>
                          <Trash2 size={13} aria-hidden="true" />
                        </RowAction>
                      </span></td>
                    </tr>;
                })}
              </tbody>
            </table>
          </Desplazable>}
      <Explain title="¿Cómo se conecta una cuenta?">
        <p>La credencial se mantiene en el perfil autenticado del proveedor y no se devuelve en el inventario.
          Compartir una cuenta permite asignarla a otros espacios; cada agente debe autenticar su perfil de ejecución.</p>
        <p>Deshabilitar conserva el registro; borrar lo retira del inventario y exige revisar una vista previa antes de confirmar.</p>
      </Explain>
    </section>

    <FormDialog open={shown && form?.kind === 'edit'} onClose={close} busy={runner.busy}
      title={form?.kind === 'edit' ? `Edición de «${form.edit.id}»` : 'Edición'}
      description="Solo la etiqueta, si se comparte y el estado son editables: proveedor, id externo y pagador no se cambian porque los accesos ya usan este id.">
      {form?.kind === 'edit' ? <>
        <div className="grid gap-3">
          <label>Etiqueta <span className={HINT}>vacío guarda null</span>
            <input {...writeProps} value={form.edit.label} onChange={(event) => { patchEdit({ label: event.target.value }); }} />
          </label>
          <label className={CHECK}><input {...writeProps} type="checkbox" checked={form.edit.sharedWithPool} onChange={(event) => { patchEdit({ sharedWithPool: event.target.checked }); }} /> Compartida con otros espacios</label>
          <label className={CHECK}><input {...writeProps} type="checkbox" checked={form.edit.enabled} onChange={(event) => { patchEdit({ enabled: event.target.checked }); }} /> Habilitada</label>
        </div>
        <Notice>
          No puedes dejar de compartir mientras otra empresa tenga acceso a la cuenta. Quita antes ese acceso, que también borra su orden de consulta.
        </Notice>
        <MutationBar snapshot={config.data} runner={runner} mutation={mutation} invalid={invalid} previewLabel="edición de cuenta" />
      </> : null}
    </FormDialog>

    <FormDialog open={shown && form?.kind === 'delete'} onClose={close} busy={runner.busy}
      title={form?.kind === 'delete' ? `Retirar o rotar «${form.accountId}»` : 'Retirar cuenta'}
      description="Borrar retira esta cuenta del inventario de forma irreversible. Las cuentas nuevas se registran desde «Mis cuotas».">
      {form?.kind === 'delete' ? <>
        <Notice tone="danger" role="note">
          El borrado falla si cualquier agente conserva acceso a esta cuenta. Quita antes esos accesos y retira sus entornos de consulta.
        </Notice>
        <Notice tone="info">
          Para eliminar la cuenta y su historial de cuotas, confirma su eliminación en «Mis cuotas» después de retirar sus entornos.
          Este formulario solo elimina registros sin dependencias.
          <LinkButton href="/my-quotas" onClick={(event) => { onNavClick(event, '/my-quotas'); }}>Eliminar en Mis cuotas</LinkButton>
        </Notice>
        <label>
          <span>Confirma escribiendo <strong className="mono">{form.accountId}</strong></span>
          <input
            {...writeProps}
            aria-label={`Confirmar borrado de ${form.accountId}`}
            value={form.confirmation}
            onChange={(event) => {
              setForm({ ...form, confirmation: event.target.value });
              runner.clear();
            }}
            autoComplete="off"
          />
        </label>
        <MutationBar snapshot={config.data} runner={runner} mutation={mutation} invalid={invalid} previewLabel="retiro o rotación de cuenta" />
      </> : null}
    </FormDialog>
  </div>;
}

/**
 * A row action with a visible verb: the accessible name carries the verb and the account, and
 * `undoes` tints the direction that takes something away. No click here writes anything —it opens
 * a form whose write still goes through its dry-run before applying. */
function RowAction({ label, text, onClick, undoes = false, disabled = false, title, children }: {
  label: string;
  text: string;
  onClick: () => void;
  undoes?: boolean;
  disabled?: boolean;
  title?: string;
  children: ReactNode;
}) {
  return (
    <button
      className={cn(
        'inline-flex min-h-7 cursor-pointer items-center gap-1 rounded-md border border-line-strong bg-surface px-2 text-xs font-medium whitespace-nowrap text-fg transition-colors enabled:hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-40',
        undoes && 'enabled:hover:bg-warn-soft enabled:hover:text-warn-ink',
      )}
      type="button"
      title={title ?? label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}{text}
    </button>
  );
}
