import { Save } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useApi } from '../../api/context';
import type { ConfigMutation, ConfigurationSnapshot } from '../../api/types';
import { useResource, type RecargaResultado } from '../../api/use-resource';
import { EmptyState } from '../../components/ui';
import { permissionState } from '../../lib';
import { CONFIG_SIN_CONTROL_REASON } from '../../navigation';
import { describeConfigError } from '../config/config-change';
import { HistorialRol } from './HistorialRol';
import { ROLE_BRIEF_MAX, bloqueoPorRuntimeDesplegado, contarRoleBrief, tonoRoleBrief } from './role-brief';

/**
 * El rol declarado de un alias (`agents.role_brief`), editable donde Steven ya mira a los bots.
 *
 * Hasta ahora este texto —el preámbulo «Tu rol: …» que el adaptador antepone al contrato— sólo se
 * LEÍA: la única forma de cambiarlo era un `UPDATE` crudo contra la base, sin revisión y sin vuelta
 * atrás. Acá se escribe por la MISMA mutación de configuración que usa «Ajustes & rollback»,
 * que deja su mutación inversa en `config_revisions`; sin inverso no hay marcha atrás y el cambio
 * no vale.
 *
 * No es una vista nueva a propósito: es una pestaña más del cajón que ya se abre al hacer clic en
 * un muñeco. Mandar al operador a otra ruta para tocar el rol del alias que está mirando es el
 * mismo defecto que se corrigió absorbiendo «Fleet» dentro de este cajón.
 *
 * REGLA DE LA PANTALLA, que es de donde salieron casi todos los defectos de la revisión: acá no se
 * afirma nada que no se haya comprobado. Ni «se recargó» sin haber esperado la recarga, ni un
 * cartel verde encima de un texto que nadie volvió a leer del servidor. Cuando algo no se pudo
 * comprobar, se dice con esas palabras.
 */

/** La fila del registro para este alias, o `undefined` si el gateway no la publica. */
function filaDelAgente(
  agents: Array<Record<string, unknown>> | null | undefined,
  tenantId: string,
  alias: string,
): Record<string, unknown> | undefined {
  if (!Array.isArray(agents)) return undefined;
  return agents.find((row) => row.tenant_id === tenantId && row.alias === alias);
}

/** La revisión de un snapshot recién leído, para poder decirle al operador cuál es la buena. */
function revisionDe(snapshot: ConfigurationSnapshot | undefined): string {
  return typeof snapshot?.revision === 'number' ? String(snapshot.revision) : 'sin dato';
}

export interface RoleBriefTabProps {
  tenantId: string;
  alias: string;
  /**
   * El borrador vive FUERA de este componente (ver `AgentDrawer`): cambiar de pestaña dentro del
   * mismo cajón lo desmonta, y perder ahí lo que el operador venía redactando —sin avisar— era
   * uno de los defectos. `undefined` significa «no hay borrador», que no es lo mismo que «hay un
   * borrador vacío»: lo segundo es querer dejar al alias sin rol.
   */
  borrador?: string;
  onBorrador: (texto: string | undefined) => void;
}

type TonoAviso = 'success' | 'error' | 'parcial';

