import { onNavClick } from '../../navigation';

/**
 * Aviso presentado a usuarios que naveguen a la ruta retirada `/jobs`.
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
