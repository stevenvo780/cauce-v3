import { FleetHostCreateSchema, FleetHostUpdateSchema, type FleetHost } from '@cauce/protocol/fleet-hosts';
import { useState, type SyntheticEvent } from 'react';
import { useApi } from '../../api/context';
import type { ConfigurationSnapshot } from '../../api/types';
import { cn } from '../../cn';
import { Button, Notice, Pill } from '../../components/kit';
import { ConfirmDialog } from '../../components/dialogs';
import { EmptyState, Time } from '../../components/ui';
import { CONFIG_SIN_CONTROL_REASON } from '../../router';
import { TONE_CLASS } from '../../status-tone';
import { ConfigSectionHeader } from './ConfigSectionHeader';
import { canUseConfigForm } from './config-form-access';
import { CHECK_LABEL, FORM_GRID } from './config-ui';
import { configFormDefinition } from './config-form-model';
import { ejecutorDeComputadora, estadoDeComputadora, mensajeDeEscritura, sePuedeEliminar, type AccionDeEscritura } from './fleet-host-model';
import { useFleetHosts } from './use-fleet-hosts';

/**
 * The fleet registry is hub-only on the server. The tenant form gate alone also admits tenant operators, so the
 * hub flag is checked explicitly; a snapshot without capabilities is read-only.
 */
const DEFINICION_HUB = configFormDefinition('tenants');

function esHub(snapshot: ConfigurationSnapshot | undefined): boolean {
  return snapshot?.capabilities?.actor.is_hub === true;
}

interface Editor {
  modo: 'alta' | 'editar';
  hostId: string;
  displayName: string;
  notes: string;
  version: number;
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

  return <div className="grid gap-4">
    <ConfigSectionHeader seccion="computadoras" />
    <Notice tone="info">
      Si una computadora está apagada o deshabilitada, solo sus agentes dejan de estar disponibles; el resto del sistema sigue funcionando.
      Instalar el ejecutor (acceso SSH, usuarios y aprobación) sigue siendo un paso del operador en cada computadora: registrarla aquí no lo instala.
    </Notice>
    {motivo ? <Notice tone="warn" role="note">Las acciones de esta sección están apagadas: {motivo}</Notice> : null}
    {flota.forbidden ? <Notice tone="info" role="note">Solo el hub administra computadoras.</Notice>
      : flota.error ? <Notice tone="danger" role="alert">{flota.error}</Notice> : null}
    {error ? <Notice tone="danger" role="alert">{error}</Notice> : null}

    <div>
      <Button variant="primary" disabled={!escribe || busy} onClick={() => { abrirAlta(); }}>Registrar computadora</Button>
    </div>

    {editor ? <form aria-label={editor.modo === 'alta' ? 'Registrar computadora' : `Editar ${editor.hostId}`}
      onSubmit={(event) => { void guardar(event); }}
      className="grid gap-3 rounded-xl border border-line bg-surface p-4">
      <div className={FORM_GRID}>
        <label className="grid gap-1">Identificador (host_id)
          {editor.modo === 'alta'
            ? <input required value={editor.hostId} disabled={busy} onChange={(event) => { setEditor({ ...editor, hostId: event.target.value }); }} />
            : <code className="text-sm">{editor.hostId}</code>}
        </label>
        <label className="grid gap-1">Nombre visible
          <input required maxLength={80} value={editor.displayName} disabled={busy}
            onChange={(event) => { setEditor({ ...editor, displayName: event.target.value }); }} />
        </label>
      </div>
      <label className="grid gap-1">Notas
        <textarea maxLength={500} rows={2} value={editor.notes} disabled={busy}
          onChange={(event) => { setEditor({ ...editor, notes: event.target.value }); }} />
      </label>
      <div className="flex flex-wrap justify-end gap-2">
        <Button size="sm" disabled={busy} onClick={() => { setEditor(undefined); }}>Cancelar</Button>
        <Button size="sm" variant="primary" type="submit" disabled={busy}>Guardar</Button>
      </div>
    </form> : null}

    {flota.loading && !flota.hosts ? <p role="status" className="m-0 text-[13px] text-muted">Leyendo computadoras…</p> : null}
    {flota.hosts && hosts.length === 0 ? <EmptyState>No hay computadoras registradas ni conocidas todavía.</EmptyState> : null}

