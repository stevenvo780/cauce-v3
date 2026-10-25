import { useState, type SyntheticEvent } from 'react';
import { ApiError } from '../../api/client';
import { useApi } from '../../api/context';
import type { ConfigurationChangeResult } from '../../api/types';
import { Button, CARD_TABLE, Notice, Outcome, SCROLL, SectionCard } from '../../components/kit';
import { EmptyState } from '../../components/ui';
import { PUBLISHED_HARNESS_DESCRIPTORS } from '../harness-descriptors';
import { describeConfigError } from './config-change';
import { dependencySummary } from './config-dependencies';
import { efectoDeRol, GUIA_DE_ROLES } from './efecto-de-rol';
import type { ConfigWrites } from './use-config-writes';

interface CatalogNotice { text: string; tone: 'success' | 'error' | 'parcial' }

const CAPABILITY_OPTIONS: readonly { id: string; label: string }[] = [
  { id: 'messages.receive', label: 'Recibir mensajes' },
  { id: 'ack.timeline', label: 'Confirmar en la línea de tiempo' },
  { id: 'origin.relay', label: 'Retransmitir el origen' },
  { id: 'jobs.interactive', label: 'Trabajos interactivos' },
  { id: 'jobs.batch', label: 'Trabajos por lote' },
];

const ROLE_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;

function text(row: Record<string, unknown>, key: string): string {
  return typeof row[key] === 'string' ? row[key] : '';
}

function flag(row: Record<string, unknown>, key: string): boolean {
  return row[key] === true;
}

function capabilitiesOf(row: Record<string, unknown>): string[] {
  return Array.isArray(row.capabilities)
    ? row.capabilities.filter((value): value is string => typeof value === 'string')
    : [];
}

function reciboValido(result: ConfigurationChangeResult, resource: string, action: string): boolean {
  return result.applied === true && result.dry_run === false
    && typeof result.revision === 'number' && Number.isSafeInteger(result.revision) && result.revision >= 1
    && typeof result.summary === 'string' && result.summary.length > 0
    && result.mutation?.resource === resource && result.mutation.action === action;
}

function describePlatformError(error: unknown): { message: string; conflict: boolean } {
  if (error instanceof ApiError && error.dependencies.length > 0) {
    return {
      conflict: false,
      message: `El servidor rechazó el cambio y no se aplicó nada: lo bloquean ${dependencySummary(error.dependencies) ?? 'dependencias guardadas'}. `
        + 'Resolvé las dependencias primero (agentes o membresías que todavía lo usan) y volvé a intentarlo.',
    };
  }
  if (error instanceof ApiError && [400, 403, 404, 409].includes(error.status) && error.message) {
    return { conflict: error.status === 409 && error.message.includes('Conflicto de revisión'), message: error.message };
  }
  return describeConfigError(error, 'Cambio rechazado sin detalle del servidor', 'directo');
}

/**
 * Write channel of the platform catalog panels: one busy flag, the chained configuration
 * snapshot revision (CAS), the exact receipt check and the reread, shared by both catalogs.
 */
function usePlatformCatalog(ctx: ConfigWrites) {
  const api = useApi();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<CatalogNotice>();
  const snapshot = ctx.config.data;
  const role = snapshot?.capabilities?.actor.role;
  const isPlatform = role === 'platform_admin';
  const revision = ctx.snapshotRevision;
  const canWrite = isPlatform && !ctx.soloLectura && revision !== undefined;

  async function run(
    resource: 'harness' | 'role_policy', action: string, expectedRevision: number | undefined,
    call: (expectedRevision: number) => Promise<ConfigurationChangeResult>,
  ): Promise<boolean> {
    if (!canWrite || expectedRevision === undefined) {
      setNotice({ tone: 'error', text: 'Cambio bloqueado: hace falta ser administrador de plataforma y tener la revisión actual del catálogo.' });
      return false;
    }
    setBusy(true);
    setNotice(undefined);
    try {
      const result = await call(expectedRevision);
      if (!reciboValido(result, resource, action)) {
        await ctx.config.reload();
        setNotice({
          tone: 'error',
          text: 'El servidor respondió sin el recibo durable exacto del cambio. Puede haberse aplicado; '
            + 'verificá la lista releída antes de repetirlo.',
        });
        return false;
      }
      const reload = await ctx.config.reload();
      setNotice({
        tone: reload.error ? 'parcial' : 'success',
        text: `Aplicado en revisión ${String(result.revision)}: ${String(result.summary)}.`
          + (reload.error ? ` PERO la relectura no llegó (${reload.error.message}); lo visible puede estar vencido.` : ''),
      });
      return true;
    } catch (error) {
      const described = describePlatformError(error);
      if (described.conflict) {
        await ctx.config.reload();
      }
      setNotice({ tone: 'error', text: described.message
        + (described.conflict ? ' Volvé a abrir la acción sobre la versión actual para continuar.' : '') });
      return false;
    } finally {
      setBusy(false);
    }
  }

  return { api, snapshot, role, isPlatform, revision, canWrite, busy: busy || ctx.busy, notice, setNotice, run };
}

