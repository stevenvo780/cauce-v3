import { Braces, Plus, SearchCheck } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import type { ConfigMutation } from '../../api/types';
import { CONFIG_SIN_CONTROL_REASON } from '../../router';
import { Panel } from '../../components/ui';
import {
  BORRADOR_VACIO, errorDeAlta, mutacionDeAlta, RECURSOS_ALTA, TITULOS_ALTA,
  type BorradorAlta, type RecursoAlta,
} from './alta-rapida';
import { textoRecarga, type ConfigChangeOutcome } from './config-change';
import './toggles.css';

/**
 * Onboarding for a resource via form. Replaces "type the mutation by hand in JSON" for the four
 * resources onboarded on a daily basis; the raw editor stays below for everything else.
 *
 * It goes through the SAME `onChange` as the wizard and the raw editor — that is, through
 * `api.changeConfiguration` with `expected_revision` — so there is no second write path that
 * could fall behind the first one.
 */
export function AltaRapida({ soloLectura, busy, onChange, encabezado }: {
  soloLectura: boolean;
  busy: boolean;
  onChange: (mutation: ConfigMutation, dryRun: boolean) => Promise<ConfigChangeOutcome>;
  /**
   * The control that picks between this onboarding and the wizard. It is rendered INSIDE the
   * panel, above the form it governs: hanging it outside was a second strip of tabs identical to
   * the areas' one, and read as page navigation. See `AltaDeEspacios`.
   */
  encabezado?: ReactNode;
}) {
  const [recurso, setRecurso] = useState<RecursoAlta>('membership');
  const [borrador, setBorrador] = useState<BorradorAlta>(BORRADOR_VACIO);
  const [aviso, setAviso] = useState<{ text: string; tone: 'success' | 'error' | 'parcial' }>();
  const [preview, setPreview] = useState<string>();
  // A freshly opened form is not a badly filled form: the reason is shouted (role=alert) only once
  // the operator touched something or tried to submit. Until then it is shown as a hint.
  const [tocado, setTocado] = useState(false);

  const invalido = errorDeAlta(recurso, borrador);
  const mutation = useMemo(() => mutacionDeAlta(recurso, borrador), [recurso, borrador]);

  function editar(parche: Partial<BorradorAlta>) {
    setBorrador((actual) => ({ ...actual, ...parche }));
    setTocado(true);
    // The previous dry-run applied to ANOTHER mutation: leaving it on screen would turn it into a
    // promise about something the server never saw.
    setPreview(undefined);
    setAviso(undefined);
  }

  function cambiarRecurso(siguiente: RecursoAlta) {
    setRecurso(siguiente);
    setPreview(undefined);
    setAviso(undefined);
    // Another resource asks for different fields: the form is freshly opened again and the
    // "cannot create yet" reason stops being a `role=alert`. Without this, picking "Room"
    // shouted at the operator a validation error about fields they had not even seen.
    setTocado(false);
  }

  async function enviar(dryRun: boolean) {
    setAviso(undefined);
    setTocado(true);
    if (invalido) {
      setAviso({ text: invalido, tone: 'error' });
      return;
    }
    const desenlace = await onChange(mutation, dryRun);
    if (!desenlace.ok) {
      setPreview(undefined);
      setAviso({ text: desenlace.message + textoRecarga(desenlace.recarga), tone: 'error' });
      return;
    }
    if (dryRun) {
      setPreview(JSON.stringify(desenlace.result, null, 2));
      setAviso({ text: 'Dry-run aceptado por el servidor: no se escribió nada todavía.', tone: 'success' });
      return;
    }
    setPreview(undefined);
    // The green comes from the server response and the reload outcome, never before.
    const fallo = desenlace.recarga && !desenlace.recarga.releido;
    setAviso({
      tone: fallo ? 'parcial' : 'success',
      text: `${TITULOS_ALTA[recurso]} creado en la revisión ${String(desenlace.result.revision ?? 'UNKNOWN')}`
        + ` (${desenlace.result.summary ?? 'sin resumen del servidor'}).${textoRecarga(desenlace.recarga)}`,
    });
    // The resource ALREADY exists: leaving the fields filled reassembles "Create" on top of it
    // and the second click earns a 409 for a duplicate row. The form returns to empty with no
    // `tocado`, so the reason "Create" is disabled shows as a hint, not as an error. The green
    // notice is not touched: it is the only thing left from the onboarding that did succeed.
    setBorrador(BORRADOR_VACIO);
    setTocado(false);
  }

  // Without `config.write` the form is not hidden — fields stay visible so the operator knows
  // WHAT could be onboarded — but it goes inert: filling it out and seeing the mutation update
  // live, on a screen whose header says "Read-only", is promising a write that will never go out.
  const inerte = { disabled: soloLectura, ...(soloLectura ? { title: CONFIG_SIN_CONTROL_REASON } : {}) };

  return <Panel title="Alta rápida" subtitle="Arma la mutación y la manda por el mismo change endpoint versionado que el editor crudo.">
    {encabezado}
    <div className="config-form">
      <label>Recurso<select
        {...inerte}
        aria-label="Recurso a crear"
        value={recurso}
        onChange={(event) => { cambiarRecurso(event.target.value as RecursoAlta); }}
      >{RECURSOS_ALTA.map((item) => <option key={item} value={item}>{TITULOS_ALTA[item]}</option>)}</select></label>

      {recurso === 'tenant' || recurso === 'room' || recurso === 'membership'
        ? <label>Tenant<input {...inerte} aria-label="Tenant" value={borrador.tenantId} onChange={(event) => { editar({ tenantId: event.target.value }); }} /></label>
        : null}
      {recurso === 'room' || recurso === 'membership'
        ? <label>Room<input {...inerte} aria-label="Room" value={borrador.roomId} onChange={(event) => { editar({ roomId: event.target.value }); }} /></label>
        : null}
      {recurso === 'membership' ? <>
        <label>Alias<input {...inerte} aria-label="Alias" value={borrador.alias} onChange={(event) => { editar({ alias: event.target.value }); }} /></label>
        <label>Rol <span className="label-hint">route/read/control salen de role_policies</span>
          <input {...inerte} aria-label="Rol" value={borrador.role} onChange={(event) => { editar({ role: event.target.value }); }} /></label>
      </> : null}
      {recurso === 'tenant' || recurso === 'room'
        ? <label>Nombre <span className="label-hint">opcional, null si queda vacío</span>
          <input {...inerte} aria-label="Nombre" value={borrador.nombre} onChange={(event) => { editar({ nombre: event.target.value }); }} /></label>
        : null}
      {recurso === 'tenant'
        ? <label className="casilla"><input {...inerte} type="checkbox" aria-label="Es hub" checked={borrador.esHub} onChange={(event) => { editar({ esHub: event.target.checked }); }} /> Es hub</label>
        : null}
      {recurso === 'acl_edge' ? <>
        <label>Desde el tenant<input {...inerte} aria-label="Desde el tenant" value={borrador.desde} onChange={(event) => { editar({ desde: event.target.value }); }} /></label>
        <label>Hacia el tenant<input {...inerte} aria-label="Hacia el tenant" value={borrador.hacia} onChange={(event) => { editar({ hacia: event.target.value }); }} /></label>
        {/* The three permissions default to NO: the backend default is deny, and the form must
            not open a cross-tenant link by default. */}
        <label className="casilla"><input {...inerte} type="checkbox" aria-label="Ruta" checked={borrador.allowRoute} onChange={(event) => { editar({ allowRoute: event.target.checked }); }} /> Ruta <span className="label-hint">allow_route: dejar que le mande mensajes</span></label>
        <label className="casilla"><input {...inerte} type="checkbox" aria-label="Lectura" checked={borrador.allowRead} onChange={(event) => { editar({ allowRead: event.target.checked }); }} /> Lectura <span className="label-hint">allow_read: dejar que lea su actividad</span></label>
        <label className="casilla"><input {...inerte} type="checkbox" aria-label="Control" checked={borrador.allowControl} onChange={(event) => { editar({ allowControl: event.target.checked }); }} /> Control <span className="label-hint">allow_control: dejar que le escriba la configuración</span></label>
      </> : null}
      <label className="casilla"><input {...inerte} type="checkbox" aria-label="Habilitado" checked={borrador.habilitado} onChange={(event) => { editar({ habilitado: event.target.checked }); }} /> Habilitado</label>
    </div>

    {/* What is about to be sent, one click from view.
        It was open by default and occupied eleven lines of raw JSON between the form and its
        buttons: to reach "Create" one had to walk past `{"resource":"membership"…}`, which is not
        what is being done but how it is encoded. It is not hidden — it is still all there, and
        is what must be read before signing anything odd — it just stops being the first thing. */}
    <details className="config-crudo">
      <summary><Braces size={13} aria-hidden="true" /> Ver la mutación que se va a enviar</summary>
      <pre className="config-preview" aria-label="Mutación del alta">{JSON.stringify(mutation, null, 2)}</pre>
    </details>

    <div className="config-actions">
      <button
        className="button secondary" type="button"
        disabled={soloLectura || busy || Boolean(invalido)}
        title={soloLectura ? CONFIG_SIN_CONTROL_REASON : undefined}
        onClick={() => void enviar(true)}
      ><SearchCheck size={16} aria-hidden="true" />Previsualizar el alta</button>
      <button
        className="button primary" type="button"
        disabled={soloLectura || busy || Boolean(invalido)}
        title={soloLectura ? CONFIG_SIN_CONTROL_REASON : undefined}
        onClick={() => void enviar(false)}
      ><Plus size={16} aria-hidden="true" />Crear</button>
    </div>

    {invalido
      ? tocado
        ? <p className="notice error" role="alert">{invalido}</p>
        : <p className="muted">Completá el formulario para habilitar el alta: {invalido}</p>
      : null}
    {preview ? <pre className="config-preview" aria-label="Dry-run del alta">{preview}</pre> : null}
    {aviso ? <p
      className={aviso.tone === 'error' ? 'notice error' : aviso.tone === 'parcial' ? 'notice parcial' : 'notice success'}
      role={aviso.tone === 'success' ? 'status' : 'alert'}
    >{aviso.text}</p> : null}
  </Panel>;
}
