import { History, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { useApi } from '../../api/context';
import { useResource } from '../../api/use-resource';
import { EmptyState, Time } from '../../components/ui';
import {
  AVISO_DE_PROFUNDIDAD, actorDeEntrada, cambioDePlantilla, estadoDelDiario, restauracionDe,
  resumirCambio,
} from './historial-rol';

/**
 * Legacy role projection journal and a safe bridge to the canonical profile.
 *
 * This component does not write. A restore only copies `previous_brief` into the `role_summary`
 * of the Profile draft. The operator reviews it there and the only save available is the
 * canonical PUT with CAS, governed batch and runtime ACK. This preserves the useful history
 * without reopening the old `agent.update {role_brief}`.
 */

interface HistorialRolProps {
  tenantId: string;
  alias: string;
  /** Absent without `config.write`: the journal is still read; only the draft loading disappears. */
  onRestaurar?: (texto: string) => void;
}

const ENTRADAS_POR_PAGINA = 10;

export function HistorialRol({ tenantId, alias, onRestaurar }: HistorialRolProps) {
  const api = useApi();
  const [visibles, setVisibles] = useState(ENTRADAS_POR_PAGINA);
  const historial = useResource(
    `historial-rol-${tenantId}-${alias}`,
    () => api.getRoleBriefHistory(tenantId, alias),
  );

  if (historial.loading && !historial.data) {
    return <p className="muted">Leyendo el diario del rol…</p>;
  }

  // A network failure is NOT "not published": `getRoleBriefHistory` already lowered the 404 to
  // `publicado:false`, so what reaches here is a real failure and is reported as such.
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

  const entradas = estado.entradas;
  const mostradas = entradas.slice(0, visibles);
  const restantes = entradas.length - mostradas.length;

  return (
    <div className="historial-rol">
      <p className="notice" role="note">{AVISO_DE_PROFUNDIDAD}</p>

      {/* It is said ONCE at the top and not on every row: repeating "no consta quién" fourteen times
          turns an important datum into noise that stops being read. */}
      <p className="historial-nota-actor">
        El diario dice qué cambió y cuándo. Las revisiones antiguas pueden no decir quién: si las
        columnas de autor llegan vacías se muestra <strong>«no consta quién»</strong>, sin atribuir
        el cambio al operador que está mirando.
      </p>

      <ol className="historial-lista">
        {mostradas.map((entrada, indice) => {
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

      {restantes > 0 ? (
        <div className="historial-paginacion">
          <p className="historial-nota-actor">
            Se ven los {mostradas.length} cambios más nuevos de {entradas.length} anotados.
          </p>
          <button
            type="button"
            className="button small secondary"
            onClick={() => { setVisibles((cuantas) => cuantas + ENTRADAS_POR_PAGINA); }}
          >
            Ver {Math.min(ENTRADAS_POR_PAGINA, restantes)} más
          </button>
        </div>
      ) : null}
    </div>
  );
}
