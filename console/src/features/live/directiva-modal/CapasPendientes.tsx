import { Wrench } from 'lucide-react';
import { CAPAS_PENDIENTES, type UbicacionDeclarada } from '../capas-pendientes';

export function CapasPendientes({ ubicacion, alias }: { ubicacion: UbicacionDeclarada; alias: string }) {
  return (
    <details className="directiva-pendientes">
      <summary>
        <Wrench size={14} aria-hidden="true" />
        Lo que todavía no se puede desde aquí — herramientas y prompts
      </summary>

      <ul className="directiva-pendiente-lista">
        {CAPAS_PENDIENTES.map((capa) => (
          <li key={capa.id}>
            <strong>{capa.titulo}</strong>
            <p className="directiva-pendiente-pedido">{capa.pedido}</p>
            <p className="directiva-pendiente-porque">{capa.porQueNo}</p>
            <p className="directiva-pendiente-falta">Para que esto tenga editor: {capa.queFalta}</p>
          </li>
        ))}
      </ul>

      <p className="directiva-pendiente-donde">
        Mientras tanto, la configuración de {alias} vive en{' '}
        {ubicacion.contenedor ? <code>{ubicacion.contenedor}</code> : <span className="unknown">contenedor UNKNOWN</span>}
        {', '}
        {ubicacion.home ? <code>{ubicacion.home}</code> : <span className="unknown">$HOME UNKNOWN</span>}
        {'. '}
        Se toca por la TUI o por <code>docker exec</code>, con lo que eso implica: sin revisión y
        sin vuelta atrás.
      </p>
    </details>
  );
}
