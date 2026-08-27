import { AlertTriangle, FileWarning } from 'lucide-react';
import type { AvisoDeCapas } from '../directiva';

export function AvisosDeSolapamiento({ avisos }: { avisos: AvisoDeCapas[] }) {
  if (avisos.length === 0) return null;
  return (
    <div className="directiva-avisos" role="group" aria-label="Avisos de solapamiento entre capas">
      {avisos.map((aviso) => (
        <div key={aviso.id} className="directiva-aviso" data-tono={aviso.tono} role={aviso.tono === 'choque' ? 'alert' : 'note'}>
          <span aria-hidden="true">
            {aviso.tono === 'choque' ? <AlertTriangle size={15} /> : <FileWarning size={15} />}
          </span>
          <div>
            <strong>{aviso.titulo}</strong>
            <p>{aviso.detalle}</p>
            {aviso.evidencia.length > 0 ? (
              <ul className="directiva-evidencia">
                {aviso.evidencia.map((dato) => <li key={dato}><code>{dato}</code></li>)}
              </ul>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}
