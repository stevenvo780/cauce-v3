import { Braces, Plus, SearchCheck } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { ConfigMutation, ConfigurationSnapshot } from '../../api/types';
import { CONFIG_SIN_CONTROL_REASON } from '../../router';
import { Button, Notice, Outcome, PREVIEW } from '../../components/kit';
import {
  AYUDA_ALTA, BORRADOR_VACIO, errorDeAlta, mutacionDeAlta, RECURSOS_ALTA, TITULOS_ALTA,
  type BorradorAlta, type RecursoAlta,
} from './alta-rapida';
import { textoRecarga, type ConfigChangeOutcome } from './config-change';
import { CHECK_LABEL, FORM_GRID, HINT } from './config-ui';
import { ConfigChangeReceipt } from './ConfigChangeReceipt';
import { configMutationSummary } from './config-change-summary';
import { nombreDeRol } from './efecto-de-rol';

/**
 * Onboarding for a resource via form. Replaces "type the mutation by hand in JSON" for the four
 * resources onboarded on a daily basis; the raw editor stays below for everything else.
 *
 * It goes through the SAME `onChange` as the wizard and the raw editor — that is, through
 * `api.changeConfiguration` with `expected_revision` — so there is no second write path that
 * could fall behind the first one.
 */
export function AltaRapida({ soloLectura, busy, onChange, snapshot }: {
  soloLectura: boolean;
  snapshot?: ConfigurationSnapshot | undefined;
  busy: boolean;
  onChange: (mutation: ConfigMutation, dryRun: boolean) => Promise<ConfigChangeOutcome>;
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
      setAviso({ text: `Vista previa aceptada: ${configMutationSummary(mutation, snapshot)}. Todavía no se ha guardado.`, tone: 'success' });
      return;
    }
    setPreview(undefined);
    // The green comes from the server response and the reload outcome, never before.
    const fallo = desenlace.recarga && !desenlace.recarga.releido;
    setAviso({
      tone: fallo ? 'parcial' : 'success',
      text: `${TITULOS_ALTA[recurso]}: creado en la revisión ${String(desenlace.result.revision ?? 'desconocida')}`
        + `: ${configMutationSummary(mutation, snapshot)}.${textoRecarga(desenlace.recarga)}`
        + (recurso === 'membership' ? ' Si esa persona o ese agente todavía no existe, dalo de alta en Agentes y elige esta sala.' : ''),
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

  return <div className="grid gap-3" role="group" aria-label="Alta rápida">
    <div className={FORM_GRID}>
      <label>Recurso<select
        {...inerte}
        aria-label="Recurso a crear"
        value={recurso}
        onChange={(event) => { cambiarRecurso(event.target.value as RecursoAlta); }}
      >{RECURSOS_ALTA.map((item) => <option key={item} value={item}>{TITULOS_ALTA[item]}</option>)}</select></label>
      <p className="m-0 text-xs text-muted md:col-span-2">{AYUDA_ALTA[recurso]}</p>

      {recurso === 'tenant' || recurso === 'room' || recurso === 'membership'
        ? <label>Espacio<input {...inerte} aria-label="Espacio" value={borrador.tenantId} onChange={(event) => { editar({ tenantId: event.target.value }); }} /></label>
        : null}
      {recurso === 'room' || recurso === 'membership'
        ? <label>Sala<input {...inerte} aria-label="Sala" value={borrador.roomId} onChange={(event) => { editar({ roomId: event.target.value }); }} /></label>
        : null}
      {recurso === 'membership'
        ? <label>Identificador<input {...inerte} aria-label="Identificador" value={borrador.alias} onChange={(event) => { editar({ alias: event.target.value }); }} /></label>
        : null}
      {recurso === 'tenant' || recurso === 'room'
        ? <label>Nombre <span className={HINT}>opcional</span>
          <input {...inerte} aria-label="Nombre" value={borrador.nombre} onChange={(event) => { editar({ nombre: event.target.value }); }} /></label>
        : null}
      {recurso === 'acl_edge' ? <>
        <label>Desde el espacio<input {...inerte} aria-label="Desde el espacio" value={borrador.desde} onChange={(event) => { editar({ desde: event.target.value }); }} /></label>
        <label>Hacia el espacio<input {...inerte} aria-label="Hacia el espacio" value={borrador.hacia} onChange={(event) => { editar({ hacia: event.target.value }); }} /></label>
        {/* The three permissions default to NO: the backend default is deny, and the form must
            not open a cross-tenant link by default. */}
        <label className={CHECK_LABEL}><input {...inerte} type="checkbox" aria-label="Puede mandar mensajes" checked={borrador.allowRoute} onChange={(event) => { editar({ allowRoute: event.target.checked }); }} /> Puede mandar mensajes</label>
        <label className={CHECK_LABEL}><input {...inerte} type="checkbox" aria-label="Puede ver la actividad" checked={borrador.allowRead} onChange={(event) => { editar({ allowRead: event.target.checked }); }} /> Puede ver la actividad</label>
        <label className={CHECK_LABEL}><input {...inerte} type="checkbox" aria-label="Puede cambiar la configuración" checked={borrador.allowControl} onChange={(event) => { editar({ allowControl: event.target.checked }); }} /> Puede cambiar la configuración</label>
      </> : null}
    </div>

    <details className="text-[13px]">
      <summary className="cursor-pointer font-medium">Opciones de alta: {borrador.habilitado ? 'habilitado' : 'deshabilitado'}
        {recurso === 'membership' ? ` · rol ${borrador.role.trim() ? nombreDeRol(borrador.role.trim()) : 'sin definir'}` : ''}
        {recurso === 'tenant' ? ` · ${borrador.esHub ? 'espacio principal' : 'espacio normal'}` : ''}
      </summary>
      <div className={`${FORM_GRID} mt-2`}>
        {recurso === 'membership'
          ? <label>Rol <span className={HINT}>en minúsculas; decide qué puede hacer en la sala</span>
            <input {...inerte} aria-label="Rol de permisos" value={borrador.role} onChange={(event) => { editar({ role: event.target.value }); }} /></label>
          : null}
        {recurso === 'tenant'
          ? <label className={CHECK_LABEL}><input {...inerte} type="checkbox" aria-label="Es el espacio principal" checked={borrador.esHub} onChange={(event) => { editar({ esHub: event.target.checked }); }} /> Es el espacio principal</label>
          : null}
        <label className={CHECK_LABEL}><input {...inerte} type="checkbox" aria-label="Habilitado" checked={borrador.habilitado} onChange={(event) => { editar({ habilitado: event.target.checked }); }} /> Habilitado</label>
      </div>
    </details>

    {/* What is about to be sent, one click from view.
        It was open by default and occupied eleven lines of raw JSON between the form and its
        buttons: to reach "Create" one had to walk past `{"resource":"membership"…}`, which is not
        what is being done but how it is encoded. It is not hidden — it is still all there, and
        is what must be read before signing anything odd — it just stops being the first thing. */}
    <details className="text-[13px]">
      <summary className="flex cursor-pointer items-center gap-1.5 text-muted"><Braces size={13} aria-hidden="true" /> Ver el detalle técnico del alta</summary>
      <pre className={`${PREVIEW} mt-2`} aria-label="Mutación del alta">{JSON.stringify(mutation, null, 2)}</pre>
    </details>

    {recurso === 'membership' ? <Notice tone="warn" role="note">
      Añade a una persona o a un agente a una sala que ya existe. No crea el agente: si todavía no está en Agentes, dalo de alta allí y elige esta misma sala.
    </Notice> : null}

    <div className="flex flex-wrap gap-2">
      <Button disabled={soloLectura || busy || Boolean(invalido)}
        title={soloLectura ? CONFIG_SIN_CONTROL_REASON : undefined}
        onClick={() => void enviar(true)}
      ><SearchCheck size={16} aria-hidden="true" />Previsualizar el alta</Button>
      <Button variant="primary" disabled={soloLectura || busy || Boolean(invalido)}
        title={soloLectura ? CONFIG_SIN_CONTROL_REASON : undefined}
        onClick={() => void enviar(false)}
      ><Plus size={16} aria-hidden="true" />Crear</Button>
    </div>

    {invalido
      ? tocado
        ? <Outcome tone="error">{invalido}</Outcome>
        : <p className="m-0 text-xs text-muted">Completa el formulario para habilitar el alta: {invalido}</p>
      : null}
    <ConfigChangeReceipt preview={preview} label="Vista previa del alta" />
    {aviso ? <Outcome tone={aviso.tone}>{aviso.text}</Outcome> : null}
  </div>;
}
