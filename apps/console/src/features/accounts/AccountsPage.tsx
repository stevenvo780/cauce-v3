import { CreditCard, EyeOff, KeyRound, PencilLine, Plus, Share2 } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { useApi } from '../../api/context';
import { useResource } from '../../api/use-resource';
import {
  Badge, EmptyState, ErrorState, LoadingState, Metric, PageHeader, Panel, PermissionBadge,
  RefreshButton, Time, Unknown,
} from '../../components/ui';
import { MutationBar } from './MutationBar';
import {
  CREDENTIAL_REF_HINTS, CREDENTIAL_REF_KINDS, accountDraftError, createAccountMutation,
  readAgents, readBindings, readCeiling, readProviderAccounts, updateAccountMutation, viewerTenant,
  type AccountDraft, type CredentialRefKind, type ProviderAccount, type RegistryContext,
} from './registry';
import { useRegistryMutation } from './use-registry-mutation';

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
  | { kind: 'edit'; edit: AccountEdit };

/**
 * Un update de cuenta reescribe label, shared_with_pool y enabled a la vez. Si el snapshot no trae
 * alguno de los dos booleanos no hay estado actual que preservar, y mandar un valor inventado
 * cambiaría en silencio algo que el operador no decidió.
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

/** Los campos del pagador no son "vacío": o son visibles, o el servidor los anuló, o el gateway
 *  ni los publica. Los tres casos se dicen con todas las letras. */
function PayerScoped({ account, children }: { account: ProviderAccount; children: ReactNode }) {
  if (account.payerFields === 'absent') {
    return <span className="unknown">No publicado por el gateway</span>;
  }
  if (account.payerFields === 'redacted') {
    return <span className="unknown">
      <EyeOff size={13} aria-hidden="true" /> No visible: la paga {account.payerTenant ?? 'otro tenant'}
    </span>;
  }
  return <>{children}</>;
}

