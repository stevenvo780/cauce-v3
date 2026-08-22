import { onNavClick } from '../../navigation';

/**
 * `/jobs` se retiró el 2026-08-22. Esto es lo que queda en su sitio.
 *
 * **No se retiró por opinión, se midió.** En la base de producción (`cauce`, contenedor
 * `cauce-v3-prod-postgres-1`), `pg_stat_user_tables` para la tabla `jobs` daba `n_tup_ins = 0`,
 * `n_tup_upd = 0`, `n_live_tup = 0` y `seq_scan = 373146`, con las estadísticas NUNCA reseteadas
 * (`pg_stat_get_db_stat_reset_time` = NULL) sobre un postmaster de 31 días. En esa misma ventana
 * `deliveries` acumulaba 15.012 inserciones. O sea: cero filas en toda la vida de la base mientras
 * el dispatcher barría la tabla trescientas setenta y tres mil veces. El único escritor en el
 * código es `POST /v3/console/jobs`, y sus únicos llamadores eran el formulario de esta misma
 * página y el arnés de QA. Un bucle cerrado sin un solo productor real.
 *
 * **Por qué un aviso y no una redirección.** `/adapters` sí redirige a la portada, porque su
 * contenido se mudó ahí y quien llega encuentra lo que buscaba. Lo de `/jobs` no se mudó a ningún
 * lado: no existe. Mandar a la portada en silencio dejaría a quien abrió un marcador creyendo que
 * la consola se equivocó de página. El trabajo real de la flota son las ENTREGAS, y ésas están en
 * Queues y en La flota ahora — así que eso es lo que se dice, con las dos puertas al lado.
 *
 * El backend NO se tocó: la ruta del gateway, `enqueueJob` y la tabla siguen en pie, porque el
 * arnés de QA de fairness los ejercita. Retirar esa maquinaria es un trabajo de backend aparte.
 */
export function JobsRetiredNotice() {
  return (
    <div className="state-card">
      <div>
        <strong>«Jobs» ya no es una vista de esta consola</strong>
        <p>
          La tabla <span className="mono">jobs</span> nunca tuvo una sola fila en producción: el único
          modo de crear una era este mismo formulario. El trabajo real de la flota son las entregas.
          Están en <a href="/queues" onClick={(event) => onNavClick(event, '/queues')}>Queues &amp; DLQ</a>{' '}
          y en <a href="/live" onClick={(event) => onNavClick(event, '/live')}>La flota ahora</a>.
        </p>
      </div>
    </div>
  );
}
