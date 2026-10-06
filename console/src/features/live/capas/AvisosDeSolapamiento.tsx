import { AlertTriangle, FileWarning } from 'lucide-react';
import { Notice } from '../../../components/form-kit';
import type { AvisoDeCapas } from '../directiva';

export function AvisosDeSolapamiento({ avisos }: { avisos: AvisoDeCapas[] }) {
  if (avisos.length === 0) return null;
  return (
    <div className="grid gap-2" role="group" aria-label="Avisos de solapamiento entre capas">
      {avisos.map((aviso) => (
        <Notice key={aviso.id} tone={aviso.tono === 'choque' ? 'danger' : 'warn'} data-tono={aviso.tono}
          role={aviso.tono === 'choque' ? 'alert' : 'note'} className="flex items-start gap-2">
          <span aria-hidden="true" className="mt-0.5 shrink-0">
            {aviso.tono === 'choque' ? <AlertTriangle size={15} /> : <FileWarning size={15} />}
          </span>
          <div className="min-w-0">
            <strong>{aviso.titulo}</strong>
            <p>{aviso.detalle}</p>
            {aviso.evidencia.length > 0 ? (
              <ul className="m-0 mt-1 grid list-none gap-0.5 p-0 text-xs">
                {aviso.evidencia.map((dato) => <li key={dato}><code>{dato}</code></li>)}
              </ul>
            ) : null}
          </div>
        </Notice>
      ))}
    </div>
  );
}