type Catalog = ReturnType<typeof usePlatformCatalog>;

function catalogoNoLeido(): React.ReactNode {
  return <EmptyState>La configuración todavía no se leyó; el catálogo aparece cuando llega el snapshot.</EmptyState>;
}

function soloLectura(catalog: Catalog, entidad: string): React.ReactNode {
  if (catalog.isPlatform) return null;
  return <Notice role="note">
    Solo el administrador de plataforma puede crear, editar o borrar {entidad}. Tu rol en esta sesión
    es {catalog.role ?? 'sin rol publicado'}: la lista es de solo lectura.
  </Notice>;
}

interface HarnessDraft { id: string; displayName: string; capabilities: string[]; enabled: boolean }

export function HarnessCatalogPanel({ ctx }: { ctx: ConfigWrites }) {
  const catalog = usePlatformCatalog(ctx);
  const rows = catalog.snapshot?.harness_definitions ?? undefined;
  const [draft, setDraft] = useState<HarnessDraft>();
  const [baseRevision, setBaseRevision] = useState<number>();
  const [editing, setEditing] = useState<string>();
  const [pendingDelete, setPendingDelete] = useState<string>();
  const [formError, setFormError] = useState<string>();
  const existing = new Set((rows ?? []).map((row) => text(row, 'id')));
  const available = PUBLISHED_HARNESS_DESCRIPTORS.map((descriptor) => descriptor.harness)
    .filter((id) => !existing.has(id));

  function openCreate() {
    setBaseRevision(catalog.revision);
    setEditing(undefined);
    setPendingDelete(undefined);
    setFormError(undefined);
    catalog.setNotice(undefined);
    setDraft({ id: available[0] ?? '', displayName: '', capabilities: ['messages.receive'], enabled: true });
  }

  function openEdit(row: Record<string, unknown>) {
    setBaseRevision(catalog.revision);
    setEditing(text(row, 'id'));
    setPendingDelete(undefined);
    setFormError(undefined);
    catalog.setNotice(undefined);
    setDraft({
      id: text(row, 'id'), displayName: text(row, 'display_name'),
      capabilities: capabilitiesOf(row), enabled: flag(row, 'enabled'),
    });
  }

  async function submit(event: SyntheticEvent) {
    event.preventDefault();
    if (!draft) return;
    if (!draft.id) { setFormError('Id del arnés: elegí un arnés con descriptor publicado.'); return; }
    if (!draft.displayName.trim()) { setFormError('Nombre visible: completá el nombre visible del arnés.'); return; }
    if (draft.capabilities.length === 0) { setFormError('Capacidades: elegí al menos una capacidad.'); return; }
    setFormError(undefined);
    const applied = editing === undefined
      ? await catalog.run('harness', 'create', baseRevision, (expected) => catalog.api.createPlatformHarness({
        id: draft.id, display_name: draft.displayName.trim(), capabilities: draft.capabilities,
        enabled: draft.enabled, expected_revision: expected,
      }))
      : await catalog.run('harness', 'update', baseRevision, (expected) => catalog.api.updatePlatformHarness(draft.id, {
        display_name: draft.displayName.trim(), capabilities: draft.capabilities,
        enabled: draft.enabled, expected_revision: expected,
      }));
    if (applied) { setDraft(undefined); setEditing(undefined); }
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    const id = pendingDelete;
    setPendingDelete(undefined);
    await catalog.run('harness', 'delete', baseRevision, (expected) => catalog.api.deletePlatformHarness(id, expected));
  }

  return <SectionCard level={3} title="Definiciones de arnés"
    description="El catálogo que ofrece el alta de agente. Crear solo registra un arnés cuyo descriptor ya está publicado; el descriptor aprobado por digest no se edita desde la web."
    actions={rows ? <span className="text-xs text-muted tabular-nums">{rows.length} {rows.length === 1 ? 'fila' : 'filas'}</span> : undefined}>
    {soloLectura(catalog, 'definiciones de arnés')}
    {!catalog.snapshot ? catalogoNoLeido() : rows === undefined
      ? <EmptyState>UNKNOWN: este gateway no publica las definiciones de arnés.</EmptyState>
      : <>
        {catalog.canWrite ? <div className="flex flex-wrap gap-2">
          <Button variant="primary" disabled={catalog.busy || available.length === 0} onClick={openCreate}>
            Crear definición de arnés
          </Button>
          {available.length === 0
            ? <span className="text-xs text-muted">Todo arnés con descriptor publicado ya tiene definición.</span> : null}
        </div> : null}
        {draft ? <form aria-label={editing === undefined ? 'Crear definición de arnés' : `Editar arnés ${draft.id}`}
          className="grid gap-3 rounded-lg border border-line p-3" onSubmit={(event) => { void submit(event); }}>
          <h4 className="m-0 text-sm font-semibold">{editing === undefined ? 'Crear definición de arnés' : `Editar arnés ${draft.id}`}</h4>
          <label className="grid gap-1 text-[13px]">
            <span>Id del arnés</span>
            {editing === undefined
              ? <select aria-label="Id del arnés" value={draft.id} disabled={catalog.busy}
                onChange={(event) => { setDraft({ ...draft, id: event.target.value }); }}>
                {available.map((id) => <option key={id} value={id}>{id}</option>)}
              </select>
              : <input aria-label="Id del arnés" value={draft.id} disabled />}
            <small className="text-muted">Solo arneses con descriptor publicado y aprobado; el descriptor no se crea ni se edita acá.</small>
          </label>
          <label className="grid gap-1 text-[13px]">
            <span>Nombre visible</span>
            <input aria-label="Nombre visible" value={draft.displayName} disabled={catalog.busy}
              onChange={(event) => { setDraft({ ...draft, displayName: event.target.value }); }} />
          </label>
          <fieldset className="grid gap-1.5 border-0 p-0">
            <legend className="text-[13px]">Capacidades</legend>
            {CAPABILITY_OPTIONS.map((option) => <label key={option.id} className="flex items-center gap-2 text-[13px]">
              <input type="checkbox" aria-label={`Capacidad ${option.id}`} checked={draft.capabilities.includes(option.id)}
                disabled={catalog.busy}
                onChange={(event) => {
                  setDraft({
                    ...draft,
                    capabilities: event.target.checked
                      ? [...draft.capabilities, option.id]
                      : draft.capabilities.filter((capability) => capability !== option.id),
                  });
                }} />
              <span>{option.label} <code className="text-xs text-muted">{option.id}</code></span>
            </label>)}
          </fieldset>
          <label className="grid gap-1 text-[13px]">
            <span>Habilitado</span>
            <select aria-label="Habilitado" value={draft.enabled ? 'true' : 'false'} disabled={catalog.busy}
              onChange={(event) => { setDraft({ ...draft, enabled: event.target.value === 'true' }); }}>
              <option value="true">Sí</option>
              <option value="false">No</option>
            </select>
          </label>
          {formError ? <p className="notice error" role="alert">{formError}</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" type="submit" disabled={catalog.busy}>
              {editing === undefined ? 'Confirmar creación' : 'Confirmar edición'}
            </Button>
            <Button disabled={catalog.busy} onClick={() => { setDraft(undefined); setEditing(undefined); }}>Cancelar</Button>
          </div>
        </form> : null}
        {pendingDelete ? <div className="grid gap-2 rounded-lg border border-line p-3" role="alertdialog" aria-label={`Eliminar arnés ${pendingDelete}`}>
          <p className="m-0 text-[13px]">
            Se elimina la definición <code>{pendingDelete}</code> del catálogo. El servidor rechaza el
            borrado si algún agente todavía la usa. El descriptor publicado no se toca.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" disabled={catalog.busy} onClick={() => { void confirmDelete(); }}>Confirmar eliminación</Button>
            <Button disabled={catalog.busy} onClick={() => { setPendingDelete(undefined); }}>Cancelar</Button>
          </div>
        </div> : null}
        {rows.length === 0 ? <EmptyState>Sin registros.</EmptyState>
          : <div className={SCROLL}><table className={CARD_TABLE}><thead><tr>
            <th>Id</th><th>Nombre visible</th><th>Capacidades</th><th>Habilitado</th>
            {catalog.canWrite ? <th>Acciones</th> : null}
          </tr></thead><tbody>
            {rows.map((row) => <tr key={text(row, 'id')}>
              <td><code className="text-xs">{text(row, 'id')}</code></td>
              <td>{text(row, 'display_name')}</td>
              <td>{capabilitiesOf(row).join(', ') || '(vacío)'}</td>
              <td>{flag(row, 'enabled') ? 'Sí' : 'No'}</td>
              {catalog.canWrite ? <td><div className="flex flex-wrap gap-2">
                <Button size="sm" disabled={catalog.busy} aria-label={`Editar arnés ${text(row, 'id')}`}
                  onClick={() => { openEdit(row); }}>Editar</Button>
                <Button size="sm" disabled={catalog.busy} aria-label={`Eliminar arnés ${text(row, 'id')}`}
                  onClick={() => { setBaseRevision(catalog.revision); setPendingDelete(text(row, 'id')); setDraft(undefined); catalog.setNotice(undefined); }}>Eliminar</Button>
              </div></td> : null}
            </tr>)}
          </tbody></table></div>}
        {catalog.notice ? <Outcome tone={catalog.notice.tone}>{catalog.notice.text}</Outcome> : null}
      </>}
  </SectionCard>;
}

interface RoleDraft {
  role: string; allowRoute: boolean; allowRead: boolean; allowControl: boolean; allowNotify: boolean;
}

const ROLE_FIELDS: readonly { key: keyof RoleDraft; label: string }[] = [
  { key: 'allowRoute', label: 'Permitir ruta' },
  { key: 'allowRead', label: 'Permitir lectura' },
  { key: 'allowControl', label: 'Permitir control' },
  { key: 'allowNotify', label: 'Permitir aviso proactivo' },
];

export function RolePoliciesPanel({ ctx }: { ctx: ConfigWrites }) {
  const catalog = usePlatformCatalog(ctx);
  const rows = catalog.snapshot?.role_policies ?? undefined;
  const [draft, setDraft] = useState<RoleDraft>();
  const [baseRevision, setBaseRevision] = useState<number>();
  const [editing, setEditing] = useState<string>();
  const [pendingDelete, setPendingDelete] = useState<string>();
  const [formError, setFormError] = useState<string>();

  function openCreate() {
    setBaseRevision(catalog.revision);
    setEditing(undefined);
    setPendingDelete(undefined);
    setFormError(undefined);
    catalog.setNotice(undefined);
    setDraft({ role: '', allowRoute: false, allowRead: false, allowControl: false, allowNotify: false });
  }

  function openEdit(row: Record<string, unknown>) {
    setBaseRevision(catalog.revision);
    setEditing(text(row, 'role'));
    setPendingDelete(undefined);
    setFormError(undefined);
    catalog.setNotice(undefined);
    setDraft({
      role: text(row, 'role'), allowRoute: flag(row, 'allow_route'), allowRead: flag(row, 'allow_read'),
      allowControl: flag(row, 'allow_control'), allowNotify: flag(row, 'allow_notify'),
    });
  }

  async function submit(event: SyntheticEvent) {
    event.preventDefault();
    if (!draft) return;
    if (editing === undefined && !ROLE_PATTERN.test(draft.role.trim())) {
      setFormError('Id del rol: usá minúsculas, dígitos, guiones o guiones bajos, empezando con una letra (máximo 64).');
      return;
    }
    setFormError(undefined);
    const value = {
      allow_route: draft.allowRoute, allow_read: draft.allowRead,
      allow_control: draft.allowControl, allow_notify: draft.allowNotify,
    };
    const applied = editing === undefined
      ? await catalog.run('role_policy', 'create', baseRevision, (expected) => catalog.api.createPlatformRolePolicy({
        role: draft.role.trim(), ...value, expected_revision: expected,
      }))
      : await catalog.run('role_policy', 'update', baseRevision, (expected) => catalog.api.updatePlatformRolePolicy(draft.role, {
        ...value, expected_revision: expected,
      }));
    if (applied) { setDraft(undefined); setEditing(undefined); }
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    const role = pendingDelete;
    setPendingDelete(undefined);
    await catalog.run('role_policy', 'delete', baseRevision, (expected) => catalog.api.deletePlatformRolePolicy(role, expected));
  }

  return <SectionCard level={3} title="Permisos por rol"
    description="Qué puede hacer cada rol que se asigna en una membresía. El cambio vale para toda la plataforma en la misma transacción."
    actions={rows ? <span className="text-xs text-muted tabular-nums">{rows.length} {rows.length === 1 ? 'fila' : 'filas'}</span> : undefined}>
    {soloLectura(catalog, 'políticas de rol')}
    <p className="m-0 max-w-prose text-[13px] text-fg-2">{GUIA_DE_ROLES}</p>
    {!catalog.snapshot ? catalogoNoLeido() : rows === undefined
      ? <EmptyState>UNKNOWN: este gateway no publica las políticas de rol.</EmptyState>
      : <>
        {catalog.canWrite ? <div className="flex flex-wrap gap-2">
          <Button variant="primary" disabled={catalog.busy} onClick={openCreate}>Crear política de rol</Button>
        </div> : null}
        {draft ? <form aria-label={editing === undefined ? 'Crear política de rol' : `Editar rol ${draft.role}`}
          className="grid gap-3 rounded-lg border border-line p-3" onSubmit={(event) => { void submit(event); }}>
          <h4 className="m-0 text-sm font-semibold">{editing === undefined ? 'Crear política de rol' : `Editar rol ${draft.role}`}</h4>
          <label className="grid gap-1 text-[13px]">
            <span>Id del rol</span>
            <input aria-label="Id del rol" value={draft.role} disabled={catalog.busy || editing !== undefined}
              onChange={(event) => { setDraft({ ...draft, role: event.target.value }); }} />
            <small className="text-muted">Minúsculas, dígitos, guiones o guiones bajos, empezando con una letra. No se puede renombrar: se crea otro y se borra el anterior.</small>
          </label>
          {ROLE_FIELDS.map((field) => <label key={field.key} className="flex items-center gap-2 text-[13px]">
            <input type="checkbox" aria-label={field.label} checked={draft[field.key] as boolean} disabled={catalog.busy}
              onChange={(event) => { setDraft({ ...draft, [field.key]: event.target.checked }); }} />
            <span>{field.label}</span>
          </label>)}
          {formError ? <p className="notice error" role="alert">{formError}</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" type="submit" disabled={catalog.busy}>
              {editing === undefined ? 'Confirmar creación' : 'Confirmar edición'}
            </Button>
            <Button disabled={catalog.busy} onClick={() => { setDraft(undefined); setEditing(undefined); }}>Cancelar</Button>
          </div>
        </form> : null}
        {pendingDelete ? <div className="grid gap-2 rounded-lg border border-line p-3" role="alertdialog" aria-label={`Eliminar rol ${pendingDelete}`}>
          <p className="m-0 text-[13px]">
            Se elimina la política del rol <code>{pendingDelete}</code>. El servidor rechaza el borrado
            si alguna membresía todavía lo usa.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" disabled={catalog.busy} onClick={() => { void confirmDelete(); }}>Confirmar eliminación</Button>
            <Button disabled={catalog.busy} onClick={() => { setPendingDelete(undefined); }}>Cancelar</Button>
          </div>
        </div> : null}
        {rows.length === 0 ? <EmptyState>Sin registros.</EmptyState>
          : <div className={SCROLL}><table className={CARD_TABLE}><thead><tr>
            <th>Rol</th><th>Ruta</th><th>Lectura</th><th>Control</th><th>Aviso</th>
            {catalog.canWrite ? <th>Acciones</th> : null}
          </tr></thead><tbody>
            {rows.map((row) => {
              const role = text(row, 'role');
              const efecto = efectoDeRol(role);
              return <tr key={role}>
                <td><span className="grid max-w-72 gap-0.5">
                  <span>{efecto.nombre}</span>
                  <code className="text-xs text-muted">{role}</code>
                  <span className="text-xs text-muted">{efecto.efecto}</span>
                </span></td>
                <td>{flag(row, 'allow_route') ? 'Sí' : 'No'}</td>
                <td>{flag(row, 'allow_read') ? 'Sí' : 'No'}</td>
                <td>{flag(row, 'allow_control') ? 'Sí' : 'No'}</td>
                <td>{flag(row, 'allow_notify') ? 'Sí' : 'No'}</td>
                {catalog.canWrite ? <td><div className="flex flex-wrap gap-2">
                  <Button size="sm" disabled={catalog.busy} aria-label={`Editar rol ${role}`}
                    onClick={() => { openEdit(row); }}>Editar</Button>
                  <Button size="sm" disabled={catalog.busy} aria-label={`Eliminar rol ${role}`}
                    onClick={() => { setBaseRevision(catalog.revision); setPendingDelete(role); setDraft(undefined); catalog.setNotice(undefined); }}>Eliminar</Button>
                </div></td> : null}
              </tr>;
            })}
          </tbody></table></div>}
        {catalog.notice ? <Outcome tone={catalog.notice.tone}>{catalog.notice.text}</Outcome> : null}
      </>}
  </SectionCard>;
}
