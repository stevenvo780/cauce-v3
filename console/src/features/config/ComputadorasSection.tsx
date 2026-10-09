import { FleetHostCreateSchema, FleetHostUpdateSchema, type FleetHost } from '@cauce/protocol/fleet-hosts';
import { useState, type SyntheticEvent } from 'react';
import { useApi } from '../../api/context';
import type { ConfigurationSnapshot } from '../../api/types';
import { Plus } from 'lucide-react';
import { Button, Notice } from '../../components/kit';
import { ConfirmDialog } from '../../components/dialogs';
import { EmptyState } from '../../components/ui';
import { CONFIG_SIN_CONTROL_REASON } from '../../router';
import { ConfigSectionHeader } from './ConfigSectionHeader';
import { canUseConfigForm } from './config-form-access';
import { ComputadoraCard } from './ComputadoraCard';
import { ComputadoraFormDialog, type Editor } from './ComputadoraFormDialog';
import { configFormDefinition } from './config-form-model';
import { mensajeDeEscritura, resumenDeFlota, type AccionDeEscritura } from './fleet-host-model';
import { useFleetHosts } from './use-fleet-hosts';

/**
 * The fleet registry is hub-only on the server. The tenant form gate alone also admits tenant operators, so the
 * hub flag is checked explicitly; a snapshot without capabilities is read-only.
 */
const DEFINICION_HUB = configFormDefinition('tenants');

const GRID_TARJETAS = 'm-0 grid list-none grid-cols-[repeat(auto-fill,minmax(min(100%,20rem),1fr))] gap-3 p-0';

function esHub(snapshot: ConfigurationSnapshot | undefined): boolean {
  return snapshot?.capabilities?.actor.is_hub === true;
}

export function ComputadorasSection({ snapshot, soloLectura }: { snapshot?: ConfigurationSnapshot; soloLectura: boolean }) {
  const api = useApi();
  const flota = useFleetHosts(true, snapshot?.revision);
  const escribe = !soloLectura && esHub(snapshot) && !!snapshot && !!DEFINICION_HUB && canUseConfigForm(snapshot, DEFINICION_HUB, 'create');
  const [editor, setEditor] = useState<Editor>();
  const [borrar, setBorrar] = useState<FleetHost>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const hosts = flota.hosts ?? [];

  async function escribir(operacion: () => Promise<unknown>, accion: AccionDeEscritura = 'edicion') {
    setBusy(true); setError(undefined);
    try {
      await operacion();
      await flota.reload();
      return true;
    } catch (cause) {
      setError(mensajeDeEscritura(cause, accion));
      return false;
    } finally {
      setBusy(false);
    }
  }

  function abrirAlta(host?: FleetHost) {
    setError(undefined);
    setEditor({ modo: 'alta', hostId: host?.host_id ?? '', displayName: host?.display_name ?? '', notes: '', version: 0 });
  }

  function abrirEdicion(host: FleetHost) {
    setError(undefined);
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
    }
    if (ok) setEditor(undefined);
  }

  function alternar(host: FleetHost) {
    void escribir(() => api.updateFleetHost(host.host_id, { expected_version: host.version, enabled: !host.enabled }));
  }

  async function eliminar() {
    if (!borrar) return;
    const ok = await escribir(() => api.deleteFleetHost(borrar.host_id, borrar.version), 'baja');
    if (ok) setBorrar(undefined);
  }

  const motivo = soloLectura ? CONFIG_SIN_CONTROL_REASON : !escribe ? 'Solo un hub puede registrar o cambiar computadoras.' : undefined;
  const editando = editor?.modo === 'editar' ? editor.hostId : undefined;
  const registradas = hosts.filter((host) => host.registered);
  const detectadas = hosts.filter((host) => !host.registered);
  const resumen = resumenDeFlota(hosts);
  const tarjeta = (host: FleetHost) => <li key={host.host_id}>
    <ComputadoraCard host={host} escribe={escribe} busy={busy} bloqueada={editando === host.host_id}
      onEditar={abrirEdicion} onAlternar={alternar} onEliminar={setBorrar} onRegistrar={abrirAlta} />
  </li>;

  return <div className="grid gap-4">
    <ConfigSectionHeader seccion="computadoras" />
    <p className="m-0 text-xs leading-relaxed text-muted">
      Si una computadora está apagada o deshabilitada, solo sus agentes dejan de estar disponibles; el resto del sistema sigue funcionando.
      Instalar el ejecutor (acceso SSH, usuarios y aprobación) sigue siendo un paso del operador en cada computadora: registrarla aquí no lo instala.
    </p>
    {motivo ? <Notice tone="warn" role="note">Las acciones de esta sección están apagadas: {motivo}</Notice> : null}
    {flota.forbidden ? <Notice tone="info" role="note">Solo el hub administra computadoras.</Notice>
      : flota.error ? <Notice tone="danger" role="alert">{flota.error}</Notice> : null}
    {error && !editor ? <Notice tone="danger" role="alert">{error}</Notice> : null}

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

    {flota.loading && !flota.hosts ? <p role="status" className="m-0 text-[13px] text-muted">Leyendo computadoras…</p> : null}
    {flota.hosts && hosts.length === 0 ? <EmptyState>No hay computadoras registradas ni conocidas todavía.</EmptyState> : null}

    <section aria-labelledby="computadoras-registradas" className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="computadoras-registradas" className="m-0 text-sm font-semibold">Registradas{flota.hosts ? ` (${String(registradas.length)})` : ''}</h3>
        <Button variant="primary" size="sm" disabled={!escribe || busy} onClick={() => { abrirAlta(); }}>
          <Plus size={14} aria-hidden="true" />Registrar computadora
        </Button>
      </div>
      {registradas.length ? <ul className={GRID_TARJETAS}>{registradas.map(tarjeta)}</ul> : hosts.length ? <EmptyState>Ninguna computadora registrada todavía.</EmptyState> : null}
    </section>

    {detectadas.length ? <section aria-labelledby="computadoras-detectadas" className="grid gap-3">
      <div className="grid gap-0.5">
        <h3 id="computadoras-detectadas" className="m-0 text-sm font-semibold">Detectadas sin registrar ({detectadas.length})</h3>
        <p className="m-0 text-xs text-muted">Sus agentes o el controlador las reportan, pero Cauce aún no las tiene en el registro.</p>
      </div>
      <ul className={GRID_TARJETAS}>{detectadas.map(tarjeta)}</ul>
    </section> : null}

    <ComputadoraFormDialog editor={editor} busy={busy} error={error}
      onChange={setEditor} onSubmit={(event) => { void guardar(event); }} onClose={() => { setEditor(undefined); }} />

    <ConfirmDialog open={!!borrar} tone="danger" busy={busy}
      title={borrar ? `Eliminar la computadora ${borrar.display_name}` : ''}
      confirmLabel="Eliminar" onConfirm={() => { void eliminar(); }} onCancel={() => { setBorrar(undefined); }}>
      <p>Se quita del registro de Cauce. No desinstala el ejecutor ni toca la máquina.</p>
    </ConfirmDialog>
  </div>;
}
