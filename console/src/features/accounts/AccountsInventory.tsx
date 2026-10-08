import {
  ChevronDown, ChevronRight, PencilLine, Plus, Power, PowerOff, Lock, Share2, Trash2,
} from 'lucide-react';
import { Fragment, useState, type ReactNode } from 'react';
import type {
  ConfigurationSnapshot, ConsoleAccess, QuotaSeverity, QuotaSnapshot, QuotaThresholds,
} from '../../api/types';
import type { Resource } from '../../api/use-resource';
import { cn } from '../../cn';
import { Button, CARD_TABLE, Explain, Kpi, KpiGrid, Notice, SCROLL } from '../../components/kit';
import { FormDialog } from '../../components/dialogs';
import { Badge, Desplazable, EmptyState, Time, Unknown } from '../../components/ui';
import { useConfigMutation } from '../config/use-config-mutation';
import { CONFIG_SIN_CONTROL_REASON } from '../../router';
import { AccountDetail } from './AccountDetail';
import { accountConsumption, type AccountConsumption } from './licenses';
import { MutationBar } from './MutationBar';
import {
  CREDENTIAL_REF_HINTS, CREDENTIAL_REF_KINDS, accountDraftError, createAccountMutation,
  deleteAccountMutation, describeRegistryError, redactPreview, updateAccountMutation, viewerTenant,
  type AccountDraft, type CredentialRefKind, type ProviderAccount, type RegistryModel,
} from './registry';
import { SEVERITY_TONE, balanceSeverity, formatPercent } from './quotas';

const emptyDraft: AccountDraft = {
  id: 'codex-steven',
  provider: 'codex',
  externalAccountId: '',
  payerTenant: '',
  label: '',
  credentialRefKind: 'env_path',
  credentialRef: 'CAUCE_CODEX_STEVEN_PATH',
  sharedWithPool: false,
  enabled: false,
};

interface AccountEdit {
  id: string;
  label: string;
  sharedWithPool: boolean;
  enabled: boolean;
}

type FormState =
  | { kind: 'create'; draft: AccountDraft }
  | { kind: 'edit'; edit: AccountEdit }
  | { kind: 'delete'; accountId: string; confirmation: string };

const FIELDS = 'grid gap-3 sm:grid-cols-2';
const CHECK = 'flex items-start gap-2 font-normal';
const HINT = 'text-xs font-normal text-muted';

/**
 * An account update rewrites label, shared_with_pool and enabled at once. If the snapshot does
 * not carry one of the two booleans there is no current state to preserve, and sending an
 * invented value would silently change something the operator did not decide.
 */
