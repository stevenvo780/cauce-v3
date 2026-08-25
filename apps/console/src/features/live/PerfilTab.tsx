import { Save } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useApi } from '../../api/context';
import type { AgentPerfil, AgentPerfilCampos, ConfigurationSnapshot } from '../../api/types';
import { useResource, type RecargaResultado } from '../../api/use-resource';
import { EmptyState } from '../../components/ui';
import { permissionState } from '../../lib';
import { describeConfigError } from '../config/config-change';
import {
  CAMPOS_DE_LISTA, CAMPOS_DE_TEXTO, ETIQUETAS, camposQueNoEntran, camposVigentes, contarUnidades,
  hayCambios, lineasALista, listaALineas, mutacionDePerfil, perfilYaExiste, unidadesDelPerfil,
} from './perfil';

/**
 * EL PERFIL DEL ALIAS: se escribe acá y termina dentro del fichero que su arnés LEE.
 *
 * ── Qué venía fallando ───────────────────────────────────────────────────────────────────────
 *
 * La consola dejaba editar ocho campos del alias y sólo UNO —`role_brief`— tenía un lector real en
 * la ejecución. Los otros siete se guardaban en la base y no llegaban a ningún sitio: el operador
 * escribía, la pantalla decía «guardado», y el agente seguía sin enterarse. Sin un error por
 * ningún lado, que es lo que lo hizo durar meses.
 *
 * Esta pestaña cierra el lazo entero y lo enseña: a la izquierda los siete campos autorados, a la
 * derecha EL TEXTO EXACTO que va a quedar en cada fichero —`CLAUDE.md` para Claude Code,
 * `AGENTS.md` para codex, los siete Markdown del espacio de trabajo para openclaw—, compuesto por
 * la MISMA función que usa el adaptador para escribirlo dentro del contenedor.
 *
 * ── La regla de la pantalla ──────────────────────────────────────────────────────────────────
 *
 * Acá no se afirma nada que no se haya comprobado. La vista previa dice de qué está compuesta
 * (`base`), los ficheros del agente dicen que no se tocan, y el cartel verde sólo aparece después
 * de releer del servidor. Cuando algo no se pudo comprobar, se dice con esas palabras.
 */

type TonoAviso = 'success' | 'error' | 'parcial';

export interface PerfilTabProps {
  tenantId: string;
  alias: string;
  /**
   * El borrador vive FUERA de este componente, igual que el del rol: cambiar de pestaña dentro
   * del mismo cajón lo desmonta, y perder ahí lo que el operador venía redactando —sin avisar—
   * ya fue un defecto una vez.
   */
  borrador?: Partial<AgentPerfilCampos>;
  onBorrador: (campos: Partial<AgentPerfilCampos> | undefined) => void;
}

