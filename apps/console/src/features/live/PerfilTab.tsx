import { Save } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ApiError } from '../../api/client';
import { useApi } from '../../api/context';
import type { AgentPerfil, AgentPerfilCampos } from '../../api/types';
import { useResource, type RecargaResultado } from '../../api/use-resource';
import { EmptyState } from '../../components/ui';
import { permissionState } from '../../lib';
import {
  CAMPOS_DE_LISTA, CAMPOS_DE_TEXTO, ETIQUETAS, camposQueNoEntran, camposVigentes, contarUnidades,
  esPerfilAplicado, hayCambios, lineasALista, listaALineas, perfilParaGuardar, unidadesDelPerfil,
} from './perfil';

/**
 * Editor y previsualización de perfil y campos de directiva del agente.
 */

type TonoAviso = 'error' | 'parcial' | 'success';

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
  const perfil = useResource(
    `perfil-${tenantId}-${alias}`, () => api.getAgentPerfil(tenantId, alias),
  );
  const access = useResource('console-access', () => api.getConsoleAccess());
  const [busy, setBusy] = useState(false);
  const [aviso, setAviso] = useState<{ text: string; tone: TonoAviso }>();
  const [ficheroAbierto, setFicheroAbierto] = useState<string>();

  const estadoPermiso = permissionState(access.data, 'config.write');
  // Ausencia, error o respuesta vieja del endpoint de acceso nunca habilitan una mutación.
  const soloLectura = estadoPermiso !== 'allowed';
  const campos = camposVigentes(perfil.data, borrador);
  const sucio = hayCambios(perfil.data, campos);
  const fuera = camposQueNoEntran(campos, perfil.data?.limites);
  const total = unidadesDelPerfil(campos);
  const presenciaConocida = typeof perfil.data?.exists === 'boolean';
  const agenteHabilitado = perfil.data?.agent_enabled === true;
  const revisionCoherente = perfil.data?.exists === false
    ? perfil.data.revision === null
    : perfil.data?.exists === true
      && typeof perfil.data.revision === 'number'
      && Number.isSafeInteger(perfil.data.revision)
      && perfil.data.revision > 0;
  const estadoConocido = perfil.data?.runtime_state === 'absent'
    || perfil.data?.runtime_state === 'pending'
    || perfil.data?.runtime_state === 'applied'
    || perfil.data?.runtime_state === 'disabled'
    || perfil.data?.runtime_state === 'drifted'
    || perfil.data?.runtime_state === 'pending_session_refresh'
    || perfil.data?.runtime_state === 'runtime_unverified';
  const runtimeActual = perfil.data?.runtime_state !== 'applied'
    || (perfil.data.runtime_verification?.state === 'current'
      && perfil.data.runtime_adoption?.evidence === 'adapter_delivery'
      && perfil.data.runtime_adoption.revision === perfil.data.revision
      && perfil.data.runtime_adoption.generation === perfil.data.runtime_verification.generation);
  const pendiente = perfil.data?.runtime_state === 'pending'
    || perfil.data?.runtime_state === 'drifted';
  const runtimeNoVerificado = perfil.data?.runtime_state === 'runtime_unverified';
  const ficheros = perfil.data?.ficheros ?? [];
  const aplicable = ficheros.length > 0;

  // El estado de persistencia habla del texto anterior. En cuanto se vuelve a editar, ya no
  // describe el borrador visible y se retira. El rojo se conserva: el rechazo sigue siendo cierto.
  useEffect(() => {
    if (sucio) setAviso((actual) => (actual?.tone === 'error' ? actual : undefined));
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
    if (estadoPermiso !== 'allowed') {
      setAviso({
        tone: 'error',
        text: 'No se acreditó config.write para esta sesión. No se envió ninguna mutación.',
      });
      return;
    }
    if (!presenciaConocida || !revisionCoherente || !estadoConocido || !runtimeActual) {
      setAviso({
        tone: 'error',
        text: 'Este gateway no informó de forma coherente la presencia, revisión y estado '
          + 'desired/applied del perfil. No guardé: sin ese CAS podría pisar una edición ajena.',
      });
      return;
    }
    if (!agenteHabilitado) {
      setAviso({
        tone: 'error',
        text: 'El alias está apagado o su estado no fue acreditado. No se cambia el desired sin '
          + 'un runtime habilitado que pueda aplicar y responder el lote.',
      });
      return;
    }
    if (!aplicable) {
      setAviso({
        tone: 'error',
        text: 'No hay ficheros gobernados acreditables para este arnés. No guardé un desired que '
          + 'la consola no podría demostrar como aplicado.',
      });
      return;
    }
    setAviso(undefined);
    setBusy(true);
    try {
      const expectedRevision = perfil.data?.exists === true ? perfil.data.revision as number : null;
      const result = await api.putAgentPerfil(
        tenantId, alias, perfilParaGuardar(campos), expectedRevision,
      );
      if (result && typeof result === 'object' && 'state' in result
        && result.state === 'pending_session_refresh') {
        setAviso({
          tone: 'parcial',
          text: 'Desired y ficheros del runtime quedaron actualizados, pero la sesión compartida '
            + 'todavía no acreditó recibir esa revisión. No se presenta como aplicada.',
        });
        await perfil.reload();
        return;
      }
      const nombres = ficheros.map((fichero) => fichero.nombre);
      if (!esPerfilAplicado(result, { tenantId, alias, nombres })) {
        setAviso({
          tone: 'error',
          text: 'El servidor devolvió 2xx, pero no acreditó la misma revisión ni un SHA y número '
            + 'de bytes por cada fichero gobernado. El borrador sigue sucio; no se afirma aplicación.',
        });
        return;
      }

      // El ACK prueba el runtime; la relectura evita soltar el borrador sobre un snapshot viejo.
      const recarga: RecargaResultado<AgentPerfil> = await perfil.reload();
      if (recarga.error) {
        setAviso({
          tone: 'parcial',
          text: `El runtime acreditó la revisión ${result.revision}, pero no pude releer el perfil `
            + `(${recarga.error.message}). Conservo el borrador para no volver a mostrar un snapshot viejo.`,
        });
        return;
      }
      if (recarga.data.exists !== true || recarga.data.revision !== result.revision
        || recarga.data.applied_revision !== result.revision
        || recarga.data.runtime_state !== 'applied'
        || recarga.data.runtime_verification?.state !== 'current'
        || recarga.data.runtime_adoption?.evidence !== 'adapter_delivery'
        || recarga.data.runtime_adoption.revision !== result.revision
        || recarga.data.runtime_adoption.generation
          !== recarga.data.runtime_verification.generation) {
        setAviso({
          tone: 'parcial',
          text: `El runtime acreditó la revisión ${result.revision}, pero la relectura ya muestra `
            + `desired ${recarga.data.revision ?? 'ausente'} y aplicado ${recarga.data.applied_revision ?? 'ninguno'}. `
            + 'No limpio el borrador ni presento esa revisión más nueva como aplicada.',
        });
        return;
      }
      onBorrador(undefined);
      setAviso({
        tone: 'success',
        text: `Aplicado: desired y runtime acreditan la revisión ${result.revision}; `
          + `${result.acknowledgements.length} ficheros respondieron SHA y bytes.`,
      });
    } catch (error) {
      const crudo = error instanceof Error ? error.message : 'el servidor no dijo por qué';
      const status = error instanceof ApiError ? error.status : undefined;
      const recarga: RecargaResultado<AgentPerfil> = await perfil.reload();
      const relectura = recarga.data;
      const quedaPendiente = relectura?.runtime_state === 'pending';
      setAviso({
        tone: 'error',
        text: recarga.error
          ? `No hubo un 2xx aplicado (HTTP ${status ?? 'sin dato'}: ${crudo}) y tampoco pude `
            + `releer (${recarga.error.message}). El borrador se conserva; no se infiere si el desired avanzó.`
          : quedaPendiente
            ? `No hubo un 2xx aplicado (HTTP ${status ?? 'sin dato'}: ${crudo}). La relectura `
              + `muestra desired ${relectura.revision ?? 'ausente'} pendiente sobre aplicado `
              + `${relectura.applied_revision ?? 'ninguno'}; el borrador se conserva y podés reintentar el lote.`
            : `No hubo un 2xx aplicado (HTTP ${status ?? 'sin dato'}: ${crudo}). Releí desired `
              + `${relectura?.revision ?? 'ausente'} / aplicado ${relectura?.applied_revision ?? 'ninguno'}; `
              + 'el borrador se conserva.',
      });
    } finally {
      setBusy(false);
    }
  }

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
            {presenciaConocida ? (
              <p className="muted perfil-ayuda">
                {perfil.data?.exists
                  ? 'Hay una fila de perfil persistida, aunque su contenido pueda estar vacío.'
                  : 'Todavía no hay una fila de perfil persistida; el primer guardado será un alta.'}
              </p>
            ) : null}
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
                disabled={soloLectura || busy || !agenteHabilitado
                  || runtimeNoVerificado || !runtimeActual}
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
                disabled={soloLectura || busy || !agenteHabilitado
                  || runtimeNoVerificado || !runtimeActual}
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
        {perfil.data?.publicado && !agenteHabilitado ? (
          <p className="perfil-aviso perfil-aviso-error" role="alert">
            Alias apagado o estado de habilitación no acreditado: edición y aplicación bloqueadas.
          </p>
        ) : null}
        {perfil.data?.publicado && agenteHabilitado && perfil.data.runtime_state === 'pending' ? (
          <p className="perfil-aviso perfil-aviso-parcial" role="status">
            Desired revisión {perfil.data.revision ?? 'sin dato'} pendiente; el runtime sólo tiene
            acreditada la revisión {perfil.data.applied_revision ?? 'ninguna'}. La vista previa no
            se presenta como aplicada. Podés reintentar aunque el texto no haya cambiado.
          </p>
        ) : null}
        {perfil.data?.publicado && agenteHabilitado && perfil.data.runtime_state === 'drifted' ? (
          <p className="perfil-aviso perfil-aviso-error" role="alert">
            La base conserva la revisión {perfil.data.revision ?? 'sin dato'} como aplicada, pero
            los SHA medidos del runtime ya no coinciden. La vista no se presenta como aplicada;
            podés restaurar el lote canónico sin cambiar el borrador.
          </p>
        ) : null}
        {perfil.data?.publicado
          && agenteHabilitado && perfil.data.runtime_state === 'pending_session_refresh' ? (
          <p className="perfil-aviso perfil-aviso-parcial" role="status">
            Los ficheros ya coinciden con desired, pero la TUI compartida todavía no acreditó
            recibir el perfil en una entrega. Un ACK de escritura no se presenta como adopción.
          </p>
        ) : null}
        {perfil.data?.publicado && agenteHabilitado && runtimeNoVerificado ? (
          <p className="perfil-aviso perfil-aviso-error" role="alert">
            El runtime no publicó una generación acreditable. Edición y aplicación quedan
            bloqueadas: una igualdad de revisiones sin ruta, SHA y generación no prueba adopción.
          </p>
        ) : null}
        {perfil.data?.publicado
          && (!presenciaConocida || !revisionCoherente || !estadoConocido || !runtimeActual) ? (
          <p className="perfil-aviso perfil-aviso-error" role="alert">
            Este gateway no informa presencia, revisión y estado desired/applied de forma
            coherente. Guardado bloqueado para no perder concurrencia ni afirmar convergencia.
          </p>
        ) : null}
        {perfil.data?.publicado && agenteHabilitado && !aplicable ? (
          <p className="perfil-aviso perfil-aviso-error" role="alert">
            Este arnés no publica un conjunto de ficheros gobernados acreditable; no se puede
            confirmar una aplicación completa.
          </p>
        ) : null}

        <button
          type="button"
          className="button primary"
          disabled={soloLectura || busy || !presenciaConocida || !revisionCoherente
            || !estadoConocido || !runtimeActual || runtimeNoVerificado
            || !agenteHabilitado || !aplicable
            || (!sucio && !pendiente) || fuera.length > 0}
          onClick={() => { void guardar(); }}
        >
          <Save size={16} aria-hidden />
          {busy
            ? 'Aplicando…'
            : pendiente && !sucio
              ? 'Reintentar aplicación'
              : perfil.data?.runtime_state === 'pending_session_refresh' && !sucio
                ? 'Esperando adopción de sesión'
                : 'Guardar y aplicar perfil'}
        </button>
        {soloLectura ? (
          <p className="muted">
            {estadoPermiso === 'unknown'
              ? 'No se pudo acreditar el permiso de escritura; la edición queda bloqueada.'
              : 'Tu sesión no tiene permiso de escritura en configuración.'}
          </p>
        ) : null}
      </section>

      <section className="perfil-vista-previa">
        <header>
          <h4>Vista previa del desired</h4>
          <p className="muted perfil-ayuda">
            {perfil.data?.harness
              ? `${perfil.data.base === 'runtime-medido' ? 'Arnés medido' : 'Arnés declarado'}: ${perfil.data.harness}.`
              : 'El registro no dice qué arnés corre este alias.'}
            {' '}
            {perfil.data?.base === 'fichero-vacio'
              ? 'Compuesto sobre fichero vacío: el gateway no lee el disco del contenedor, así que lo '
                + 'que una persona haya escrito a mano NO aparece acá — sigue en el fichero y no se toca.'
              : null}
          </p>
          {pendiente ? (
            <p className="perfil-aviso perfil-aviso-parcial">
              Esta composición corresponde al desired pendiente; no describe el runtime aplicado.
            </p>
          ) : null}
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
