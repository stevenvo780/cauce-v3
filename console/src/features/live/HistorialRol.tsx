import { History, RotateCcw } from 'lucide-react';
import { useApi } from '../../api/context';
import { useResource } from '../../api/use-resource';
import { EmptyState, Time } from '../../components/ui';
import {
  AVISO_DE_PROFUNDIDAD, actorDeEntrada, cambioDePlantilla, estadoDelDiario, restauracionDe,
  resumirCambio,
} from './historial-rol';

/**
 * Diario de la proyección legacy del rol y puente seguro hacia el perfil canónico.
 *
 * Este componente no escribe. Una restauración sólo copia `previous_brief` al `role_summary` del
 * borrador de Perfil. El operador lo revisa allí y el único guardado disponible es el PUT
 * canónico con CAS, lote gobernado y ACK del runtime. Así se conserva el historial útil sin
 * reabrir el antiguo `agent.update {role_brief}`.
 */

export interface HistorialRolProps {
  tenantId: string;
  alias: string;
  /** Ausente sin `config.write`: el diario se lee igual y sólo desaparece la carga del borrador. */
  onRestaurar?: (texto: string) => void;
}

export function HistorialRol({ tenantId, alias, onRestaurar }: HistorialRolProps) {
  const api = useApi();
  const historial = useResource(
    `historial-rol-${tenantId}-${alias}`,
    () => api.getRoleBriefHistory(tenantId, alias),
  );

  if (historial.loading && !historial.data) {
    return <p className="muted">Leyendo el diario del rol…</p>;
  }

  // Un fallo de red NO es «no publicado»: `getRoleBriefHistory` ya bajó el 404 a `publicado:false`,
  // así que lo que llega acá es un fallo de verdad y se dice como tal.
  if (historial.error && !historial.data) {
    return (
      <EmptyState>
        No se pudo leer el diario del rol de {alias}: {historial.error.message}. Eso NO significa
        que no haya cambiado nunca —significa que la consola no lo pudo mirar—.
      </EmptyState>
    );
  }

  const estado = estadoDelDiario(historial.data);

  if (estado.clase === 'no-publicado') {
    return (
      <EmptyState>
        No se pudo mirar el diario del rol: {estado.motivo} Eso NO significa que este rol no haya
        cambiado nunca. El día que el gateway publique{' '}
        <code>GET /v3/console/role-assignments/:tenant/:alias/history</code>, esta sección se llena sola.
      </EmptyState>
    );
  }

  if (estado.clase === 'vacio') {
    return (
      <div className="historial-rol">
        <EmptyState>
          El servidor miró y no hay ningún cambio anotado para {alias}. {AVISO_DE_PROFUNDIDAD}
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="historial-rol">
      <p className="notice" role="note">{AVISO_DE_PROFUNDIDAD}</p>

      {/* Se dice UNA vez arriba y no en cada fila: repetir «no consta quién» catorce veces
          convierte un dato importante en ruido que se deja de leer. */}
      <p className="historial-nota-actor">
        El diario dice qué cambió y cuándo. Las revisiones antiguas pueden no decir quién: si las
        columnas de autor llegan vacías se muestra <strong>«no consta quién»</strong>, sin atribuir
        el cambio al operador que está mirando.
      </p>

      <ol className="historial-lista">
        {estado.entradas.map((entrada, indice) => {
          const cambio = resumirCambio(entrada);
          const plantilla = cambioDePlantilla(entrada);
          const actor = actorDeEntrada(entrada);
          const restauracion = restauracionDe(entrada);
          return (
            <li key={entrada.id ?? indice} className="historial-entrada" data-clase={cambio.clase}>
              <div className="historial-entrada-head">
                <span className="historial-entrada-icono" aria-hidden="true"><History size={14} /></span>
                <div>
                  <strong>{cambio.titulo}</strong>
                  <p className="historial-entrada-cuando">
                    <Time value={entrada.changed_at} />
                    {actor ? <> · por <code>{actor}</code></> : <> · no consta quién</>}
                  </p>
                </div>
              </div>

              <p className="historial-entrada-detalle">{cambio.detalle}</p>
              {plantilla ? <p className="historial-entrada-plantilla">{plantilla}</p> : null}

              {typeof entrada.previous_brief === 'string' ? (
                <details>
                  <summary>Ver el texto que había antes de este cambio</summary>
                  <pre className="historial-texto">{entrada.previous_brief}</pre>
                </details>
              ) : null}

              {onRestaurar ? (
                <div className="historial-entrada-acciones">
                  <button
                    type="button"
                    className="button small secondary"
                    onClick={() => { onRestaurar(restauracion.clase === 'texto' ? restauracion.texto : ''); }}
                  >
                    <RotateCcw size={14} aria-hidden="true" />
                    {restauracion.clase === 'texto'
                      ? ' Usar este texto en Perfil'
                      : ' Vaciar el rol en un borrador de Perfil'}
                  </button>
                  <span className="historial-entrada-ayuda">
                    {restauracion.clase === 'texto'
                      ? 'No guarda nada: carga role_summary y abre Perfil para revisarlo y aplicarlo con CAS y ACK.'
                      : 'Antes de este cambio no había rol. Perfil se abre con role_summary vacío; los demás campos se conservan.'}
                  </span>
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
