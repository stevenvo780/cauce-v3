import { FleetHostCreateSchema, FleetHostUpdateSchema, type FleetHost } from '@cauce/protocol/fleet-hosts';
import { useRef, useState, type SyntheticEvent } from 'react';
import { useApi } from '../../api/context';
import type { ConfigurationSnapshot } from '../../api/types';
import { Plus } from 'lucide-react';
import { ActionButton } from '../../components/action-button';
import { Button, Notice } from '../../components/kit';
import { ConfirmDialog } from '../../components/dialogs';
import { EmptyState, LoadingState } from '../../components/ui';
import { CONFIG_SIN_CONTROL_REASON } from '../../router';
import { ConfigSectionHeader } from './ConfigSectionHeader';
import { ComputadoraCard } from './ComputadoraCard';
import { ComputadoraFormDialog, type Editor } from './ComputadoraFormDialog';
import { mensajeDeEscritura, resumenDeFlota, type AccionDeEscritura } from './fleet-host-model';
import { useFleetHosts } from './use-fleet-hosts';
import { diffConflictFields, isCasConflict, type ConflictFieldDiff } from '../../components/conflict';
import { ConflictNotice } from '../../components/ConflictNotice';
import { HostEnrollmentPanel } from './HostEnrollmentPanel';
import { canManageCompany } from '../auth/company-authority';

const GRID_TARJETAS = 'm-0 grid list-none grid-cols-[repeat(auto-fill,minmax(min(100%,20rem),1fr))] gap-3 p-0';

function hostPermission(snapshot: ConfigurationSnapshot | undefined, action: 'create' | 'update' | 'delete'): boolean {
  const capabilities = snapshot?.capabilities;
  if (!capabilities?.actor.can_control || !Array.isArray(capabilities.resources)) return false;
  const grant = capabilities.resources.find(resource => resource.resource === 'fleet_host');
  return !!grant && Array.isArray(grant.actions) && grant.actions.includes(action) && ['platform', 'company'].includes(grant.scope);
}