    <ul className={cn('m-0 grid list-none gap-3 p-0', 'md:grid-cols-2')}>
      {hosts.map((host) => {
        const estado = estadoDeComputadora(host);
        return <li key={host.host_id}>
          <article aria-labelledby={`computadora-${host.host_id}`} className="grid content-start gap-3 rounded-xl border border-line bg-surface p-4">
            <header className="flex flex-wrap items-start justify-between gap-2">
              <div className="grid min-w-0 gap-0.5">
                <h3 id={`computadora-${host.host_id}`} className="m-0 text-[15px] font-semibold break-words">{host.display_name}</h3>
                <code className="text-xs text-muted break-all">{host.host_id}</code>
              </div>
              {host.registered
                ? <Pill tone={estado.tono}>{estado.etiqueta}</Pill>
                : <Pill tone="warn">Sin registrar</Pill>}
            </header>

            <dl className="m-0 grid gap-1.5 text-[13px]">
              <div className="grid gap-0.5 sm:grid-cols-[9rem_minmax(0,1fr)]">
                <dt className="text-muted">Estado</dt>
                <dd className="m-0">{estado.etiqueta}, {estado.fuente}</dd>
              </div>
              <div className="grid gap-0.5 sm:grid-cols-[9rem_minmax(0,1fr)]">
                <dt className="text-muted">Último contacto</dt>
                <dd className="m-0">{host.last_seen_at ? <Time value={host.last_seen_at} relativo /> : 'Nunca'}</dd>
              </div>
              <div className="grid gap-0.5 sm:grid-cols-[9rem_minmax(0,1fr)]">
                <dt className="text-muted">Ejecutor</dt>
                <dd className={cn('m-0', !host.approved && 'text-warn')}>{host.registered ? ejecutorDeComputadora(host) : 'Registra la computadora para aprobarla.'}</dd>
              </div>
            </dl>

            {host.registered ? <label className={CHECK_LABEL}>
              <input type="checkbox" checked={host.enabled} disabled={!escribe || busy || editando === host.host_id}
                onChange={() => { alternar(host); }} />
              Habilitada
            </label> : null}

            <section aria-label={`Agentes de ${host.display_name}`} className="grid gap-1.5">
              <h4 className="m-0 text-xs font-medium text-muted">Agentes ({host.agents.length})</h4>
              {host.agents.length ? <ul className="m-0 grid list-none gap-1 p-0 text-[13px]">
                {host.agents.map((agent) => <li key={`${agent.tenant_id}/${agent.alias}`} className="flex flex-wrap items-center gap-2">
                  <span aria-hidden="true" className={cn('size-2 shrink-0 rounded-full', TONE_CLASS[agent.online ? 'ok' : 'neutral'].dot)} />
                  <span className="break-all">{agent.alias}</span>
                  <span className="text-xs text-muted">{agent.tenant_id} · {agent.online ? 'en línea' : 'fuera de línea'}</span>
                </li>)}
              </ul> : <p className="m-0 text-xs text-muted">Sin agentes en esta computadora.</p>}
            </section>

            <footer className="flex flex-wrap items-center gap-2">
              {host.registered ? <>
                <Button size="sm" disabled={!escribe || busy} onClick={() => { abrirEdicion(host); }}>Editar</Button>
                {sePuedeEliminar(host)
                  ? <Button size="sm" variant="danger" disabled={!escribe || busy || editando === host.host_id} onClick={() => { setBorrar(host); }}>Eliminar</Button>
                  : <span className="text-xs text-muted">Para eliminarla, quita antes sus agentes.</span>}
              </> : <Button size="sm" variant="primary" disabled={!escribe || busy} onClick={() => { abrirAlta(host); }}>Registrar</Button>}
            </footer>
          </article>
        </li>;
      })}
    </ul>

    <ConfirmDialog open={!!borrar} tone="danger" busy={busy}
      title={borrar ? `Eliminar la computadora ${borrar.display_name}` : ''}
      confirmLabel="Eliminar" onConfirm={() => { void eliminar(); }} onCancel={() => { setBorrar(undefined); }}>
      <p>Se quita del registro de Cauce. No desinstala el ejecutor ni toca la máquina.</p>
    </ConfirmDialog>
  </div>;
}