export function RoleBriefTab({ tenantId, alias, borrador, onBorrador }: RoleBriefTabProps) {
  const api = useApi();
  // Perezoso por construcción: el snapshot de configuración sólo se pide cuando esta pestaña se
  // abre, igual que `/v3/status` en la pestaña «Conexión». El mapa se refresca cada cuatro
  // segundos y no debe arrastrar un fetch más por cada latido.
  const config = useResource('drawer-config', () => api.getConfiguration());
  const access = useResource('console-access', () => api.getConsoleAccess());
  const [busy, setBusy] = useState(false);
  const [aviso, setAviso] = useState<{ text: string; tone: TonoAviso }>();

  const permiso = permissionState(access.data, 'config.write');
  // Con el permiso `unknown` -no se pudo leer el RBAC- el editor queda HABILITADO: ante la duda no
  // se le quita nada a nadie, y el servidor rechaza igual si no corresponde. Mismo criterio que
  // `configNavAvailability`, y por lo mismo se DESHABILITA en vez de esconder: un editor ausente
  // no distingue «no tengo permiso» de «esto no existe».
  const soloLectura = permiso === 'denied';

  const fila = filaDelAgente(config.data?.agents, tenantId, alias);
  const guardado = typeof fila?.role_brief === 'string' ? fila.role_brief : '';
  const texto = borrador ?? guardado;
  const largo = contarRoleBrief(texto);
  const tono = tonoRoleBrief(largo);
  // Ver `bloqueoPorRuntimeDesplegado`: es una guarda con fecha de retiro, no una regla del producto.
  const bloqueoRuntime = bloqueoPorRuntimeDesplegado(texto);
  const sucio = texto !== guardado;

  // El verde «Rol guardado en la revisión N» habla del texto que se envió. En cuanto el operador
  // vuelve a escribir, ese cartel pasa a estar encima de OTRO texto —uno que nadie guardó— y se
  // convierte en una afirmación falsa: se retira solo. El rojo no se toca: el rechazo del
  // servidor sigue siendo cierto mientras el operador corrige.
  useEffect(() => {
    if (sucio) setAviso((actual) => (actual?.tone === 'success' ? undefined : actual));
  }, [sucio]);

  if (config.loading && !config.data) {
    return <p className="muted">Leyendo el rol declarado desde la configuración versionada…</p>;
  }
  if (config.error && !config.data) {
    return (
      <EmptyState>
        No se pudo leer la configuración, así que el rol de este alias es un dato que no tenemos —no «vacío»—:
        {' '}{config.error.message}
      </EmptyState>
    );
  }
  if (!Array.isArray(config.data?.agents)) {
    return (
      <EmptyState>
        Este gateway no publica el registro de agentes, así que no hay rol que mostrar ni dónde
        escribirlo. Clave ausente no es lo mismo que lista vacía.
      </EmptyState>
    );
  }
  if (!fila) {
    return (
      <EmptyState>
        {alias} no está en el registro de agentes de {tenantId}: apareció por entregas o por lease.
        Un alias sin fila en el registro no tiene rol declarado que editar.
      </EmptyState>
    );
  }

  async function guardar() {
    setAviso(undefined);
    // La cadena vacía viaja tal cual: el store la convierte en NULL porque el CHECK exige longitud
    // >= 1, y NULL es lo que hace que el adaptador OMITA la línea «Tu rol:» en vez de anteponer una
    // vacía. Mandar `null` desde acá diría lo mismo, pero dejaría al operador sin ver qué se envió.
    const mutation: ConfigMutation = {
      resource: 'agent',
      action: 'update',
      tenant_id: tenantId,
      alias,
      value: { role_brief: texto },
    };
    setBusy(true);
    try {
      const revision = typeof config.data?.revision === 'number' ? config.data.revision : undefined;
      const result = await api.changeConfiguration(mutation, {
        dryRun: false,
        ...(revision === undefined ? {} : { expectedRevision: revision }),
      });
      // El 201 dice que el servidor lo aceptó, no que la pantalla esté mostrando lo aceptado. Se
      // espera la relectura ANTES de soltar el borrador: si se soltara acá, el textarea volvería
      // al valor viejo del snapshot y el cartel verde quedaría encima del texto anterior.
      const recarga: RecargaResultado<ConfigurationSnapshot> = await config.reload();
      if (recarga.error) {
        setAviso({
          tone: 'parcial',
          text: `Guardé el rol en la revisión ${result.revision ?? 'una revisión que el servidor no informó'}, pero NO pude releer la `
            + `configuración (${recarga.error.message}): lo que ves es lo que envié, no lo que el `
            + 'servidor tiene. El borrador se conserva; volvé a abrir esta pestaña cuando la lectura funcione.',
        });
        return;
      }
      onBorrador(undefined);
      setAviso({
        tone: 'success',
        text: `Rol guardado en la revisión ${result.revision ?? 'una revisión que el servidor no informó'} y releído del servidor: esto es lo `
          + 'que hay en la base. Se puede deshacer desde el audit trail de Configuración.',
      });
    } catch (error) {
      // Un botón que no dice nada al fallar es peor que no tenerlo: el operador cree que guardó y
      // el alias sigue con el rol viejo. El mensaje del servidor se muestra entero.
      const descripcion = describeConfigError(error, 'El servidor rechazó el guardado y no dijo por qué');
      if (!descripcion.conflict) {
        setAviso({ tone: 'error', text: descripcion.message });
        return;
      }
      // Choque optimista: otro operador movió la configuración. Sin recargar DE VERDAD —y sin
      // esperarla— la revisión de esta pestaña queda congelada y cada reintento vuelve a mandar la
      // misma revisión vencida: un bucle del que el operador no puede salir. Por eso se relee, se
      // espera el dato, y recién entonces se le dice que reintente.
      const crudo = error instanceof Error ? error.message : 'el servidor no dijo por qué';
      const recarga: RecargaResultado<ConfigurationSnapshot> = await config.reload();
      setAviso({
        tone: 'error',
        text: recarga.error
          ? `Conflicto de revisión (el servidor dijo: «${crudo}») y NO se aplicó nada. La relectura `
            + `TAMBIÉN falló (${recarga.error.message}), así que esta pestaña sigue con la revisión `
            + 'vencida y reintentar ahora volvería a chocar: recargá la consola antes de insistir.'
          : `Conflicto de revisión: otro operador cambió la configuración mientras escribías y NO se `
            + `aplicó nada (el servidor dijo: «${crudo}»). Ya releí el snapshot y esperé el dato: la `
            + `revisión buena es la ${revisionDe(recarga.data)}, tu texto sigue acá, revisalo y volvé a guardar.`,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="role-brief">
      <p className="muted">
        Es el preámbulo de identidad que el adaptador antepone al contrato de {alias} («Tu rol: …»).
        Se guarda por la mutación de configuración, con su inversa: NO es un UPDATE contra la base.
      </p>

      {/* `useResource` conserva el último dato bueno cuando una relectura falla, así que sin este
          cartel un GET caído no se notaba en ningún sitio: la pantalla seguía mostrando texto
          viejo con cara de actual. La guarda de más arriba sólo cubre el caso «nunca hubo dato». */}
      {config.error ? (
        <p className="notice error" role="alert">
          La última relectura de la configuración falló ({config.error.message}), así que lo que ves
          es la ÚLTIMA lectura buena, no lo que el servidor tiene ahora.
        </p>
      ) : null}

      <label className="role-brief-field">
        <span>Rol declarado</span>
        <textarea
          aria-label={`Rol declarado de ${alias}`}
          rows={14}
          value={texto}
          readOnly={soloLectura}
          spellCheck={false}
          onChange={(event) => onBorrador(event.target.value)}
        />
      </label>

      <div className="role-brief-meter">
        {/* El contador es texto normal a propósito. Tenía `role="status"` y eso hacía que el lector
            de pantalla cantara el número en CADA tecla, tapando justo el aviso que importa. */}
        <span className="role-brief-count" data-tone={tono}>
          {largo} / {ROLE_BRIEF_MAX}
        </span>
        {/* La región viva es ESTA, y está siempre en el DOM aunque esté vacía: un `role="status"`
            que aparece y desaparece se anuncia de forma desigual según el lector. Quien no ve el
            color es justamente quien más necesita enterarse de que el alias se va a quedar sordo. */}
        <span className="role-brief-warn" role="status">
          {bloqueoRuntime !== undefined
            ? <span className="role-brief-warn" data-motivo="utf16">{bloqueoRuntime}</span>
            : null}
          {tono === 'pasado'
            ? `Pasado del tope por ${largo - ROLE_BRIEF_MAX}: guardado bloqueado. Un rol de más de `
              + `${ROLE_BRIEF_MAX} caracteres deja al alias SORDO sin dar ningún error.`
            : tono === 'cerca'
              ? `Quedan ${ROLE_BRIEF_MAX - largo} caracteres. Pasado el tope el alias deja de recibir, `
                + 'y no lo avisa nadie más que este contador.'
              : ''}
        </span>
      </div>

      {soloLectura ? (
        <p className="notice" role="note">
          Solo lectura: {CONFIG_SIN_CONTROL_REASON} El texto se muestra igual —esconderlo no
          distinguiría «no tengo permiso» de «este alias no tiene rol».
        </p>
      ) : (
        <div className="role-brief-actions">
          <button
            type="button"
            className="button primary"
            disabled={busy || tono === 'pasado' || bloqueoRuntime !== undefined || !sucio}
            onClick={() => void guardar()}
          >
            <Save size={15} aria-hidden="true" /> Guardar el rol
          </button>
          {sucio ? (
            <button type="button" className="button small secondary" disabled={busy} onClick={() => onBorrador(undefined)}>
              Descartar los cambios
            </button>
          ) : null}
        </div>
      )}

      {aviso ? (
        <p
          className={aviso.tone === 'success' ? 'notice success' : aviso.tone === 'parcial' ? 'notice parcial' : 'notice error'}
          role={aviso.tone === 'success' ? 'status' : 'alert'}
        >
          {aviso.text}
        </p>
      ) : null}

      {/*
       * El diario va DEBAJO del editor y plegado, no en una pestaña aparte: deshacer un cambio
       * termina en el textarea de arriba, y mandar al operador a otra vista para volver con un
       * texto en la mano es el mismo defecto que se corrigió trayendo el rol a este cajón.
       *
       * Plegado porque el gesto normal es escribir, no auditar; abierto ocuparía más que el propio
       * editor y empujaría el botón de guardar fuera de la vista.
       */}
      <details className="historial-rol-caja">
        <summary>Historial y vuelta atrás</summary>
        <HistorialRol
          tenantId={tenantId}
          alias={alias}
          soloLectura={soloLectura}
          onRestaurar={(restaurado) => onBorrador(restaurado)}
        />
      </details>
    </div>
  );
}