export function AccountsPage() {
  const api = useApi();
  const config = useResource('registry-configuration', () => api.getConfiguration());
  const access = useResource('console-access', () => api.getConsoleAccess());
  const [form, setForm] = useState<FormState>({ kind: 'create', draft: emptyDraft });

  const accounts = useMemo(() => readProviderAccounts(config.data), [config.data]);
  const agents = useMemo(() => readAgents(config.data), [config.data]);
  const ceiling = useMemo(() => readCeiling(config.data), [config.data]);
  const bindings = useMemo(() => readBindings(config.data), [config.data]);
  const tenantIds = useMemo(
    () => (config.data?.tenants ?? []).map((row) => row.id).filter((id): id is string => typeof id === 'string'),
    [config.data],
  );
  const context: RegistryContext = useMemo(() => ({
    accounts: accounts.items, agents: agents.items, ceiling: ceiling.items,
    bindings: bindings.items, tenantIds,
  }), [accounts.items, agents.items, ceiling.items, bindings.items, tenantIds]);
  const runner = useRegistryMutation({ config, access, context });

  const actorTenant = viewerTenant(access.data?.subject);
  const pooled = accounts.available ? accounts.items.filter((item) => item.sharedWithPool === true).length : null;
  const enabled = accounts.available ? accounts.items.filter((item) => item.enabled === true).length : null;
  const foreign = accounts.available && actorTenant
    ? accounts.items.filter((item) => item.payerTenant !== null && item.payerTenant !== actorTenant).length
    : null;

  const editing = form.kind === 'edit'
    ? accounts.items.find((item) => item.id === form.edit.id)
    : undefined;
  const editInvalid = form.kind === 'edit'
    ? (editing ? editBlocker(editing) : 'La cuenta que estabas editando ya no está en el snapshot: volvé al inventario.')
    : undefined;
  const mutation = form.kind === 'create'
    ? (accountDraftError(form.draft) ? undefined : createAccountMutation(form.draft))
    : (editInvalid ? undefined : updateAccountMutation(form.edit.id, {
      label: form.edit.label.trim() || null,
      sharedWithPool: form.edit.sharedWithPool,
      enabled: form.edit.enabled,
    }));
  const invalid = form.kind === 'create' ? accountDraftError(form.draft) : editInvalid;

  function editDraft(patch: Partial<AccountDraft>) {
    setForm((current) => (current.kind === 'create' ? { kind: 'create', draft: { ...current.draft, ...patch } } : current));
    runner.clear();
  }

  function editAccount(account: ProviderAccount, patch: Partial<AccountEdit> = {}) {
    setForm({ kind: 'edit', edit: editFrom(account, patch) });
    runner.clear();
  }

  function patchEdit(patch: Partial<AccountEdit>) {
    setForm((current) => (current.kind === 'edit' ? { kind: 'edit', edit: { ...current.edit, ...patch } } : current));
    runner.clear();
  }

  if (config.loading && !config.data) return <LoadingState label="Leyendo el pool de suscripciones…" />;
  if (config.error && !config.data) return <ErrorState error={config.error} onRetry={config.reload} />;

  return <>
    <PageHeader
      eyebrow="Pool de suscripciones"
      title="Cuentas de IA"
      description="Inventario de provider_accounts: una cuenta tiene UN pagador y sólo se presta si su pagador la publicó al pool. La credencial no vive en la base: credential_ref es siempre un locator y el servidor no lo devuelve, ni siquiera a quien paga."
      actions={<RefreshButton onClick={config.reload} loading={config.loading} />}
    />
    <PermissionBadge access={access.data} permission="config.write" />

    <div className="metrics-grid">
      <Metric label="Cuentas visibles" value={accounts.available ? accounts.items.length : null} detail={accounts.available ? 'propias más las publicadas al pool' : 'GET /v3/console/config no publica provider_accounts'} />
      <Metric label="Publicadas al pool" value={pooled} tone="positive" detail="shared_with_pool = consentimiento del pagador" />
      <Metric label="Habilitadas" value={enabled} detail="enabled arranca en false: default-deny" />
      <Metric label="Pagadas por otro tenant" value={foreign} tone="warning" detail={actorTenant ? `pagador ≠ ${actorTenant}` : 'el servidor no informó el tenant del actor'} />
    </div>

    <Panel title="Inventario de cuentas" subtitle="Datos efectivos del servidor. No hay borrado duro desde esta pantalla: una cuenta se retira deshabilitándola.">
      {!accounts.available
        ? <EmptyState>
          No disponible: este gateway no publica <code>provider_accounts</code> dentro de <code>GET /v3/console/config</code>. No se muestra inventario porque no hay dato que mostrar, y la consola no lo simula.
        </EmptyState>
        : accounts.items.length === 0
          ? <EmptyState>El servidor devolvió cero cuentas visibles para este actor.</EmptyState>
          : <div className="table-wrap">
            <table>
              <caption className="sr-only">Inventario de cuentas de proveedores de IA</caption>
              <thead><tr>
                <th>Cuenta</th><th>Proveedor</th><th>Etiqueta</th><th>Paga</th><th>Pool</th>
                <th>Estado</th><th>Id externo</th><th>Tipo de locator</th><th>Actualizada</th><th>Acciones</th>
              </tr></thead>
              <tbody>
                {accounts.items.map((account) => <tr key={account.id}>
                  <td><div className="identity-cell"><span className="icon-box"><CreditCard size={16} aria-hidden="true" /></span><strong className="mono">{account.id}</strong></div></td>
                  <td><span className="mono"><Unknown value={account.provider} /></span></td>
                  <td><Unknown value={account.label} /></td>
                  <td>
                    <Unknown value={account.payerTenant} />
                    {actorTenant && account.payerTenant && account.payerTenant !== actorTenant
                      ? <div><span className="chip">prestada</span></div>
                      : null}
                  </td>
                  <td>{account.sharedWithPool === null
                    ? <Badge tone="unknown">UNKNOWN</Badge>
                    : <Badge tone={account.sharedWithPool ? 'info' : 'offline'}>{account.sharedWithPool ? 'PUBLICADA' : 'PRIVADA'}</Badge>}</td>
                  <td>{account.enabled === null
                    ? <Badge tone="unknown">UNKNOWN</Badge>
                    : <Badge tone={account.enabled ? 'online' : 'offline'}>{account.enabled ? 'HABILITADA' : 'DESHABILITADA'}</Badge>}</td>
                  <td><PayerScoped account={account}><span className="mono"><Unknown value={account.externalAccountId} /></span></PayerScoped></td>
                  <td><PayerScoped account={account}><span className="mono"><Unknown value={account.credentialRefKind} /></span></PayerScoped></td>
                  <td><Time value={account.updatedAt} /></td>
                  <td><span className="config-actions">
                    <button className="button small" type="button" onClick={() => editAccount(account)}>
                      <PencilLine size={14} aria-hidden="true" />Editar
                    </button>
                    <button className="button small" type="button" onClick={() => editAccount(account, { enabled: account.enabled !== true })}>
                      {account.enabled === true ? 'Deshabilitar' : 'Habilitar'}
                    </button>
                    <button className="button small" type="button" onClick={() => editAccount(account, { sharedWithPool: account.sharedWithPool !== true })}>
                      <Share2 size={14} aria-hidden="true" />{account.sharedWithPool === true ? 'Despublicar' : 'Publicar'}
                    </button>
                  </span></td>
                </tr>)}
              </tbody>
            </table>
          </div>}
      <p className="trust-callout">
        <KeyRound size={15} aria-hidden="true" />
        El snapshot nunca trae <code>credential_ref</code>. Lo único que se registra es dónde encontrar la credencial —una variable de entorno, una ruta, o un <code>esquema:path</code> de secret manager— y sólo el host que ya tiene el material puede resolverla. Por eso prestar una cuenta no filtra nada.
      </p>
    </Panel>

    {form.kind === 'create' ? <Panel title="Alta de cuenta" subtitle="Un alta declara quién paga la suscripción y dónde está su credencial. Todo pasa por dry-run antes de aplicarse.">
      <div className="config-form">
        <label>Id de cuenta <span className="label-hint">global, inmutable, referenciado por los techos</span>
          <input value={form.draft.id} onChange={(event) => editDraft({ id: event.target.value })} />
        </label>
        <label>Proveedor <span className="label-hint">codex, gemini, minimax…</span>
          <input value={form.draft.provider} onChange={(event) => editDraft({ provider: event.target.value })} />
        </label>
        <label>Id externo de la suscripción <span className="label-hint">uuid, mail u org id. NUNCA el secreto</span>
          <input value={form.draft.externalAccountId} onChange={(event) => editDraft({ externalAccountId: event.target.value })} />
        </label>
        <label>Tenant pagador <span className="label-hint">quién paga; inmutable después del alta</span>
          <input value={form.draft.payerTenant} onChange={(event) => editDraft({ payerTenant: event.target.value })} />
        </label>
        <label>Etiqueta <span className="label-hint">opcional</span>
          <input value={form.draft.label} onChange={(event) => editDraft({ label: event.target.value })} />
        </label>
        <label>Tipo de locator
          <select value={form.draft.credentialRefKind} onChange={(event) => editDraft({ credentialRefKind: event.target.value as CredentialRefKind })}>
            {CREDENTIAL_REF_KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
          </select>
        </label>
        <label className="config-json">Locator de la credencial <span className="label-hint">{CREDENTIAL_REF_HINTS[form.draft.credentialRefKind]}</span>
          <input value={form.draft.credentialRef} onChange={(event) => editDraft({ credentialRef: event.target.value })} />
        </label>
        <label><input type="checkbox" checked={form.draft.sharedWithPool} onChange={(event) => editDraft({ sharedWithPool: event.target.checked })} /> Publicar al pool <span className="label-hint">habilita que otros tenants la pidan prestada</span></label>
        <label><input type="checkbox" checked={form.draft.enabled} onChange={(event) => editDraft({ enabled: event.target.checked })} /> Habilitada</label>
      </div>
      <MutationBar runner={runner} mutation={mutation} invalid={invalid} previewLabel="alta de cuenta" />
    </Panel> : null}

    {form.kind === 'edit' ? <Panel title={`Edición de «${form.edit.id}»`} subtitle="Sólo la etiqueta, la publicación al pool y el estado son editables: proveedor, id externo, pagador y locator son inmutables porque los techos ya referencian este id.">
      <div className="config-form">
        <label className="config-json">Etiqueta <span className="label-hint">vacío guarda null</span>
          <input value={form.edit.label} onChange={(event) => patchEdit({ label: event.target.value })} />
        </label>
        <label><input type="checkbox" checked={form.edit.sharedWithPool} onChange={(event) => patchEdit({ sharedWithPool: event.target.checked })} /> Publicada al pool</label>
        <label><input type="checkbox" checked={form.edit.enabled} onChange={(event) => patchEdit({ enabled: event.target.checked })} /> Habilitada</label>
      </div>
      <p className="notice">
        Despublicar del pool falla mientras otro tenant tenga la cuenta en el techo de alguno de sus alias: Postgres lo impide con <code>alias_routing_ceiling_borrow_requires_pool</code>. Hay que revocar antes ese techo, que a su vez cascadea su binding.
      </p>
      <MutationBar runner={runner} mutation={mutation} invalid={invalid} previewLabel="edición de cuenta" />
      <div className="config-actions">
        <button className="button small" type="button" onClick={() => { setForm({ kind: 'create', draft: emptyDraft }); runner.clear(); }}>
          <Plus size={14} aria-hidden="true" />Volver al alta de cuenta
        </button>
      </div>
    </Panel> : null}
  </>;
}
