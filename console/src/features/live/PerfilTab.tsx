import { Save } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import { ContextoContaminadoError } from '../../api/client/agent-client';
import { useApi } from '../../api/context';
import type { AgentPerfil } from '../../api/types';
import { useResource, type RecargaResultado } from '../../api/use-resource';
import { EmptyState, ViewTabs } from '../../components/ui';
import type { PermissionState } from '../../lib';
import {
  DOCUMENT_REASON_MAX, DOCUMENT_REASON_MIN, explicarFalloDeMotivo, problemaDeMotivo,
} from './ficheros-motivo';
import { ProfileFields } from './ProfileFields';
import { AvisoDeContaminacion, RecargaDeContexto } from './RecargaDeContexto';
import { ContextReconciliation } from './ContextReconciliation';
import { ProfileStatus } from './ProfileStatus';
import { pendingProfileReceipt, profileIsAdopted } from './profile-save-receipt';
import { draftFields, draftRevisionConflict, editProfileDraft, profileMatchesDraft, type ProfileDraft, type ProfileOutcome, type ProfileSettlement } from './profile-draft';
import {
  CAMPOS_DE_LISTA, CAMPOS_DE_TEXTO, CONTAMINACION_ILEGIBLE, MENSAJES_DE_APLICACION,
  camposQueNoEntran, contaminacionDe,
  destinosDelArnes, esPerfilAplicado, hayCambios, lineasCrudas,
  motivoSinDestino,
  perfilParaGuardar, unidadesDelPerfil, veredictoVigente,
  type ContaminacionDeContexto,
} from './perfil';

/**
 * Editor and preview of the agent profile and directive fields.
 */

interface PerfilTabProps {
  tenantId: string;
  alias: string;
  /**
   * The draft lives OUTSIDE this component, like the role one: switching tabs within the same
   * drawer unmounts it, and losing there what the operator was drafting —without warning— was
   * already a defect once.
   */
  borrador?: ProfileDraft;
  onBorrador: (campos: ProfileDraft | undefined) => void;
  onMutationSettled?: () => void;
  onWriteInFlightChange?: (inFlight: boolean) => void;
  writeInFlight?: boolean;
  blockedByManualDraft?: boolean;
  runtimeRefreshRevision?: number;
  restauracion?: number;
  configWritePermission: PermissionState;
  outcome?: ProfileOutcome;
  onSettlement?: (settlement: ProfileSettlement) => void;
}

