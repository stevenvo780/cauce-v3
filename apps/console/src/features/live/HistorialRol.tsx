import { History, RotateCcw } from 'lucide-react';
import { useApi } from '../../api/context';
import { useResource } from '../../api/use-resource';
import { EmptyState, Time } from '../../components/ui';
import {
  AVISO_DE_PROFUNDIDAD, actorDeEntrada, cambioDePlantilla, estadoDelDiario, restauracionDe,
  resumirCambio,
} from './historial-rol';

/**
 * EL DIARIO DEL ROL DECLARADO, Y LA VUELTA ATRÁS.
 *
 * Era el tercer pedido de Steven —«ver el historial y poder volver a una versión anterior»— y el
 * único de los tres que no tenía nada construido: el rol se podía leer y escribir, pero un cambio
 * desafortunado no se deshacía desde ningún sitio. La tabla existía y no la miraba nadie.
 *
 * CÓMO SE DESHACE, Y POR QUÉ ASÍ. El botón NO guarda: trae el texto anterior al editor de arriba y
 * deja al operador delante de él, con el botón «Guardar el rol» de siempre. Parece un rodeo y es
 * justo lo contrario. Escribir directo desde acá se saltaría, una por una, todas las guardas que
 * ese editor ya tiene y que costaron caro:
 *
 *   · el bloqueo por UTF-16 (`bloqueoPorRuntimeDesplegado`), que es lo único que hoy impide dejar
 *     a un alias SORDO. Y un texto viejo es EXACTAMENTE el que más riesgo tiene de disparar ese
 *     bloqueo: se escribió por psql, antes de que existiera guarda ninguna.
 *   · la `expected_revision`, sin la cual dos operadores se pisan en silencio;
 *   · la relectura tras guardar, que es lo que separa «el servidor lo aceptó» de «esto es lo que hay»;
 *   · y que el operador VEA lo que va a guardar antes de guardarlo.
 *
 * Un «deshacer» de un clic que se salta las cinco cosas no es más cómodo, es más peligroso: el
 * texto que restaura es el que ya se demostró que alguien quiso cambiar.
 *
 * Además, deshacer acá no borra nada: guardar el texto anterior crea una revisión NUEVA, con su
 * inversa en `config_revisions`. El diario sigue creciendo hacia adelante y el cambio que se
 * deshizo se sigue viendo. No hay forma de perder una versión desde esta pantalla.
 */

export interface HistorialRolProps {
  tenantId: string;
  alias: string;
  /**
   * Trae un texto al editor de la capa 1. Es el MISMO canal que usa el textarea al escribir, así
   * que el texto restaurado queda «sucio» y pasa por el contador, por el bloqueo de UTF-16 y por
   * el botón de guardar como si se hubiera tecleado a mano.
   */
  onRestaurar: (texto: string) => void;
  /** Sin `config.write` el diario se LEE igual: lo que se retira es la vuelta atrás, no la vista. */
  soloLectura: boolean;
}

export function HistorialRol({ tenantId, alias, onRestaurar, soloLectura }: HistorialRolProps) {
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
        El diario dice qué cambió y cuándo. <strong>No dice quién</strong>: las columnas de autor
        llegan vacías por todos los caminos de escritura, incluido este editor. Para saber quién
        hay que cruzarlo con el registro de auditoría.
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

              {soloLectura ? null : (
                <div className="historial-entrada-acciones">
                  <button
                    type="button"
                    className="button small secondary"
                    onClick={() => onRestaurar(restauracion.clase === 'texto' ? restauracion.texto : '')}
                  >
                    <RotateCcw size={14} aria-hidden="true" />
                    {restauracion.clase === 'texto'
                      ? ' Traer este texto al editor'
                      : ' Deshacer esto dejaría al alias SIN rol'}
                  </button>
                  <span className="historial-entrada-ayuda">
                    {restauracion.clase === 'texto'
                      ? 'Se carga arriba para que lo revises; no se guarda hasta que pulses «Guardar el rol».'
                      : 'Antes de este cambio no tenía rol. Vacía el editor de arriba: revisalo antes de guardar.'}
                  </span>
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
