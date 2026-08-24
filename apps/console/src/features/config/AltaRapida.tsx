import { Braces, Plus, SearchCheck } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import type { ConfigMutation } from '../../api/types';
import { CONFIG_SIN_CONTROL_REASON } from '../../navigation';
import { Panel } from '../../components/ui';
import {
  BORRADOR_VACIO, errorDeAlta, mutacionDeAlta, RECURSOS_ALTA, TITULOS_ALTA,
  type BorradorAlta, type RecursoAlta,
} from './alta-rapida';
import { textoRecarga, type ConfigChangeOutcome } from './config-change';
import './toggles.css';

/**
 * Alta de un recurso con formulario. Reemplaza al «tipeá la mutación a mano en JSON» para los
 * cuatro recursos que se dan de alta a diario; el editor crudo sigue abajo para todo lo demás.
 *
 * Va por el MISMO `onChange` que el wizard y que el editor crudo —o sea, por
 * `api.changeConfiguration` con `expected_revision`—, así que no hay un segundo camino de escritura
 * que pueda quedarse atrás del primero.
 */
export function AltaRapida({ soloLectura, busy, onChange, encabezado }: {
  soloLectura: boolean;
  busy: boolean;
  onChange: (mutation: ConfigMutation, dryRun: boolean) => Promise<ConfigChangeOutcome>;
  /**
   * El control que elige entre este alta y el wizard. Se pinta DENTRO del panel, arriba del
   * formulario que gobierna: colgado por fuera era una segunda tira de pestañas idéntica a la de
   * las áreas, y se leía como navegación de la página. Ver `AltaDeEspacios`.
   */
  encabezado?: ReactNode;
}) {
  const [recurso, setRecurso] = useState<RecursoAlta>('membership');
  const [borrador, setBorrador] = useState<BorradorAlta>(BORRADOR_VACIO);
  const [aviso, setAviso] = useState<{ text: string; tone: 'success' | 'error' | 'parcial' }>();
  const [preview, setPreview] = useState<string>();
  // Un formulario recién abierto no es un formulario mal llenado: el motivo se grita (role=alert)
  // recién cuando el operador tocó algo o intentó enviar. Antes de eso se muestra como pista.
  const [tocado, setTocado] = useState(false);

  const invalido = errorDeAlta(recurso, borrador);
  const mutation = useMemo(() => mutacionDeAlta(recurso, borrador), [recurso, borrador]);

  function editar(parche: Partial<BorradorAlta>) {
    setBorrador((actual) => ({ ...actual, ...parche }));
    setTocado(true);
    // El dry-run anterior valía para OTRA mutación: dejarlo en pantalla lo convertiría en una
    // promesa sobre algo que el servidor nunca vio.
    setPreview(undefined);
    setAviso(undefined);
  }

  function cambiarRecurso(siguiente: RecursoAlta) {
    setRecurso(siguiente);
    setPreview(undefined);
    setAviso(undefined);
    // Otro recurso pide otros campos: el formulario vuelve a estar recién abierto y el motivo de
    // «todavía no se puede crear» deja de ser un `role=alert`. Sin esto, elegir «Room» le gritaba
    // al operador un error de validación sobre campos que ni siquiera había visto.
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
    // El verde sale con la respuesta del servidor y con el desenlace de la relectura, nunca antes.
    const fallo = desenlace.recarga && !desenlace.recarga.releido;
    setAviso({
      tone: fallo ? 'parcial' : 'success',
      text: `${TITULOS_ALTA[recurso]} creado en la revisión ${desenlace.result.revision ?? 'UNKNOWN'}`
        + ` (${desenlace.result.summary ?? 'sin resumen del servidor'}).${textoRecarga(desenlace.recarga)}`,
    });
    // El recurso YA existe: dejar los campos llenos rearma «Crear» sobre él y el segundo clic se
    // gana un 409 de fila duplicada. El formulario vuelve a vacío y sin `tocado`, así que el
    // motivo de que «Crear» esté apagado se muestra como pista y no como error. El aviso verde no
    // se toca: es lo único que queda del alta que sí se hizo.
    setBorrador(BORRADOR_VACIO);
    setTocado(false);
  }

  // Sin `config.write` el formulario no se esconde —los campos siguen a la vista para saber QUÉ se
  // podría dar de alta— pero queda inerte: llenarlo entero y ver la mutación actualizarse en vivo,
  // en una pantalla que arriba dice «Solo lectura», es prometer una escritura que nunca va a salir.
  const inerte = { disabled: soloLectura, ...(soloLectura ? { title: CONFIG_SIN_CONTROL_REASON } : {}) };

  return <Panel title="Alta rápida" subtitle="Arma la mutación y la manda por el mismo change endpoint versionado que el editor crudo.">
    {encabezado}
    <div className="config-form">
      <label>Recurso<select
        {...inerte}
        aria-label="Recurso a crear"
        value={recurso}
        onChange={(event) => cambiarRecurso(event.target.value as RecursoAlta)}
      >{RECURSOS_ALTA.map((item) => <option key={item} value={item}>{TITULOS_ALTA[item]}</option>)}</select></label>

      {recurso === 'tenant' || recurso === 'room' || recurso === 'membership'
        ? <label>Tenant<input {...inerte} aria-label="Tenant" value={borrador.tenantId} onChange={(event) => editar({ tenantId: event.target.value })} /></label>
        : null}
      {recurso === 'room' || recurso === 'membership'
        ? <label>Room<input {...inerte} aria-label="Room" value={borrador.roomId} onChange={(event) => editar({ roomId: event.target.value })} /></label>
        : null}
      {recurso === 'membership' ? <>
        <label>Alias<input {...inerte} aria-label="Alias" value={borrador.alias} onChange={(event) => editar({ alias: event.target.value })} /></label>
        <label>Rol <span className="label-hint">route/read/control salen de role_policies</span>
          <input {...inerte} aria-label="Rol" value={borrador.role} onChange={(event) => editar({ role: event.target.value })} /></label>
      </> : null}
      {recurso === 'tenant' || recurso === 'room'
        ? <label>Nombre <span className="label-hint">opcional, null si queda vacío</span>
          <input {...inerte} aria-label="Nombre" value={borrador.nombre} onChange={(event) => editar({ nombre: event.target.value })} /></label>
        : null}
      {recurso === 'tenant'
        ? <label className="casilla"><input {...inerte} type="checkbox" aria-label="Es hub" checked={borrador.esHub} onChange={(event) => editar({ esHub: event.target.checked })} /> Es hub</label>
        : null}
      {recurso === 'acl_edge' ? <>
        <label>Desde el tenant<input {...inerte} aria-label="Desde el tenant" value={borrador.desde} onChange={(event) => editar({ desde: event.target.value })} /></label>
        <label>Hacia el tenant<input {...inerte} aria-label="Hacia el tenant" value={borrador.hacia} onChange={(event) => editar({ hacia: event.target.value })} /></label>
        {/* Los tres permisos arrancan en NO: el default del backend es deny, y el formulario no
            debe abrir un cruce entre tenants por omisión. */}
        <label className="casilla"><input {...inerte} type="checkbox" aria-label="Ruta" checked={borrador.allowRoute} onChange={(event) => editar({ allowRoute: event.target.checked })} /> Ruta <span className="label-hint">allow_route: dejar que le mande mensajes</span></label>
        <label className="casilla"><input {...inerte} type="checkbox" aria-label="Lectura" checked={borrador.allowRead} onChange={(event) => editar({ allowRead: event.target.checked })} /> Lectura <span className="label-hint">allow_read: dejar que lea su actividad</span></label>
        <label className="casilla"><input {...inerte} type="checkbox" aria-label="Control" checked={borrador.allowControl} onChange={(event) => editar({ allowControl: event.target.checked })} /> Control <span className="label-hint">allow_control: dejar que le escriba la configuración</span></label>
      </> : null}
      <label className="casilla"><input {...inerte} type="checkbox" aria-label="Habilitado" checked={borrador.habilitado} onChange={(event) => editar({ habilitado: event.target.checked })} /> Habilitado</label>
    </div>

    {/* Lo que se va a enviar, a UN CLIC de la vista.
        Estaba abierto por defecto y ocupaba once líneas de JSON crudo entre el formulario y sus
        botones: para llegar a «Crear» había que pasar por delante de `{"resource":"membership"…}`,
        que no es lo que se está por hacer sino cómo se codifica. No se esconde —sigue estando
        entero, y es lo que hay que leer antes de firmar algo raro—: deja de ser lo primero. */}
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