export function ComputadorasSection({ snapshot, soloLectura }: { snapshot?: ConfigurationSnapshot; soloLectura: boolean }) {
  const api = useApi();
  const flota = useFleetHosts(true, snapshot?.revision);
  const escribe = !soloLectura && hostPermission(snapshot, 'update');
  const crea = !soloLectura && hostPermission(snapshot, 'create');
  const borra = !soloLectura && hostPermission(snapshot, 'delete');
  const [editor, setEditor] = useState<Editor>();
  const [borrar, setBorrar] = useState<FleetHost>();
  const [deleteBackups, setDeleteBackups] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [conflictDiffs, setConflictDiffs] = useState<ConflictFieldDiff[]>();
  const [conflictFresh, setConflictFresh] = useState<FleetHost>();
  const writeCause = useRef<unknown>(undefined);
  const hosts = flota.hosts ?? [];

  async function escribir(operacion: () => Promise<unknown>, accion: AccionDeEscritura = 'edicion') {
    setBusy(true); setError(undefined); writeCause.current = undefined;
    try {
      await operacion();
      await flota.reload();
      return true;
    } catch (cause) {
      writeCause.current = cause;
      setError(mensajeDeEscritura(cause, accion));
      return false;
    } finally {
      setBusy(false);
    }
  }

  function abrirAlta(host?: FleetHost) {
    setError(undefined); setConflictDiffs(undefined); setConflictFresh(undefined);
    setEditor({ modo: 'alta', hostId: host?.host_id ?? '', displayName: host?.display_name ?? '', notes: '', version: 0 });
  }

  function abrirEdicion(host: FleetHost) {
    setError(undefined); setConflictDiffs(undefined); setConflictFresh(undefined);
    setEditor({ modo: 'editar', hostId: host.host_id, displayName: host.display_name, notes: host.notes, version: host.version });
  }

  async function guardar(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor) return;
    const { hostId, displayName, notes } = editor;
    const invalido = 'Revisa el identificador (minúsculas, números, guion o guion bajo) y el nombre visible.';
    let ok: boolean;
    if (editor.modo === 'alta') {
      const alta = FleetHostCreateSchema.safeParse({ host_id: hostId, display_name: displayName, notes });
      if (!alta.success) { setError(invalido); return; }
      ok = await escribir(() => api.createFleetHost(alta.data), 'alta');
    } else {
      const cambio = FleetHostUpdateSchema.safeParse({ expected_version: editor.version, display_name: displayName, notes });
      if (!cambio.success) { setError(invalido); return; }
      ok = await escribir(() => api.updateFleetHost(hostId, cambio.data));
      if (!ok && isCasConflict(writeCause.current)) {
        const fresh = (await api.listFleetHosts().catch(() => undefined))?.find((host) => host.host_id === hostId);
        if (fresh) {
          setConflictFresh(fresh);
          setConflictDiffs(diffConflictFields(
            { display_name: displayName, notes },
            { display_name: fresh.display_name, notes: fresh.notes },
            { display_name: 'Nombre visible', notes: 'Notas' },
          ));
        } else setConflictDiffs([]);
      }
    }
    if (ok) { setEditor(undefined); setConflictDiffs(undefined); setConflictFresh(undefined); }
  }

  async function reintentarComputadora() {
    if (editor?.modo !== 'editar') return;
    const fresh = (await api.listFleetHosts().catch(() => undefined))?.find((host) => host.host_id === editor.hostId) ?? conflictFresh;
    if (!fresh) return;
    setConflictFresh(fresh);
    const cambio = FleetHostUpdateSchema.safeParse({ expected_version: fresh.version, display_name: editor.displayName, notes: editor.notes });
    if (!cambio.success) { setError('Revisa el identificador (minúsculas, números, guion o guion bajo) y el nombre visible.'); return; }
    const ok = await escribir(() => api.updateFleetHost(editor.hostId, cambio.data));
    if (ok) { setEditor(undefined); setConflictDiffs(undefined); setConflictFresh(undefined); }
  }

  function alternar(host: FleetHost) {
    void escribir(() => api.updateFleetHost(host.host_id, { expected_version: host.version, enabled: !host.enabled }));
  }

  async function eliminar() {
    if (!borrar) return;
    const ok = await escribir(() => deleteBackups ? api.deleteFleetHost(borrar.host_id, borrar.version, true)
      : api.deleteFleetHost(borrar.host_id, borrar.version), 'baja');
    if (ok) setBorrar(undefined);
  }

  const motivo = soloLectura ? CONFIG_SIN_CONTROL_REASON : !escribe ? 'Tu autoridad de empresa no permite cambiar computadoras.' : undefined;
  const editando = editor?.modo === 'editar' ? editor.hostId : undefined;
  const registradas = hosts.filter((host) => host.registered);
  const detectadas = hosts.filter((host) => !host.registered);
  const resumen = resumenDeFlota(hosts);
  const tarjeta = (host: FleetHost) => <li key={host.host_id}>
    <ComputadoraCard host={host} escribe={escribe} crea={crea} borra={borra} busy={busy} bloqueada={editando === host.host_id}
      onEditar={abrirEdicion} onAlternar={alternar} onEliminar={host => { setError(undefined); setDeleteBackups(false); setBorrar(host); }} onRegistrar={abrirAlta} />
  </li>;

  return <div className="grid gap-4">
    <ConfigSectionHeader seccion="computadoras" />
    <HostEnrollmentPanel canEnroll={!soloLectura && canManageCompany(snapshot?.capabilities?.actor.role)} />
    <p className="m-0 text-xs leading-relaxed text-muted">
      Si una computadora está apagada o deshabilitada, solo sus agentes dejan de estar disponibles; el resto del sistema sigue funcionando.
      Registrarla aquí no instala el ejecutor. Para conectarla y prepararlo, sigue las instrucciones de «Conectar un ordenador» en esa computadora.
    </p>
    {motivo ? <Notice tone="warn" role="note">Las acciones de esta sección están apagadas: {motivo}</Notice> : null}
    {flota.forbidden ? <Notice tone="info" role="note">Esta sesión no puede consultar las computadoras de esta empresa.</Notice>
      : flota.error ? <Notice tone="danger" role="alert" className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1">{flota.error}</span>
        <ActionButton size="sm" label="Reintentar" pendingLabel="Reintentando…" busy={flota.loading} done={false} announceError={false} action={() => flota.reload()} />
      </Notice> : null}
    {error && !editor && !borrar ? <Notice tone="danger" role="alert">{error}</Notice> : null}

    {flota.hosts ? <ul aria-label="Resumen de la flota"
      className="m-0 grid list-none grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line p-0 sm:grid-cols-3 lg:grid-cols-5">
      {[
        ['Registradas', resumen.registradas, ''],
        ['Conectadas', resumen.conectadas, resumen.conectadas ? 'text-ok-ink' : ''],
        ['Deshabilitadas', resumen.deshabilitadas, ''],
        ['Sin registrar', resumen.sinRegistrar, resumen.sinRegistrar ? 'text-warn-ink' : ''],
        ['Agentes', resumen.agentes, ''],
      ].map(([etiqueta, valor, tinta]) => <li key={etiqueta} className="flex items-baseline justify-between gap-2 bg-surface max-sm:last:col-span-2 px-3 py-2.5 sm:grid sm:justify-start sm:gap-0">
        <span className="text-xs text-muted">{etiqueta}</span>
        <strong className={`text-xl leading-tight font-semibold tabular-nums ${tinta as string}`}>{valor}</strong>
      </li>)}
    </ul> : null}

    {flota.loading && !flota.hosts ? <LoadingState label="Leyendo computadoras…" /> : null}
    {flota.hosts && hosts.length === 0 ? <EmptyState>No hay computadoras registradas ni conocidas todavía. Conecta la primera desde «Añadir ordenador».</EmptyState> : null}

    <section aria-labelledby="computadoras-registradas" className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="computadoras-registradas" className="m-0 text-sm font-semibold">Registradas{flota.hosts ? ` (${String(registradas.length)})` : ''}</h3>
        <Button variant="primary" size="sm" disabled={!crea || busy} title={!crea ? (soloLectura ? CONFIG_SIN_CONTROL_REASON : 'Tu autoridad de empresa no permite registrar computadoras.') : busy ? 'Espera a que termine la operación en curso.' : undefined} onClick={() => { abrirAlta(); }}>
          <Plus size={14} aria-hidden="true" />Registrar computadora
        </Button>
      </div>
      {registradas.length ? <ul className={GRID_TARJETAS}>{registradas.map(tarjeta)}</ul> : hosts.length ? <EmptyState>{crea ? 'Ninguna computadora registrada todavía. Registra la primera con «Registrar computadora».' : 'Ninguna computadora registrada todavía. Conecta una desde «Añadir ordenador».'}</EmptyState> : null}
    </section>

    {detectadas.length ? <section aria-labelledby="computadoras-detectadas" className="grid gap-3">
      <div className="grid gap-0.5">
        <h3 id="computadoras-detectadas" className="m-0 text-sm font-semibold">Detectadas sin registrar ({detectadas.length})</h3>
        <p className="m-0 text-xs text-muted">Sus agentes o el controlador las reportan, pero Cauce aún no las tiene en el registro.</p>
      </div>
      <ul className={GRID_TARJETAS}>{detectadas.map(tarjeta)}</ul>
    </section> : null}

    <ComputadoraFormDialog editor={editor} busy={busy} error={conflictDiffs ? undefined : error}
      conflict={editor && conflictDiffs ? <ConflictNotice diffs={conflictDiffs} busy={busy}
        onRetry={() => { void reintentarComputadora(); }}
        onDiscard={() => {
          if (conflictFresh) setEditor({ modo: 'editar', hostId: conflictFresh.host_id, displayName: conflictFresh.display_name, notes: conflictFresh.notes, version: conflictFresh.version });
          setConflictDiffs(undefined); setConflictFresh(undefined); setError(undefined);
        }} /> : undefined}
      onChange={setEditor} onSubmit={(event) => { void guardar(event); }} onClose={() => { setEditor(undefined); setConflictDiffs(undefined); setConflictFresh(undefined); }} />

    <ConfirmDialog open={!!borrar} tone="danger" busy={busy}
      title={borrar ? `Eliminar la computadora ${borrar.display_name}` : ''}
      confirmLabel="Eliminar" onConfirm={() => { void eliminar(); }} onCancel={() => { setBorrar(undefined); }}>
      <p>Se quita del registro de Cauce. No desinstala el ejecutor ni toca la máquina.</p>
      <label className="flex items-start gap-2">
        <input type="checkbox" checked={deleteBackups} disabled={busy} onChange={event => { setDeleteBackups(event.target.checked); }} />
        <span>Eliminar también todas sus copias de espacio del servidor. Es irreversible; descarga antes las que quieras conservar.</span>
      </label>
      <p>Si hay copias en curso, espera a que terminen. Los agentes y entornos de cuota deben eliminarse antes.</p>
      {error ? <Notice tone="danger" role="alert">{error}</Notice> : null}
    </ConfirmDialog>
  </div>;
}