export function PerfilTab({ tenantId, alias, borrador, onBorrador }: PerfilTabProps) {
  const api = useApi();
  const perfil = useResource(`perfil-${tenantId}-${alias}`, () => api.getAgentPerfil(alias));
  const config = useResource('drawer-config', () => api.getConfiguration());
  const access = useResource('console-access', () => api.getConsoleAccess());
  const [busy, setBusy] = useState(false);
  const [aviso, setAviso] = useState<{ text: string; tone: TonoAviso }>();
  const [ficheroAbierto, setFicheroAbierto] = useState<string>();

  const soloLectura = permissionState(access.data, 'config.write') === 'denied';
  const campos = camposVigentes(perfil.data, borrador);
  const sucio = hayCambios(perfil.data, campos);
  const fuera = camposQueNoEntran(campos, perfil.data?.limites);
  const total = unidadesDelPerfil(campos);

  // El verde habla del texto que se envió. En cuanto el operador vuelve a escribir, ese cartel
  // pasa a estar encima de OTRO texto —uno que nadie guardó— y se convierte en una afirmación
  // falsa: se retira solo. El rojo no se toca: el rechazo sigue siendo cierto mientras se corrige.
  useEffect(() => {
    if (sucio) setAviso((actual) => (actual?.tone === 'success' ? undefined : actual));
  }, [sucio]);

  if (perfil.loading && !perfil.data) {
    return <p className="muted">Leyendo el perfil del alias y componiendo sus ficheros…</p>;
  }
  if (perfil.error && !perfil.data) {
    return (
      <EmptyState>
        No se pudo leer el perfil, así que lo que tiene este alias es un dato que no tenemos —no
        «vacío»—: {perfil.error.message}
      </EmptyState>
    );
  }
  if (perfil.data && !perfil.data.publicado) {
    return <EmptyState>{perfil.data.motivo ?? 'Este gateway no publica el perfil de los alias.'}</EmptyState>;
  }

  function editarTexto(campo: (typeof CAMPOS_DE_TEXTO)[number], valor: string) {
    onBorrador({ ...borrador, [campo]: valor });
  }

  function editarLista(campo: (typeof CAMPOS_DE_LISTA)[number], texto: string) {
    onBorrador({ ...borrador, [campo]: lineasALista(texto) });
  }

  async function guardar() {
    setAviso(undefined);
    setBusy(true);
    try {
      const revision = typeof config.data?.revision === 'number' ? config.data.revision : undefined;
      const mutation = mutacionDePerfil(tenantId, alias, campos, perfilYaExiste(perfil.data));
      const result = await api.changeConfiguration(mutation, {
        dryRun: false,
        ...(revision === undefined ? {} : { expectedRevision: revision }),
      });
      /*
       * El 201 dice que el servidor lo aceptó, no que la pantalla esté enseñando lo aceptado. Se
       * espera la relectura ANTES de soltar el borrador: si se soltara acá, las cajas volverían al
       * valor viejo y el cartel verde quedaría encima del texto anterior. Y se relee el PERFIL,
       * que es donde vive la vista previa recompuesta — releer sólo la configuración dejaría los
       * ficheros de la derecha mostrando el texto de antes de guardar.
       */
      const recarga: RecargaResultado<AgentPerfil> = await perfil.reload();
      await config.reload();
      if (recarga.error) {
        setAviso({
          tone: 'parcial',
          text: `Guardé el perfil en la revisión ${result.revision ?? 'una revisión que el servidor no informó'}, pero NO pude releerlo `
            + `(${recarga.error.message}): lo que ves es lo que envié, no lo que el servidor tiene. `
            + 'El borrador se conserva; volvé a abrir esta pestaña cuando la lectura funcione.',
        });
        return;
      }
      onBorrador(undefined);
      setAviso({
        tone: 'success',
        text: `Perfil guardado en la revisión ${result.revision ?? 'una revisión que el servidor no informó'} y releído del servidor: los `
          + 'ficheros de la derecha son los que se van a escribir. Se puede deshacer desde el audit '
          + 'trail de Configuración.',
      });
    } catch (error) {
      const descripcion = describeConfigError(error, 'El servidor rechazó el guardado y no dijo por qué');
      if (!descripcion.conflict) {
        setAviso({ tone: 'error', text: descripcion.message });
        return;
      }
      const crudo = error instanceof Error ? error.message : 'el servidor no dijo por qué';
      const recarga: RecargaResultado<ConfigurationSnapshot> = await config.reload();
      setAviso({
        tone: 'error',
        text: recarga.error
          ? `Conflicto de revisión (el servidor dijo: «${crudo}») y NO se aplicó nada. La relectura `
            + `TAMBIÉN falló (${recarga.error.message}), así que esta pestaña sigue con una revisión `
            + 'vencida: recargá la página antes de reintentar.'
          : `Conflicto de revisión y NO se aplicó nada: otro operador movió la configuración. Ya `
            + `releí (revisión ${typeof recarga.data?.revision === 'number' ? recarga.data.revision : 'sin dato'}); revisá lo que escribiste y reintentá.`,
      });
    } finally {
      setBusy(false);
    }
  }

  const ficheros = perfil.data?.ficheros ?? [];
  const abierto = ficheros.find((f) => f.nombre === ficheroAbierto) ?? ficheros[0];

  return (
    <div className="perfil-tab">
      <section className="perfil-editor">
        <header className="perfil-cabecera">
          <div>
            <h4>Perfil de {alias}</h4>
            <p className="muted perfil-ayuda">
              Esto es lo FIJO del alias y va a su fichero de arnés, no al sobre de cada mensaje.
              Entre turnos sólo debería viajar lo que fluctúa.
            </p>
          </div>
          <p className={`perfil-medida${fuera.length > 0 ? ' perfil-medida-fuera' : ''}`}>
            {total.toLocaleString('es')} / {(perfil.data?.limites?.total ?? 0).toLocaleString('es')} unidades
          </p>
        </header>

        {CAMPOS_DE_TEXTO.map((campo) => {
          const valor = campos[campo];
          const tope = campo === 'role_summary'
            ? perfil.data?.limites?.role_summary
            : perfil.data?.limites?.purpose;
          const medido = contarUnidades(valor);
          return (
            <label key={campo} className="perfil-campo">
              <span className="perfil-campo-titulo">{ETIQUETAS[campo].titulo}</span>
              <span className="muted perfil-campo-ayuda">
                {ETIQUETAS[campo].ayuda} <em>→ {ETIQUETAS[campo].destino}</em>
              </span>
              <textarea
                value={valor}
                rows={campo === 'purpose' ? 4 : 3}
                disabled={soloLectura || busy}
                onChange={(event) => editarTexto(campo, event.target.value)}
              />
              <span className={`perfil-cuenta${tope !== undefined && medido > tope ? ' perfil-cuenta-fuera' : ''}`}>
                {medido} / {tope ?? '—'}
              </span>
            </label>
          );
        })}

        {CAMPOS_DE_LISTA.map((campo) => {
          const items = campos[campo];
          return (
            <label key={campo} className="perfil-campo">
              <span className="perfil-campo-titulo">{ETIQUETAS[campo].titulo}</span>
              <span className="muted perfil-campo-ayuda">
                {ETIQUETAS[campo].ayuda} <em>→ {ETIQUETAS[campo].destino}</em>
              </span>
              <textarea
                value={listaALineas(items)}
                rows={4}
                disabled={soloLectura || busy}
                onChange={(event) => editarLista(campo, event.target.value)}
              />
              <span className={`perfil-cuenta${items.length > (perfil.data?.limites?.items ?? Infinity) ? ' perfil-cuenta-fuera' : ''}`}>
                {items.length} {items.length === 1 ? 'entrada' : 'entradas'} / {perfil.data?.limites?.items ?? '—'}
              </span>
            </label>
          );
        })}

        {fuera.length > 0 ? (
          <ul className="perfil-fuera" role="alert">
            {fuera.map((problema) => (
              <li key={problema.campo}>
                {problema.campo}: {problema.medido.toLocaleString('es')} unidades, el tope es{' '}
                {problema.tope.toLocaleString('es')}.
              </li>
            ))}
          </ul>
        ) : null}

        {aviso ? <p className={`perfil-aviso perfil-aviso-${aviso.tone}`} role="status">{aviso.text}</p> : null}

        <button
          type="button"
          className="button primary"
          disabled={soloLectura || busy || !sucio || fuera.length > 0}
          onClick={() => { void guardar(); }}
        >
          <Save size={16} aria-hidden />
          {busy ? 'Guardando…' : 'Guardar perfil'}
        </button>
        {soloLectura ? (
          <p className="muted">Tu sesión no tiene permiso de escritura en configuración.</p>
        ) : null}
      </section>

      <section className="perfil-vista-previa">
        <header>
          <h4>Lo que se va a escribir</h4>
          <p className="muted perfil-ayuda">
            {perfil.data?.harness
              ? `Arnés medido: ${perfil.data.harness}.`
              : 'El registro no dice qué arnés corre este alias.'}
            {' '}
            {perfil.data?.base === 'fichero-vacio'
              ? 'Compuesto sobre fichero vacío: el gateway no lee el disco del contenedor, así que lo '
                + 'que una persona haya escrito a mano NO aparece acá — sigue en el fichero y no se toca.'
              : null}
          </p>
        </header>

        {perfil.data?.aviso ? <EmptyState>{perfil.data.aviso}</EmptyState> : null}

        {ficheros.length > 0 ? (
          <>
            <div className="perfil-ficheros" role="tablist" aria-label="Ficheros del arnés">
              {ficheros.map((fichero) => (
                <button
                  key={fichero.nombre}
                  type="button"
                  role="tab"
                  aria-selected={abierto?.nombre === fichero.nombre}
                  className="perfil-fichero-tab"
                  onClick={() => setFicheroAbierto(fichero.nombre)}
                >
                  {fichero.nombre}
                  {fichero.politica === 'solo-si-falta' ? <span className="perfil-del-agente"> · del agente</span> : null}
                </button>
              ))}
            </div>
            {abierto ? (
              <div className="perfil-fichero-cuerpo" role="tabpanel">
                {abierto.politica === 'solo-si-falta' ? (
                  <p className="muted">
                    {abierto.nombre} es del agente: lo escribe él. Si ya existe NO se toca ni para
                    fusionar un bloque nuestro; si falta se crea vacío.
                  </p>
                ) : null}
                <pre className="perfil-fichero-texto">{abierto.texto || '(este fichero queda sin bloque: no hay nada declarado que le toque)'}</pre>
                <p className="muted">{abierto.unidades.toLocaleString('es')} unidades</p>
              </div>
            ) : null}
          </>
        ) : null}
      </section>
    </div>
  );
}