export function PerfilTab({
  tenantId, alias, borrador, onBorrador, onMutationSettled, onWriteInFlightChange,
  writeInFlight = false, blockedByManualDraft = false, runtimeRefreshRevision = 0,
  restauracion = 0, configWritePermission,
  outcome, onSettlement,
}: PerfilTabProps) {
  const api = useApi();
  const perfil = useResource(
    `perfil-${tenantId}-${alias}`, () => api.getAgentPerfil(tenantId, alias),
  );
  const [localBusy, setLocalBusy] = useState(false);
  const [aviso, setAviso] = useState<ProfileOutcome | undefined>(outcome);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setAviso(outcome); }, [outcome]);
  const [ficheroAbierto, setFicheroAbierto] = useState<string>();
  const [motivo, setMotivo] = useState('');
  const [veredicto, setVeredicto] = useState<ContaminacionDeContexto>();
  const idMotivo = useId();
  useEffect(() => { setMotivo(''); }, [restauracion]);

  const estadoPermiso = configWritePermission;
  // Absence, error or a stale response from the access endpoint never enable a mutation.
  const soloLectura = estadoPermiso !== 'allowed';
  const campos = draftFields(perfil.data, borrador);
  const revisionConflict = !localBusy && !writeInFlight && draftRevisionConflict(perfil.data, borrador);
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
    || profileIsAdopted(perfil.data);
  const pendiente = perfil.data?.runtime_state === 'pending'
    || perfil.data?.runtime_state === 'drifted';
  const runtimeNoVerificado = perfil.data?.runtime_state === 'runtime_unverified';
  const ficheros = perfil.data?.ficheros ?? [];
  const aplicable = ficheros.length > 0;
  const arnesConPerfil = ['claude', 'codex', 'openclaw', 'muse'].includes(perfil.data?.harness ?? '');
  const destinos = destinosDelArnes(perfil.data?.harness, ficheros);
  const sinDestino = motivoSinDestino(destinos);
  const busy = localBusy || writeInFlight;
  const problemaMotivo = problemaDeMotivo(motivo);
  const contaminacion = veredictoVigente(veredicto, contaminacionDe(perfil.data));
  const enCuarentena = contaminacion?.contaminated === true;
  const reconciliable = enCuarentena && contaminacion.findings.length > 0
    && contaminacion.findings.every((finding) => finding.reason === 'expectation_sha_mismatch')
    && ['claude', 'codex', 'openclaw'].includes(perfil.data?.harness ?? '');
  const recargable = perfil.data?.runtime_state === 'pending_session_refresh'
    || perfil.data?.runtime_state === 'drifted';

  // The persistence state speaks about the previous text. As soon as it is edited again, it no
  // longer describes the visible draft and is withdrawn. The red is kept: the rejection is still true.
  useEffect(() => {
    if (sucio) setAviso((actual) => (actual?.tone === 'error' ? actual : undefined));
  }, [sucio]);

  const reloadProfile = perfil.reload;
  useEffect(() => {
    if (runtimeRefreshRevision > 0) void reloadProfile();
  }, [reloadProfile, runtimeRefreshRevision]);

  useEffect(() => {
    if (borrador && !borrador.base && perfil.data?.publicado) {
      onBorrador(editProfileDraft(perfil.data, borrador, {}));
    }
  }, [borrador, perfil.data, onBorrador]);

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
    onBorrador(editProfileDraft(perfil.data, borrador, { [campo]: valor }));
  }

  function editarLista(campo: (typeof CAMPOS_DE_LISTA)[number], texto: string) {
    onBorrador(editProfileDraft(perfil.data, borrador, { [campo]: lineasCrudas(texto) }));
  }

  function settle(outcome: ProfileOutcome, next?: { draft: ProfileDraft | undefined }) {
    const draft = next ? next.draft : borrador;
    if (onSettlement) onSettlement({ expectedDraft: borrador, draft, outcome });
    else onBorrador(draft);
    if (mounted.current) setAviso(outcome);
  }

  async function readAfterMutation(): Promise<RecargaResultado<AgentPerfil>> {
    try {
      const data = await api.getAgentPerfil(tenantId, alias);
      if (mounted.current) {
        const displayed = await perfil.reload();
        if (displayed.data) return displayed;
      }
      return { data };
    } catch (error) {
      return { error: error instanceof Error ? error : new Error('No se pudo releer el perfil') };
    }
  }

  async function guardar() {
    if (busy || revisionConflict) return;
    if (blockedByManualDraft) {
      setAviso({
        tone: 'error',
        text: 'Hay un borrador sin guardar en el manual. Guardalo o descartalo antes de aplicar '
          + 'los campos canónicos; así su SHA base no queda obsoleto ni se pierde texto.',
      });
      return;
    }
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
    if (enCuarentena) {
      setAviso({
        tone: 'error',
        text: 'El contexto de este alias está en cuarentena: sus ficheros de gobierno contienen '
          + 'algo que no es suyo. No se envió ninguna escritura.',
      });
      return;
    }
    if (problemaMotivo !== undefined) {
      setAviso({
        tone: 'error',
        text: `${problemaMotivo} La fila de auditoría se escribe con ese texto, así que sin él no `
          + 'se manda nada.',
      });
      return;
    }
    setAviso(undefined);
    setLocalBusy(true);
    onWriteInFlightChange?.(true);
    try {
      const expectedRevision = borrador?.base?.revision
        ?? (borrador?.base ? null : perfil.data?.exists === true ? (perfil.data.revision ?? null) : null);
      const result = await api.putAgentPerfil(
        tenantId, alias, perfilParaGuardar(campos), expectedRevision, motivo.trim(),
      );
      if (result && typeof result === 'object' && 'state' in result
        && result.state === 'pending_session_refresh') {
        const receipt = pendingProfileReceipt(result, tenantId, alias, ficheros.map((file) => file.nombre));
        const refreshed = await readAfterMutation();
        if (receipt === undefined || refreshed.data?.revision !== receipt.revision
          || refreshed.data.runtime_verification?.state !== 'current'
          || refreshed.data.runtime_verification.generation !== receipt.generation
          || !profileMatchesDraft(refreshed.data, campos)) {
          settle({ tone: 'error', text: 'El servidor no acreditó el guardado completo del perfil pendiente. El borrador se conserva; no se afirma aplicación.' });
          return;
        }
        setMotivo('');
        settle({
          tone: 'parcial',
          text: 'Desired y ficheros del runtime quedaron actualizados, pero la sesión compartida '
            + 'todavía no acreditó recibir esa revisión. No se presenta como aplicada.',
        }, { draft: undefined });
        return;
      }
      const nombres = ficheros.map((fichero) => fichero.nombre);
      if (!esPerfilAplicado(result, { tenantId, alias, nombres })) {
        settle({
          tone: 'error',
          text: 'El servidor devolvió 2xx, pero no acreditó la misma revisión ni un SHA y número '
            + 'de bytes por cada fichero gobernado. El borrador sigue sucio; no se afirma aplicación.',
        });
        return;
      }

      // The ACK proves the runtime; the re-read avoids dropping the draft onto a stale snapshot.
      const recarga = await readAfterMutation();
      if (recarga.error) {
        settle({
          tone: 'parcial',
          text: `El runtime acreditó la revisión ${String(result.revision)}, pero no pude releer el perfil `
            + `(${recarga.error.message}). Conservo el borrador para no volver a mostrar un snapshot viejo.`,
        });
        return;
      }
      if (recarga.data.exists !== true || recarga.data.revision !== result.revision
        || !profileIsAdopted(recarga.data)) {
        settle({
          tone: 'parcial',
          text: `El runtime acreditó la revisión ${String(result.revision)}, pero la relectura ya muestra `
            + `desired ${String(recarga.data.revision ?? 'ausente')} y aplicado ${String(recarga.data.applied_revision ?? 'ninguno')}. `
            + 'No limpio el borrador ni presento esa revisión más nueva como aplicada.',
        });
        return;
      }
      setMotivo('');
      settle({
        tone: 'success',
        text: `Aplicado: desired y runtime acreditan la revisión ${String(result.revision)}; `
          + `${String(result.acknowledgements.length)} ficheros respondieron SHA y bytes.`,
      }, { draft: undefined });
    } catch (error) {
      const crudo = error instanceof Error ? error.message : 'el servidor no dijo por qué';
      const status = error instanceof ApiError ? error.status : undefined;
      const codigo = error instanceof ApiError ? error.code : undefined;
      if (error instanceof ContextoContaminadoError) {
        setVeredicto(contaminacionDe(error.cuerpo) ?? CONTAMINACION_ILEGIBLE);
        settle({
          tone: 'error',
          text: `${crudo} No se escribió nada: el borrador y el motivo se conservan.`,
        });
        return;
      }
      const delMotivo = codigo === 'invalid_reason' || codigo === 'writable_requires_attribution'
        ? explicarFalloDeMotivo(status, codigo, crudo)
        : undefined;
      if (delMotivo !== undefined) {
        settle({ tone: 'error', text: `${delMotivo.titulo}. ${delMotivo.detalle}` });
        return;
      }
      const recarga = await readAfterMutation();
      const relectura = recarga.data;
      const quedaPendiente = relectura?.runtime_state === 'pending';
      const preserved = relectura && quedaPendiente && profileMatchesDraft(relectura, campos)
        ? editProfileDraft(relectura, undefined, campos) : borrador;
      settle({
        tone: 'error',
        text: recarga.error
          ? `No hubo un 2xx aplicado (HTTP ${String(status ?? 'sin dato')}: ${crudo}) y tampoco pude `
            + `releer (${recarga.error.message}). El borrador se conserva; no se infiere si el desired avanzó.`
          : quedaPendiente
            ? `No hubo un 2xx aplicado (HTTP ${String(status ?? 'sin dato')}: ${crudo}). La relectura `
              + `muestra desired ${String(relectura.revision ?? 'ausente')} pendiente sobre aplicado `
              + `${String(relectura.applied_revision ?? 'ninguno')}; el borrador se conserva y podés reintentar el lote.`
            : `No hubo un 2xx aplicado (HTTP ${String(status ?? 'sin dato')}: ${crudo}). Releí desired `
              + `${String(relectura?.revision ?? 'ausente')} / aplicado ${String(relectura?.applied_revision ?? 'ninguno')}; `
              + 'el borrador se conserva.',
      }, { draft: preserved });
    } finally {
      setLocalBusy(false);
      onMutationSettled?.();
      onWriteInFlightChange?.(false);
    }
  }

  const abierto = ficheros.find((f) => f.nombre === ficheroAbierto) ?? ficheros[0];

  return (
    <div className="perfil-tab">
      <ProfileStatus profile={perfil.data} />
      <section className="perfil-editor">
        <header className="perfil-cabecera">
          <div>
            <h4>Campos canónicos de {alias}</h4>
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

        {sinDestino === undefined ? null : (
          <p className="perfil-aviso perfil-aviso-parcial perfil-sin-destino" role="status">
            Ningún campo tiene un fichero de destino que se pueda nombrar. {sinDestino}
          </p>
        )}

        <ProfileFields
          fields={campos} destinations={destinos} limits={perfil.data?.limites}
          disabled={soloLectura || busy || !agenteHabilitado
            || !arnesConPerfil || runtimeNoVerificado || !runtimeActual}
          onTextChange={editarTexto} onListChange={editarLista}
        />

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
        {revisionConflict ? (
          <div className="perfil-conflict" role="alert">
            <strong>El perfil cambió mientras editabas.</strong>
            <p>Tu borrador conserva la revisión {String(borrador?.base?.revision ?? 'ausente')}. La lectura actual es {String(perfil.data?.revision ?? 'ausente')}. No se usa una revisión nueva para sobrescribirlo.</p>
            <details><summary>Comparar con el perfil guardado</summary>
              <pre>{JSON.stringify(perfil.data?.perfil, null, 2)}</pre>
            </details>
          </div>
        ) : null}
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
            <strong>Sesión sin adoptar todavía:</strong>{' '}
            {MENSAJES_DE_APLICACION.pending_session_refresh} Un ACK de escritura no se presenta
            como adopción.
          </p>
        ) : null}
        {perfil.data?.publicado && agenteHabilitado && recargable ? (
          <RecargaDeContexto
            tenantId={tenantId}
            alias={alias}
            permitida={!soloLectura}
            enCuarentena={enCuarentena}
            editorBlocked={busy || sucio || blockedByManualDraft}
            onWriteInFlightChange={onWriteInFlightChange}
            onVeredicto={setVeredicto}
            onRecargado={() => { void perfil.reload(); onMutationSettled?.(); }}
          />
        ) : null}
        {contaminacion?.contaminated === true
          ? <AvisoDeContaminacion contaminacion={contaminacion} />
          : null}
        {reconciliable && perfil.data?.publicado && agenteHabilitado && revisionCoherente
          && typeof perfil.data.revision === 'number' ? (
          <ContextReconciliation
            key={`${tenantId}/${alias}/${String(perfil.data.revision)}`}
            tenantId={tenantId} alias={alias} revision={perfil.data.revision}
            documents={ficheros.filter((document) => document.politica === 'bloque-gestionado')
              .map((document) => document.nombre)}
            permitida={!soloLectura} bloqueada={busy || sucio || blockedByManualDraft}
            onVeredicto={setVeredicto} onWriteInFlightChange={onWriteInFlightChange}
            onSettled={() => { void perfil.reload(); onMutationSettled?.(); }}
          />
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
        {blockedByManualDraft ? (
          <p className="perfil-aviso perfil-aviso-parcial" role="status">
            Hay un borrador manual pendiente. Guardalo o descartalo antes de aplicar estos campos;
            el perfil cambia el mismo fichero y volvería obsoleta su huella CAS.
          </p>
        ) : null}

        <label className="perfil-motivo" htmlFor={idMotivo}>
          Motivo de este cambio de perfil (lo escribe una persona y queda en la auditoría)
          <input
            id={idMotivo}
            type="text"
            value={motivo}
            maxLength={DOCUMENT_REASON_MAX}
            autoComplete="off"
            spellCheck={false}
            placeholder="Motivo del cambio, escrito a mano…"
            aria-describedby={`${idMotivo}-pista`}
            disabled={soloLectura || busy || enCuarentena || !agenteHabilitado}
            onChange={(event) => { setMotivo(event.target.value); }}
          />
        </label>
        <p className="perfil-razon" id={`${idMotivo}-pista`}>
          {motivo.length === 0
            ? `Hace falta un motivo escrito a mano: sin él no se guarda (mínimo `
              + `${String(DOCUMENT_REASON_MIN)}, máximo ${String(DOCUMENT_REASON_MAX)}).`
            : problemaMotivo
              ?? `Motivo válido · ${String(motivo.trim().length)}/${String(DOCUMENT_REASON_MAX)}`}
        </p>

        <button
          type="button"
          className="button primary"
          disabled={soloLectura || busy || revisionConflict || !presenciaConocida || !revisionCoherente
            || !estadoConocido || !runtimeActual || runtimeNoVerificado
            || !agenteHabilitado || !aplicable || enCuarentena || problemaMotivo !== undefined
            || blockedByManualDraft || (!sucio && !pendiente) || fuera.length > 0}
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
        <button
          type="button" className="button secondary"
          disabled={busy || blockedByManualDraft || (!borrador && !perfil.error)}
          onClick={() => {
            onBorrador(undefined);
            setMotivo('');
            setAviso(undefined);
            void perfil.reload();
          }}
        >Descartar borrador de perfil y releer</button>
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
          {sucio ? <p className="perfil-aviso perfil-aviso-parcial">Esta composición corresponde al perfil guardado. El borrador aún no se ha guardado ni proyectado.</p> : null}
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
            <ViewTabs
              tabs={ficheros.map((fichero) => ({
                id: fichero.nombre,
                label: (
                  <>
                    {fichero.nombre}
                    {fichero.politica === 'solo-si-falta' ? <span className="perfil-del-agente"> · del agente</span> : null}
                  </>
                ),
              }))}
              active={abierto.nombre}
              onSelect={setFicheroAbierto}
              label="Ficheros del arnés"
              variant="chip"
              panelId="perfil-fichero-panel"
            />
            <div
              className="perfil-fichero-cuerpo"
              id="perfil-fichero-panel"
              role="tabpanel"
              aria-labelledby={`view-tab-${abierto.nombre}`}
            >
              {abierto.politica === 'solo-si-falta' ? (
                <p className="muted">
                  {abierto.nombre} es del agente: lo escribe él. Si ya existe NO se toca ni para
                  fusionar un bloque nuestro; si falta se crea vacío.
                </p>
              ) : null}
              <pre className="perfil-fichero-texto">{abierto.texto || '(este fichero queda sin bloque: no hay nada declarado que le toque)'}</pre>
              <p className="muted">{abierto.unidades.toLocaleString('es')} unidades</p>
            </div>
          </>
        ) : null}
      </section>
    </div>
  );
}