function editBlocker(account: ProviderAccount): string | undefined {
  if (account.sharedWithPool === null || account.enabled === null) {
    return 'El snapshot no trae shared_with_pool y/o enabled para esta cuenta. El update reescribe los tres campos a la vez, así que sin el estado actual no se puede editar sin pisar algo: actualizá el snapshot.';
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

/** Inventory and management of AI provider accounts and consumption state. */
export function AccountsInventory({ config, access, quotas, registry }: {
  config: Resource<ConfigurationSnapshot>;
  access: Resource<ConsoleAccess>;
  quotas: Resource<QuotaSnapshot>;
  registry: RegistryModel;
}) {
  const [form, setForm] = useState<FormState>();
  // Closing a form hides it without discarding what was typed: only starting another one replaces it.
  const [shown, setShown] = useState(false);
  const [openDetail, setOpenDetail] = useState<Set<string>>(new Set());

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
  const foreign = accounts.available && actorTenant
    ? accounts.items.filter((item) => item.payerTenant !== null && item.payerTenant !== actorTenant).length
    : null;

  const editing = form?.kind === 'edit'
    ? accounts.items.find((item) => item.id === form.edit.id)
    : undefined;
  const editInvalid = form?.kind === 'edit'
    ? (editing ? editBlocker(editing) : 'La cuenta que estabas editando ya no está en el snapshot: volvé al inventario.')
    : undefined;
  const accountCeilings = form?.kind === 'delete'
    ? ceiling.items.filter((entry) => entry.accountId === form.accountId)
    : [];
  const deleteInvalid = form?.kind === 'delete'
    ? !ceiling.available
      ? 'No se puede borrar con seguridad: el gateway no publicó alias_routing_ceiling y no se sabe si algún alias todavía referencia la cuenta.'
      : accountCeilings.length > 0
        ? accountCeilings.length === 1
          ? `Primero revocá el techo que todavía apunta a esta cuenta: ${accountCeilings[0]?.tenantId}/${accountCeilings[0]?.alias}.`
          : `Primero revocá los ${String(accountCeilings.length)} techos que todavía apuntan a esta cuenta: ${accountCeilings.map((entry) => `${entry.tenantId}/${entry.alias}`).join(', ')}.`
        : form.confirmation !== form.accountId
          ? `Escribí exactamente «${form.accountId}» para confirmar el borrado.`
          : undefined
    : undefined;
  const mutation = form?.kind === 'create'
    ? (accountDraftError(form.draft) ? undefined : createAccountMutation(form.draft))
    : form?.kind === 'edit'
      ? (editInvalid ? undefined : updateAccountMutation(form.edit.id, {
        label: form.edit.label.trim() || null,
        sharedWithPool: form.edit.sharedWithPool,
        enabled: form.edit.enabled,
      }))
      : form?.kind === 'delete' ? (deleteInvalid ? undefined : deleteAccountMutation(form.accountId)) : undefined;
  const invalid = form?.kind === 'create'
    ? accountDraftError(form.draft)
    : form?.kind === 'edit' ? editInvalid : deleteInvalid;

  function open(next: FormState) {
    setForm(next);
    setShown(true);
    runner.clear();
  }

  function close() {
    setShown(false);
    runner.clear();
  }

  function editDraft(patch: Partial<AccountDraft>) {
    setForm((current) => (current?.kind === 'create' ? { kind: 'create', draft: { ...current.draft, ...patch } } : current));
    runner.clear();
  }

  function patchEdit(patch: Partial<AccountEdit>) {
    setForm((current) => (current?.kind === 'edit' ? { kind: 'edit', edit: { ...current.edit, ...patch } } : current));
    runner.clear();
  }

  function toggleDetail(accountId: string) {
    setOpenDetail((current) => {
      const next = new Set(current);
      if (next.has(accountId)) next.delete(accountId); else next.add(accountId);
      return next;
    });
  }

  return <div className="grid gap-4">
    <KpiGrid label="Indicadores">
      <Kpi label="Cuentas visibles" value={accounts.available ? accounts.items.length : null} detail={accounts.available ? 'propias más las del pool' : 'el servidor no publica el inventario'} />
      <Kpi label="Publicadas al pool" value={pooled} detail="prestadas por su pagador" />
      <Kpi label="Habilitadas" value={enabled} detail="las que el despacho puede usar" />
      <Kpi label="Pagadas por otro tenant" value={foreign} tone={foreign ? 'warning' : 'neutral'} detail={actorTenant ? `pagador distinto de ${actorTenant}` : 'tenant del actor sin informar'} />
    </KpiGrid>

    <section aria-label="Inventario de cuentas">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="m-0 text-sm font-semibold">Inventario</h2>
        <Button variant="primary" {...writeProps} onClick={() => { open(form?.kind === 'create' ? form : { kind: 'create', draft: emptyDraft }); }}>
          <Plus size={15} aria-hidden="true" />Nueva cuenta
        </Button>
      </div>
      {!accounts.available
        ? <EmptyState>
          No disponible: este gateway no publica el inventario de cuentas (<code>provider_accounts</code>). No se muestra nada porque no hay dato, y la consola no lo simula.
        </EmptyState>
        : accounts.items.length === 0
          ? <EmptyState>El servidor devolvió cero cuentas visibles para este actor.</EmptyState>
          : <Desplazable etiqueta="Inventario de cuentas de proveedores de IA" className={SCROLL}>
            <table className={CARD_TABLE}>
              <caption className="sr-only">Inventario de cuentas de proveedores de IA</caption>
              <thead><tr>
                <th>Cuenta</th><th>Proveedor</th><th>Paga</th><th>Pool</th>
                <th>Estado</th><th>Consumo</th><th>Actualizada</th><th>Acciones</th>
              </tr></thead>
              <tbody>
                {accounts.items.map((account) => {
                  const consumption = accountConsumption(account.id, quotas.data, quotas.data?.thresholds);
                  const detailOpen = openDetail.has(account.id);
                  return <Fragment key={account.id}>
                    <tr>
                      <td data-label="Cuenta"><strong className="mono">{account.id}</strong><small className="subline"><Unknown value={account.label} /></small></td>
                      <td data-label="Proveedor"><span className="mono"><Unknown value={account.provider} /></span></td>
                      <td data-label="Paga">
                        <Unknown value={account.payerTenant} />
                        {actorTenant && account.payerTenant && account.payerTenant !== actorTenant
                          ? <span className="chip ml-1.5">prestada</span>
                          : null}
                      </td>
                      <td data-label="Pool">{account.sharedWithPool === null
                        ? <Badge tone="unknown">SIN DATO</Badge>
                        : <Badge tone={account.sharedWithPool ? 'info' : 'offline'}>{account.sharedWithPool ? 'PUBLICADA' : 'PRIVADA'}</Badge>}</td>
                      <td data-label="Estado">{account.enabled === null
                        ? <Badge tone="unknown">SIN DATO</Badge>
                        : <Badge tone={account.enabled ? 'online' : 'offline'}>{account.enabled ? 'HABILITADA' : 'DESHABILITADA'}</Badge>}</td>
                      <td data-label="Consumo"><AccountUsage consumption={consumption} thresholds={quotas.data?.thresholds} /></td>
                      <td data-label="Actualizada"><Time value={account.updatedAt} relativo /></td>
                      <td data-label="Acciones" data-wide><span className="-ml-1 inline-flex flex-wrap gap-0.5">
                        <RowAction label={`Detalle de ${account.id}`} expanded={detailOpen} onClick={() => { toggleDetail(account.id); }}>
                          {detailOpen ? <ChevronDown size={15} aria-hidden="true" /> : <ChevronRight size={15} aria-hidden="true" />}
                        </RowAction>
                        <RowAction {...writeProps} label={`Editar «${account.id}»`} onClick={() => { open({ kind: 'edit', edit: editFrom(account) }); }}>
                          <PencilLine size={15} aria-hidden="true" />
                        </RowAction>
                        <RowAction
                          label={account.enabled === true ? `Deshabilitar «${account.id}»` : `Habilitar «${account.id}»`}
                          {...writeProps}
                          undoes={account.enabled === true}
                          onClick={() => { open({ kind: 'edit', edit: editFrom(account, { enabled: account.enabled !== true }) }); }}
                        >
                          {account.enabled === true ? <PowerOff size={15} aria-hidden="true" /> : <Power size={15} aria-hidden="true" />}
                        </RowAction>
                        <RowAction
                          label={account.sharedWithPool === true ? `Despublicar «${account.id}» del pool` : `Publicar «${account.id}» al pool`}
                          {...writeProps}
                          undoes={account.sharedWithPool === true}
                          onClick={() => { open({ kind: 'edit', edit: editFrom(account, { sharedWithPool: account.sharedWithPool !== true }) }); }}
                        >
                          {account.sharedWithPool === true ? <Lock size={15} aria-hidden="true" /> : <Share2 size={15} aria-hidden="true" />}
                        </RowAction>
                        <RowAction {...writeProps} label={`Retirar o rotar «${account.id}»`} undoes onClick={() => { open({ kind: 'delete', accountId: account.id, confirmation: '' }); }}>
                          <Trash2 size={15} aria-hidden="true" />
                        </RowAction>
                      </span></td>
                    </tr>
                    {detailOpen ? <tr className="row-detail">
                      <td colSpan={8} className="max-md:!block max-md:!p-0">
                        <AccountDetail accountId={account.id} account={account} quotas={quotas.data} />
                      </td>
                    </tr> : null}
                  </Fragment>;
                })}
              </tbody>
            </table>
          </Desplazable>}
      <Explain title="¿Dónde vive la credencial?">
        <p>El snapshot nunca trae <code>credential_ref</code>. Lo único que se registra es dónde encontrar la credencial —una variable de entorno, una ruta, o un <code>esquema:path</code> de secret manager— y sólo el host que ya tiene el material puede resolverla. Por eso prestar una cuenta no filtra nada.</p>
        <p>Deshabilitar conserva el registro; borrar se reserva para retiro definitivo o rotación y exige confirmación más dry-run.</p>
      </Explain>
    </section>

    <FormDialog open={shown && form?.kind === 'create'} onClose={close} busy={runner.busy} title="Alta de cuenta"
      description="Declara quién paga la suscripción y dónde está su credencial. Todo pasa por dry-run antes de aplicarse.">
      {form?.kind === 'create' ? <>
        <div className={FIELDS}>
          <label>Id de cuenta <span className={HINT}>global, inmutable, referenciado por los techos</span>
            <input {...writeProps} value={form.draft.id} onChange={(event) => { editDraft({ id: event.target.value }); }} />
          </label>
          <label>Proveedor <span className={HINT}>codex, gemini, minimax…</span>
            <input {...writeProps} value={form.draft.provider} onChange={(event) => { editDraft({ provider: event.target.value }); }} />
          </label>
          <label>Id externo de la suscripción <span className={HINT}>uuid, mail u org id. NUNCA el secreto</span>
            <input {...writeProps} value={form.draft.externalAccountId} onChange={(event) => { editDraft({ externalAccountId: event.target.value }); }} />
          </label>
          <label>Tenant pagador <span className={HINT}>quién paga; inmutable después del alta</span>
            <input {...writeProps} value={form.draft.payerTenant} onChange={(event) => { editDraft({ payerTenant: event.target.value }); }} />
          </label>
          <label>Etiqueta <span className={HINT}>opcional</span>
            <input {...writeProps} value={form.draft.label} onChange={(event) => { editDraft({ label: event.target.value }); }} />
          </label>
          <label>Tipo de locator
            <select {...writeProps} value={form.draft.credentialRefKind} onChange={(event) => { editDraft({ credentialRefKind: event.target.value as CredentialRefKind }); }}>
              {CREDENTIAL_REF_KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
            </select>
          </label>
          <label className="sm:col-span-2">Locator de la credencial <span className={HINT}>{CREDENTIAL_REF_HINTS[form.draft.credentialRefKind]}</span>
            <input {...writeProps} value={form.draft.credentialRef} onChange={(event) => { editDraft({ credentialRef: event.target.value }); }} />
          </label>
          <label className={CHECK}><input {...writeProps} type="checkbox" checked={form.draft.sharedWithPool} onChange={(event) => { editDraft({ sharedWithPool: event.target.checked }); }} /> <span>Publicar al pool <span className={HINT}>habilita que otros tenants la pidan prestada</span></span></label>
          <label className={CHECK}><input {...writeProps} type="checkbox" checked={form.draft.enabled} onChange={(event) => { editDraft({ enabled: event.target.checked }); }} /> Habilitada</label>
        </div>
        <MutationBar runner={runner} mutation={mutation} invalid={invalid} previewLabel="alta de cuenta" />
      </> : null}
    </FormDialog>

    <FormDialog open={shown && form?.kind === 'edit'} onClose={close} busy={runner.busy}
      title={form?.kind === 'edit' ? `Edición de «${form.edit.id}»` : 'Edición'}
      description="Sólo la etiqueta, la publicación al pool y el estado son editables: proveedor, id externo, pagador y locator son inmutables porque los techos ya referencian este id.">
      {form?.kind === 'edit' ? <>
        <div className="grid gap-3">
          <label>Etiqueta <span className={HINT}>vacío guarda null</span>
            <input {...writeProps} value={form.edit.label} onChange={(event) => { patchEdit({ label: event.target.value }); }} />
          </label>
          <label className={CHECK}><input {...writeProps} type="checkbox" checked={form.edit.sharedWithPool} onChange={(event) => { patchEdit({ sharedWithPool: event.target.checked }); }} /> Publicada al pool</label>
          <label className={CHECK}><input {...writeProps} type="checkbox" checked={form.edit.enabled} onChange={(event) => { patchEdit({ enabled: event.target.checked }); }} /> Habilitada</label>
        </div>
        <Notice>
          Despublicar del pool falla mientras otro tenant tenga la cuenta en el techo de alguno de sus alias (<code>alias_routing_ceiling_borrow_requires_pool</code>). Hay que revocar antes ese techo, que a su vez cascadea su binding.
        </Notice>
        <MutationBar runner={runner} mutation={mutation} invalid={invalid} previewLabel="edición de cuenta" />
      </> : null}
    </FormDialog>

    <FormDialog open={shown && form?.kind === 'delete'} onClose={close} busy={runner.busy}
      title={form?.kind === 'delete' ? `Retirar o rotar «${form.accountId}»` : 'Retirar cuenta'}
      description="Borrar es irreversible en el inventario actual y es el primer paso de una rotación de identidad o locator: después hay que recrear el mismo id con la credencial nueva.">
      {form?.kind === 'delete' ? <>
        <Notice tone="danger" role="note">
          El borrado falla si cualquier alias conserva esta cuenta en su techo. No encadena una recreación automática:
          si el alta posterior fallara, encadenarla dejaría la cuenta ausente sin darle al operador control sobre el desenlace.
        </Notice>
        <label>
          <span>Confirmá escribiendo <strong className="mono">{form.accountId}</strong></span>
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
        <MutationBar runner={runner} mutation={mutation} invalid={invalid} previewLabel="retiro o rotación de cuenta" />
      </> : null}
    </FormDialog>
  </div>;
}

/**
 * A row action in the width of an icon: the accessible name carries the verb and the account, and
 * `undoes` tints the direction that takes something away. No click here writes anything —it opens
 * a form whose write still goes through its dry-run before applying. */
function RowAction({ label, onClick, expanded, undoes = false, disabled = false, title, children }: {
  label: string;
  onClick: () => void;
  expanded?: boolean;
  undoes?: boolean;
  disabled?: boolean;
  title?: string;
  children: ReactNode;
}) {
  return (
    <button
      className={cn(
        'inline-grid size-7 cursor-pointer place-items-center rounded-md border-0 bg-transparent p-0 text-muted transition-colors enabled:hover:bg-muted-bg enabled:hover:text-fg disabled:cursor-not-allowed disabled:opacity-40',
        undoes && 'enabled:hover:bg-warn-soft enabled:hover:text-warn-ink',
      )}
      type="button"
      title={title ?? label}
      aria-label={label}
      aria-expanded={expanded}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/**
 * The consumption of an account in the width of a cell: worst remaining across its windows, how
 * many windows, and the plan when the provider declares one. Amber is kept for a fault —a probe
 * that answered `ok: false`, or a sample whose percentages are unusable. An account the collector
 * simply does not watch gets a grey dash: painting an expected absence amber on every row is what
 * stops amber from meaning anything. The color comes from `balanceSeverity`, the criterion of the
 * Consumption tab and of the server.
 */
function AccountUsage({ consumption, thresholds }: {
  consumption: AccountConsumption;
  thresholds: QuotaThresholds | null | undefined;
}) {
  const plan = consumption.plan ? `plan ${consumption.plan}` : null;
  if (!consumption.available || consumption.windows.length === 0) {
    return <span>
      {consumption.probeDown
        ? <span className="unknown" title={consumption.reason}>?</span>
        : <span className="muted" title={consumption.reason} aria-label="sin muestra">—</span>}
      {plan ? <small className="subline">{plan}</small> : null}
    </span>;
  }
  let worst: { percent: number; severity: QuotaSeverity | null } | null = null;
  for (const window of consumption.windows) {
    const percent = window.remaining_percent;
    if (typeof percent !== 'number') continue;
    if (worst === null || percent < worst.percent) worst = { percent, severity: window.severity };
  }
  if (worst === null) {
    return <span className="unknown" title="Ninguna ventana trajo un porcentaje utilizable">?</span>;
  }
  const windows = `${String(consumption.windows.length)} ${consumption.windows.length === 1 ? 'ventana' : 'ventanas'}`;
  return (
    <span>
      <Badge tone={SEVERITY_TONE[balanceSeverity(worst.percent, worst.severity, thresholds)]}>
        {formatPercent(worst.percent)} libre
      </Badge>
      <small className="subline">{plan ? `${windows} · ${plan}` : windows}</small>
    </span>
  );
}
